import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ask } from "../commands/ask.js";
import { capture } from "../commands/capture.js";
import { check } from "../commands/check.js";
import { cleanupMessages } from "../commands/cleanup-messages.js";
import { inbox, renderInboxInstruction } from "../commands/inbox.js";
import { pending } from "../commands/pending.js";
import {
	type RespondArgs,
	respond as rawRespond,
} from "../commands/respond.js";
import { send as rawSend, type SendArgs } from "../commands/send.js";
import { sessions } from "../commands/sessions.js";
import { CommDB } from "../db.js";
import { createTestLeadIdentityEnvs } from "./helpers/lead-identity-env.js";

let identityEnvs: Record<string, NodeJS.ProcessEnv> = {};

function respond(args: RespondArgs): Promise<void> {
	return rawRespond({
		...args,
		env: { ...identityEnvs[args.fromAgent], ...args.env },
	});
}

function send(args: SendArgs): Promise<string> {
	return rawSend({
		...args,
		env: { ...identityEnvs[args.fromAgent], ...args.env },
	});
}

describe("commands round-trip", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-comm-cmd-"));
		dbPath = join(tmpDir, "comm.db");
		identityEnvs = createTestLeadIdentityEnvs(tmpDir, [
			"product-lead",
			"ops-lead",
		]);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function bindRunner(execId: string, leadId: string): void {
		const db = new CommDB(dbPath);
		db.registerSession(execId, "runner", "test", `issue-${execId}`, leadId);
		db.close();
	}

	it("should complete a full ask → pending → respond → check cycle", async () => {
		bindRunner("exec-123", "product-lead");
		// Runner asks a question
		const questionId = ask({
			lead: "product-lead",
			execId: "exec-123",
			question: "Should I use REST or GraphQL?",
			dbPath,
		});
		expect(questionId).toBeTruthy();

		// Check: not yet answered
		const beforeAnswer = check({ questionId, dbPath });
		expect(beforeAnswer.status).toBe("pending");
		expect(beforeAnswer.content).toBeUndefined();

		// Lead sees pending question
		const pendingQs = pending({ lead: "product-lead", dbPath });
		expect(pendingQs).toHaveLength(1);
		expect(pendingQs[0]!.id).toBe(questionId);
		expect(pendingQs[0]!.from_agent).toBe("exec-123");
		expect(pendingQs[0]!.content).toBe("Should I use REST or GraphQL?");

		// Lead responds
		await respond({
			questionId,
			fromAgent: "product-lead",
			answer: "Use REST for simplicity.",
			dbPath,
		});

		// Check: now answered
		const afterAnswer = check({ questionId, dbPath });
		expect(afterAnswer.status).toBe("answered");
		expect(afterAnswer.content).toBe("Use REST for simplicity.");

		// No more pending
		expect(pending({ lead: "product-lead", dbPath })).toHaveLength(0);
	});

	it("only the explicitly matching runner consumes a gate response", async () => {
		bindRunner("exec-owner", "product-lead");
		const questionId = ask({
			lead: "product-lead",
			execId: "exec-owner",
			question: "Ship?",
			dbPath,
		});
		await respond({
			questionId,
			fromAgent: "product-lead",
			answer: "yes",
			dbPath,
		});

		expect(check({ questionId, dbPath }).content).toBe("yes");
		let db = new CommDB(dbPath, false);
		expect(db.getResponse(questionId)?.delivered_at).toBeNull();
		db.close();

		expect(
			check({ questionId, dbPath, executionId: "exec-observer" }).content,
		).toBe("yes");
		db = new CommDB(dbPath, false);
		expect(db.getResponse(questionId)?.delivered_at).toBeNull();
		db.close();

		expect(
			check({ questionId, dbPath, executionId: "exec-owner" }).content,
		).toBe("yes");
		db = new CommDB(dbPath, false);
		expect(db.getResponse(questionId)?.delivered_at).not.toBeNull();
		db.close();
	});

	it("should handle multiple runners asking different leads", async () => {
		bindRunner("runner", "product-lead");
		const q1 = ask({
			lead: "product-lead",
			question: "Q1 from runner-1",
			dbPath,
		});
		const _q2 = ask({
			lead: "product-lead",
			question: "Q2 from runner-2",
			dbPath,
		});
		const _q3 = ask({
			lead: "ops-lead",
			question: "Q3 from runner-1",
			dbPath,
		});

		expect(pending({ lead: "product-lead", dbPath })).toHaveLength(2);
		expect(pending({ lead: "ops-lead", dbPath })).toHaveLength(1);

		await respond({
			questionId: q1,
			fromAgent: "product-lead",
			answer: "A1",
			dbPath,
		});
		expect(pending({ lead: "product-lead", dbPath })).toHaveLength(1);
	});

	it("should use 'runner' as default from_agent when execId not provided", () => {
		const _qId = ask({
			lead: "product-lead",
			question: "A question",
			dbPath,
		});

		const pendingQs = pending({ lead: "product-lead", dbPath });
		expect(pendingQs[0]!.from_agent).toBe("runner");
	});

	it("persists a queue-native UTC deadline on an ask", () => {
		const deadlineAt = "2026-07-20T08:30:00.000Z";
		const questionId = ask({
			lead: "product-lead",
			execId: "exec-deadline",
			question: "urgent question",
			dbPath,
			deadlineAt,
		});
		const db = new CommDB(dbPath);
		try {
			expect(db.getMessageById(questionId)?.deadline_at).toBe(deadlineAt);
		} finally {
			db.close();
		}
	});

	it("should throw when responding to non-existent question", async () => {
		// FLY-175: respond() is now async (gated checkpoints route via Bridge).
		await expect(
			respond({
				questionId: "non-existent",
				fromAgent: "product-lead",
				answer: "Answer",
				dbPath,
			}),
		).rejects.toThrow("not found");
	});
});

