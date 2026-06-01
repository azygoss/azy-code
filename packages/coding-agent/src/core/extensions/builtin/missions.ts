import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	getKeybindings,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { APP_NAME } from "../../../config.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import {
	appendMissionOrchestratorActivity,
	completeMissionRun,
	createMissionRun,
	getLatestMissionRun,
	hasRunningMissionRuns,
	listMissionRuns,
	type MissionAgentActivity,
	type MissionRunAgent,
	type MissionRunState,
	readMissionOrchestrator,
	readMissionRun,
	recoverStaleMissionRuns,
	updateMissionRunAgent,
} from "../../missions/runs.ts";
import {
	activateMission,
	blockMission,
	completeMission,
	createMission,
	getActiveMission,
	getMissionDir,
	incrementMissionRuns,
	listMissions,
	type MissionModels,
	type MissionState,
	resolveMission,
	updateMission,
} from "../../missions/store.ts";
import { WorkerOutputCollector } from "../../missions/worker-output.ts";
import type { ExtensionAPI, ExtensionContext } from "../types.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const OUTPUT_LIMIT = 48 * 1024;

export type SubagentRole = "orchestrator" | "worker" | "reviewer";

export interface WorkerTask {
	id?: string;
	task: string;
	role?: SubagentRole;
	model?: string;
	tools?: string[];
}

export interface WorkerResult {
	id: string;
	task: string;
	role: SubagentRole;
	model?: string;
	status: "queued" | "running" | "complete" | "failed";
	output: string;
	stderr: string;
	exitCode: number | null;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	activity: MissionAgentActivity[];
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	results: WorkerResult[];
}

interface MissionDetails {
	action: "create" | "list" | "status" | "history" | "inspect" | "update" | "activate" | "run" | "block" | "complete";
	mission?: MissionState;
	missions?: MissionState[];
	run?: MissionRunState;
	runs?: MissionRunState[];
	results?: WorkerResult[];
}

type MissionDashboardAction = { type: "create" } | { type: "select"; missionId: string } | { type: "close" };

const missionConsoleListeners = new Map<string, Set<() => void>>();

function subscribeMissionConsole(missionId: string, listener: () => void): () => void {
	const listeners = missionConsoleListeners.get(missionId) ?? new Set();
	listeners.add(listener);
	missionConsoleListeners.set(missionId, listeners);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) missionConsoleListeners.delete(missionId);
	};
}

function notifyMissionConsole(missionId: string): void {
	for (const listener of missionConsoleListeners.get(missionId) ?? []) listener();
}

function appendParentOrchestratorActivity(activity: MissionAgentActivity): void {
	if (process.env.AZYCODE_INTERNAL_SUBAGENT_ROLE) return;
	const mission = getActiveMission();
	if (!mission) return;
	appendMissionOrchestratorActivity(mission, activity);
	notifyMissionConsole(mission.id);
}

const ROLE_PROMPTS: Record<SubagentRole, string> = {
	orchestrator: [
		"You are the mission orchestrator.",
		"Decompose the objective, assign bounded worker tasks, review handoffs, and keep the parent informed.",
		"Do not edit files unless the task explicitly requires direct orchestration work.",
	].join("\n"),
	worker: [
		"You are an implementation worker.",
		"Complete the assigned task end to end in the current working directory.",
		"Inspect before editing, keep changes scoped, run focused verification, and return a concise handoff.",
	].join("\n"),
	reviewer: [
		"You are a review worker.",
		"Inspect the assigned surface for bugs, regressions, missing tests, and incomplete requirements.",
		"Return findings ordered by severity with file references. Do not edit unless explicitly asked.",
	].join("\n"),
};

const WorkerTaskSchema = Type.Object({
	task: Type.String({ description: "Bounded task delegated to the subagent." }),
	role: Type.Optional(StringEnum(["orchestrator", "worker", "reviewer"] as const)),
	model: Type.Optional(Type.String({ description: "Optional provider/model or model id override for this task." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional active tool allowlist for this task." })),
});

const SubagentParams = Type.Object({
	task: Type.Optional(Type.String({ description: "Single delegated task." })),
	role: Type.Optional(StringEnum(["orchestrator", "worker", "reviewer"] as const)),
	model: Type.Optional(Type.String({ description: "Optional provider/model or model id override." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional active tool allowlist." })),
	tasks: Type.Optional(Type.Array(WorkerTaskSchema, { description: "Parallel delegated tasks." })),
	chain: Type.Optional(
		Type.Array(WorkerTaskSchema, { description: "Sequential tasks. Use {previous} in later tasks." }),
	),
});

const MissionParams = Type.Object({
	action: StringEnum([
		"create",
		"list",
		"status",
		"history",
		"inspect",
		"update",
		"activate",
		"run",
		"block",
		"complete",
	] as const),
	missionId: Type.Optional(Type.String({ description: "Mission id. Defaults to the active mission." })),
	runId: Type.Optional(Type.String({ description: "Run id for inspect. Defaults to the latest run." })),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 100, description: "Maximum history entries. Defaults to 20." }),
	),
	objective: Type.Optional(Type.String({ description: "Mission objective for create or update." })),
	orchestratorModel: Type.Optional(Type.String({ description: "Parent orchestrator model." })),
	workerModel: Type.Optional(Type.String({ description: "Default implementation worker model." })),
	reviewerModel: Type.Optional(Type.String({ description: "Default reviewer model." })),
	tasks: Type.Optional(Type.Array(WorkerTaskSchema, { description: "Tasks to run for this mission." })),
});

function writeJson(path: string, value: unknown): void {
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, path);
}

function appendJsonLine(path: string, value: unknown): void {
	appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function getFinalOutput(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
	}
	return "";
}

function getInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const runtime = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(runtime)) {
		return { command: process.execPath, args };
	}
	return { command: APP_NAME, args };
}

function truncateOutput(output: string): string {
	if (Buffer.byteLength(output, "utf8") <= OUTPUT_LIMIT) return output;
	return `${output.slice(0, OUTPUT_LIMIT)}\n\n[output truncated]`;
}

