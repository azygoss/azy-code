import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMissionDir, type MissionState, readMission } from "./store.ts";

export type MissionRunStatus = "running" | "complete" | "failed";
export type MissionAgentStatus = "active" | "blocked" | "queued" | "running" | "complete" | "failed" | "skipped";
export type MissionAgentRole = "orchestrator" | "worker" | "reviewer";
export type MissionActivityKind = "status" | "assistant" | "tool" | "result" | "error";

export interface MissionAgentActivity {
	timestamp: string;
	kind: MissionActivityKind;
	text: string;
}

export interface MissionRunAgent {
	id: string;
	role: MissionAgentRole;
	label: string;
	model?: string;
	task: string;
	status: MissionAgentStatus;
	output: string;
	stderr: string;
	exitCode: number | null;
	startedAt?: string;
	updatedAt: string;
	completedAt?: string;
	handoffPath?: string;
	activity: MissionAgentActivity[];
}

export interface MissionRunState {
	id: string;
	missionId: string;
	status: MissionRunStatus;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	agents: MissionRunAgent[];
}

export interface MissionRunTask {
	id: string;
	role: MissionAgentRole;
	model?: string;
	task: string;
}

const MAX_AGENT_ACTIVITY = 80;
const DEFAULT_STALE_RUN_IDLE_MS = 5 * 60 * 1000;

function now(): string {
	return new Date().toISOString();
}

function isMissionId(id: string): boolean {
	return /^mis_[a-zA-Z0-9_-]+$/.test(id);
}

function isMissionAgentId(id: string): boolean {
	return id.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isMissionAgentActivity(value: unknown): value is MissionAgentActivity {
	if (!isRecord(value)) return false;
	return (
		typeof value.timestamp === "string" &&
		(value.kind === "status" ||
			value.kind === "assistant" ||
			value.kind === "tool" ||
			value.kind === "result" ||
			value.kind === "error") &&
		typeof value.text === "string"
	);
}

function isMissionRunAgent(value: unknown): value is MissionRunAgent {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		(value.role === "orchestrator" || value.role === "worker" || value.role === "reviewer") &&
		typeof value.label === "string" &&
		(value.model === undefined || typeof value.model === "string") &&
		typeof value.task === "string" &&
		(value.status === "active" ||
			value.status === "blocked" ||
			value.status === "queued" ||
			value.status === "running" ||
			value.status === "complete" ||
			value.status === "failed" ||
			value.status === "skipped") &&
		typeof value.output === "string" &&
		typeof value.stderr === "string" &&
		(value.exitCode === null || typeof value.exitCode === "number") &&
		(value.startedAt === undefined || typeof value.startedAt === "string") &&
		typeof value.updatedAt === "string" &&
		(value.completedAt === undefined || typeof value.completedAt === "string") &&
		(value.handoffPath === undefined || typeof value.handoffPath === "string") &&
		Array.isArray(value.activity) &&
		value.activity.every(isMissionAgentActivity)
	);
}

function isMissionRunState(value: unknown): value is MissionRunState {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		/^run_[a-zA-Z0-9_-]+$/.test(value.id) &&
		typeof value.missionId === "string" &&
		isMissionId(value.missionId) &&
		(value.status === "running" || value.status === "complete" || value.status === "failed") &&
		typeof value.startedAt === "string" &&
		typeof value.updatedAt === "string" &&
		(value.completedAt === undefined || typeof value.completedAt === "string") &&
		Array.isArray(value.agents) &&
		value.agents.every(isMissionRunAgent) &&
		value.agents.some((agent) => agent.id === "orchestrator")
	);
}

function getMissionRunsDir(missionId: string): string {
	if (!isMissionId(missionId)) throw new Error(`Invalid mission id: ${missionId}`);
	return join(getMissionDir(missionId), "runs");
}

export function getMissionRunDir(missionId: string, runId: string): string {
	if (!/^run_[a-zA-Z0-9_-]+$/.test(runId)) throw new Error(`Invalid mission run id: ${runId}`);
	return join(getMissionRunsDir(missionId), runId);
}

function writeMissionRun(run: MissionRunState): void {
	const dir = getMissionRunDir(run.missionId, run.id);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "state.json");
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(run, null, 2)}\n`);
	renameSync(temporaryPath, path);
}

function writeMissionOrchestrator(missionId: string, orchestrator: MissionRunAgent): void {
	const path = join(getMissionDir(missionId), "orchestrator.json");
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(orchestrator, null, 2)}\n`);
	renameSync(temporaryPath, path);
}

