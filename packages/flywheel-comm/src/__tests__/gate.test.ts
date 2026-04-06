import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GateArgs, gate } from "../commands/gate.js";
import { CommDB } from "../db.js";

describe("gate command", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-gate-test-"));
		dbPath = join(tmpDir, "comm.db");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function baseArgs(overrides?: Partial<GateArgs>): GateArgs {
		return {
			checkpoint: "brainstorm",
			lead: "product-lead",
			execId: "runner-1",
			message: "My understanding of the task",
			dbPath,
			timeoutMs: 500, // short timeout for tests
			timeoutBehavior: "fail-close",
			cleanupTtlHours: 24,
			pollIntervalMs: 50, // fast polling for tests
			...overrides,
		};
	}

	it("should timeout with fail-close and exit 1", async () => {
		const result = await gate(baseArgs());
		expect(result.status).toBe("timeout");
		expect(result.exitCode).toBe(1);
	});

	it("should timeout with fail-open and exit 0", async () => {
		const result = await gate(baseArgs({ timeoutBehavior: "fail-open" }));
		expect(result.status).toBe("timeout");
		expect(result.exitCode).toBe(0);
	});

	it("should return answered when response is provided", async () => {
		// Start gate in background
		const gatePromise = gate(baseArgs({ timeoutMs: 5000 }));

		// Wait for question to be created
		await sleep(100);

		// Find the question and respond
		const db = new CommDB(dbPath);
		try {
			const questions = db.getPendingQuestions("product-lead");
			expect(questions.length).toBe(1);
			expect(questions[0].checkpoint).toBe("brainstorm");

			db.insertResponse(
				questions[0].id,
				"product-lead",
				"Looks good, proceed!",
			);
		} finally {
			db.close();
		}

		const result = await gatePromise;
		expect(result.status).toBe("answered");
		expect(result.content).toBe("Looks good, proceed!");
		expect(result.exitCode).toBe(0);
	});

	it("should parse approved field from JSON response", async () => {
		const gatePromise = gate(baseArgs({ timeoutMs: 5000 }));
		await sleep(100);

		const db = new CommDB(dbPath);
		try {
			const questions = db.getPendingQuestions("product-lead");
			db.insertResponse(
				questions[0].id,
				"product-lead",
				JSON.stringify({ approved: true, feedback: "Great plan!" }),
			);
		} finally {
			db.close();
		}

		const result = await gatePromise;
		expect(result.status).toBe("answered");
		expect(result.approved).toBe(true);
	});

	it("should create question with checkpoint column", async () => {
		// Start gate then immediately check DB
		const gatePromise = gate(baseArgs({ timeoutMs: 200 }));
		await sleep(50);

		const db = new CommDB(dbPath);
		try {
			const questions = db.getPendingQuestions("product-lead");
			expect(questions.length).toBe(1);
			expect(questions[0].checkpoint).toBe("brainstorm");
			expect(questions[0].from_agent).toBe("runner-1");
			expect(questions[0].to_agent).toBe("product-lead");
		} finally {
			db.close();
		}

		await gatePromise; // let it timeout
	});

	it("should use content_ref for messages over threshold", async () => {
		const longMessage = "x".repeat(3000); // > 2KB
		const gatePromise = gate(
			baseArgs({ message: longMessage, timeoutMs: 200 }),
		);
		await sleep(50);

		const db = new CommDB(dbPath);
		try {
			const questions = db.getPendingQuestions("product-lead");
			expect(questions.length).toBe(1);
			expect(questions[0].content_type).toBe("ref");
			expect(questions[0].content_ref).toBeTruthy();
		} finally {
			db.close();
		}

		await gatePromise;
	});

	it("should return error with exit 0 on infrastructure failure (fail-open)", async () => {
		// Use a non-existent path to trigger DB open failure
		const result = await gate(
			baseArgs({
				dbPath: "/nonexistent/path/comm.db",
				timeoutBehavior: "fail-open",
			}),
		);
		expect(result.status).toBe("error");
		expect(result.exitCode).toBe(0);
	});

	it("should expire orphaned question on post-insert failure (fail-open)", async () => {
		// Create a working DB first so question insert succeeds
		const setupDb = new CommDB(dbPath);
		setupDb.close();

		// Spy on CommDB.openReadonly to throw after question is created (simulating poll failure)
		const originalOpenReadonly = CommDB.openReadonly;
		let callCount = 0;
		vi.spyOn(CommDB, "openReadonly").mockImplementation((...args) => {
			callCount++;
			throw new Error("Simulated DB read failure");
		});

		try {
			const result = await gate(
				baseArgs({
					timeoutBehavior: "fail-open",
					timeoutMs: 200,
					pollIntervalMs: 50,
				}),
			);

			expect(result.status).toBe("error");
			expect(result.exitCode).toBe(0);

			// Verify: the orphaned question should be expired (not in pending)
			const checkDb = new CommDB(dbPath);
			try {
				const pending = checkDb.getPendingQuestions("product-lead");
				expect(pending.length).toBe(0); // expired by cleanup
			} finally {
				checkDb.close();
			}
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("should throw on infrastructure failure (fail-close)", async () => {
		await expect(
			gate(
				baseArgs({
					dbPath: "/nonexistent/path/comm.db",
					timeoutBehavior: "fail-close",
				}),
			),
		).rejects.toThrow();
	});

	it("should resolve gate (mark read + shorten TTL) after answer", async () => {
		const gatePromise = gate(baseArgs({ timeoutMs: 5000 }));
		await sleep(100);

		const db = new CommDB(dbPath);
		let questionId: string;
		try {
			const questions = db.getPendingQuestions("product-lead");
			questionId = questions[0].id;
			db.insertResponse(questionId, "product-lead", "OK");
		} finally {
			db.close();
		}

		await gatePromise;

		// Verify question is resolved
		const db2 = new CommDB(dbPath);
		try {
			const pending = db2.getPendingQuestions("product-lead");
			expect(pending.length).toBe(0); // no longer pending
		} finally {
			db2.close();
		}
	});
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