function cloneWorkerResult(result: WorkerResult): WorkerResult {
	return { ...result, activity: [...result.activity] };
}

function getMessageActivity(message: Message): MissionAgentActivity[] {
	const timestamp = new Date().toISOString();
	if (message.role === "assistant") {
		const activity: MissionAgentActivity[] = [];
		for (const part of message.content) {
			if (part.type === "toolCall") activity.push({ timestamp, kind: "tool", text: `Calling ${part.name}` });
			if (part.type === "text" && part.text.trim()) {
				activity.push({ timestamp, kind: "assistant", text: part.text.trim().split("\n")[0] });
			}
		}
		return activity;
	}
	if (message.role === "toolResult") {
		return [{ timestamp, kind: "result", text: `Completed ${message.toolName}` }];
	}
	return [];
}

async function runWorker(
	task: WorkerTask,
	cwd: string,
	signal?: AbortSignal,
	onProgress?: (result: WorkerResult, activity?: MissionAgentActivity) => void,
): Promise<WorkerResult> {
	const startedAt = new Date().toISOString();
	const role = task.role ?? "worker";
	const result: WorkerResult = {
		id: task.id ?? randomUUID(),
		task: task.task,
		role,
		model: task.model,
		status: "running",
		output: "",
		stderr: "",
		exitCode: null,
		startedAt,
		updatedAt: startedAt,
		activity: [],
	};
	const args = ["--mode", "json", "--print", "--no-session", "--append-system-prompt", ROLE_PROMPTS[role]];
	if (task.model) args.push("--model", task.model);
	if (task.tools?.length) args.push("--tools", task.tools.join(","));
	args.push(task.task);
	const invocation = getInvocation(args);

	return new Promise((resolve) => {
		const messages: Message[] = [];
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			env: { ...process.env, AZYCODE_INTERNAL_SUBAGENT_ROLE: role },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const outputCollector = new WorkerOutputCollector();
		let finished = false;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const emit = (activity?: MissionAgentActivity) => {
			if (activity) result.activity = [...result.activity, activity].slice(-80);
			result.updatedAt = new Date().toISOString();
			onProgress?.(cloneWorkerResult(result), activity);
		};
		const recordMessages = (newMessages: Message[]) => {
			for (const message of newMessages) {
				messages.push(message);
				result.output = truncateOutput(getFinalOutput(messages));
				const activity = getMessageActivity(message);
				if (activity.length === 0) emit();
				for (const item of activity) emit(item);
			}
		};
		const finish = (exitCode: number | null, error?: Error) => {
			if (finished) return;
			finished = true;
			if (heartbeat) clearInterval(heartbeat);
			if (killTimer) clearTimeout(killTimer);
			recordMessages(outputCollector.finish());
			result.exitCode = exitCode;
			result.status = exitCode === 0 && !error ? "complete" : "failed";
			result.stderr = error ? `${result.stderr}\n${error.message}`.trim() : result.stderr.trim();
			result.output = truncateOutput(
				getFinalOutput(messages) || result.stderr || outputCollector.getRawOutput() || "(no output)",
			);
			result.completedAt = new Date().toISOString();
			emit({
				timestamp: result.completedAt,
				kind: result.status === "complete" ? "status" : "error",
				text: result.status === "complete" ? "Worker completed." : "Worker failed.",
			});
			resolve(cloneWorkerResult(result));
		};
		heartbeat = setInterval(() => emit(), 15_000);
		emit({ timestamp: startedAt, kind: "status", text: "Worker process started." });
		child.stdout.on("data", (chunk: Buffer) => {
			recordMessages(outputCollector.push(chunk.toString()));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			result.stderr += chunk.toString();
			emit({ timestamp: new Date().toISOString(), kind: "error", text: "Worker wrote to stderr." });
		});
		child.on("error", (error) => finish(null, error));
		child.on("close", (code) => finish(code));
		if (signal) {
			const abort = () => {
				emit({ timestamp: new Date().toISOString(), kind: "error", text: "Worker cancellation requested." });
				child.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!finished) {
						emit({
							timestamp: new Date().toISOString(),
							kind: "error",
							text: "Worker did not exit after SIGTERM; sending SIGKILL.",
						});
						child.kill("SIGKILL");
					}
				}, 3000);
				killTimer.unref();
			};
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});
}

async function mapLimit<T>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<WorkerResult>,
): Promise<WorkerResult[]> {
	const results: WorkerResult[] = [];
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await fn(items[index], index);
			}
		}),
	);
	return results;
}

async function runTasks(
	tasks: WorkerTask[],
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (partial: AgentToolResult<SubagentDetails>) => void,
	onWorkerUpdate?: (result: WorkerResult, activity?: MissionAgentActivity) => void,
): Promise<WorkerResult[]> {
	const placeholders = tasks.map<WorkerResult>((task) => ({
		id: task.id ?? randomUUID(),
		task: task.task,
		role: task.role ?? "worker",
		model: task.model,
		status: "queued",
		output: "",
		stderr: "",
		exitCode: null,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		activity: [],
	}));
	const emit = () => {
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `${placeholders.filter((result) => result.status === "complete" || result.status === "failed").length}/${tasks.length} workers complete`,
				},
			],
			details: { mode: "parallel", results: [...placeholders] },
		});
	};
	emit();
	return mapLimit(tasks, MAX_CONCURRENCY, async (task, index) => {
		const result = await runWorker({ ...task, id: placeholders[index].id }, cwd, signal, (progress, activity) => {
			placeholders[index] = progress;
			onWorkerUpdate?.(progress, activity);
			emit();
		});
		placeholders[index] = result;
		emit();
		return result;
	});
}

function formatWorkerResults(results: WorkerResult[]): string {
	return results
		.map(
			(result) => `### ${result.role}: ${result.status}\nModel: ${result.model ?? "inherited"}\n\n${result.output}`,
		)
		.join("\n\n---\n\n");
}

