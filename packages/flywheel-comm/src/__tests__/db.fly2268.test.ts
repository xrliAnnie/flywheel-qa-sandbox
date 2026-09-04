import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCommDbWritable } from "../commdb-open-gate.js";
import { prepareFly2268CommDbRebuild } from "../commdb-rebuild-preflight.js";
import { CommDB } from "../db.js";
import { MailboxQueue } from "../mailbox-queue.js";

function downgradeShutdownSchema(dbPath: string): void {
	const raw = new Database(dbPath);
	raw.exec(`
		DROP VIEW IF EXISTS messages;
		DROP VIEW IF EXISTS lead_inbox;
		DROP INDEX IF EXISTS idx_rsc_pending;
		ALTER TABLE runner_shutdown_controls RENAME TO runner_shutdown_controls_new;
		CREATE TABLE runner_shutdown_controls (
			execution_id TEXT PRIMARY KEY,
			request_id TEXT NOT NULL UNIQUE,
			state TEXT NOT NULL CHECK(state IN ('requested','acked','failed')),
			requested_at INTEGER NOT NULL,
			finished_at INTEGER,
			error TEXT
		);
		INSERT INTO runner_shutdown_controls
			(execution_id, request_id, state, requested_at, finished_at, error)
		SELECT execution_id, request_id, state, requested_at, finished_at, error
		FROM runner_shutdown_controls_new;
		DROP TABLE runner_shutdown_controls_new;
	`);
	raw.pragma("wal_checkpoint(TRUNCATE)");
	raw.close();
}