describe("send/inbox round-trip", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-comm-sendinbox-"));
		dbPath = join(tmpDir, "comm.db");
		identityEnvs = createTestLeadIdentityEnvs(tmpDir, [
			"product-lead",
			"ops-lead",
		]);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should complete a send → inbox round-trip", async () => {
		const instId = await send({
			fromAgent: "product-lead",
			toAgent: "exec-123",
			content: "Stop current work and switch to GEO-999",
			dbPath,
		});
		expect(instId).toBeTruthy();

		const result = inbox({ execId: "exec-123", dbPath });
		expect(result.instructions).toHaveLength(1);
		expect(result.instructions[0]!.id).toBe(instId);
		expect(result.instructions[0]!.content).toBe(
			"Stop current work and switch to GEO-999",
		);
		expect(result.instructions[0]!.from_agent).toBe("product-lead");
	});

	it("should mark instructions as read after inbox retrieval", async () => {
		await send({
			fromAgent: "product-lead",
			toAgent: "exec-123",
			content: "Instruction 1",
			dbPath,
		});

		// First inbox call reads and marks as read
		const first = inbox({ execId: "exec-123", dbPath });
		expect(first.instructions).toHaveLength(1);

		// Second inbox call should return empty
		const second = inbox({ execId: "exec-123", dbPath });
		expect(second.instructions).toHaveLength(0);
	});

	it("renders absolute creation time with a dynamic age at pull", async () => {
		await send({
			fromAgent: "product-lead",
			toAgent: "exec-age",
			content: "Time-sensitive instruction",
			dbPath,
		});
		const instruction = inbox({ execId: "exec-age", dbPath }).instructions[0]!;
		const createdAtMs = Date.parse(instruction.created_at);

		const firstPull = renderInboxInstruction(instruction, createdAtMs + 60_000);
		const laterPull = renderInboxInstruction(
			instruction,
			createdAtMs + 11 * 60_000,
		);
		expect(firstPull).toContain(`created_at ${instruction.created_at}`);
		expect(firstPull).toContain("age at pull: 1 minute");
		expect(laterPull).toContain("age at pull: 11 minutes");
		expect(laterPull).toContain("Time-sensitive instruction");
	});

	it("should isolate instructions per runner", async () => {
		await send({
			fromAgent: "product-lead",
			toAgent: "exec-A",
			content: "For runner A",
			dbPath,
		});
		await send({
			fromAgent: "product-lead",
			toAgent: "exec-B",
			content: "For runner B",
			dbPath,
		});

		const inboxA = inbox({ execId: "exec-A", dbPath });
		expect(inboxA.instructions).toHaveLength(1);
		expect(inboxA.instructions[0]!.content).toBe("For runner A");

		const inboxB = inbox({ execId: "exec-B", dbPath });
		expect(inboxB.instructions).toHaveLength(1);
		expect(inboxB.instructions[0]!.content).toBe("For runner B");
	});

	it("should receive instructions from multiple leads", async () => {
		await send({
			fromAgent: "product-lead",
			toAgent: "exec-123",
			content: "From product",
			dbPath,
		});
		await send({
			fromAgent: "ops-lead",
			toAgent: "exec-123",
			content: "From ops",
			dbPath,
		});

		const result = inbox({ execId: "exec-123", dbPath });
		expect(result.instructions).toHaveLength(2);
		const contents = result.instructions.map((i) => i.content);
		expect(contents).toContain("From product");
		expect(contents).toContain("From ops");
	});

	it("should return empty instructions when DB does not exist", () => {
		const result = inbox({
			execId: "exec-123",
			dbPath: join(tmpDir, "nonexistent.db"),
		});
		expect(result.instructions).toHaveLength(0);
	});
});

