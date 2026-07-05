import { mkdtempSync, rmSync } from "node:fs";
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

	it("FLY-208 6c-②: approve_to_ship + plain-text reply → caution line appended", async () => {
		// Production incident: the blocking gate returned the Lead's raw
		// "APPROVE — ..." text and the Runner merged on it BEFORE
		// verify-approval. Non-structured-approval answers on approve_to_ship
		// now carry an explicit caution.
		const gatePromise = gate(
			baseArgs({ checkpoint: "approve_to_ship", timeoutMs: 5000 }),
		);
		await sleep(100);
		const db = new CommDB(dbPath);
		try {
			const questions = db.getPendingQuestions("product-lead");
			db.insertResponse(
				questions[0].id,
				"product-lead",
				"APPROVE — founder 批准在案,可以 merge",
			);
		} finally {
			db.close();
		}
		const result = await gatePromise;
		expect(result.status).toBe("answered");
		expect(result.approved).toBeUndefined();
		expect(result.content).toContain("APPROVE — founder 批准在案");
		expect(result.content).toContain(
			"NOT verified approval — run verify-approval before any merge",
		);
	});

	it("FLY-208 6c-②: approve_to_ship + structured JSON approval → NO caution line", async () => {
		const gatePromise = gate(
			baseArgs({ checkpoint: "approve_to_ship", timeoutMs: 5000 }),
		);
		await sleep(100);
		const db = new CommDB(dbPath);
		try {
			const questions = db.getPendingQuestions("product-lead");
			db.insertResponse(
				questions[0].id,
				"product-lead",
				JSON.stringify({ approved: true }),
			);
		} finally {
			db.close();
		}
		const result = await gatePromise;
		expect(result.approved).toBe(true);
		expect(result.content).not.toContain("NOT verified approval");
	});

	it("FLY-208 6c-②: non-approve checkpoints keep replies undecorated", async () => {
		const gatePromise = gate(baseArgs({ timeoutMs: 5000 })); // brainstorm
		await sleep(100);
		const db = new CommDB(dbPath);
		try {
			const questions = db.getPendingQuestions("product-lead");
			db.insertResponse(questions[0].id, "product-lead", "Looks good!");
		} finally {
			db.close();
		}
		const result = await gatePromise;
		expect(result.content).toBe("Looks good!");
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
		const _originalOpenReadonly = CommDB.openReadonly;
		let _callCount = 0;
		vi.spyOn(CommDB, "openReadonly").mockImplementation((..._args) => {
			_callCount++;
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

	// ─── FLY-159 ──────────────────────────────────────────────────────────────

	describe("FLY-159 timeout cleanup + event reporting", () => {
		const ORIG_ENV = { ...process.env };

		beforeEach(() => {
			process.env.FLYWHEEL_BRIDGE_URL = "http://bridge.test";
			process.env.FLYWHEEL_EXEC_ID = "runner-1";
			process.env.FLYWHEEL_ISSUE_ID = "issue-uuid-1";
			process.env.FLYWHEEL_PROJECT_NAME = "flywheel-test";
		});

		afterEach(() => {
			process.env = { ...ORIG_ENV };
			vi.restoreAllMocks();
		});

		it("fail-close timeout cleans up CommDB question (getPendingQuestions empty)", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(null, { status: 204 }),
			);

			const result = await gate(
				baseArgs({ timeoutBehavior: "fail-close", timeoutMs: 200 }),
			);
			expect(result.status).toBe("timeout");
			expect(result.exitCode).toBe(1);

			const db = new CommDB(dbPath);
			try {
				expect(db.getPendingQuestions("product-lead").length).toBe(0);
			} finally {
				db.close();
			}
		});

		it("fail-open timeout cleans up CommDB question too", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(null, { status: 204 }),
			);

			const result = await gate(
				baseArgs({ timeoutBehavior: "fail-open", timeoutMs: 200 }),
			);
			expect(result.status).toBe("timeout");
			expect(result.exitCode).toBe(0);

			const db = new CommDB(dbPath);
			try {
				expect(db.getPendingQuestions("product-lead").length).toBe(0);
			} finally {
				db.close();
			}
		});

		it("fail-close timeout POSTs gate_timed_out event to Bridge with full payload", async () => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response(null, { status: 204 }));

			await gate(
				baseArgs({
					timeoutBehavior: "fail-close",
					timeoutMs: 200,
					timeoutBehaviorSource: "default",
					message: "My understanding of the task",
				}),
			);

			// Find the gate_timed_out POST (Phase 1b stage POST is absent since no stage arg)
			const gateCall = fetchSpy.mock.calls.find((call) => {
				const body = JSON.parse(String(call[1]?.body ?? "{}"));
				return body.event_type === "gate_timed_out";
			});
			expect(gateCall).toBeDefined();
			const [url, init] = gateCall!;
			expect(url).toBe("http://bridge.test/events");
			const body = JSON.parse(String(init?.body ?? "{}"));
			expect(body.event_type).toBe("gate_timed_out");
			expect(body.execution_id).toBe("runner-1");
			expect(body.issue_id).toBe("issue-uuid-1");
			expect(body.project_name).toBe("flywheel-test");
			expect(body.source).toBe("flywheel-comm");
			expect(body.payload.checkpoint).toBe("brainstorm");
			expect(body.payload.exec_id).toBe("runner-1");
			expect(body.payload.lead_id).toBe("product-lead");
			expect(body.payload.timeout_behavior).toBe("fail-close");
			expect(body.payload.timeout_behavior_source).toBe("default");
			expect(body.payload.original_message).toBe(
				"My understanding of the task",
			);
			expect(body.payload.question_id).toBeTruthy();
			expect(typeof body.payload.waited_ms).toBe("number");
			expect(body.payload.waited_ms).toBeGreaterThan(0);
		});

		it("fail-open timeout does NOT POST gate_timed_out (Codex R2 Issue 2)", async () => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response(null, { status: 204 }));

			await gate(baseArgs({ timeoutBehavior: "fail-open", timeoutMs: 200 }));

			const gateCall = fetchSpy.mock.calls.find((call) => {
				const body = JSON.parse(String(call[1]?.body ?? "{}"));
				return body.event_type === "gate_timed_out";
			});
			expect(gateCall).toBeUndefined();
		});

		it("fail-close still exits 1 even when Bridge POST fails", async () => {
			vi.spyOn(globalThis, "fetch").mockRejectedValue(
				new Error("ECONNREFUSED"),
			);

			const result = await gate(
				baseArgs({ timeoutBehavior: "fail-close", timeoutMs: 200 }),
			);
			expect(result.status).toBe("timeout");
			expect(result.exitCode).toBe(1);
		});

		it("timeoutBehaviorSource defaults to 'default' when not provided", async () => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response(null, { status: 204 }));

			await gate(
				baseArgs({
					timeoutBehavior: "fail-close",
					timeoutMs: 200,
					// timeoutBehaviorSource intentionally omitted
				}),
			);

			const gateCall = fetchSpy.mock.calls.find((call) => {
				const body = JSON.parse(String(call[1]?.body ?? "{}"));
				return body.event_type === "gate_timed_out";
			});
			expect(gateCall).toBeDefined();
			const body = JSON.parse(String(gateCall![1]?.body ?? "{}"));
			expect(body.payload.timeout_behavior_source).toBe("default");
		});

		it("timeoutBehaviorSource='flag' propagates into payload", async () => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response(null, { status: 204 }));

			await gate(
				baseArgs({
					timeoutBehavior: "fail-close",
					timeoutMs: 200,
					timeoutBehaviorSource: "flag",
				}),
			);

			const gateCall = fetchSpy.mock.calls.find((call) => {
				const body = JSON.parse(String(call[1]?.body ?? "{}"));
				return body.event_type === "gate_timed_out";
			});
			const body = JSON.parse(String(gateCall![1]?.body ?? "{}"));
			expect(body.payload.timeout_behavior_source).toBe("flag");
		});

		it("truncates original_message > 500 chars in payload", async () => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response(null, { status: 204 }));
			const longMessage = "a".repeat(600);

			await gate(
				baseArgs({
					timeoutBehavior: "fail-close",
					timeoutMs: 200,
					message: longMessage,
				}),
			);

			const gateCall = fetchSpy.mock.calls.find((call) => {
				const body = JSON.parse(String(call[1]?.body ?? "{}"));
				return body.event_type === "gate_timed_out";
			});
			const body = JSON.parse(String(gateCall![1]?.body ?? "{}"));
			// 500 chars + ellipsis "…"
			expect(body.payload.original_message.length).toBe(501);
			expect(body.payload.original_message.endsWith("…")).toBe(true);
		});

		it("does NOT POST event when FLYWHEEL_BRIDGE_URL is unset", async () => {
			process.env.FLYWHEEL_BRIDGE_URL = "";
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response(null, { status: 204 }));

			await gate(baseArgs({ timeoutBehavior: "fail-close", timeoutMs: 200 }));

			const gateCall = fetchSpy.mock.calls.find((call) => {
				const body = JSON.parse(String(call[1]?.body ?? "{}"));
				return body.event_type === "gate_timed_out";
			});
			expect(gateCall).toBeUndefined();
		});
	});
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
