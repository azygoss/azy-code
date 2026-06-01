# Missions and Subagents

Azy Code includes built-in orchestration tools for delegating isolated work and keeping long-running objectives on disk.

## Subagents

The `subagent` tool starts isolated `azycode` processes. It supports:

- One bounded task.
- Parallel tasks with a maximum concurrency of four.
- Sequential chains where later tasks can reference `{previous}`.
- Per-task `orchestrator`, `worker`, or `reviewer` roles.
- Optional per-task model and tool allowlist overrides.

When a mission is active, standalone `subagent` calls are automatically attached to that mission's run history, live console, transcripts, and handoffs.

## Missions

The `mission` tool adds persistent orchestration state. A mission stores its objective, status, working directory, model profile, run count, worker transcripts, JSON handoffs, run snapshots, and event logs under `~/.azycode/agent/missions/`.

Use the `history` action to list persisted run ids after a resume. It returns the newest 20 runs by default and accepts `limit` up to 100. Use `inspect` to load the latest persisted run, or pass `runId` to inspect a specific historical run.

The model profile has separate slots for:

- `orchestrator`: the parent session model.
- `worker`: the default implementation subagent model.
- `reviewer`: the default review subagent model.

Run `/missions` to open the interactive mission dashboard. The dashboard creates missions, activates existing missions, completes missions, configures each role model independently, and opens the mission console. Run `/missions create` to open the creation wizard directly, `/missions models` to edit the active mission profile, or `/missions console` to open the active mission console. The active mission is shown above the editor with a compact status footer.

## Mission Console

The mission console opens on the parent orchestrator. It persists parent turn lifecycle, assistant summaries, tool start/end events, and delegation activity, then shows the run role distribution, relative update age, selected agent model, task, status, event count, newest-first activity feed, latest output, and persisted handoff path. When delegated agents start, each worker or reviewer appears as a switchable tab.

- Press `tab` to cycle between the orchestrator and delegated agents, or press `1` through `9` to jump directly to an agent.
- Press `up` or `down` to scroll the selected agent activity and output.
- Press `page up` or `page down` to inspect older or newer runs.
- Press `escape` to close the console.

Each run is stored under `~/.azycode/agent/missions/<mission-id>/runs/<run-id>/`. `state.json` keeps the latest agent snapshots and `events.jsonl` keeps live activity events. On startup, Azy Code marks worker runs with no updates for five minutes as failed so interrupted sessions do not remain permanently active.

When a chained run stops after an error, later queued agents are recorded as `skipped` instead of remaining queued indefinitely.

When the parent run is interrupted, Azy Code requests worker shutdown with `SIGTERM` and escalates to `SIGKILL` after three seconds if a subprocess does not exit.

Set `AZYCODE_MISSIONS_DIR` to override the mission storage directory for isolated environments or automated tests.

A mission cannot be marked blocked or complete while a delegated run is still active. Use the `block` action or dashboard to pause a mission that is waiting on external input, then use the `activate` action or dashboard when work can continue.

Delegated runs can start only while a mission is `active`.