describe("FLY-2268 durable turn ledger", () => {
	let db: CommDB;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-2268-turn-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("starts a newly granted turn at generation one with no active daemon turn", () => {
		expect(db.grantTurn("FLY-2268", "worker-a", "worker", 100)).toBe(1);
		expect(db.getTurn("FLY-2268")).toMatchObject({
			turn_generation: 1,
			active_turn_id: null,
		});
	});

	it("marks one active daemon turn per execution generation", () => {
		db.registerSession("worker-a", "window-a", "flywheel", "FLY-2268", "lead");
		db.grantTurn("FLY-2268", "worker-a", "worker", 100);

		expect(db.markTurnStarted("worker-a", "turn-a")).toEqual({
			ok: true,
			turnGeneration: 1,
		});
		expect(db.getTurn("FLY-2268")?.active_turn_id).toBe("turn-a");
		expect(db.markTurnStarted("worker-a", "turn-a")).toEqual({
			ok: false,
			reason: "already_active",
		});
	});

	it("promotes only the completed generation's deferred wakes at the turn boundary", () => {
		db.registerSession("worker-a", "window-a", "flywheel", "FLY-2268", "lead");
		db.grantTurn("FLY-2268", "worker-a", "worker", 100);
		db.markTurnStarted("worker-a", "turn-a");
		const enqueued = db.enqueueRunnerPhaseWake(
			"worker-a",
			{ id: "wake-a", to: "worker-a", content: "read next turn" },
			101,
			{ admissionState: "deferred_midturn", turnGeneration: 1 },
		);
		expect(enqueued.wake).toMatchObject({
			admission_state: "deferred_midturn",
			turn_generation: 1,
		});

		expect(db.markTurnCompleted("worker-a", "turn-a")).toEqual({
			ok: true,
			promoted: 1,
		});
		expect(db.getTurn("FLY-2268")?.active_turn_id).toBeNull();
		expect(db.listRunnerPhaseWakes("worker-a")[0]).toMatchObject({
			admission_state: "queued",
			turn_generation: 1,
		});
	});

	it("clears the old active id, increments generation, and releases the old holder on handoff", () => {
		db.registerSession("worker-a", "window-a", "flywheel", "FLY-2268", "lead");
		db.registerSession("worker-b", "window-b", "flywheel", "FLY-2268", "lead");
		db.grantTurn("FLY-2268", "worker-a", "worker", 100);
		db.markTurnStarted("worker-a", "turn-a");
		db.enqueueRunnerPhaseWake(
			"worker-a",
			{ id: "wake-old", to: "worker-a", content: "handoff" },
			101,
			{ admissionState: "deferred_midturn", turnGeneration: 1 },
		);

		db.grantTurn("FLY-2268", "worker-b", "worker", 102);

		expect(db.getTurn("FLY-2268")).toMatchObject({
			holder_exec_id: "worker-b",
			turn_generation: 2,
			active_turn_id: null,
		});
		expect(db.listRunnerPhaseWakes("worker-a")[0].admission_state).toBe(
			"queued",
		);
		expect(db.markTurnCompleted("worker-a", "turn-a")).toEqual({
			ok: true,
			noop: true,
		});
	});

	it("reconciles an externally active turn without overwriting a different active id", () => {
		db.registerSession("worker-a", "window-a", "flywheel", "FLY-2268", "lead");
		db.grantTurn("FLY-2268", "worker-a", "worker", 100);

		expect(db.reconcileTurnState("worker-a", "turn-live")).toEqual({
			ok: true,
			turnGeneration: 1,
		});
		expect(db.reconcileTurnState("worker-a", "turn-live")).toEqual({
			ok: true,
			turnGeneration: 1,
		});
		expect(db.reconcileTurnState("worker-a", "turn-foreign")).toEqual({
			ok: false,
			reason: "active_turn_mismatch",
		});
		expect(db.getTurn("FLY-2268")?.active_turn_id).toBe("turn-live");
	});

	it("reconciles a completed or empty thread by releasing only deferred mail", () => {
		db.registerSession("worker-a", "window-a", "flywheel", "FLY-2268", "lead");
		db.grantTurn("FLY-2268", "worker-a", "worker", 100);
		db.markTurnStarted("worker-a", "turn-live");
		db.enqueueRunnerPhaseWake(
			"worker-a",
			{ id: "wake-deferred", to: "worker-a", content: "after boundary" },
			101,
			{ admissionState: "deferred_midturn", turnGeneration: 1 },
		);
		db.enqueueRunnerPhaseWake(
			"worker-a",
			{ id: "wake-unclassified", to: "worker-a", content: "after recovery" },
			102,
		);

		expect(db.reconcileTurnState("worker-a", null)).toEqual({
			ok: true,
			promoted: 1,
		});
		expect(db.getTurn("FLY-2268")?.active_turn_id).toBeNull();
		expect(
			db.listRunnerPhaseWakes("worker-a").map((wake) => wake.admission_state),
		).toEqual(["queued", null]);
	});

	it("classifies receiver delivery atomically against the durable active turn", () => {
		db.registerSession("worker-a", "window-a", "flywheel", "FLY-2268", "lead");
		db.grantTurn("FLY-2268", "worker-a", "worker", 100);
		db.markTurnStarted("worker-a", "turn-live");

		expect(
			db.enqueueRunnerReceiverWake(
				"worker-a",
				{ id: "mid-turn", to: "worker-a", content: "next boundary" },
				101,
			),
		).toMatchObject({
			kind: "queued",
			wake: { admission_state: "deferred_midturn", turn_generation: 1 },
		});

		db.markTurnCompleted("worker-a", "turn-live");
		expect(
			db.enqueueRunnerReceiverWake(
				"worker-a",
				{ id: "at-boundary", to: "worker-a", content: "read now" },
				102,
			),
		).toMatchObject({
			kind: "queued",
			wake: { admission_state: "queued", turn_generation: 1 },
		});
	});

	it("captures and verifies the exact completion-drain mail set", () => {
		db.registerSession(
			"worker-a",
			"window-a",
			"flywheel",
			"FLY-2268",
			"lead",
			"codex",
			true,
		);
		const mailId = db.insertInstruction(
			"lead",
			"worker-a",
			"finish this first",
		);
		db.enqueueRunnerPhaseWake(
			"worker-a",
			{ id: "wake-a", to: "worker-a", content: "next boundary" },
			101,
			{ admissionState: "queued", turnGeneration: 1 },
		);
		db.enqueueRunnerPhaseWake(
			"worker-b",
			{ id: "wake-a", to: "worker-b", content: "same id, other worker" },
			102,
			{ admissionState: "queued", turnGeneration: 1 },
		);
		db.markRunnerPhaseWakeStarted("worker-b", "wake-a", 103);
		db.finishRunnerPhaseWake("worker-b", "wake-a", 104);
		db.registerSession(
			"worker-a",
			"window-a-reattached",
			"flywheel",
			"FLY-2268",
			"lead",
		);

		const pending = db.getCompletionDrainPending("worker-a");
		expect(pending).toMatchObject({
			mailbox: [mailId],
			phaseWakes: ["wake-a"],
		});
		expect(
			db.getCompletionDrainVerification(
				"worker-a",
				pending.mailbox,
				pending.phaseWakes,
			),
		).toEqual({
			mailbox: { [mailId]: "QUEUED" },
			phaseWakes: { "wake-a": "pending" },
		});

		db.markInstructionRead(mailId);
		db.markRunnerPhaseWakeStarted("worker-a", "wake-a", 102);
		expect(
			db.getCompletionDrainVerification(
				"worker-a",
				pending.mailbox,
				pending.phaseWakes,
			),
		).toEqual({
			mailbox: { [mailId]: "ACKED" },
			phaseWakes: { "wake-a": "started" },
		});
	});

	it("does not challenge plain Codex executions with lifecycle-less phase wakes", () => {
		db.registerSession(
			"worker-a",
			"window-a",
			"flywheel",
			"FLY-2268",
			"lead",
			"codex",
			false,
		);
		db.enqueueRunnerPhaseWake(
			"worker-a",
			{ id: "wake-a", to: "worker-a", content: "no lifecycle reader" },
			101,
			{ admissionState: "queued", turnGeneration: 1 },
		);

		expect(db.getCompletionDrainPending("worker-a").phaseWakes).toEqual([]);
	});

	it("uses the same phase-keepalive predicate for receiver ingress and drain", () => {
		db.registerSession(
			"worker-a",
			"window-a",
			"flywheel",
			"FLY-2268",
			"lead",
			"claude-code",
			true,
		);
		expect(
			db.enqueueRunnerReceiverDelivery(
				"worker-a",
				{ id: "claude-wake", to: "worker-a", content: "unsupported" },
				101,
			),
		).toMatchObject({ kind: "queued" });
		expect(db.getCompletionDrainPending("worker-a").phaseWakes).toEqual([
			"claude-wake",
		]);
	});

	it("captures only mailbox rows the runner can pull and acknowledge", () => {
		const liveId = db.insertInstruction("lead", "worker-a", "live");
		const permanentId = db.insertInstruction("lead", "worker-a", "permanent");
		const expiredId = db.insertInstruction("lead", "worker-a", "expired");
		const leadId = db.insertInstruction("lead", "worker-a", "for lead");
		const externalId = db.insertInstruction("lead", "worker-a", "external");
		const eventId = db.insertInstruction("lead", "worker-a", "event");
		const raw = new Database(join(tmpDir, "comm.db"));
		try {
			raw
				.prepare("UPDATE mailbox SET expires_at = NULL WHERE id = ?")
				.run(permanentId);
			raw
				.prepare("UPDATE mailbox SET expires_at = ? WHERE id = ?")
				.run("2000-01-01T00:00:00.000Z", expiredId);
			raw
				.prepare("UPDATE mailbox SET recipient_kind = 'lead' WHERE id = ?")
				.run(leadId);
			raw
				.prepare("UPDATE mailbox SET carrier = 'external' WHERE id = ?")
				.run(externalId);
			raw
				.prepare("UPDATE mailbox SET type = 'progress' WHERE id = ?")
				.run(eventId);
		} finally {
			raw.close();
		}

		const drainMailbox = db.getCompletionDrainPending("worker-a").mailbox;
		expect(drainMailbox).toHaveLength(2);
		expect(drainMailbox).toEqual(expect.arrayContaining([liveId, permanentId]));
		const unread = db.getUnreadInstructions("worker-a").map((row) => row.id);
		expect(unread).toEqual(expect.arrayContaining(drainMailbox));
	});
});