describe("sessions command", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-comm-sessions-"));
		dbPath = join(tmpDir, "comm.db");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should list all registered sessions", () => {
		const db = new CommDB(dbPath);
		db.registerSession("exec-1", "GEO-1:@0", "geoforge3d", "GEO-100");
		db.registerSession("exec-2", "GEO-2:@1", "geoforge3d", "GEO-101");
		db.close();

		const result = sessions({ dbPath });
		expect(result).toHaveLength(2);
		expect(result[0]!.execution_id).toBe("exec-1");
		expect(result[1]!.execution_id).toBe("exec-2");
	});

	it("should filter active-only sessions", () => {
		const db = new CommDB(dbPath);
		db.registerSession("exec-1", "GEO-1:@0", "geoforge3d");
		db.registerSession("exec-2", "GEO-2:@1", "geoforge3d");
		db.updateSessionStatus("exec-1", "completed");
		db.close();

		const result = sessions({ dbPath, activeOnly: true });
		expect(result).toHaveLength(1);
		expect(result[0]!.execution_id).toBe("exec-2");
	});

	it("should return empty array when DB does not exist", () => {
		const result = sessions({
			dbPath: join(tmpDir, "nonexistent.db"),
		});
		expect(result).toHaveLength(0);
	});

	it("should filter sessions by leadId", () => {
		const db = new CommDB(dbPath);
		db.registerSession(
			"exec-1",
			"GEO-1:@0",
			"geoforge3d",
			"GEO-100",
			"product-lead",
		);
		db.registerSession(
			"exec-2",
			"GEO-2:@1",
			"geoforge3d",
			"GEO-101",
			"ops-lead",
		);
		db.registerSession(
			"exec-3",
			"GEO-3:@2",
			"geoforge3d",
			"GEO-102",
			"product-lead",
		);
		db.close();

		const productSessions = sessions({
			dbPath,
			leadId: "product-lead",
		});
		expect(productSessions).toHaveLength(2);
		expect(productSessions.map((s) => s.execution_id)).toEqual([
			"exec-1",
			"exec-3",
		]);

		const opsSessions = sessions({ dbPath, leadId: "ops-lead" });
		expect(opsSessions).toHaveLength(1);
		expect(opsSessions[0]!.execution_id).toBe("exec-2");
	});

	it("should return no sessions when leadId matches none", () => {
		const db = new CommDB(dbPath);
		db.registerSession(
			"exec-1",
			"GEO-1:@0",
			"geoforge3d",
			"GEO-100",
			"product-lead",
		);
		db.close();

		const result = sessions({ dbPath, leadId: "unknown-lead" });
		expect(result).toHaveLength(0);
	});
});