function formatMissionRun(run: MissionRunState): string {
	return [
		`${run.id} [${run.status}] started=${run.startedAt} updated=${run.updatedAt}`,
		...run.agents.map((agent) => {
			const output = agent.output ? `\n${agent.output}` : "";
			const activity = agent.activity
				.slice(-5)
				.map((item) => `${item.timestamp} ${item.kind}: ${item.text}`)
				.join("\n");
			return `### ${agent.label} [${agent.status}]\nid=${agent.id} role=${agent.role} model=${agent.model ?? "inherited"} exit=${agent.exitCode ?? "pending"}\nhandoff=${agent.handoffPath ?? "pending"}\ntask=${agent.task}\nactivity:\n${activity || "(none)"}${output}`;
		}),
	].join("\n\n");
}

function formatMissionRunHistory(runs: MissionRunState[], total: number): string {
	return total
		? [
				`Showing ${runs.length}/${total} mission runs`,
				...runs.map(
					(run) => `${run.id} [${run.status}] ${compactTimestamp(run.startedAt)} · ${missionRunSummary(run)}`,
				),
			].join("\n")
		: "No mission runs.";
}

function persistRun(mission: MissionState, results: WorkerResult[], runId?: string): void {
	const dir = getMissionDir(mission.id);
	for (const result of results) {
		appendJsonLine(join(dir, "worker-transcripts.jsonl"), result);
		const timestamp = (result.completedAt ?? new Date().toISOString()).replace(/[:.]/g, "-");
		const handoffPath = join(dir, "handoffs", `${timestamp}__${result.role}__${result.id}.json`);
		writeJson(handoffPath, result);
		if (runId) updateMissionRunAgent(mission.id, runId, result.id, { handoffPath });
	}
}

interface MissionTracking {
	mission: MissionState;
	runId: string;
	tasks: WorkerTask[];
}

function beginMissionTracking(mission: MissionState, tasks: WorkerTask[], ctx: ExtensionContext): MissionTracking {
	const trackedTasks = tasks.map((task) => ({ ...withMissionDefaults(task, mission), id: task.id ?? randomUUID() }));
	const run = createMissionRun(
		mission,
		trackedTasks.map((task) => ({
			id: task.id ?? randomUUID(),
			role: task.role ?? "worker",
			model: task.model,
			task: task.task,
		})),
	);
	const updatedMission = incrementMissionRuns(mission);
	notifyMissionConsole(mission.id);
	updateMissionStatus(ctx);
	return { mission: updatedMission, runId: run.id, tasks: trackedTasks };
}

function updateMissionTracking(
	tracking: MissionTracking,
	result: WorkerResult,
	ctx: ExtensionContext,
	activity?: MissionAgentActivity,
): void {
	updateMissionRunAgent(tracking.mission.id, tracking.runId, result.id, {
		status: result.status,
		output: result.output,
		stderr: result.stderr,
		exitCode: result.exitCode,
		startedAt: result.startedAt,
		completedAt: result.completedAt,
		activity,
	});
	notifyMissionConsole(tracking.mission.id);
	updateMissionStatus(ctx);
}

function completeMissionTracking(tracking: MissionTracking, results: WorkerResult[], ctx: ExtensionContext): void {
	persistRun(tracking.mission, results, tracking.runId);
	completeMissionRun(tracking.mission.id, tracking.runId);
	notifyMissionConsole(tracking.mission.id);
	updateMissionStatus(ctx);
}

function getRoleModel(models: MissionModels, role: SubagentRole): string | undefined {
	return models[role];
}

function withMissionDefaults(task: WorkerTask, mission: MissionState): WorkerTask {
	const role = task.role ?? "worker";
	return { ...task, role, model: task.model ?? getRoleModel(mission.models, role) };
}

function missionSummary(mission: MissionState): string {
	return `${mission.id} [${mission.status}] ${mission.objective}\n  orchestrator=${mission.models.orchestrator ?? "inherited"} worker=${mission.models.worker ?? "inherited"} reviewer=${mission.models.reviewer ?? "inherited"} runs=${mission.runs}\n  latest=${missionRunSummary(getLatestMissionRun(mission.id))}`;
}

function compactModel(model: string | undefined, fallback: string): string {
	if (!model) return fallback;
	const [provider, ...idParts] = model.split("/");
	return `${provider}/${idParts.join("/").replace(/^.*\//, "")}`;
}

function compactTimestamp(timestamp: string | undefined): string {
	return timestamp ? timestamp.replace("T", " ").slice(0, 19) : "never";
}

function compactAge(timestamp: string | undefined): string {
	if (!timestamp) return "never";
	const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
	if (!Number.isFinite(elapsedSeconds)) return "unknown";
	if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
	const elapsedHours = Math.floor(elapsedMinutes / 60);
	if (elapsedHours < 24) return `${elapsedHours}h ago`;
	return `${Math.floor(elapsedHours / 24)}d ago`;
}

function missionRunSummary(run: MissionRunState | undefined): string {
	if (!run) return "no worker runs";
	const agents = run.agents.filter((agent) => agent.id !== "orchestrator");
	const running = agents.filter((agent) => agent.status === "running" || agent.status === "queued").length;
	const complete = agents.filter((agent) => agent.status === "complete").length;
	const failed = agents.filter((agent) => agent.status === "failed").length;
	const skipped = agents.filter((agent) => agent.status === "skipped").length;
	return `${run.status} · ${running} running · ${complete} complete · ${failed} failed · ${skipped} skipped`;
}

