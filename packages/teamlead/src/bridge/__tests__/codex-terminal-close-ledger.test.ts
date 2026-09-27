import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	type CodexTerminalCloseObservation,
	closeAttemptState,
	createCodexTerminalCloseAttemptRecorder,
	observeCodexTerminalClose,
	terminalBodiesForQuotaPage,
	validateCodexTerminalCloseEvidence,
} from "../codex-terminal-close-ledger.js";

describe("FLY-2903 codex_terminal_close ledger", () => {
	let store: StateStore;
	let clock: Date;
	const deps = () => ({
		store: store.codexTerminalClose,
		events: {
			insertEvent: (event: Parameters<StateStore["insertEvent"]>[0]) =>
				store.insertEvent(event),
			transaction: (fn: () => void) => store.runInTransaction(fn),
		},
		now: () => clock,
	});
	const observation = (
		overrides: Partial<CodexTerminalCloseObservation> = {},
	): CodexTerminalCloseObservation => ({
		state: "pending_confirm",
		source: "bridge.codex-terminal-sweep",
		projectName: "flywheel",
		issueIdentifier: "FLY-2903",
		sessionStatus: "completed",
		terminalAt: "2026-09-25 10:00:00",
		evidence: { liveness: "absent", ledger: "valid_group", socketLive: false },
		...overrides,
	});
	const events = (exec: string) =>
		store
			.getEventsByExecution(exec)
			.filter((e) => e.event_type.startsWith("codex_terminal_close_"));

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		clock = new Date("2026-09-25T10:10:00.000Z");
	});
	afterEach(() => {
		store.close();
	});

	it("round-trips a row with token and rollout fields", () => {
		observeCodexTerminalClose(deps(), "exec-1", {
			...observation(),
			tokens: {
				rolloutPath: "/x/sessions/rollout-t.jsonl",
				rolloutOffset: 120,
				tokensAtTerminal: 1000,
				tokensAfterTerminal: 0,
				confirmTokens: 1000,
			},
		});
		const row = store.codexTerminalClose.get("exec-1");
		expect(row).toMatchObject({
			execution_id: "exec-1",
			project_name: "flywheel",
			issue_identifier: "FLY-2903",
			session_status: "completed",
			state: "pending_confirm",
			attempts: 1,
			rollout_path: "/x/sessions/rollout-t.jsonl",
			rollout_offset: 120,
			tokens_at_terminal: 1000,
			tokens_after_terminal: 0,
			confirm_tokens: 1000,
			first_seen_at: "2026-09-25T10:10:00.000Z",
			last_checked_at: "2026-09-25T10:10:00.000Z",
			closed_at: null,
		});
		expect(JSON.parse(row?.last_evidence ?? "{}")).toEqual({
			source: "bridge.codex-terminal-sweep",
			liveness: "absent",
			ledger: "valid_group",
			socketLive: false,
		});
	});

	it("the CHECK constraint rejects an unknown state", () => {
		expect(() =>
			observeCodexTerminalClose(deps(), "exec-bad", {
				...observation(),
				state: "zombie" as never,
			}),
		).toThrow();
		expect(store.codexTerminalClose.get("exec-bad")).toBeUndefined();
		const valid = observeCodexTerminalClose(deps(), "exec-ok", observation());
		expect(() =>
			store.codexTerminalClose.upsert({
				...valid.row,
				execution_id: "exec-bad",
				state: "zombie" as never,
			}),
		).toThrow(/CHECK/);
	});

	it("rejects unknown evidence fields, bad enum values and oversize evidence before writing", () => {
		expect(() =>
			validateCodexTerminalCloseEvidence({ argv: "codex app-server" } as never),
		).toThrow();
		expect(() =>
			validateCodexTerminalCloseEvidence({ liveness: "maybe" } as never),
		).toThrow();
		expect(() =>
			validateCodexTerminalCloseEvidence({ error: "/Users/x/secret path" }),
		).toThrow();
		expect(() =>
			validateCodexTerminalCloseEvidence({ source: "a".repeat(3000) }),
		).toThrow();
		expect(() =>
			observeCodexTerminalClose(deps(), "exec-ev", {
				...observation(),
				evidence: { path: "/tmp/x" } as never,
			}),
		).toThrow();
		expect(store.codexTerminalClose.get("exec-ev")).toBeUndefined();
		expect(
			validateCodexTerminalCloseEvidence({
				procs: { status: "ok", count: 0 },
				ownership: "none",
				ownerStop: "stopped",
				reap: "reaped",
				rollout: "rewound",
			}),
		).toMatchObject({ ownership: "none" });
	});

	it("writes one event per state change and none on a same-state replay", () => {
		observeCodexTerminalClose(deps(), "exec-2", observation());
		clock = new Date("2026-09-25T10:15:00.000Z");
		observeCodexTerminalClose(deps(), "exec-2", observation());
		expect(events("exec-2").map((e) => e.event_type)).toEqual([
			"codex_terminal_close_pending_confirm",
		]);
		expect(store.codexTerminalClose.get("exec-2")?.last_checked_at).toBe(
			"2026-09-25T10:15:00.000Z",
		);
		clock = new Date("2026-09-25T10:20:00.000Z");
		observeCodexTerminalClose(deps(), "exec-2", {
			...observation({ state: "closed" }),
			closedAt: clock.toISOString(),
		});
		const written = events("exec-2");
		expect(written.map((e) => e.event_type)).toEqual([
			"codex_terminal_close_pending_confirm",
			"codex_terminal_close_closed",
		]);
		expect(written[1]?.event_id).toBe("codex-terminal-close:exec-2:closed:2");
		expect(written[1]?.source).toBe("bridge.codex-terminal-sweep");
		expect(store.codexTerminalClose.get("exec-2")).toMatchObject({
			state: "closed",
			attempts: 2,
			closed_at: "2026-09-25T10:20:00.000Z",
		});
	});

	it("a replayed transition with the same deterministic event id is not duplicated", () => {
		observeCodexTerminalClose(deps(), "exec-3", observation());
		// Simulate a crash between the event and a later row write by restoring
		// the old state: the deterministic event id deduplicates the replay.
		store.codexTerminalClose.upsert({
			...store.codexTerminalClose.get("exec-3")!,
			state: "close_attempted",
			attempts: 0,
		});
		observeCodexTerminalClose(deps(), "exec-3", observation());
		expect(events("exec-3")).toHaveLength(1);
	});

	it("keeps streaks, alert keys and untouched token fields across observations", () => {
		observeCodexTerminalClose(deps(), "exec-4", {
			...observation({ state: "owned_seen" }),
			ownedStreak: 1,
			tokens: { tokensAtTerminal: 50 },
		});
		observeCodexTerminalClose(deps(), "exec-4", {
			...observation({ state: "stop_requested" }),
			ownedStreak: 2,
			alertedKey: "stop_requested:0",
		});
		expect(store.codexTerminalClose.get("exec-4")).toMatchObject({
			owned_streak: 2,
			tokens_at_terminal: 50,
			alerted_key: "stop_requested:0",
		});
	});

	it("closeAttemptState maps a terminal-path reap onto the ledger without regressing closed", () => {
		expect(closeAttemptState(undefined, "reaped")).toBe("close_attempted");
		expect(closeAttemptState(undefined, "absent")).toBe("close_attempted");
		expect(closeAttemptState(undefined, "unverifiable")).toBe(
			"alive_unverifiable",
		);
		expect(closeAttemptState(undefined, "residual")).toBe("alive_residual");
		expect(closeAttemptState("closed", "absent")).toBe("closed");
		// Review R1 LOW: a reap that signalled a live, proven group contradicts
		// `closed`; the sweep must prove the close again.
		expect(closeAttemptState("closed", "reaped")).toBe("close_attempted");
		expect(closeAttemptState("closed", "residual")).toBe("alive_residual");
		expect(closeAttemptState("pending_confirm", "reaped")).toBe(
			"close_attempted",
		);
	});

	it("lists recent visible rows for the quota page, newest first, bounded", () => {
		for (let i = 0; i < 12; i += 1) {
			observeCodexTerminalClose(deps(), `exec-v${i}`, {
				...observation({
					state: i === 0 ? "closed" : "alive_unverifiable",
					terminalAt: `2026-09-25 09:${String(10 + i).padStart(2, "0")}:00`,
				}),
				...(i === 0 ? { tokens: { tokensAfterTerminal: 5 } } : {}),
			});
		}
		observeCodexTerminalClose(deps(), "exec-old", {
			...observation({
				state: "alive_residual",
				terminalAt: "2026-09-23 09:00:00",
			}),
		});
		observeCodexTerminalClose(deps(), "exec-quiet", {
			...observation({ state: "closed", terminalAt: "2026-09-25 09:59:00" }),
		});
		const rows = store.codexTerminalClose.listVisible({
			now: clock,
			limit: 10,
		});
		expect(rows).toHaveLength(10);
		expect(rows[0]?.execution_id).toBe("exec-v11");
		expect(rows.map((r) => r.execution_id)).not.toContain("exec-old");
		expect(rows.map((r) => r.execution_id)).not.toContain("exec-quiet");
		const all = store.codexTerminalClose.listVisible({ now: clock, limit: 50 });
		expect(all.map((r) => r.execution_id)).toContain("exec-v0");
	});

	it("the terminal-path recorder reads the session and never regresses a closed row", () => {
		store.upsertSession({
			execution_id: "exec-rec",
			issue_id: "issue-rec",
			issue_identifier: "FLY-2903",
			project_name: "flywheel",
			status: "running",
			adapter_type: "codex-tmux",
		});
		store.forceStatus("exec-rec", "terminated", "2026-09-25 10:00:00", "x");
		const recorder = createCodexTerminalCloseAttemptRecorder(store);
		recorder.recordCloseAttempt({
			executionId: "exec-rec",
			source: "bridge.terminate",
			ownerStop: "stopped",
			reap: "reaped",
		});
		const row = store.codexTerminalClose.get("exec-rec");
		expect(row).toMatchObject({
			state: "close_attempted",
			session_status: "terminated",
			issue_identifier: "FLY-2903",
			project_name: "flywheel",
		});
		expect(row?.terminal_at).toBeTruthy();
		expect(JSON.parse(row?.last_evidence ?? "{}")).toEqual({
			source: "bridge.terminate",
			ownerStop: "stopped",
			reap: "reaped",
		});
		expect(events("exec-rec").map((e) => e.event_type)).toEqual([
			"codex_terminal_close_close_attempted",
		]);

		observeCodexTerminalClose(deps(), "exec-rec", {
			...observation({ state: "closed" }),
			closedAt: clock.toISOString(),
		});
		recorder.recordCloseAttempt({
			executionId: "exec-rec",
			source: "bridge.close-runner",
			reap: "absent",
		});
		expect(store.codexTerminalClose.get("exec-rec")?.state).toBe("closed");
		recorder.recordCloseAttempt({
			executionId: "exec-rec",
			source: "bridge.close-runner",
			reap: "residual",
		});
		expect(store.codexTerminalClose.get("exec-rec")?.state).toBe(
			"alive_residual",
		);
	});

	it("sweep candidates: terminal codex-tmux sessions 0..48h past terminal, not closed, oldest first", () => {
		const seed = (exec: string, status: string, adapter = "codex-tmux") => {
			store.upsertSession({
				execution_id: exec,
				issue_id: `issue-${exec}`,
				project_name: "flywheel",
				status: "running",
				adapter_type: adapter,
			});
			if (status !== "running") store.forceStatus(exec, status, "", "x");
		};
		seed("c-completed", "completed");
		seed("c-failed", "failed");
		seed("c-terminated", "terminated");
		seed("c-blocked", "blocked");
		seed("c-running", "running");
		seed("c-parked", "ship_parked");
		seed("c-claude", "completed", "claude-tmux");
		seed("c-closed", "completed");
		observeCodexTerminalClose(deps(), "c-closed", {
			...observation({ state: "closed" }),
		});
		const realNow = Date.now();
		const ids = (offsetMs: number) =>
			store.codexTerminalClose.listSweepCandidateExecutionIds({
				now: new Date(realNow + offsetMs),
				limit: 25,
			});
		expect(ids(10 * 60_000).sort()).toEqual([
			"c-blocked",
			"c-completed",
			"c-failed",
			"c-terminated",
		]);
		expect(ids(60_000).sort()).toEqual([
			"c-blocked",
			"c-completed",
			"c-failed",
			"c-terminated",
		]);
		expect(ids(-60_000)).toEqual([]);
		expect(ids(49 * 3_600_000)).toEqual([]);
		expect(
			store.codexTerminalClose.listSweepCandidateExecutionIds({
				now: new Date(realNow + 10 * 60_000),
				limit: 2,
			}),
		).toHaveLength(2);
	});

	it("the scorecard exposes the newest codex source bound to an execution", () => {
		const raw = (
			store as unknown as {
				db: { raw: { prepare(sql: string): { run(...a: unknown[]): void } } };
			}
		).db.raw;
		const insert = raw.prepare(
			`INSERT INTO workflow_scorecard_cursor
			   (vendor, native_session_id, source_generation, execution_id,
			    source_locator, committed_offset, source_fingerprint, coverage,
			    updated_at)
			 VALUES (?, ?, 'g1', ?, ?, 0, 'fp', 'complete', ?)`,
		);
		insert.run(
			"codex",
			"t-old",
			"exec-s",
			"/h/sessions/old-t-old.jsonl",
			"2026-09-25T09:00:00Z",
		);
		insert.run(
			"codex",
			"t-new",
			"exec-s",
			"/h/sessions/new-t-new.jsonl",
			"2026-09-25T10:00:00Z",
		);
		insert.run(
			"claude",
			"t-claude",
			"exec-s",
			"/c.jsonl",
			"2026-09-25T11:00:00Z",
		);
		expect(
			store.workflowScorecard.latestCodexSourceForExecution("exec-s"),
		).toEqual({
			source_locator: "/h/sessions/new-t-new.jsonl",
			native_session_id: "t-new",
		});
		expect(
			store.workflowScorecard.latestCodexSourceForExecution("missing"),
		).toBeUndefined();
	});

	it("quota banner rows map visible ledger rows and degrade to empty on error", () => {
		observeCodexTerminalClose(deps(), "exec-banner", {
			...observation({
				state: "alive_residual",
				terminalAt: "2026-09-25 09:30:00",
			}),
			tokens: { tokensAfterTerminal: 42 },
		});
		expect(terminalBodiesForQuotaPage(store, clock)).toEqual([
			{
				executionId: "exec-banner",
				issueIdentifier: "FLY-2903",
				terminalAt: "2026-09-25 09:30:00",
				state: "alive_residual",
				tokensAfterTerminal: 42,
			},
		]);
		const logs: string[] = [];
		expect(
			terminalBodiesForQuotaPage(
				{
					codexTerminalClose: {
						listVisible: () => {
							throw new Error("no such table");
						},
					},
				},
				clock,
				(line) => logs.push(line),
			),
		).toEqual([]);
		expect(logs).toHaveLength(1);
	});
});