export function createOrchestratorAgent(mission: MissionState): MissionRunAgent {
	const timestamp = mission.updatedAt;
	return {
		id: "orchestrator",
		role: "orchestrator",
		label: "Orchestrator",
		model: mission.models.orchestrator,
		task: mission.objective,
		status: mission.status,
		output:
			"The parent Azy Code session owns orchestration. Delegated agents appear as switchable tabs when worker runs start.",
		stderr: "",
		exitCode: null,
		startedAt: mission.createdAt,
		updatedAt: timestamp,
		activity: [
			{
				timestamp,
				kind: "status",
				text: mission.status === "active" ? "Mission orchestration is active." : `Mission is ${mission.status}.`,
			},
		],
	};
}

export function readMissionOrchestrator(mission: MissionState): MissionRunAgent {
	const path = join(getMissionDir(mission.id), "orchestrator.json");
	if (!existsSync(path)) return createOrchestratorAgent(mission);
	try {
		const orchestrator: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isMissionRunAgent(orchestrator) || orchestrator.id !== "orchestrator") {
			return createOrchestratorAgent(mission);
		}
		return {
			...orchestrator,
			model: mission.models.orchestrator,
			task: mission.objective,
			status: mission.status,
		};
	} catch {
		return createOrchestratorAgent(mission);
	}
}

export function appendMissionOrchestratorActivity(
	mission: MissionState,
	activity: MissionAgentActivity,
	output = activity.text,
): MissionRunAgent {
	const orchestrator = readMissionOrchestrator(mission);
	orchestrator.output = output;
	orchestrator.updatedAt = activity.timestamp;
	orchestrator.activity = [...orchestrator.activity, activity].slice(-MAX_AGENT_ACTIVITY);
	writeMissionOrchestrator(mission.id, orchestrator);
	return orchestrator;
}

export function createMissionRun(mission: MissionState, tasks: MissionRunTask[]): MissionRunState {
	if (mission.status !== "active")
		throw new Error(`Cannot delegate work for ${mission.status} mission: ${mission.id}`);
	if (tasks.length === 0) throw new Error("Mission runs require at least one delegated agent");
	const taskIds = new Set<string>();
	for (const task of tasks) {
		if (!isMissionAgentId(task.id) || task.id === "orchestrator") {
			throw new Error(`Invalid mission agent id: ${task.id}`);
		}
		if (taskIds.has(task.id)) throw new Error(`Duplicate mission agent id: ${task.id}`);
		taskIds.add(task.id);
	}
	const timestamp = now();
	const delegationActivity: MissionAgentActivity = {
		timestamp,
		kind: "status",
		text: `Delegated ${tasks.length} agent${tasks.length === 1 ? "" : "s"}.`,
	};
	const orchestrator = appendMissionOrchestratorActivity(
		mission,
		delegationActivity,
		`${delegationActivity.text} Monitor worker tabs for live progress and review handoffs before completing the mission.`,
	);
	const run: MissionRunState = {
		id: `run_${timestamp.replaceAll(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`,
		missionId: mission.id,
		status: "running",
		startedAt: timestamp,
		updatedAt: timestamp,
		agents: [
			orchestrator,
			...tasks.map((task, index) => ({
				id: task.id,
				role: task.role,
				label: `${task.role === "worker" ? "Worker" : task.role === "reviewer" ? "Reviewer" : "Sub-orchestrator"} ${index + 1}`,
				model: task.model,
				task: task.task,
				status: "queued" as const,
				output: "",
				stderr: "",
				exitCode: null,
				updatedAt: timestamp,
				activity: [
					{
						timestamp,
						kind: "status" as const,
						text: "Queued for delegation.",
					},
				],
			})),
		],
	};
	writeMissionRun(run);
	appendMissionRunEvent(mission.id, run.id, orchestrator.id, delegationActivity);
	for (const agent of run.agents.slice(1)) {
		const queuedActivity = agent.activity[0];
		if (queuedActivity) appendMissionRunEvent(mission.id, run.id, agent.id, queuedActivity);
	}
	return run;
}

export function readMissionRun(missionId: string, runId: string): MissionRunState | undefined {
	if (!isMissionId(missionId)) return undefined;
	if (!/^run_[a-zA-Z0-9_-]+$/.test(runId)) return undefined;
	const path = join(getMissionRunDir(missionId, runId), "state.json");
	if (!existsSync(path)) return undefined;
	try {
		const run: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isMissionRunState(run) && run.missionId === missionId && run.id === runId ? run : undefined;
	} catch {
		return undefined;
	}
}

export function listMissionRuns(missionId: string): MissionRunState[] {
	if (!isMissionId(missionId)) return [];
	const dir = getMissionRunsDir(missionId);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => readMissionRun(missionId, entry.name))
		.filter((run): run is MissionRunState => run !== undefined)
		.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id));
}