describe("FLY-2268 exact runner shutdown requests", () => {
	let db: CommDB;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-2268-shutdown-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("keeps multiple exact requests and acknowledges every pending request on exit", () => {
		db.requestRunnerShutdown("worker-a", "land-cleanup", 200);
		db.requestRunnerShutdown("worker-a", "resident-expiry:worker-a:r1", 201);

		expect(db.listPendingRunnerShutdowns("worker-a")).toHaveLength(2);
		expect(
			db.getRunnerShutdownRequest("worker-a", "resident-expiry:worker-a:r1"),
		).toMatchObject({ state: "requested" });
		expect(
			db.finishAllPendingRunnerShutdowns("worker-a", { ok: true }, 202),
		).toBe(2);
		expect(
			db.getRunnerShutdownRequest("worker-a", "land-cleanup"),
		).toMatchObject({ state: "acked" });
		expect(
			db.getRunnerShutdownRequest("worker-a", "resident-expiry:worker-a:r1"),
		).toMatchObject({ state: "acked" });
	});

	it("does not take the migration lock on a current-schema writable open", () => {
		const dbPath = join(tmpDir, "comm.db");
		const blocker = new Database(dbPath);
		blocker.exec("BEGIN IMMEDIATE");
		let opened: Database.Database | undefined;
		try {
			expect(() => {
				opened = openCommDbWritable(dbPath);
			}).not.toThrow();
		} finally {
			opened?.close();
			blocker.exec("ROLLBACK");
			blocker.close();
		}
	});

	it("allows cross-execution request ids and settles failed history only once", () => {
		db.requestRunnerShutdown("worker-a", "shared-request", 200);
		db.requestRunnerShutdown("worker-b", "shared-request", 201);
		db.finishRunnerShutdown(
			"worker-a",
			"shared-request",
			{ ok: false, error: "old failure" },
			202,
		);

		expect(db.settleFailedRunnerShutdowns("worker-a", "superseded:new")).toBe(
			1,
		);
		expect(db.settleFailedRunnerShutdowns("worker-a", "ignored")).toBe(0);
		expect(
			db.getRunnerShutdownRequest("worker-a", "shared-request"),
		).toMatchObject({ state: "failed", settlement_reason: "superseded:new" });
		expect(
			db.getRunnerShutdownRequest("worker-b", "shared-request"),
		).toMatchObject({ state: "requested", settlement_reason: null });
	});

	it("keeps legacy writers available before the Bridge publishes a receipt and warns once", () => {
		const dbPath = join(tmpDir, "legacy.db");
		db.close();
		db = new CommDB(dbPath);
		db.requestRunnerShutdown("worker-a", "legacy-request", 100);
		db.close();
		downgradeShutdownSchema(dbPath);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const first = new CommDB(dbPath);
		first.insertInstruction("lead", "worker-a", "deploy-window-write");
		first.close();
		const second = new CommDB(dbPath);
		expect(second.getUnreadInstructions("worker-a")).toHaveLength(1);
		second.close();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("FLY-2268");
		warn.mockRestore();
	});

	it("keeps path-based mailbox writers available before the receipt exists", () => {
		const dbPath = join(tmpDir, "legacy-mailbox.db");
		db.close();
		db = new CommDB(dbPath);
		db.requestRunnerShutdown("worker-a", "legacy-request", 100);
		db.close();
		downgradeShutdownSchema(dbPath);
		const queue = new MailboxQueue(dbPath);
		expect(queue).toBeInstanceOf(MailboxQueue);
		queue.close();
	});

	it("keeps legacy writers available when a published receipt becomes stale", async () => {
		const dbPath = join(tmpDir, "stale-receipt.db");
		db.close();
		db = new CommDB(dbPath);
		db.requestRunnerShutdown("worker-a", "legacy-request", 100);
		db.close();
		downgradeShutdownSchema(dbPath);
		await prepareFly2268CommDbRebuild(dbPath);

		const concurrent = new Database(dbPath);
		concurrent
			.prepare(
				"UPDATE runner_shutdown_controls SET requested_at = ? WHERE execution_id = ?",
			)
			.run(101, "worker-a");
		concurrent.close();

		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(() => {
			db = new CommDB(dbPath);
			db.insertInstruction("lead", "worker-a", "stale-window-write");
		}).not.toThrow();
		expect(db.getUnreadInstructions("worker-a")).toHaveLength(1);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("commdb_schema_preflight_stale"),
		);
		const inspected = new Database(dbPath, { readonly: true });
		const columns = inspected
			.prepare("PRAGMA table_info(runner_shutdown_controls)")
			.all() as Array<{ name: string; pk: number }>;
		inspected.close();
		expect(columns.find((column) => column.name === "execution_id")?.pk).toBe(
			1,
		);
		expect(columns.find((column) => column.name === "request_id")?.pk).toBe(0);
		warn.mockRestore();
	});

	it("rebuilds the legacy primary key only from a source-bound verified backup", async () => {
		const dbPath = join(tmpDir, "migration.db");
		db.close();
		db = new CommDB(dbPath);
		db.requestRunnerShutdown("worker-a", "legacy-request", 100);
		db.close();
		downgradeShutdownSchema(dbPath);

		const receipt = await prepareFly2268CommDbRebuild(dbPath);
		expect(receipt?.backupPath).toContain(".pre-fly2268-");
		db = new CommDB(dbPath);
		expect(
			db.getRunnerShutdownRequest("worker-a", "legacy-request"),
		).toMatchObject({ state: "requested", settlement_reason: null });
		db.close();

		const inspected = new Database(dbPath, { readonly: true });
		const columns = inspected
			.prepare("PRAGMA table_info(runner_shutdown_controls)")
			.all() as Array<{ name: string; pk: number }>;
		inspected.close();
		expect(columns.find((column) => column.name === "execution_id")?.pk).toBe(
			1,
		);
		expect(columns.find((column) => column.name === "request_id")?.pk).toBe(2);
		expect(columns.some((column) => column.name === "settlement_reason")).toBe(
			true,
		);
		expect(
			readdirSync(tmpDir).some((name) =>
				name.includes("fly2268-rebuild-receipt.json.consumed-"),
			),
		).toBe(true);
	});

	it("lets the losing concurrent writer recheck the migrated schema after the lock", async () => {
		const dbPath = join(tmpDir, "concurrent-migration.db");
		db.close();
		db = new CommDB(dbPath);
		db.requestRunnerShutdown("seed", "seed-request", 100);
		db.close();
		downgradeShutdownSchema(dbPath);
		const seed = new Database(dbPath);
		const insert = seed.prepare(
			`INSERT INTO runner_shutdown_controls
				 (execution_id, request_id, state, requested_at)
				 VALUES (?, ?, 'requested', ?)`,
		);
		seed.transaction(() => {
			for (let index = 0; index < 20_000; index += 1) {
				insert.run(`seed-${index}`, `request-${index}`, 101 + index);
			}
		})();
		seed.pragma("wal_checkpoint(TRUNCATE)");
		seed.close();
		await prepareFly2268CommDbRebuild(dbPath);

		const fixture = join(
			fileURLToPath(new URL(".", import.meta.url)),
			"fixtures/fly2268-open-writer.ts",
		);
		const tsx = join(process.cwd(), "../../node_modules/.bin/tsx");
		const startPath = join(tmpDir, "start");
		const launches = ["writer-a", "writer-b"].map((executionId) => {
			const readyPath = join(tmpDir, `${executionId}.ready`);
			const child = spawn(
				tsx,
				[fixture, dbPath, executionId, readyPath, startPath],
				{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
			);
			let stderr = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			return {
				readyPath,
				exit: new Promise<{ code: number | null; stderr: string }>((resolve) =>
					child.once("exit", (code) => resolve({ code, stderr })),
				),
			};
		});
		const readyDeadline = Date.now() + 10_000;
		while (
			launches.some(({ readyPath }) => !existsSync(readyPath)) &&
			Date.now() < readyDeadline
		) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(launches.every(({ readyPath }) => existsSync(readyPath))).toBe(true);
		writeFileSync(startPath, "go", "utf8");
		const exits = await Promise.all(launches.map(({ exit }) => exit));
		expect(exits.map(({ code }) => code)).toEqual([0, 0]);
		for (const { stderr } of exits) {
			expect(stderr).toMatch(
				/^(?:\[FLY-2268\] commdb_schema_preflight_stale: source binding mismatch; legacy CommDB remains writable until Bridge refreshes .+\n)?$/,
			);
		}

		db = new CommDB(dbPath);
		expect(db.getUnreadInstructions("writer-a")).toHaveLength(1);
		expect(db.getUnreadInstructions("writer-b")).toHaveLength(1);
	}, 20_000);
});