describe("cleanup-messages command", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-comm-cleanup-msg-"));
		dbPath = join(tmpDir, "comm.db");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should clean up read messages older than TTL", () => {
		// Setup: create a read instruction older than 24h
		const db = new CommDB(dbPath);
		const instId = db.insertInstruction("product-lead", "exec-1", "Old msg");
		db.markInstructionRead(instId);
		(db as any).db
			.prepare(
				"UPDATE mailbox SET state = 'ACKED', acked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-73 hours') WHERE id = ?",
			)
			.run(instId);
		db.close();

		const result = cleanupMessages({ dbPath });
		expect(result.cleaned).toBe(1);
	});

	it("should respect a custom TTL above the 72-hour retention floor", () => {
		const db = new CommDB(dbPath);
		const instId = db.insertInstruction(
			"product-lead",
			"exec-1",
			"96h old msg",
		);
		db.markInstructionRead(instId);
		(db as any).db
			.prepare(
				"UPDATE mailbox SET acked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-96 hours') WHERE id = ?",
			)
			.run(instId);
		db.close();

		expect(cleanupMessages({ dbPath, ttlHours: 120 }).cleaned).toBe(0);
		const raw = new Database(dbPath);
		raw
			.prepare(
				"UPDATE mailbox SET acked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-121 hours') WHERE id = ?",
			)
			.run(instId);
		raw.close();
		expect(cleanupMessages({ dbPath, ttlHours: 120 }).cleaned).toBe(1);
	});

	it("should return 0 when DB does not exist", () => {
		const result = cleanupMessages({
			dbPath: join(tmpDir, "nonexistent.db"),
		});
		expect(result.cleaned).toBe(0);
	});
});

describe("capture command", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-comm-capture-"));
		dbPath = join(tmpDir, "comm.db");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should throw when DB does not exist", () => {
		expect(() =>
			capture({
				execId: "exec-1",
				dbPath: join(tmpDir, "nonexistent.db"),
			}),
		).toThrow("Database not found");
	});

	it("should throw when session is not found", () => {
		// Create DB but no sessions
		const db = new CommDB(dbPath);
		db.close();

		expect(() => capture({ execId: "exec-nonexistent", dbPath })).toThrow(
			"No session found for execution",
		);
	});

	it("should throw when tmux window is not available", () => {
		// Register a session
		const db = new CommDB(dbPath);
		db.registerSession("exec-tmux", "GEO-FAKE:@99", "geoforge3d");
		db.close();

		// capture will try to exec tmux which will fail (no real tmux session)
		expect(() => capture({ execId: "exec-tmux", dbPath })).toThrow(
			"tmux window not found",
		);
	});
});

describe("ask --report (FLY-1041)", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-ask-report-"));
		dbPath = join(tmpDir, "comm.db");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("report:true marks the question kind='report'; default stays NULL", () => {
		const reportId = ask({
			lead: "lead-1",
			execId: "exec-1",
			question: "DONE: merged",
			dbPath,
			report: true,
		});
		const plainId = ask({
			lead: "lead-1",
			execId: "exec-1",
			question: "which db should I use?",
			dbPath,
		});
		const db = new CommDB(dbPath);
		try {
			expect(db.getMessageById(reportId)?.kind).toBe("report");
			expect(db.getMessageById(plainId)?.kind).toBeNull();
		} finally {
			db.close();
		}
	});
});