export function getLatestMissionRun(missionId: string): MissionRunState | undefined {
	if (!isMissionId(missionId)) return undefined;
	const dir = getMissionRunsDir(missionId);
	if (!existsSync(dir)) return undefined;
	for (const entry of readdirSync(dir, { withFileTypes: true })
		.filter((item) => item.isDirectory())
		.sort((left, right) => right.name.localeCompare(left.name))) {
		const run = readMissionRun(missionId, entry.name);
		if (run) return run;
	}
	return undefined;
}

export function hasRunningMissionRuns(missionId: string): boolean {
	return listMissionRuns(missionId).some((run) => run.status === "running");
}

export function appendMissionRunEvent(
	missionId: string,
	runId: string,
	agentId: string,
	event: MissionAgentActivity,
): void {
	const dir = getMissionRunDir(missionId, runId);
	mkdirSync(dir, { recursive: true });
	appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ agentId, ...event })}\n`);
}

export function updateMissionRunAgent(
	missionId: string,
	runId: string,
	agentId: string,
	updates: Partial<Omit<MissionRunAgent, "id" | "activity">> & { activity?: MissionAgentActivity },
): MissionRunState | undefined {
	const run = readMissionRun(missionId, runId);
	if (!run) return undefined;
	if (!run.agents.some((agent) => agent.id === agentId)) return undefined;
	const timestamp = now();
	run.updatedAt = timestamp;
	run.agents = run.agents.map((agent) => {
		if (agent.id !== agentId) return agent;
		const activity = updates.activity
			? [...agent.activity, updates.activity].slice(-MAX_AGENT_ACTIVITY)
			: agent.activity;
		return { ...agent, ...updates, activity, updatedAt: timestamp };
	});
	writeMissionRun(run);
	if (updates.activity) appendMissionRunEvent(missionId, runId, agentId, updates.activity);
	return run;
}

export function completeMissionRun(missionId: string, runId: string): MissionRunState | undefined {
	const run = readMissionRun(missionId, runId);
	if (!run) return undefined;
	if (run.status !== "running") return run;
	const timestamp = now();
	const workers = run.agents.filter((agent) => agent.id !== "orchestrator");
	if (workers.some((agent) => agent.status === "running")) return run;
	const skippedActivity: MissionAgentActivity = {
		timestamp,
		kind: "status",
		text: "Skipped because the delegated run ended before execution.",
	};
	for (const worker of workers) {
		if (worker.status !== "queued") continue;
		worker.status = "skipped";
		worker.updatedAt = timestamp;
		worker.completedAt = timestamp;
		worker.activity = [...worker.activity, skippedActivity].slice(-MAX_AGENT_ACTIVITY);
		appendMissionRunEvent(missionId, runId, worker.id, skippedActivity);
	}
	run.status = workers.some((agent) => agent.status === "failed" || agent.status === "skipped")
		? "failed"
		: "complete";
	run.updatedAt = timestamp;
	run.completedAt = timestamp;
	const orchestrator = run.agents.find((agent) => agent.id === "orchestrator");
	const activity: MissionAgentActivity = {
		timestamp,
		kind: run.status === "complete" ? "status" : "error",
		text: `Delegated run ${run.status}. Review ${workers.length} worker handoff${workers.length === 1 ? "" : "s"}.`,
	};
	if (orchestrator) {
		orchestrator.output = activity.text;
		orchestrator.updatedAt = timestamp;
		orchestrator.activity = [...orchestrator.activity, activity].slice(-MAX_AGENT_ACTIVITY);
	}
	const mission = readMission(missionId);
	if (mission) appendMissionOrchestratorActivity(mission, activity);
	writeMissionRun(run);
	appendMissionRunEvent(missionId, run.id, "orchestrator", activity);
	return run;
}

export function recoverStaleMissionRuns(
	missionId: string,
	currentTime = Date.now(),
	maxIdleMs = DEFAULT_STALE_RUN_IDLE_MS,
): MissionRunState[] {
	const recovered: MissionRunState[] = [];
	for (const run of listMissionRuns(missionId)) {
		if (run.status !== "running") continue;
		const updatedTime = Date.parse(run.updatedAt);
		if (Number.isFinite(updatedTime) && Math.abs(currentTime - updatedTime) < maxIdleMs) continue;
		const timestamp = new Date(currentTime).toISOString();
		for (const agent of run.agents) {
			if (agent.status !== "queued" && agent.status !== "running") continue;
			updateMissionRunAgent(missionId, run.id, agent.id, {
				status: "failed",
				completedAt: timestamp,
				activity: {
					timestamp,
					kind: "error",
					text: "Recovered stale worker state after an interrupted Azy Code session.",
				},
			});
		}
		const completed = completeMissionRun(missionId, run.id);
		if (completed) recovered.push(completed);
	}
	return recovered;
}
