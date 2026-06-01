import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendMissionOrchestratorActivity,
	completeMissionRun,
	createMissionRun,
	getLatestMissionRun,
	getMissionRunDir,
	hasRunningMissionRuns,
	listMissionRuns,
	readMissionOrchestrator,
	readMissionRun,
	recoverStaleMissionRuns,
	updateMissionRunAgent,
} from "../src/core/missions/runs.ts";
import {
	activateMission,
	blockMission,
	completeMission,
	createMission,
	getActiveMission,
	getMissionDir,
	incrementMissionRuns,
	listMissions,
	readMission,
} from "../src/core/missions/store.ts";
import { WorkerOutputCollector } from "../src/core/missions/worker-output.ts";

describe("missions extension", () => {
	let tempDir: string;
	let previousMissionsDir: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "azycode-missions-"));
		previousMissionsDir = process.env.AZYCODE_MISSIONS_DIR;
		process.env.AZYCODE_MISSIONS_DIR = join(tempDir, "missions");
	});

	afterEach(() => {
		if (previousMissionsDir === undefined) {
			delete process.env.AZYCODE_MISSIONS_DIR;
		} else {
			process.env.AZYCODE_MISSIONS_DIR = previousMissionsDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("persists mission state and rejects unsafe ids", () => {
		const mission = createMission("Implement orchestration", tempDir, {
			orchestrator: "openai/gpt-5",
			worker: "anthropic/claude-sonnet",
		});

		expect(readMission(mission.id)).toEqual(mission);
		expect(listMissions()).toEqual([mission]);
		expect(readMission("../outside")).toBeUndefined();
		expect(() => getMissionDir("../outside")).toThrow("Invalid mission id");
		const invalidMissionDir = join(process.env.AZYCODE_MISSIONS_DIR!, "mis_invalid");
		mkdirSync(invalidMissionDir, { recursive: true });
		writeFileSync(join(invalidMissionDir, "state.json"), "{}");
		expect(readMission("mis_invalid")).toBeUndefined();
		const mismatchMissionDir = join(process.env.AZYCODE_MISSIONS_DIR!, "mis_mismatch");
		mkdirSync(mismatchMissionDir, { recursive: true });
		writeFileSync(join(mismatchMissionDir, "state.json"), JSON.stringify(mission));
		expect(readMission("mis_mismatch")).toBeUndefined();
		expect(listMissions().map((item) => item.id)).not.toContain("mis_invalid");
		expect(listMissions().map((item) => item.id)).not.toContain("mis_mismatch");
		expect(existsSync(join(process.env.AZYCODE_MISSIONS_DIR!, mission.id, "handoffs"))).toBe(true);
		const markdown = readFileSync(join(process.env.AZYCODE_MISSIONS_DIR!, mission.id, "mission.md"), "utf8");
		expect(markdown).toContain("# Implement orchestration");
		expect(markdown).toContain("Runs: 0");
		expect(markdown).toContain("- Orchestrator: openai/gpt-5");
	});

	it("tracks the selected active mission and clears completed selections", () => {
		const first = createMission("First mission", tempDir);
		const second = createMission("Second mission", tempDir);

		expect(getActiveMission()?.id).toBe(second.id);
		activateMission(first);
		expect(getActiveMission()?.id).toBe(first.id);

		completeMission(first);
		expect(getActiveMission()?.id).toBe(second.id);

		writeFileSync(join(process.env.AZYCODE_MISSIONS_DIR!, "active-mission.json"), "{");
		expect(getActiveMission()?.id).toBe(second.id);
	});

	it("clears blocked missions from the active selection", () => {
		const first = createMission("First active mission", tempDir);
		const second = createMission("Mission waiting on input", tempDir);

		const blocked = blockMission(second);

		expect(readMission(second.id)?.status).toBe("blocked");
		expect(readMissionOrchestrator(blocked).status).toBe("blocked");
		expect(getActiveMission()?.id).toBe(first.id);
	});

	it("increments run counts from persisted state when callers hold stale snapshots", () => {
		const mission = createMission("Count delegated runs", tempDir);

		incrementMissionRuns(mission);
		incrementMissionRuns(mission);

		expect(readMission(mission.id)?.runs).toBe(2);
		expect(readFileSync(join(getMissionDir(mission.id), "mission.md"), "utf8")).toContain("Runs: 2");
	});

	it("persists orchestrator-first worker runs with live activity", () => {
		const mission = createMission("Implement a live mission console", tempDir, {
			orchestrator: "openai/gpt-5",
			worker: "anthropic/claude-sonnet",
		});
		const run = createMissionRun(mission, [
			{
				id: "worker-1",
				role: "worker",
				model: mission.models.worker,
				task: "Implement run persistence",
			},
		]);

		expect(run.agents.map((agent) => agent.role)).toEqual(["orchestrator", "worker"]);
		expect(run.agents[0].status).toBe("active");
		expect(run.agents[0].output).toContain("Delegated 1 agent.");
		expect(run.agents[1].status).toBe("queued");
		expect(hasRunningMissionRuns(mission.id)).toBe(true);
		expect(readMissionRun(mission.id, "../outside")).toBeUndefined();
		expect(readMissionRun("../outside", run.id)).toBeUndefined();
		expect(listMissionRuns("../outside")).toEqual([]);
		expect(() => getMissionRunDir(mission.id, "../outside")).toThrow("Invalid mission run id");
		const corruptDir = join(process.env.AZYCODE_MISSIONS_DIR!, mission.id, "runs", "run_corrupt");
		mkdirSync(corruptDir, { recursive: true });
		writeFileSync(join(corruptDir, "state.json"), "{");
		expect(readMissionRun(mission.id, "run_corrupt")).toBeUndefined();
		const incompleteDir = join(process.env.AZYCODE_MISSIONS_DIR!, mission.id, "runs", "run_incomplete");
		mkdirSync(incompleteDir, { recursive: true });
		writeFileSync(join(incompleteDir, "state.json"), "{}");
		expect(readMissionRun(mission.id, "run_incomplete")).toBeUndefined();
		expect(listMissionRuns(mission.id).map((item) => item.id)).not.toContain("run_corrupt");
		expect(listMissionRuns(mission.id).map((item) => item.id)).not.toContain("run_incomplete");

		updateMissionRunAgent(mission.id, run.id, "worker-1", {
			status: "complete",
			output: "Implemented persistence.",
			exitCode: 0,
			completedAt: "2026-06-01T10:30:00.000Z",
			handoffPath: "/tmp/handoff.json",
			activity: {
				timestamp: "2026-06-01T10:30:00.000Z",
				kind: "status",
				text: "Worker completed.",
			},
		});
		const completed = completeMissionRun(mission.id, run.id);

		expect(completed?.status).toBe("complete");
		expect(hasRunningMissionRuns(mission.id)).toBe(false);
		expect(completed?.agents[0].output).toContain("Delegated run complete.");
		expect(readMissionRun(mission.id, run.id)?.agents[1].output).toBe("Implemented persistence.");
		expect(readMissionRun(mission.id, run.id)?.agents[1].handoffPath).toBe("/tmp/handoff.json");
		expect(getLatestMissionRun(mission.id)?.id).toBe(run.id);
		expect(
			readFileSync(join(process.env.AZYCODE_MISSIONS_DIR!, mission.id, "runs", run.id, "events.jsonl"), "utf8"),
		).toContain("Queued for delegation.");
		expect(
			readFileSync(join(process.env.AZYCODE_MISSIONS_DIR!, mission.id, "runs", run.id, "events.jsonl"), "utf8"),
		).toContain("Worker completed.");
	});

	it("rejects unsafe delegation and ignores unknown run agents", () => {
		const mission = createMission("Keep delegation state bounded", tempDir);

		expect(() => createMissionRun(mission, [])).toThrow("at least one delegated agent");
		expect(() => createMissionRun(mission, [{ id: "../outside", role: "worker", task: "Escape storage" }])).toThrow(
			"Invalid mission agent id",
		);
		expect(() => createMissionRun(mission, [{ id: "w".repeat(129), role: "worker", task: "Oversized id" }])).toThrow(
			"Invalid mission agent id",
		);
		expect(() =>
			createMissionRun(mission, [
				{ id: "worker-1", role: "worker", task: "First task" },
				{ id: "worker-1", role: "reviewer", task: "Duplicate task" },
			]),
		).toThrow("Duplicate mission agent id");
		const run = createMissionRun(mission, [{ id: "worker-1", role: "worker", task: "Valid task" }]);

		expect(updateMissionRunAgent(mission.id, run.id, "missing-worker", { status: "complete" })).toBeUndefined();
		expect(readMissionRun(mission.id, run.id)?.agents).toHaveLength(2);

		const blocked = blockMission(mission);
		expect(() => createMissionRun(blocked, [{ id: "worker-2", role: "worker", task: "Blocked task" }])).toThrow(
			"Cannot delegate work for blocked mission",
		);
	});

	it("persists mission-level orchestrator activity across runs", () => {
		const mission = createMission("Track parent orchestration", tempDir, {
			orchestrator: "openai/gpt-5",
		});
		appendMissionOrchestratorActivity(mission, {
			timestamp: "2026-06-01T10:00:00.000Z",
			kind: "status",
			text: "Parent orchestrator turn started.",
		});

		const run = createMissionRun(mission, [{ id: "worker-1", role: "worker", task: "Implement a task" }]);

		expect(readMissionOrchestrator(mission).activity.map((item) => item.text)).toContain(
			"Parent orchestrator turn started.",
		);
		expect(run.agents[0].activity.map((item) => item.text)).toContain("Parent orchestrator turn started.");

		writeFileSync(join(getMissionDir(mission.id), "orchestrator.json"), "{}");
		expect(readMissionOrchestrator(mission).activity.map((item) => item.text)).toEqual([
			"Mission orchestration is active.",
		]);
	});

	it("recovers stale interrupted worker runs without touching fresh runs", () => {
		const mission = createMission("Recover interrupted work", tempDir);
		const staleRun = createMissionRun(mission, [{ id: "stale-worker", role: "worker", task: "Old work" }]);
		const freshRun = createMissionRun(mission, [{ id: "fresh-worker", role: "worker", task: "Current work" }]);
		const invalidTimestampRun = createMissionRun(mission, [
			{ id: "invalid-timestamp-worker", role: "worker", task: "Corrupted timestamp work" },
		]);
		const futureTimestampRun = createMissionRun(mission, [
			{ id: "future-timestamp-worker", role: "worker", task: "Future timestamp work" },
		]);
		const nearFutureTimestampRun = createMissionRun(mission, [
			{ id: "near-future-worker", role: "worker", task: "Clock skew work" },
		]);
		const stalePath = join(process.env.AZYCODE_MISSIONS_DIR!, mission.id, "runs", staleRun.id, "state.json");
		const invalidTimestampPath = join(
			process.env.AZYCODE_MISSIONS_DIR!,
			mission.id,
			"runs",
			invalidTimestampRun.id,
			"state.json",
		);
		const futureTimestampPath = join(
			process.env.AZYCODE_MISSIONS_DIR!,
			mission.id,
			"runs",
			futureTimestampRun.id,
			"state.json",
		);
		const nearFutureTimestampPath = join(
			process.env.AZYCODE_MISSIONS_DIR!,
			mission.id,
			"runs",
			nearFutureTimestampRun.id,
			"state.json",
		);
		const currentTime = Date.parse(freshRun.updatedAt) + 60 * 1000;
		writeFileSync(
			stalePath,
			`${JSON.stringify({ ...staleRun, updatedAt: new Date(currentTime - 60 * 60 * 1000).toISOString() }, null, 2)}\n`,
		);
		writeFileSync(
			invalidTimestampPath,
			`${JSON.stringify({ ...invalidTimestampRun, updatedAt: "invalid" }, null, 2)}\n`,
		);
		writeFileSync(
			futureTimestampPath,
			`${JSON.stringify({ ...futureTimestampRun, updatedAt: new Date(currentTime + 60 * 60 * 1000).toISOString() }, null, 2)}\n`,
		);
		writeFileSync(
			nearFutureTimestampPath,
			`${JSON.stringify({ ...nearFutureTimestampRun, updatedAt: new Date(currentTime + 60 * 1000).toISOString() }, null, 2)}\n`,
		);

		const recovered = recoverStaleMissionRuns(mission.id, currentTime);

		expect(recovered.map((run) => run.id).sort()).toEqual(
			[futureTimestampRun.id, invalidTimestampRun.id, staleRun.id].sort(),
		);
		expect(readMissionRun(mission.id, staleRun.id)?.status).toBe("failed");
		expect(readMissionRun(mission.id, staleRun.id)?.agents[1].status).toBe("failed");
		expect(readMissionRun(mission.id, invalidTimestampRun.id)?.status).toBe("failed");
		expect(readMissionRun(mission.id, futureTimestampRun.id)?.status).toBe("failed");
		expect(readMissionRun(mission.id, freshRun.id)?.status).toBe("running");
		expect(readMissionRun(mission.id, nearFutureTimestampRun.id)?.status).toBe("running");
	});

	it("counts delegated sub-orchestrators when finalizing a run", () => {
		const mission = createMission("Delegate orchestration", tempDir);
		const run = createMissionRun(mission, [
			{ id: "sub-orchestrator", role: "orchestrator", task: "Coordinate a bounded workstream" },
		]);
		updateMissionRunAgent(mission.id, run.id, "sub-orchestrator", {
			status: "failed",
			exitCode: 1,
		});

		expect(completeMissionRun(mission.id, run.id)?.status).toBe("failed");
	});

	it("marks unexecuted queued agents as skipped when a run ends early", () => {
		const mission = createMission("Stop a failed chain", tempDir);
		const run = createMissionRun(mission, [
			{ id: "worker-1", role: "worker", task: "Fail first" },
			{ id: "worker-2", role: "worker", task: "Should not execute" },
		]);
		updateMissionRunAgent(mission.id, run.id, "worker-1", {
			status: "failed",
			exitCode: 1,
		});

		const completed = completeMissionRun(mission.id, run.id);

		expect(completed?.status).toBe("failed");
		expect(completed?.agents[2].status).toBe("skipped");
		expect(completeMissionRun(mission.id, run.id)).toEqual(completed);
	});

	it("does not finalize a run while a worker is still running", () => {
		const mission = createMission("Wait for active workers", tempDir);
		const run = createMissionRun(mission, [{ id: "worker-1", role: "worker", task: "Keep working" }]);
		updateMissionRunAgent(mission.id, run.id, "worker-1", { status: "running" });

		expect(completeMissionRun(mission.id, run.id)?.status).toBe("running");
		expect(hasRunningMissionRuns(mission.id)).toBe(true);
	});

	it("caps live worker snapshots while preserving the full event log", () => {
		const mission = createMission("Keep long worker activity bounded", tempDir);
		const run = createMissionRun(mission, [{ id: "worker-1", role: "worker", task: "Emit progress" }]);
		for (let index = 0; index < 90; index++) {
			updateMissionRunAgent(mission.id, run.id, "worker-1", {
				activity: {
					timestamp: "2026-06-01T10:30:00.000Z",
					kind: "status",
					text: `event-${index}`,
				},
			});
		}

		const activity = readMissionRun(mission.id, run.id)?.agents[1].activity;
		expect(activity).toHaveLength(80);
		expect(activity?.[0].text).toBe("event-10");
		expect(activity?.at(-1)?.text).toBe("event-89");
		const events = readFileSync(join(getMissionRunDir(mission.id, run.id), "events.jsonl"), "utf8");
		expect(events).toContain("event-0");
		expect(events).toContain("event-89");
	});

	it("keeps raw worker output separate from chunked json events", () => {
		const collector = new WorkerOutputCollector();
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Chunked event completed." }],
		} as AssistantMessage;
		const event = JSON.stringify({ type: "message_end", message });
		const splitAt = Math.floor(event.length / 2);

		expect(collector.push(`plain worker output\n${event.slice(0, splitAt)}`)).toEqual([]);
		expect(collector.push(event.slice(splitAt))).toEqual([]);
		expect(collector.finish()).toEqual([message]);
		expect(collector.getRawOutput()).toBe("plain worker output");
	});
});
