import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
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

	function reports(): Array<{ id: string; content: string; kind: string }> {
		const raw = new Database(dbPath);
		try {
			return raw
				.prepare(
					"SELECT id, content, kind FROM messages WHERE from_agent = ? AND kind = 'report' ORDER BY rowid",
				)
				.all(execId) as Array<{ id: string; content: string; kind: string }>;
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
			.prepare("UPDATE messages SET created_at = ? WHERE from_agent = ?")
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
	});

	it("excludes answered and superseded questions from the stop reason", async () => {
		const answered = db.insertQuestion(execId, leadId, "answered");
		db.insertResponse(answered, leadId, "ok");
		const superseded = db.insertQuestion(execId, leadId, "superseded");
		const raw = new Database(dbPath);
		raw
			.prepare(
				"UPDATE messages SET superseded_at = datetime('now') WHERE id = ?",
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

		const exec2 = "exec-parked";
		db.registerSession(exec2, "runner:2", "flywheel", issueId, leadId);
		db.upsertDeclaredState(exec2, "parked", "phase complete", Date.now(), null);
		const parked = await emit({ execId: exec2, turnId: "turn-parked" });
		expect(parked).toMatchObject({
			reason: "done",
			detail: "parked: phase complete",
		});
	});

	it("uses durable lineage after session finalization", async () => {
		db.finalizeSession(execId);
		const result = await emit({ turnId: "turn-after-finalize" });
		expect(result.status).toBe("sent");
		expect(reports()[0]!.content).toContain("issue=FLY-1571 exec=exec-fly1571");
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

	it("does not let a prior-turn ask pollute the current turn", async () => {
		const old = db.insertQuestion(execId, leadId, "old ask");
		const raw = new Database(dbPath);
		raw
			.prepare("UPDATE messages SET created_at = ? WHERE id = ?")
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

	it("uses a unique fail-safe key for separate unanchored Claude invocations", async () => {
		const opts = {
			source: "claude-stop" as const,
			turnId: undefined,
			transcriptPath: join(dir, "missing-transcript.jsonl"),
		};
		const first = await emit(opts);
		const second = await emit(opts);
		expect(second.questionId).not.toBe(first.questionId);
		expect(reports()).toHaveLength(2);
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
