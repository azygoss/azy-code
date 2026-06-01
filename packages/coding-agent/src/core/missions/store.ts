import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";

export type MissionStatus = "active" | "complete" | "blocked";

export interface MissionModels {
	orchestrator?: string;
	worker?: string;
	reviewer?: string;
}

export interface MissionState {
	id: string;
	objective: string;
	status: MissionStatus;
	cwd: string;
	models: MissionModels;
	createdAt: string;
	updatedAt: string;
	runs: number;
}

function now(): string {
	return new Date().toISOString();
}

export function getMissionsDir(): string {
	return process.env.AZYCODE_MISSIONS_DIR || join(getAgentDir(), "missions");
}

function isMissionId(id: string): boolean {
	return /^mis_[a-zA-Z0-9_-]+$/.test(id);
}

export function getMissionDir(id: string): string {
	if (!isMissionId(id)) throw new Error(`Invalid mission id: ${id}`);
	return join(getMissionsDir(), id);
}

function getActiveMissionPath(): string {
	return join(getMissionsDir(), "active-mission.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isMissionState(value: unknown): value is MissionState {
	if (!isRecord(value) || !isRecord(value.models)) return false;
	return (
		typeof value.id === "string" &&
		isMissionId(value.id) &&
		typeof value.objective === "string" &&
		(value.status === "active" || value.status === "complete" || value.status === "blocked") &&
		typeof value.cwd === "string" &&
		(value.models.orchestrator === undefined || typeof value.models.orchestrator === "string") &&
		(value.models.worker === undefined || typeof value.models.worker === "string") &&
		(value.models.reviewer === undefined || typeof value.models.reviewer === "string") &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		typeof value.runs === "number"
	);
}

function writeText(path: string, text: string): void {
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, text, "utf8");
	renameSync(temporaryPath, path);
}

function writeJson(path: string, value: unknown): void {
	writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeMission(state: MissionState): void {
	const dir = getMissionDir(state.id);
	mkdirSync(join(dir, "handoffs"), { recursive: true });
	writeJson(join(dir, "state.json"), state);
	writeText(
		join(dir, "mission.md"),
		[
			`# ${state.objective}`,
			"",
			`Status: ${state.status}`,
			`Runs: ${state.runs}`,
			`Working directory: ${state.cwd}`,
			"",
			"## Models",
			"",
			`- Orchestrator: ${state.models.orchestrator ?? "current session"}`,
			`- Worker: ${state.models.worker ?? "orchestrator"}`,
			`- Reviewer: ${state.models.reviewer ?? "orchestrator"}`,
			"",
		].join("\n"),
	);
}

function writeActiveMissionId(id: string): void {
	mkdirSync(getMissionsDir(), { recursive: true });
	writeJson(getActiveMissionPath(), { id });
}

export function createMission(objective: string, cwd: string, models: MissionModels = {}): MissionState {
	const timestamp = now();
	const state: MissionState = {
		id: `mis_${randomUUID().slice(0, 8)}`,
		objective,
		status: "active",
		cwd,
		models,
		createdAt: timestamp,
		updatedAt: timestamp,
		runs: 0,
	};
	writeMission(state);
	writeActiveMissionId(state.id);
	return state;
}

export function readMission(id: string): MissionState | undefined {
	if (!isMissionId(id)) return undefined;
	const path = join(getMissionDir(id), "state.json");
	if (!existsSync(path)) return undefined;
	try {
		const state: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isMissionState(state) && state.id === id ? state : undefined;
	} catch {
		return undefined;
	}
}

export function listMissions(): MissionState[] {
	const dir = getMissionsDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => readMission(entry.name))
		.filter((mission): mission is MissionState => mission !== undefined)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getActiveMission(): MissionState | undefined {
	try {
		const pointer = JSON.parse(readFileSync(getActiveMissionPath(), "utf8")) as { id?: string };
		const mission = pointer.id ? readMission(pointer.id) : undefined;
		if (mission?.status === "active") return mission;
	} catch {
		// Fall back to the newest active mission for pre-pointer mission stores.
	}
	return listMissions().find((mission) => mission.status === "active");
}

export function activateMission(state: MissionState): MissionState {
	const activated = updateMission(state, { status: "active" });
	writeActiveMissionId(activated.id);
	return activated;
}

export function updateMission(
	state: MissionState,
	updates: Partial<Pick<MissionState, "objective" | "status" | "models" | "runs">>,
): MissionState {
	const updated = { ...state, ...updates, updatedAt: now() };
	writeMission(updated);
	return updated;
}

export function incrementMissionRuns(state: MissionState): MissionState {
	const current = readMission(state.id) ?? state;
	return updateMission(current, { runs: current.runs + 1 });
}

export function resolveMission(id: string | undefined): MissionState | undefined {
	return id ? readMission(id) : getActiveMission();
}

export function completeMission(state: MissionState): MissionState {
	const wasActive = getActiveMission()?.id === state.id;
	const completed = updateMission(state, { status: "complete" });
	if (wasActive) {
		rmSync(getActiveMissionPath(), { force: true });
	}
	return completed;
}

export function blockMission(state: MissionState): MissionState {
	const wasActive = getActiveMission()?.id === state.id;
	const blocked = updateMission(state, { status: "blocked" });
	if (wasActive) {
		rmSync(getActiveMissionPath(), { force: true });
	}
	return blocked;
}