function formatCount(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function missionDashboardItems(missions: MissionState[], activeMissionId: string | undefined): SelectItem[] {
	return [
		{
			value: "create",
			label: "+ Create mission",
			description: "Define objective and choose orchestrator, worker, and reviewer models",
		},
		...missions.map((mission) => {
			const latestRun = getLatestMissionRun(mission.id);
			return {
				value: mission.id,
				label: `${mission.id === activeMissionId ? "●" : "○"} ${mission.objective}`,
				description: `${mission.id} · ${mission.status} · ${mission.runs} runs · ${missionRunSummary(latestRun)} · ${compactTimestamp(latestRun?.updatedAt ?? mission.updatedAt)}\n   O ${compactModel(mission.models.orchestrator, "current")}  W ${compactModel(mission.models.worker, "inherit")}  R ${compactModel(mission.models.reviewer, "inherit")}`,
			};
		}),
	];
}

function statusColor(status: MissionRunAgent["status"]): "success" | "warning" | "error" | "muted" {
	if (status === "failed") return "error";
	if (status === "active" || status === "complete") return "success";
	if (status === "blocked" || status === "running") return "warning";
	return "muted";
}

class MissionConsoleComponent implements Component {
	private selectedAgent = 0;
	private selectedRun = 0;
	private scrollOffset = 0;
	private readonly unsubscribe: () => void;
	private readonly refreshTimer: ReturnType<typeof setInterval>;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly missionId: string;
	private readonly done: () => void;

	constructor(tui: TUI, theme: Theme, missionId: string, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.missionId = missionId;
		this.done = done;
		this.unsubscribe = subscribeMissionConsole(missionId, () => this.tui.requestRender());
		this.refreshTimer = setInterval(() => this.tui.requestRender(), 1000);
	}

	private getAgents(): MissionRunAgent[] {
		const mission = resolveMission(this.missionId);
		if (!mission) return [];
		return listMissionRuns(mission.id)[this.selectedRun]?.agents ?? [readMissionOrchestrator(mission)];
	}

	private renderAgentTabs(agents: MissionRunAgent[], width: number): string {
		const tabs = agents.map((agent, index) => {
			const selected = index === this.selectedAgent;
			const label = `${index + 1}:${agent.role.toUpperCase()} ${agent.status}`;
			return selected ? this.theme.bold(this.theme.fg("accent", `[${label}]`)) : this.theme.fg("dim", label);
		});
		return truncateToWidth(tabs.join("  "), width);
	}

	render(width: number): string[] {
		const mission = resolveMission(this.missionId);
		if (!mission) return [this.theme.fg("error", "Mission no longer exists.")];
		const runs = listMissionRuns(mission.id);
		this.selectedRun = Math.min(this.selectedRun, Math.max(0, runs.length - 1));
		const selectedRun = runs[this.selectedRun];
		const agents = selectedRun?.agents ?? [readMissionOrchestrator(mission)];
		this.selectedAgent = Math.min(this.selectedAgent, Math.max(0, agents.length - 1));
		const agent = agents[this.selectedAgent];
		if (!agent) return [this.theme.fg("error", "No mission agents available.")];
		const contentWidth = Math.max(20, width - 4);
		const delegatedAgents = agents.filter((item) => item.id !== "orchestrator");
		const roleSummary = [
			formatCount(delegatedAgents.filter((item) => item.role === "worker").length, "worker"),
			formatCount(delegatedAgents.filter((item) => item.role === "reviewer").length, "reviewer"),
			formatCount(delegatedAgents.filter((item) => item.role === "orchestrator").length, "sub-orchestrator"),
		].join(" · ");
		const lines = [
			this.theme.fg("borderAccent", "─".repeat(Math.max(1, width))),
			` ${this.theme.bold(this.theme.fg("accent", "AZY CODE  /  MISSION CONSOLE"))}`,
			` ${this.theme.fg("muted", mission.id)}  ${this.theme.fg("dim", `runs ${mission.runs} · ${mission.status} · history ${runs.length ? `${this.selectedRun + 1}/${runs.length}` : "empty"}`)}`,
			"",
			` ${this.renderAgentTabs(agents, contentWidth)}`,
			"",
			` ${this.theme.fg("dim", "RUN")}    ${selectedRun?.id ?? "No delegated runs yet."}`,
			` ${this.theme.fg("dim", "STATE")}  ${selectedRun ? `${missionRunSummary(selectedRun)} · updated ${compactAge(selectedRun.updatedAt)}` : "idle"}`,
			` ${this.theme.fg("dim", "ROLES")}  ${roleSummary}`,
			` ${this.theme.fg("dim", "AGENT")}  ${this.theme.bold(agent.label)}  ${this.theme.fg(statusColor(agent.status), agent.status.toUpperCase())}  ${this.theme.fg("dim", `· ${agent.activity.length} events · updated ${compactAge(agent.updatedAt)}`)}`,
			` ${this.theme.fg("dim", "MODEL")}  ${agent.model ?? "inherited from orchestrator"}`,
			` ${this.theme.fg("dim", "TASK")}   ${agent.task}`,
			` ${this.theme.fg("dim", "EXIT")}   ${agent.exitCode ?? "pending"}${agent.completedAt ? ` · completed ${agent.completedAt}` : ""}`,
			` ${this.theme.fg("dim", "HANDOFF")} ${agent.handoffPath ?? "pending"}`,
			"",
			` ${this.theme.fg("dim", "ACTIVITY")}`,
		];
		const activity = agent.activity.length
			? [...agent.activity]
					.reverse()
					.map((item) => `${item.timestamp.slice(11, 19)}  ${item.kind.padEnd(9)} ${item.text}`)
			: ["No activity recorded yet."];
		const output = agent.output ? ["", this.theme.fg("dim", "OUTPUT"), ...agent.output.split("\n")] : [];
		const detailLines = [...activity, ...output].flatMap((line) => wrapTextWithAnsi(` ${line}`, contentWidth));
		const viewportHeight = 15;
		const maxOffset = Math.max(0, detailLines.length - viewportHeight);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		lines.push(...detailLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight));
		lines.push("");
		lines.push(
			` ${this.theme.fg("dim", `tab/1-9 agent   pgup/pgdn history   ↑↓ scroll   esc close   ${selectedRun?.status ?? "not started"}`)}`,
		);
		lines.push(this.theme.fg("borderMuted", "─".repeat(Math.max(1, width))));
		return lines.map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const agents = this.getAgents();
		const runCount = listMissionRuns(this.missionId).length;
		if (kb.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (/^[1-9]$/.test(data) && Number(data) <= agents.length) {
			this.selectedAgent = Number(data) - 1;
			this.scrollOffset = 0;
		} else if (kb.matches(data, "tui.input.tab")) {
			this.selectedAgent = agents.length ? (this.selectedAgent + 1) % agents.length : 0;
			this.scrollOffset = 0;
		} else if (kb.matches(data, "tui.select.up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.scrollOffset += 1;
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.selectedRun = Math.min(Math.max(0, runCount - 1), this.selectedRun + 1);
			this.selectedAgent = 0;
			this.scrollOffset = 0;
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.selectedRun = Math.max(0, this.selectedRun - 1);
			this.selectedAgent = 0;
			this.scrollOffset = 0;
		}
		this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.refreshTimer);
		this.unsubscribe();
	}
}

async function showMissionConsole(ctx: ExtensionContext, missionId: string): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new MissionConsoleComponent(tui, theme, missionId, done),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "92%", maxHeight: "88%" },
		},
	);
}

