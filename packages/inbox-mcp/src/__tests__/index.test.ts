import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Utility matching the Bridge-side isLeaseAlive() check
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ── Test suite for poll logic ──
// Tests exercise the same SQL queries used by the inbox-mcp server,
// using flywheel-comm's CommDB for DB access (shared native bindings).

describe("inbox-mcp poll logic", () => {
	let testDir: string;
	let db: CommDB;
	const leadId = "test-lead";

	beforeEach(() => {
		testDir = join(tmpdir(), `inbox-mcp-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		db = new CommDB(join(testDir, "comm.db"));
	});

	afterEach(() => {
		db?.close();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("returns unread instructions for the target lead", () => {
		db.insertInstruction("bridge", leadId, "event 1");
		db.insertInstruction("bridge", leadId, "event 2");
		db.insertInstruction("bridge", "other-lead", "not for us");

		const messages = db.getUnreadInstructions(leadId);
		expect(messages).toHaveLength(2);
		expect(messages[0].content).toBe("event 1");
		expect(messages[1].content).toBe("event 2");
	});

	it("marks messages as read after processing", () => {
		const id = db.insertInstruction("bridge", leadId, "event 1");

		expect(db.getUnreadInstructions(leadId)).toHaveLength(1);

		db.markInstructionRead(id);

		expect(db.getUnreadInstructions(leadId)).toHaveLength(0);
	});

	it("returns empty array when no unread messages", () => {
		expect(db.getUnreadInstructions(leadId)).toHaveLength(0);
	});

	it("preserves FIFO ordering by created_at", () => {
		// Insert two messages — they get sequential created_at timestamps
		const id1 = db.insertInstruction("bridge", leadId, "first");
		const id2 = db.insertInstruction("bridge", leadId, "second");

		const messages = db.getUnreadInstructions(leadId);
		expect(messages[0].content).toBe("first");
		expect(messages[1].content).toBe("second");
	});

	it("only marks read one message at a time (at-least-once safety)", () => {
		const id1 = db.insertInstruction("bridge", leadId, "event 1");
		db.insertInstruction("bridge", leadId, "event 2");

		db.markInstructionRead(id1);

		const remaining = db.getUnreadInstructions(leadId);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].content).toBe("event 2");
	});

	it("handles multiple messages from different agents", () => {
		db.insertInstruction("bridge", leadId, "from bridge");
		db.insertInstruction("runner-1", leadId, "from runner");

		const messages = db.getUnreadInstructions(leadId);
		expect(messages).toHaveLength(2);
		expect(messages[0].from_agent).toBe("bridge");
		expect(messages[1].from_agent).toBe("runner-1");
	});
});

describe("inbox-mcp lease management", () => {
	let testDir: string;
	const leadId = "test-lead";

	beforeEach(() => {
		testDir = join(tmpdir(), `inbox-mcp-lease-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("writes a valid PID lease file", () => {
		const leasePath = join(testDir, `.inbox-ready-${leadId}`);
		const lease = { pid: process.pid, startedAt: new Date().toISOString() };
		writeFileSync(leasePath, JSON.stringify(lease));

		expect(existsSync(leasePath)).toBe(true);
		const parsed = JSON.parse(readFileSync(leasePath, "utf-8"));
		expect(parsed.pid).toBe(process.pid);
		expect(parsed.startedAt).toBeTruthy();
	});

	it("lease PID check succeeds for running process", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	it("lease PID check fails for non-existent process", () => {
		expect(isProcessAlive(99999999)).toBe(false);
	});

	it("deletes stale lease on cleanup", () => {
		const leasePath = join(testDir, `.inbox-ready-${leadId}`);
		writeFileSync(
			leasePath,
			JSON.stringify({ pid: 1, startedAt: "2020-01-01" }),
		);
		expect(existsSync(leasePath)).toBe(true);

		unlinkSync(leasePath);
		expect(existsSync(leasePath)).toBe(false);
	});
});
