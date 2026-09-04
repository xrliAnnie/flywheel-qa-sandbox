import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runnerStopped } from "../commands/runner-stopped.js";
import { CommDB } from "../db.js";

describe("runner-stopped", () => {
	let dir: string;
	let dbPath: string;
	let stateDir: string;
	let db: CommDB;
	const execId = "exec-fly1571";
	const issueId = "FLY-1571";
	const leadId = "flywheel-eng-lead";
	const ingressTs = "2026-08-04T12:00:10.000Z";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1571-runner-stopped-"));
		dbPath = join(dir, "comm.db");
		stateDir = join(dir, "state");
		db = new CommDB(dbPath);
		db.registerSession(execId, "runner:1", "flywheel", issueId, leadId);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const emit = (overrides: Partial<Parameters<typeof runnerStopped>[0]> = {}) =>
		runnerStopped({
			dbPath,
			execId,
			envIssueId: issueId,
			source: "codex-notify",
			turnId: randomUUID(),
			ingressTs,
			stateDir,
			...overrides,
		});

	function reports(): Array<{
		id: string;
		content: string;
		kind: string;
		state: string;
		delivered_at: string | null;
		relay_state: string;
		superseded_at: string | null;
		superseded_by: string | null;
	}> {
		const raw = new Database(dbPath);
		try {
			return raw
				.prepare(
					`SELECT p.id, p.content, p.kind, m.state, m.delivered_at,
					        p.relay_state, p.superseded_at, p.superseded_by
					   FROM mailbox_message_projection p
					   JOIN mailbox m ON m.id = p.id
					  WHERE p.from_agent = ? AND p.kind = 'report' ORDER BY p.rowid`,
				)
				.all(execId) as ReturnType<typeof reports>;
		} finally {
			raw.close();
		}
	}

	function declarationStateKey(executionId = execId): string | undefined {
		const raw = new Database(dbPath, { readonly: true });
		try {
			return (
				raw
					.prepare(
						"SELECT state_key FROM runner_stop_declarations WHERE execution_id = ?",
					)
					.get(executionId) as { state_key: string } | undefined
			)?.state_key;
		} finally {
			raw.close();
		}
	}

	function writeCompletion(
		route: string,
		opts: { summary?: string; pr?: number; eventId?: string } = {},
	): string {
		mkdirSync(stateDir, { recursive: true });
		const completionEventId = opts.eventId ?? randomUUID();
		writeFileSync(
			join(stateDir, "last-complete.json"),
			JSON.stringify({
				v: 1,
				completionEventId,
				executionId: execId,
				issueId,
				route,
				...(opts.pr ? { pr: opts.pr } : {}),
				sanitizedSummary: opts.summary ?? "finished cleanly",
				createdAt: ingressTs,
			}),
		);
		return completionEventId;
	}

	it("emits the required fields and maps an unconsumed completion route", async () => {
		const completionEventId = writeCompletion("needs_review", { pr: 73 });
		const result = await emit({ turnId: "turn-ready" });

		expect(result).toMatchObject({
			status: "sent",
			reason: "awaiting_approval",
			route: "needs_review",
		});
		expect(reports()).toHaveLength(1);
		expect(reports()[0]!.content).toBe(
			"RUNNER-STOPPED kind=runner_stopped reason=awaiting_approval issue=FLY-1571 exec=exec-fly1571 route=needs_review detail=PR #73 ready, awaiting founder approval",
		);
		expect(
			readFileSync(join(stateDir, "consumed", completionEventId), "utf8"),
		).toBe("");
	});

	it("collapses changed summary for the same blocked completion event", async () => {
		const completionEventId = randomUUID();
		writeCompletion("blocked", {
			eventId: completionEventId,
			summary: "blocked wording A",
		});
		const first = await emit({
			turnId: "blocked-summary-a",
			derivedAtMs: 100,
		});
		unlinkSync(join(stateDir, "consumed", completionEventId));
		writeCompletion("blocked", {
			eventId: completionEventId,
			summary: "blocked wording B",
		});
		const second = await emit({
			turnId: "blocked-summary-b",
			derivedAtMs: 200,
		});

		expect(first).toMatchObject({ status: "sent", reason: "blocked" });
		expect(second).toMatchObject({ status: "duplicate", reason: "blocked" });
		expect(reports()).toHaveLength(1);
		expect(reports()[0]!.content).toContain("detail=blocked wording A");
		expect(declarationStateKey()).toBe(
			`completion\0${completionEventId}\0blocked\0-`,
		);
		expect(existsSync(join(stateDir, "consumed", completionEventId))).toBe(
			false,
		);
	});

	it("uses the native StopFailure fixture shape for quota and context_full", async () => {
		const quota = await emit({
			source: "claude-stop-failure",
			turnId: "claude-rate",
			stopFailure: {
				error: "rate_limit",
				errorDetails: null,
				lastAssistantMessage: "API Error: Request rejected (429)",
			},
		});
		expect(quota.reason).toBe("quota");

		const context = await emit({
			source: "claude-stop-failure",
			turnId: "claude-context",
			stopFailure: {
				error: "invalid_request",
				errorDetails:
					'400 {"error":{"type":"invalid_request_error","message":"prompt is too long for fixture"}}',
				lastAssistantMessage: "Prompt is too long",
			},
		});
		expect(context.reason).toBe("context_full");
	});

	it("does not consume a completion breadcrumb when StopFailure takes priority", async () => {
		const completionEventId = writeCompletion("needs_review", { pr: 73 });
		const failed = await emit({
			source: "claude-stop-failure",
			turnId: "claude-rate-before-completion",
			stopFailure: {
				error: "rate_limit",
				lastAssistantMessage: "API Error: Request rejected (429)",
			},
		});

		expect(failed.reason).toBe("quota");
		expect(existsSync(join(stateDir, "consumed", completionEventId))).toBe(
			false,
		);
		expect((await emit({ turnId: "turn-after-rate-limit" })).reason).toBe(
			"awaiting_approval",
		);
		expect(existsSync(join(stateDir, "consumed", completionEventId))).toBe(
			true,
		);
	});

	it("does not promote near-match assistant text without the proven error_details shape", async () => {
		const result = await emit({
			source: "claude-stop-failure",
			turnId: "claude-negative",
			stopFailure: {
				error: "invalid_request",
				errorDetails: "request was rejected",
				lastAssistantMessage: "It looks like the prompt is too long",
			},
		});
		expect(result.reason).toBe("error");
	});

	it("collapses changed StopFailure detail under the same structured error", async () => {
		const first = await emit({
			source: "claude-stop-failure",
			turnId: "failure-detail-a",
			stopFailure: {
				error: "server_error",
				errorDetails: "backend wording A",
			},
			derivedAtMs: 100,
		});
		const second = await emit({
			source: "claude-stop-failure",
			turnId: "failure-detail-b",
			stopFailure: {
				error: "server_error",
				errorDetails: "backend wording B",
			},
			derivedAtMs: 200,
		});

		expect(first.status).toBe("sent");
		expect(second.status).toBe("duplicate");
		expect(reports()).toHaveLength(1);
		expect(declarationStateKey()).toBe("stop_failure\0server_error\0error");
	});

	it("collapses different Codex messages with the same quota classification", async () => {
		const first = await emit({
			turnId: "quota-wording-a",
			lastMessage: "Rate limit reached; retry later.",
			derivedAtMs: 100,
		});
		const second = await emit({
			turnId: "quota-wording-b",
			lastMessage: "Usage limit exhausted for this account.",
			derivedAtMs: 200,
		});

		expect(first).toMatchObject({ status: "sent", reason: "quota" });
		expect(second).toMatchObject({ status: "duplicate", reason: "quota" });
		expect(reports()).toHaveLength(1);
		expect(declarationStateKey()).toBe("codex_classification\0quota");
	});

	it("prefers a checkpoint over earlier ordinary asks and ignores prior reports", async () => {
		const raw = new Database(dbPath);
		for (let i = 0; i < 5; i += 1) {
			db.insertQuestion(execId, leadId, `ask-${i}`);
		}
		const gateId = db.insertQuestion(execId, leadId, "approval", {
			checkpoint: "approve_to_ship",
		});
		db.insertQuestion(execId, leadId, "old stop report", { kind: "report" });
		raw
			.prepare("UPDATE mailbox SET created_at = ? WHERE from_agent = ?")
			.run("2026-08-04 12:00:05", execId);
		raw.close();

		const result = await emit({
			turnId: "turn-gate",
			prevIngress: "2026-08-04T12:00:00.000Z",
		});
		expect(result).toMatchObject({
			reason: "awaiting_approval",
			detail: `waiting on gate ${gateId}`,
		});
		expect(declarationStateKey()).toBe(
			`pending_gate\0${gateId}\0approve_to_ship`,
		);
	});

	it("excludes answered and superseded questions from the stop reason", async () => {
		const answered = db.insertQuestion(execId, leadId, "answered");
		db.insertResponse(answered, leadId, "ok");
		const superseded = db.insertQuestion(execId, leadId, "superseded");
		const raw = new Database(dbPath);
		raw
			.prepare(
				"UPDATE mailbox SET superseded_at = datetime('now') WHERE id = ?",
			)
			.run(superseded);
		raw.close();

		const result = await emit({ turnId: "turn-no-pending" });
		expect(result).toMatchObject({
			reason: "blocked",
			detail: "idle without declared completion",
		});
	});

	it("maps session terminal state and an active park declaration", async () => {
		db.markSessionTerminalStatus(execId, "failed");
		expect((await emit({ turnId: "turn-failed" })).reason).toBe("error");
		expect(declarationStateKey()).toBe("session\0failed");

		const exec2 = "exec-parked";
		db.registerSession(exec2, "runner:2", "flywheel", issueId, leadId);
		db.upsertDeclaredState(exec2, "parked", "phase complete", Date.now(), null);
		const parked = await emit({ execId: exec2, turnId: "turn-parked" });
		expect(parked).toMatchObject({
			reason: "done",
			detail: "parked: phase complete",
		});
	});

	it("prioritizes an unanswered approval gate over an active park", async () => {
		const exec2 = "exec-parked-at-gate";
		db.registerSession(exec2, "runner:3", "flywheel", issueId, leadId);
		db.upsertDeclaredState(
			exec2,
			"parked",
			"waiting to ship",
			Date.now(),
			null,
		);
		const gateId = db.insertQuestion(exec2, leadId, "approval", {
			checkpoint: "approve_to_ship",
		});
		const raw = new Database(dbPath);
		raw
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-08-04 11:59:30", gateId);

		const parked = await emit({
			execId: exec2,
			turnId: "turn-parked-at-gate",
			prevIngress: "2026-08-04T12:00:00.000Z",
		});
		expect(parked).toMatchObject({
			reason: "awaiting_approval",
			detail: `waiting on gate ${gateId}`,
		});

		db.insertResponse(gateId, leadId, "approved");
		const askId = db.insertQuestion(exec2, leadId, "need an answer");
		raw
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-08-04 12:00:05", askId);
		raw.close();
		const waitingOnAnswer = await emit({
			execId: exec2,
			turnId: "turn-parked-at-ask",
			prevIngress: "2026-08-04T12:00:00.000Z",
		});
		expect(waitingOnAnswer).toMatchObject({
			reason: "blocked",
			detail: `waiting on answer to ${askId}`,
		});
		expect(declarationStateKey(exec2)).toBe(`pending_question\0${askId}`);

		db.insertResponse(askId, leadId, "answered");
		expect(
			await emit({ execId: exec2, turnId: "turn-parked-without-pending" }),
		).toMatchObject({
			reason: "done",
			detail: "parked: waiting to ship",
		});
	});

	it("uses durable lineage after session finalization", async () => {
		db.finalizeSession(execId);
		const result = await emit({ turnId: "turn-after-finalize" });
		expect(result.status).toBe("sent");
		expect(reports()[0]!.content).toContain("issue=FLY-1571 exec=exec-fly1571");
	});

	it("clears the current declaration ledger on finalization and lets a late receipt-lineage report rebuild it", async () => {
		db.upsertDeclaredState(execId, "parked", "finalizing", Date.now(), null);
		await emit({ turnId: "before-finalize", derivedAtMs: 100 });
		const raw = new Database(dbPath);
		const ledgerCount = () =>
			(
				raw
					.prepare(
						"SELECT COUNT(*) AS count FROM runner_stop_declarations WHERE execution_id = ?",
					)
					.get(execId) as { count: number }
			).count;
		expect(ledgerCount()).toBe(1);

		db.finalizeSession(execId);
		expect(ledgerCount()).toBe(0);
		raw.close();

		const late = await emit({ turnId: "after-finalize", derivedAtMs: 200 });
		expect(late.status).toBe("sent");
	});

	it("rehydrates the declaration ledger when the exact late turn is replayed after finalization", async () => {
		db.upsertDeclaredState(execId, "parked", "finalizing", Date.now(), null);
		const first = await emit({ turnId: "late-replay", derivedAtMs: 100 });
		db.finalizeSession(execId);

		const replay = await emit({ turnId: "late-replay", derivedAtMs: 200 });
		const nextTurn = await emit({
			turnId: "late-replay-next",
			derivedAtMs: 300,
		});

		expect(replay).toMatchObject({
			status: "duplicate",
			questionId: first.questionId,
		});
		expect(nextTurn).toMatchObject({
			status: "duplicate",
			questionId: first.questionId,
		});
		expect(reports()).toHaveLength(1);
	});

	it("clears the current declaration ledger with resident phase lifecycle deletion", async () => {
		db.upsertDeclaredState(
			execId,
			"parked",
			"phase-terminal",
			Date.now(),
			null,
		);
		await emit({ turnId: "before-phase-delete", derivedAtMs: 100 });

		db.deleteSessionAndRunnerPhaseLifecycle(execId);
		const raw = new Database(dbPath, { readonly: true });
		const row = raw
			.prepare("SELECT 1 FROM runner_stop_declarations WHERE execution_id = ?")
			.get(execId);
		raw.close();
		expect(row).toBeUndefined();
	});

	it("migrates an existing declaration once without overwriting new state on reopen", () => {
		db.close();
		const legacy = new Database(dbPath);
		legacy.exec(`
			DROP TABLE runner_stop_declarations;
			CREATE TABLE runner_stop_declarations (
				execution_id TEXT PRIMARY KEY,
				content_hash TEXT NOT NULL,
				content TEXT NOT NULL,
				question_id TEXT NOT NULL,
				derived_at_ms INTEGER NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
		const legacyContent = "legacy canonical content";
		legacy
			.prepare(
				`INSERT INTO runner_stop_declarations
				   (execution_id, content_hash, content, question_id, derived_at_ms, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				execId,
				"a".repeat(64),
				legacyContent,
				`rstop-${"a".repeat(32)}`,
				100,
				ingressTs,
			);
		legacy.close();

		db = new CommDB(dbPath);
		const migrated = new Database(dbPath, { readonly: true });
		const columns = migrated
			.prepare("PRAGMA table_info(runner_stop_declarations)")
			.all() as Array<{ name: string }>;
		const migratedRow = migrated
			.prepare(
				`SELECT state_hash, state_key, content_hash, derived_at_ms, emitted_at_ms
				   FROM runner_stop_declarations WHERE execution_id = ?`,
			)
			.get(execId) as {
			state_hash: string;
			state_key: string;
			content_hash: string;
			derived_at_ms: number;
			emitted_at_ms: number;
		};
		migrated.close();

		expect(columns.map(({ name }) => name)).toEqual(
			expect.arrayContaining(["state_hash", "state_key", "emitted_at_ms"]),
		);
		expect(migratedRow).toMatchObject({
			state_hash: migratedRow.content_hash,
			state_key: legacyContent,
			derived_at_ms: 100,
			emitted_at_ms: 100,
		});

		db.recordRunnerStopDeclaration({
			executionId: execId,
			leadId,
			stateKey: "machine-state",
			content: "new canonical content",
			questionId: `rstop-${"b".repeat(32)}`,
			derivedAtMs: 200,
		});
		db.close();
		db = new CommDB(dbPath);

		expect(declarationStateKey()).toBe("machine-state");
		const reopened = new Database(dbPath, { readonly: true });
		expect(
			reopened
				.prepare(
					"SELECT derived_at_ms, emitted_at_ms FROM runner_stop_declarations WHERE execution_id = ?",
				)
				.get(execId),
		).toEqual({ derived_at_ms: 200, emitted_at_ms: 200 });
		reopened.close();
	});

	it("fails closed on identity disagreement without inserting a report", async () => {
		await expect(
			emit({ envIssueId: "FLY-9999", turnId: "turn-wrong-identity" }),
		).rejects.toThrow(/identity/i);
		expect(reports()).toHaveLength(0);
	});

	it("is idempotent for a replayed Codex turn", async () => {
		const first = await emit({ turnId: "same-turn" });
		const second = await emit({ turnId: "same-turn" });
		expect(first.questionId).toBe(second.questionId);
		expect(reports()).toHaveLength(1);
	});

	it("collapses rewritten fallback detail across distinct Codex turns", async () => {
		const first = await emit({
			turnId: "fallback-wording-a",
			lastMessage: "No state change; still waiting.",
			derivedAtMs: 100,
		});
		const second = await emit({
			turnId: "fallback-wording-b",
			lastMessage: "Still waiting because state remains unchanged.",
			derivedAtMs: 200,
		});

		expect(first.status).toBe("sent");
		expect(second).toMatchObject({
			status: "duplicate",
			questionId: first.questionId,
		});
		expect(reports()).toHaveLength(1);
		expect(declarationStateKey()).toBe(
			"fallback\0idle_without_declared_completion",
		);
	});

	it("suppresses an unchanged parked declaration across distinct Codex turns", async () => {
		db.upsertDeclaredState(execId, "parked", "quiet-wait", Date.now(), null);

		const first = await emit({ turnId: "quiet-turn-1" });
		const second = await emit({ turnId: "quiet-turn-2" });

		expect(first.status).toBe("sent");
		expect(second.status).toBe("duplicate");
		expect(second.questionId).toBe(first.questionId);
		expect(reports()).toHaveLength(1);
	});

	it("collapses free-text park reason rewrites within the window", async () => {
		db.upsertDeclaredState(execId, "parked", "wording A", Date.now(), null);
		const first = await emit({ turnId: "park-wording-a", derivedAtMs: 100 });
		db.upsertDeclaredState(execId, "parked", "wording B", Date.now(), null);
		const second = await emit({ turnId: "park-wording-b", derivedAtMs: 200 });

		expect(first.status).toBe("sent");
		expect(second).toMatchObject({
			status: "duplicate",
			questionId: first.questionId,
		});
		expect(reports()).toHaveLength(1);
		expect(reports()[0]!.content).toContain("detail=parked: wording A");
		expect(declarationStateKey()).toBe("declared\0parked");
	});

	it("emits identical content immediately when structured state changes", () => {
		const content =
			"RUNNER-STOPPED kind=runner_stopped reason=done issue=FLY-1571 exec=exec-fly1571 route=- detail=same";
		const first = db.recordRunnerStopDeclaration({
			executionId: execId,
			leadId,
			stateKey: "state-a",
			content,
			questionId: `rstop-${"1".repeat(32)}`,
			derivedAtMs: 100,
		});
		const second = db.recordRunnerStopDeclaration({
			executionId: execId,
			leadId,
			stateKey: "state-b",
			content,
			questionId: `rstop-${"2".repeat(32)}`,
			derivedAtMs: 101,
		});

		expect([first.status, second.status]).toEqual(["sent", "sent"]);
		expect(reports()).toHaveLength(2);
	});

	it("collapses changed content while structured state is unchanged", () => {
		const first = db.recordRunnerStopDeclaration({
			executionId: execId,
			leadId,
			stateKey: "same-state",
			content:
				"RUNNER-STOPPED kind=runner_stopped reason=blocked issue=FLY-1571 exec=exec-fly1571 route=- detail=wording-a",
			questionId: `rstop-${"3".repeat(32)}`,
			derivedAtMs: 100,
		});
		const second = db.recordRunnerStopDeclaration({
			executionId: execId,
			leadId,
			stateKey: "same-state",
			content:
				"RUNNER-STOPPED kind=runner_stopped reason=blocked issue=FLY-1571 exec=exec-fly1571 route=- detail=wording-b",
			questionId: `rstop-${"4".repeat(32)}`,
			derivedAtMs: 200,
		});

		expect(first.status).toBe("sent");
		expect(second).toMatchObject({
			status: "duplicate",
			questionId: first.questionId,
			contentMatched: false,
		});
		expect(reports()).toHaveLength(1);
	});

	it("allows changed-content heartbeats at the boundary but keeps exact content collapsed", () => {
		const windowMs = 30 * 60_000;
		const record = (content: string, digit: string, derivedAtMs: number) =>
			db.recordRunnerStopDeclaration({
				executionId: execId,
				leadId,
				stateKey: "heartbeat-state",
				content,
				questionId: `rstop-${digit.repeat(32)}`,
				derivedAtMs,
			});

		const first = record("content-a", "5", 100);
		const beforeBoundary = record("content-b", "6", 100 + windowMs - 1);
		const atBoundary = record("content-c", "7", 100 + windowMs);
		const exactLater = record("content-c", "8", 100 + 2 * windowMs);

		expect([
			first.status,
			beforeBoundary.status,
			atBoundary.status,
			exactLater.status,
		]).toEqual(["sent", "duplicate", "sent", "duplicate"]);
		expect(reports()).toHaveLength(2);
	});

	it("rejects an older same-state rewrite before evaluating the heartbeat window", () => {
		const current = db.recordRunnerStopDeclaration({
			executionId: execId,
			leadId,
			stateKey: "same-state",
			content: "newer wording",
			questionId: `rstop-${"9".repeat(32)}`,
			derivedAtMs: 200,
		});
		const stale = db.recordRunnerStopDeclaration({
			executionId: execId,
			leadId,
			stateKey: "same-state",
			content: "older wording",
			questionId: `rstop-${"0".repeat(32)}`,
			derivedAtMs: 100,
		});

		expect(current.status).toBe("sent");
		expect(stale).toMatchObject({
			status: "stale",
			questionId: current.questionId,
			contentMatched: false,
		});
		expect(reports()).toHaveLength(1);
	});

	it("rejects an empty structured state key", () => {
		expect(() =>
			db.recordRunnerStopDeclaration({
				executionId: execId,
				leadId,
				stateKey: "",
				content: "content",
				questionId: `rstop-${"e".repeat(32)}`,
				derivedAtMs: 100,
			}),
		).toThrow("runner stop stateKey must be non-empty");
	});

	it("emits parked to completion to parked while superseding only a delivered edge", async () => {
		db.upsertDeclaredState(execId, "parked", "A", Date.now(), null);
		const firstA = await emit({
			turnId: "edge-a-1",
			derivedAtMs: 100,
		});
		const raw = new Database(dbPath);
		raw
			.prepare(
				`UPDATE mailbox SET state = 'ACKED', delivered_at = ?, acked_at = ?
				  WHERE id = ?`,
			)
			.run(ingressTs, ingressTs, firstA.questionId);
		raw.close();

		writeCompletion("needs_review", { pr: 73 });
		const edgeB = await emit({ turnId: "edge-b", derivedAtMs: 200 });
		expect(db.getMessageById(firstA.questionId)).toMatchObject({
			relay_state: "terminal_disposed",
			superseded_by: edgeB.questionId,
		});
		const secondA = await emit({
			turnId: "edge-a-2",
			derivedAtMs: 300,
		});

		expect([firstA.status, edgeB.status, secondA.status]).toEqual([
			"sent",
			"sent",
			"sent",
		]);
		const rows = reports();
		expect(
			rows.map(({ content }) => content.match(/detail=(.*)$/)?.[1]),
		).toEqual(["PR #73 ready, awaiting founder approval", "parked: A"]);
		expect(rows[0]).toMatchObject({
			state: "QUEUED",
			relay_state: "open",
			superseded_at: null,
		});
		expect(db.getPendingQuestions(leadId).map(({ id }) => id)).toEqual(
			expect.arrayContaining([edgeB.questionId, secondA.questionId]),
		);
	});

	it("rejects an older different derivation without regressing current", () => {
		const current = db.recordRunnerStopDeclaration({
			executionId: execId,
			leadId,
			stateKey: "state-newer",
			content:
				"RUNNER-STOPPED kind=runner_stopped reason=done issue=FLY-1571 exec=exec-fly1571 route=- detail=newer",
			questionId: `rstop-${"a".repeat(32)}`,
			derivedAtMs: 200,
		});
		const stale = db.recordRunnerStopDeclaration({
			executionId: execId,
			leadId,
			stateKey: "state-older",
			content:
				"RUNNER-STOPPED kind=runner_stopped reason=done issue=FLY-1571 exec=exec-fly1571 route=- detail=older",
			questionId: `rstop-${"b".repeat(32)}`,
			derivedAtMs: 100,
		});

		expect(current.status).toBe("sent");
		expect(stale).toMatchObject({
			status: "stale",
			contentMatched: false,
			questionId: current.questionId,
		});
		expect(reports()).toHaveLength(1);
		expect(reports()[0]?.content).toContain("detail=newer");
	});

	it("preserves the first content when the same turn is re-derived differently", async () => {
		const first = await emit({ turnId: "same-turn-conflict" });
		const firstContent = reports()[0]!.content;
		rmSync(join(stateDir, "sent"), { recursive: true, force: true });
		db.insertQuestion(execId, leadId, "newly visible question");

		const second = await emit({ turnId: "same-turn-conflict" });
		expect(first.questionId).toBe(second.questionId);
		expect(second.status).toBe("duplicate");
		expect(reports()).toHaveLength(1);
		expect(reports()[0]!.content).toBe(firstContent);
	});

	it("does not consume a completion breadcrumb on a deterministic turn-id content conflict", async () => {
		const first = await emit({
			turnId: "completion-conflict",
			derivedAtMs: 100,
		});
		rmSync(join(stateDir, "sent"), { recursive: true, force: true });
		const completionEventId = writeCompletion("needs_review", { pr: 73 });

		const conflict = await emit({
			turnId: "completion-conflict",
			derivedAtMs: 200,
		});

		expect(conflict).toMatchObject({
			status: "duplicate",
			questionId: first.questionId,
		});
		expect(existsSync(join(stateDir, "consumed", completionEventId))).toBe(
			false,
		);
		expect(reports()).toHaveLength(1);
	});

	it("does not consume a completion breadcrumb when its derivation is stale", async () => {
		const current = db.recordRunnerStopDeclaration({
			executionId: execId,
			leadId,
			stateKey: "state-newer-observation",
			content:
				"RUNNER-STOPPED kind=runner_stopped reason=done issue=FLY-1571 exec=exec-fly1571 route=- detail=newer observation",
			questionId: `rstop-${"c".repeat(32)}`,
			derivedAtMs: 200,
		});
		const completionEventId = writeCompletion("needs_review", { pr: 73 });

		const stale = await emit({
			turnId: "stale-completion",
			derivedAtMs: 100,
		});

		expect(stale).toMatchObject({
			status: "stale",
			questionId: current.questionId,
		});
		expect(existsSync(join(stateDir, "consumed", completionEventId))).toBe(
			false,
		);
		expect(reports()).toHaveLength(1);
	});

	it("does not let a prior-turn ask pollute the current turn", async () => {
		const old = db.insertQuestion(execId, leadId, "old ask");
		const raw = new Database(dbPath);
		raw
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-08-04 11:59:59", old);
		raw.close();

		const result = await emit({
			turnId: "turn-after-old-ask",
			prevIngress: "2026-08-04T12:00:00.000Z",
		});
		expect(result).toMatchObject({
			reason: "blocked",
			detail: "idle without declared completion",
		});
	});

	it("emits every genuine fallback and pending-question state transition", async () => {
		const fallbackA = await emit({
			turnId: "flap-fallback-a",
			derivedAtMs: 100,
		});
		const askA = db.insertQuestion(execId, leadId, "first wait target");
		const raw = new Database(dbPath);
		raw
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-08-04 12:00:05", askA);
		const pendingA = await emit({
			turnId: "flap-pending-a",
			prevIngress: "2026-08-04T12:00:00.000Z",
			derivedAtMs: 200,
		});
		db.insertResponse(askA, leadId, "answered");
		const fallbackB = await emit({
			turnId: "flap-fallback-b",
			derivedAtMs: 300,
		});
		const askB = db.insertQuestion(execId, leadId, "second wait target");
		raw
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-08-04 12:00:06", askB);
		raw.close();
		const pendingB = await emit({
			turnId: "flap-pending-b",
			prevIngress: "2026-08-04T12:00:00.000Z",
			derivedAtMs: 400,
		});

		expect([
			fallbackA.status,
			pendingA.status,
			fallbackB.status,
			pendingB.status,
		]).toEqual(["sent", "sent", "sent", "sent"]);
		expect(reports()).toHaveLength(4);
	});

	it("does not reuse consumed completion state on a later turn", async () => {
		writeCompletion("auto_approve");
		expect((await emit({ turnId: "turn-one" })).reason).toBe("done");
		expect((await emit({ turnId: "turn-two" })).reason).toBe("blocked");
	});

	it("ignores traversal-shaped and symlink-parent completion markers", async () => {
		writeCompletion("auto_approve", { eventId: "../../outside" });
		expect((await emit({ turnId: "turn-traversal" })).reason).toBe("blocked");
		expect(existsSync(join(dir, "outside"))).toBe(false);

		rmSync(join(stateDir, "sent"), { recursive: true, force: true });
		writeCompletion("auto_approve");
		const outside = join(dir, "outside-consumed");
		mkdirSync(outside);
		symlinkSync(outside, join(stateDir, "consumed"));
		expect((await emit({ turnId: "turn-symlink" })).reason).toBe("blocked");
		expect(readdirSync(outside)).toHaveLength(0);
	});

	it("suppresses unchanged declarations from separate unanchored Claude invocations", async () => {
		const opts = {
			source: "claude-stop" as const,
			turnId: undefined,
			transcriptPath: join(dir, "missing-transcript.jsonl"),
		};
		const first = await emit(opts);
		const second = await emit(opts);
		expect(second.status).toBe("duplicate");
		expect(second.questionId).toBe(first.questionId);
		expect(reports()).toHaveLength(1);
	});

	it("anchors Claude retries to the last real user row, skipping meta rows", async () => {
		const transcript = join(dir, "transcript.jsonl");
		writeFileSync(
			transcript,
			[
				JSON.stringify({
					type: "user",
					uuid: "real-user",
					timestamp: "2026-08-04T12:00:01.000Z",
					message: { content: "do the work" },
				}),
				JSON.stringify({
					type: "assistant",
					uuid: "assistant",
					message: { content: [{ type: "text", text: "done" }] },
				}),
				JSON.stringify({
					type: "user",
					uuid: "meta-user",
					isMeta: true,
					message: { content: "stop-hook continuation" },
				}),
			].join("\n"),
		);

		const opts = {
			source: "claude-stop" as const,
			turnId: undefined,
			sessionId: "claude-session",
			transcriptPath: transcript,
		};
		const first = await emit(opts);
		const second = await emit(opts);
		expect(first.questionId).toBe(second.questionId);
		expect(reports()).toHaveLength(1);
	});
});