class MissionDashboardComponent extends Container {
	private selectList: SelectList;
	private tui: TUI;

	constructor(
		tui: TUI,
		theme: Theme,
		missions: MissionState[],
		activeMissionId: string | undefined,
		done: (result: MissionDashboardAction) => void,
	) {
		super();
		this.tui = tui;
		this.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold(theme.fg("accent", "AZY CODE  /  MISSIONS")), 1, 0));
		this.addChild(
			new Text(
				theme.fg("muted", "Persistent orchestration with isolated workers and per-role model routing."),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`${theme.fg("dim", "ACTIVE")}  ${activeMissionId ? theme.fg("success", activeMissionId) : theme.fg("muted", "none")}`,
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const items = missionDashboardItems(missions, activeMissionId);
		this.selectList = new SelectList(items, Math.min(items.length, 9), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", theme.bold(text)),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		this.selectList.onSelect = (item) =>
			done(item.value === "create" ? { type: "create" } : { type: "select", missionId: item.value });
		this.selectList.onCancel = () => done({ type: "close" });
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  ↑↓ navigate   enter open   esc close"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((text) => theme.fg("borderMuted", text)));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
		this.tui.requestRender();
	}
}

function renderResults(results: WorkerResult[], theme: Theme, expanded = false): Text {
	let text = "";
	for (const result of results) {
		const icon =
			result.status === "queued"
				? "·"
				: result.status === "running"
					? "○"
					: result.status === "complete"
						? "✓"
						: "!";
		const color =
			result.status === "queued"
				? "muted"
				: result.status === "running"
					? "warning"
					: result.status === "complete"
						? "success"
						: "error";
		text += `${theme.fg(color, icon)} ${theme.fg("accent", result.role)} ${theme.fg("muted", result.model ?? "inherited")}\n`;
		text += `${theme.fg("dim", result.task.length > 90 ? `${result.task.slice(0, 87)}...` : result.task)}\n`;
		const activity = expanded ? result.activity : result.activity.slice(-2);
		for (const item of activity) {
			text += `${theme.fg("muted", `  ${item.kind.padEnd(9)} ${item.text}`)}\n`;
		}
		if (result.output) {
			const output = expanded ? result.output : result.output.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("dim", output)}\n`;
		}
	}
	return new Text(text.trimEnd(), 0, 0);
}

function updateMissionStatus(ctx: ExtensionContext): void {
	const mission = getActiveMission();
	if (!mission) {
		ctx.ui.setStatus("mission", undefined);
		ctx.ui.setWidget("mission", undefined);
		return;
	}
	const latestRun = getLatestMissionRun(mission.id);
	const orchestrator = readMissionOrchestrator(mission);
	ctx.ui.setStatus(
		"mission",
		ctx.ui.theme.fg(
			"accent",
			`mission ${mission.id.slice(4)} · ${mission.runs} runs · ${latestRun?.status ?? "idle"}`,
		),
	);
	ctx.ui.setWidget("mission", [
		ctx.ui.theme.fg("borderMuted", "── ") +
			ctx.ui.theme.fg("accent", "Mission") +
			ctx.ui.theme.fg("borderMuted", " ──"),
		ctx.ui.theme.fg("text", mission.objective),
		ctx.ui.theme.fg(
			"dim",
			`orchestrator ${mission.models.orchestrator ?? "current session"} · worker ${mission.models.worker ?? "orchestrator"} · reviewer ${mission.models.reviewer ?? "orchestrator"}`,
		),
		ctx.ui.theme.fg("dim", `latest ${missionRunSummary(latestRun)}`),
		ctx.ui.theme.fg("dim", `updated ${compactTimestamp(latestRun?.updatedAt ?? orchestrator.updatedAt)}`),
		ctx.ui.theme.fg("dim", "open /missions console"),
	]);
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

async function selectMissionModel(
	title: string,
	current: string | undefined,
	ctx: ExtensionContext,
	inheritLabel = "Inherit current model",
): Promise<string | undefined | null> {
	const inherit = inheritLabel;
	const models = ctx.modelRegistry.getAvailable();
	const modelChoices = models.map((model) => {
		const key = modelKey(model);
		const name = model.name !== model.id ? ` · ${model.name}` : "";
		return { key, label: `${key}${name}${key === current ? "  [selected]" : ""}` };
	});
	if (current && !modelChoices.some((choice) => choice.key === current)) {
		modelChoices.push({ key: current, label: `${current}  [selected · unavailable]` });
	}
	const choices = [inherit, ...modelChoices.map((choice) => choice.label)];
	const selected = await ctx.ui.select(title, choices);
	if (selected === undefined) return null;
	if (selected === inherit) return undefined;
	return modelChoices.find((choice) => choice.label === selected)?.key ?? current;
}

async function applyOrchestratorModel(
	modelKeyValue: string | undefined,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<void> {
	if (!modelKeyValue) return;
	const [provider, ...idParts] = modelKeyValue.split("/");
	const model = ctx.modelRegistry.find(provider, idParts.join("/"));
	if (!model) {
		ctx.ui.notify(`Model not found: ${modelKeyValue}.`, "warning");
	} else if (!(await pi.setModel(model))) {
		ctx.ui.notify(`No authentication configured for ${modelKeyValue}.`, "warning");
	}
}

async function configureMissionModels(mission: MissionState, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	const orchestrator = await selectMissionModel(
		"Orchestrator model · coordinates work",
		mission.models.orchestrator,
		ctx,
		`Use current session model · ${ctx.model ? modelKey(ctx.model) : "not set"}`,
	);
	if (orchestrator === null) return;
	const worker = await selectMissionModel(
		"Worker model · implementation subagents",
		mission.models.worker,
		ctx,
		`Inherit orchestrator · ${orchestrator ?? "current session"}`,
	);
	if (worker === null) return;
	const reviewer = await selectMissionModel(
		"Reviewer model · verification subagents",
		mission.models.reviewer,
		ctx,
		`Inherit orchestrator · ${orchestrator ?? "current session"}`,
	);
	if (reviewer === null) return;
	const updated = updateMission(mission, {
		models: {
			orchestrator,
			worker,
			reviewer,
		},
	});
	await applyOrchestratorModel(orchestrator, ctx, pi);
	updateMissionStatus(ctx);
	ctx.ui.notify(`Model profile updated for ${updated.id}.`);
}

async function createMissionFromUI(ctx: ExtensionContext, pi: ExtensionAPI): Promise<MissionState | undefined> {
	const objective = await ctx.ui.input("Mission objective · describe the finished outcome");
	if (!objective?.trim()) return undefined;
	const draft: MissionState = {
		id: "new mission",
		objective: objective.trim(),
		status: "active",
		cwd: ctx.cwd,
		models: {},
		createdAt: "",
		updatedAt: "",
		runs: 0,
	};
	const orchestrator = await selectMissionModel(
		"1/3  Orchestrator model · coordinates work",
		ctx.model ? modelKey(ctx.model) : undefined,
		ctx,
		`Use current session model · ${ctx.model ? modelKey(ctx.model) : "not set"}`,
	);
	if (orchestrator === null) return undefined;
	const worker = await selectMissionModel(
		"2/3  Worker model · implementation subagents",
		orchestrator,
		ctx,
		`Inherit orchestrator · ${orchestrator ?? "current session"}`,
	);
	if (worker === null) return undefined;
	const reviewer = await selectMissionModel(
		"3/3  Reviewer model · verification subagents",
		worker ?? orchestrator,
		ctx,
		`Inherit orchestrator · ${orchestrator ?? "current session"}`,
	);
	if (reviewer === null) return undefined;
	draft.models = { orchestrator, worker, reviewer };
	const mission = createMission(draft.objective, draft.cwd, draft.models);
	await applyOrchestratorModel(orchestrator, ctx, pi);
	updateMissionStatus(ctx);
	ctx.ui.notify(`Created and activated ${mission.id}.`, "info");
	return mission;
}

async function showMissionDashboard(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	while (true) {
		const activeMission = getActiveMission();
		const result = await ctx.ui.custom<MissionDashboardAction>((tui, theme, _kb, done) => {
			return new MissionDashboardComponent(tui, theme, listMissions(), activeMission?.id, done);
		});
		if (result.type === "close") return;
		if (result.type === "create") {
			const created = await createMissionFromUI(ctx, pi);
			if (created) await showMissionConsole(ctx, created.id);
			continue;
		}
		const mission = resolveMission(result.missionId);
		if (!mission) continue;
		const action = await ctx.ui.select(`${mission.id} · ${mission.objective}`, [
			"Open mission console",
			mission.id === activeMission?.id ? "Active mission" : "Set as active mission",
			"Configure role models",
			...(mission.status === "active" ? ["Mark blocked"] : []),
			...(mission.status !== "complete" ? ["Mark complete"] : []),
			"Back to missions",
		]);
		if (!action || action === "Back to missions" || action === "Active mission") continue;
		if (action === "Open mission console") {
			await showMissionConsole(ctx, mission.id);
		} else if (action === "Set as active mission") {
			const activated = activateMission(mission);
			await applyOrchestratorModel(activated.models.orchestrator, ctx, pi);
			updateMissionStatus(ctx);
			ctx.ui.notify(`Activated ${activated.id}.`, "info");
		} else if (action === "Configure role models") {
			await configureMissionModels(mission, ctx, pi);
		} else if (action === "Mark blocked") {
			if (hasRunningMissionRuns(mission.id)) {
				ctx.ui.notify("Cannot block a mission while delegated runs are active.", "warning");
				continue;
			}
			const blocked = blockMission(mission);
			updateMissionStatus(ctx);
			ctx.ui.notify(`Blocked ${blocked.id}.`, "info");
		} else if (action === "Mark complete") {
			if (hasRunningMissionRuns(mission.id)) {
				ctx.ui.notify("Cannot complete a mission while delegated runs are active.", "warning");
				continue;
			}
			const completed = completeMission(mission);
			updateMissionStatus(ctx);
			ctx.ui.notify(`Completed ${completed.id}.`, "info");
		}
	}
}

export default function missionsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate isolated work to orchestrator, worker, or reviewer subagents. Use exactly one mode: task, tasks, or chain. Every task can select its own model.",
		promptSnippet: "Delegate bounded tasks to isolated orchestrator, worker, or reviewer processes.",
		promptGuidelines: [
			"Use subagent for parallel research, implementation, or review when independent context windows improve quality.",
			"Assign narrow tasks and explicitly select a model per task when different cost or reasoning profiles are useful.",
		],
		parameters: SubagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const modes =
				Number(Boolean(params.task)) +
				Number(Boolean(params.tasks?.length)) +
				Number(Boolean(params.chain?.length));
			if (modes !== 1) {
				return {
					content: [{ type: "text", text: "Provide exactly one subagent mode: task, tasks, or chain." }],
					details: {},
					isError: true,
				};
			}
			if (params.task) {
				const task = { task: params.task, role: params.role, model: params.model, tools: params.tools };
				const activeMission = getActiveMission();
				const tracking = activeMission ? beginMissionTracking(activeMission, [task], ctx) : undefined;
				const result = await runWorker(tracking?.tasks[0] ?? task, ctx.cwd, signal, (progress, activity) => {
					if (tracking) updateMissionTracking(tracking, progress, ctx, activity);
					onUpdate?.({
						content: [{ type: "text", text: `${progress.role} ${progress.status}` }],
						details: { mode: "single", results: [progress] } satisfies SubagentDetails,
					});
				});
				if (tracking) completeMissionTracking(tracking, [result], ctx);
				return {
					content: [{ type: "text", text: result.output }],
					details: { mode: "single", results: [result] } satisfies SubagentDetails,
					isError: result.status === "failed",
				};
			}
			if (params.tasks?.length) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `Maximum parallel task count is ${MAX_PARALLEL_TASKS}.` }],
						details: {},
						isError: true,
					};
				}
				const activeMission = getActiveMission();
				const tracking = activeMission ? beginMissionTracking(activeMission, params.tasks, ctx) : undefined;
				const results = await runTasks(
					tracking?.tasks ?? params.tasks,
					ctx.cwd,
					signal,
					onUpdate,
					tracking ? (progress, activity) => updateMissionTracking(tracking, progress, ctx, activity) : undefined,
				);
				if (tracking) completeMissionTracking(tracking, results, ctx);
				return {
					content: [{ type: "text", text: formatWorkerResults(results) }],
					details: { mode: "parallel", results } satisfies SubagentDetails,
					isError: results.some((result) => result.status === "failed"),
				};
			}
			const results: WorkerResult[] = [];
			let previous = "";
			const activeMission = getActiveMission();
			const tracking = activeMission ? beginMissionTracking(activeMission, params.chain ?? [], ctx) : undefined;
			for (const task of tracking?.tasks ?? params.chain ?? []) {
				const result = await runWorker(
					{ ...task, task: task.task.replace(/\{previous\}/g, previous) },
					ctx.cwd,
					signal,
					(progress, activity) => {
						if (tracking) updateMissionTracking(tracking, progress, ctx, activity);
						onUpdate?.({
							content: [{ type: "text", text: `chain ${results.length + 1}/${params.chain?.length ?? 0}` }],
							details: { mode: "chain", results: [...results, progress] } satisfies SubagentDetails,
						});
					},
				);
				results.push(result);
				if (result.status === "failed") break;
				previous = result.output;
			}
			if (tracking) completeMissionTracking(tracking, results, ctx);
			return {
				content: [{ type: "text", text: formatWorkerResults(results) }],
				details: { mode: "chain", results } satisfies SubagentDetails,
				isError: results.some((result) => result.status === "failed"),
			};
		},
		renderCall(args, theme) {
			const mode = args.tasks?.length
				? `${args.tasks.length} parallel`
				: args.chain?.length
					? `${args.chain.length} chained`
					: (args.role ?? "worker");
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", mode)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			return details
				? renderResults(details.results, theme, expanded)
				: new Text(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "mission",
		label: "Mission",
		executionMode: "sequential",
		description:
			"Manage persistent orchestrated missions. Create an objective, configure separate orchestrator/worker/reviewer models, run delegated tasks, inspect run details, and complete the mission.",
		promptSnippet: "Manage a persistent mission with orchestrator, worker, and reviewer model profiles.",
		promptGuidelines: [
			"For multi-step implementation work, create or reuse a mission and delegate bounded tasks to workers.",
			"Use reviewer tasks before marking a mission complete. Preserve worker handoffs for the orchestrator.",
		],
		parameters: MissionParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (params.action === "create") {
				if (!params.objective?.trim())
					return { content: [{ type: "text", text: "objective is required" }], details: {}, isError: true };
				const mission = createMission(params.objective.trim(), ctx.cwd, {
					orchestrator: params.orchestratorModel,
					worker: params.workerModel,
					reviewer: params.reviewerModel,
				});
				updateMissionStatus(ctx);
				return {
					content: [{ type: "text", text: missionSummary(mission) }],
					details: { action: "create", mission } satisfies MissionDetails,
				};
			}
			if (params.action === "list") {
				const missions = listMissions();
				return {
					content: [
						{ type: "text", text: missions.length ? missions.map(missionSummary).join("\n\n") : "No missions." },
					],
					details: { action: "list", missions } satisfies MissionDetails,
				};
			}
			const mission = resolveMission(params.missionId);
			if (!mission)
				return {
					content: [{ type: "text", text: "Mission not found. Create one first." }],
					details: {},
					isError: true,
				};
			if (params.action === "status") {
				return {
					content: [{ type: "text", text: missionSummary(mission) }],
					details: { action: "status", mission } satisfies MissionDetails,
				};
			}
			if (params.action === "history") {
				const allRuns = listMissionRuns(mission.id);
				const runs = allRuns.slice(0, params.limit ?? 20);
				return {
					content: [{ type: "text", text: formatMissionRunHistory(runs, allRuns.length) }],
					details: { action: "history", mission, runs } satisfies MissionDetails,
				};
			}
			if (params.action === "inspect") {
				const run = params.runId ? readMissionRun(mission.id, params.runId) : getLatestMissionRun(mission.id);
				if (!run) {
					return {
						content: [{ type: "text", text: "Mission run not found. Start a delegated run first." }],
						details: { action: "inspect", mission } satisfies MissionDetails,
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: formatMissionRun(run) }],
					details: { action: "inspect", mission, run } satisfies MissionDetails,
				};
			}
			if (params.action === "update") {
				const updated = updateMission(mission, {
					objective: params.objective?.trim() || mission.objective,
					models: {
						orchestrator: params.orchestratorModel ?? mission.models.orchestrator,
						worker: params.workerModel ?? mission.models.worker,
						reviewer: params.reviewerModel ?? mission.models.reviewer,
					},
				});
				updateMissionStatus(ctx);
				return {
					content: [{ type: "text", text: missionSummary(updated) }],
					details: { action: "update", mission: updated } satisfies MissionDetails,
				};
			}
			if (params.action === "activate") {
				const activated = activateMission(mission);
				await applyOrchestratorModel(activated.models.orchestrator, ctx, pi);
				updateMissionStatus(ctx);
				return {
					content: [{ type: "text", text: `Activated ${activated.id}` }],
					details: { action: "activate", mission: activated } satisfies MissionDetails,
				};
			}
			if (params.action === "complete") {
				if (hasRunningMissionRuns(mission.id)) {
					return {
						content: [{ type: "text", text: "Cannot complete a mission while delegated runs are active." }],
						details: { action: "complete", mission } satisfies MissionDetails,
						isError: true,
					};
				}
				const completed = completeMission(mission);
				updateMissionStatus(ctx);
				return {
					content: [{ type: "text", text: `Completed ${completed.id}` }],
					details: { action: "complete", mission: completed } satisfies MissionDetails,
				};
			}
			if (params.action === "block") {
				if (hasRunningMissionRuns(mission.id)) {
					return {
						content: [{ type: "text", text: "Cannot block a mission while delegated runs are active." }],
						details: { action: "block", mission } satisfies MissionDetails,
						isError: true,
					};
				}
				const blocked = blockMission(mission);
				updateMissionStatus(ctx);
				return {
					content: [{ type: "text", text: `Blocked ${blocked.id}` }],
					details: { action: "block", mission: blocked } satisfies MissionDetails,
				};
			}
			if (!params.tasks?.length)
				return {
					content: [{ type: "text", text: "tasks are required for mission run" }],
					details: {},
					isError: true,
				};
			if (mission.status !== "active")
				return {
					content: [
						{
							type: "text",
							text: `Cannot run delegated tasks for a ${mission.status} mission. Activate it first.`,
						},
					],
					details: { action: "run", mission } satisfies MissionDetails,
					isError: true,
				};
			if (params.tasks.length > MAX_PARALLEL_TASKS)
				return {
					content: [{ type: "text", text: `Maximum task count is ${MAX_PARALLEL_TASKS}.` }],
					details: {},
					isError: true,
				};
			const tracking = beginMissionTracking(mission, params.tasks, ctx);
			const results = await runTasks(
				tracking.tasks,
				mission.cwd,
				signal,
				onUpdate
					? (partial) => {
							onUpdate({
								content: partial.content,
								details: {
									action: "run",
									mission: tracking.mission,
									results: partial.details?.results,
								} satisfies MissionDetails,
							});
						}
					: undefined,
				(result, activity) => updateMissionTracking(tracking, result, ctx, activity),
			);
			completeMissionTracking(tracking, results, ctx);
			return {
				content: [{ type: "text", text: formatWorkerResults(results) }],
				details: { action: "run", mission: tracking.mission, results } satisfies MissionDetails,
				isError: results.some((result) => result.status === "failed"),
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("mission"))} ${theme.fg("accent", args.action)}${args.missionId ? ` ${theme.fg("muted", args.missionId)}` : ""}${args.runId ? ` ${theme.fg("dim", args.runId)}` : ""}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as MissionDetails | undefined;
			if (details?.results) return renderResults(details.results, theme, expanded);
			return new Text(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"), 0, 0);
		},
	});

	pi.registerCommand("missions", {
		description: "Open mission dashboard or console, create missions, and configure per-role models",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/missions requires interactive mode", "error");
				return;
			}
			const mission = getActiveMission();
			if (args.trim() === "create") {
				const created = await createMissionFromUI(ctx, pi);
				if (created) await showMissionConsole(ctx, created.id);
				return;
			}
			if (args.trim() === "models") {
				if (!mission) {
					ctx.ui.notify("No active mission. Ask the agent to create one first.", "warning");
					return;
				}
				await configureMissionModels(mission, ctx, pi);
				return;
			}
			if (args.trim() === "console") {
				if (!mission) {
					ctx.ui.notify("No active mission. Ask the agent to create one first.", "warning");
					return;
				}
				await showMissionConsole(ctx, mission.id);
				return;
			}
			await showMissionDashboard(ctx, pi);
		},
	});

	pi.on("before_agent_start", () => {
		const mission = getActiveMission();
		if (!mission) return;
		appendParentOrchestratorActivity({
			timestamp: new Date().toISOString(),
			kind: "status",
			text: "Parent orchestrator turn started.",
		});
		return {
			message: {
				customType: "mission-context",
				content: [
					`Active mission: ${mission.objective}`,
					`Mission id: ${mission.id}`,
					`Model profile: orchestrator=${mission.models.orchestrator ?? "current"}, worker=${mission.models.worker ?? "inherited"}, reviewer=${mission.models.reviewer ?? "inherited"}`,
					"Use mission or subagent tools for bounded delegation. Use mission history and mission inspect after a resume, then review worker handoffs before completing the mission.",
				].join("\n"),
				display: false,
				details: mission,
			},
		};
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const firstText = event.message.content.find((part) => part.type === "text" && part.text.trim());
		if (!firstText || firstText.type !== "text") return;
		const firstLine = firstText.text.trim().split("\n")[0];
		appendParentOrchestratorActivity({
			timestamp: new Date().toISOString(),
			kind: "assistant",
			text: firstLine.length > 240 ? `${firstLine.slice(0, 237)}...` : firstLine,
		});
	});
	pi.on("tool_execution_start", (event) => {
		appendParentOrchestratorActivity({
			timestamp: new Date().toISOString(),
			kind: "tool",
			text: `Calling ${event.toolName}.`,
		});
	});
	pi.on("tool_execution_end", (event) => {
		appendParentOrchestratorActivity({
			timestamp: new Date().toISOString(),
			kind: event.isError ? "error" : "result",
			text: `${event.isError ? "Failed" : "Completed"} ${event.toolName}.`,
		});
	});
	pi.on("agent_end", (_event, ctx) => {
		if (process.env.AZYCODE_INTERNAL_SUBAGENT_ROLE) return;
		appendParentOrchestratorActivity({
			timestamp: new Date().toISOString(),
			kind: "status",
			text: "Parent orchestrator turn completed.",
		});
		updateMissionStatus(ctx);
	});
	pi.on("session_start", (_event, ctx) => {
		const recovered = listMissions().flatMap((mission) => recoverStaleMissionRuns(mission.id));
		updateMissionStatus(ctx);
		if (recovered.length) {
			ctx.ui.notify(
				`Recovered ${recovered.length} interrupted mission run${recovered.length === 1 ? "" : "s"}.`,
				"warning",
			);
		}
	});
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("mission", undefined);
		ctx.ui.setWidget("mission", undefined);
	});
}
