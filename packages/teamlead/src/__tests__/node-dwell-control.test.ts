import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeFlagStore } from "../bridge/flag-store-runtime.js";
import {
	ReceiptBusyError,
	ReceiptRejectedError,
	readNodeDwellEnabled,
	readNodeDwellThresholdHours,
	readOpenApproveGates,
	runNodeDwellControl,
	writeNodeDwellReviewBatch,
} from "../node-dwell-control.js";
import { StateStore } from "../StateStore.js";

const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("FLY-2210 node dwell control", () => {
	it("reads and projects the hot project-scoped master switch", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2210-enabled-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const writer = await StateStore.create(dbPath);
		initializeFlagStore(writer, {});
		writer.close();

		await expect(readNodeDwellEnabled(dbPath, "flywheel")).resolves.toBe(true);
		const off = await StateStore.create(dbPath);
		expect(
			off.applyScopedFlagValueChange({
				name: "node_dwell",
				scope: "flywheel",
				op: "set",
				rawTo: "0",
				expectedChangeSeq: 0,
				actor: "fixture",
				reason: "pause node dwell patrol",
			}),
		).toMatchObject({ ok: true });
		off.close();
		await expect(readNodeDwellEnabled(dbPath, "flywheel")).resolves.toBe(false);

		const stdout: string[] = [];
		const stderr: string[] = [];
		await expect(
			runNodeDwellControl(
				["enabled", "--db", dbPath, "--project", "flywheel"],
				{
					stdout: (line) => stdout.push(line),
					stderr: (line) => stderr.push(line),
				},
			),
		).resolves.toBe(0);
		expect(stdout).toEqual(["NODE_DWELL_ENABLED project=flywheel enabled=no"]);
		expect(stderr).toEqual([]);
	});

	it("reads project, star, then default threshold through readonly StateStore maintenance", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2210-threshold-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const writer = await StateStore.create(dbPath);
		initializeFlagStore(writer, {});
		expect(
			writer.applyScopedFlagValueChange({
				name: "node_dwell_threshold_hours",
				scope: "*",
				op: "set",
				rawTo: "4",
				expectedChangeSeq: 0,
				actor: "fixture",
				reason: "wildcard fixture",
			}),
		).toMatchObject({ ok: true });
		expect(
			writer.applyScopedFlagValueChange({
				name: "node_dwell_threshold_hours",
				scope: "flywheel",
				op: "set",
				rawTo: "1.5",
				expectedChangeSeq: 0,
				actor: "fixture",
				reason: "project fixture",
			}),
		).toMatchObject({ ok: true });
		writer.close();

		const open = vi.spyOn(StateStore, "openForMaintenance");
		const create = vi.spyOn(StateStore, "create");
		await expect(readNodeDwellThresholdHours(dbPath, "flywheel")).resolves.toBe(
			1.5,
		);
		await expect(
			readNodeDwellThresholdHours(dbPath, "geoforge3d"),
		).resolves.toBe(4);
		await expect(
			readNodeDwellThresholdHours(dbPath, "defaulted"),
		).resolves.toBe(4);
		expect(open).toHaveBeenCalledWith(dbPath, { readonly: true });
		expect(create).not.toHaveBeenCalled();
	});

	it("fails closed with stable maintenance errors for missing and drifted databases", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2210-threshold-error-"));
		roots.push(root);
		const missing = join(root, "missing.db");
		await expect(readNodeDwellEnabled(missing, "flywheel")).rejects.toThrow(
			/NODE_DWELL_UNAVAILABLE maintenance_database_missing/,
		);
		await expect(
			readNodeDwellThresholdHours(missing, "flywheel"),
		).rejects.toThrow(/NODE_DWELL_UNAVAILABLE maintenance_database_missing/);

		const drifted = join(root, "drifted.db");
		const raw = new Database(drifted);
		raw.exec("CREATE TABLE workflow_run (run_id TEXT PRIMARY KEY)");
		raw.close();
		await expect(readNodeDwellEnabled(drifted, "flywheel")).rejects.toThrow(
			/NODE_DWELL_UNAVAILABLE maintenance_schema_mismatch/,
		);
		await expect(
			readNodeDwellThresholdHours(drifted, "flywheel"),
		).rejects.toThrow(/NODE_DWELL_UNAVAILABLE maintenance_schema_mismatch/);

		const missingFlags = join(root, "missing-flags.db");
		const initialized = await StateStore.create(missingFlags);
		initializeFlagStore(initialized, {});
		initialized.close();
		const withoutFlags = new Database(missingFlags);
		withoutFlags.exec("DROP TABLE flag_values");
		withoutFlags.close();
		await expect(
			readNodeDwellEnabled(missingFlags, "flywheel"),
		).rejects.toThrow(/NODE_DWELL_UNAVAILABLE maintenance_schema_mismatch/);
	});

	it("uses stable question-domain and invalid-threshold projections", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2210-question-domain-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const commDbPath = join(root, "comm.db");
		const writer = await StateStore.create(dbPath);
		initializeFlagStore(writer, {});
		expect(
			writer.applyScopedFlagValueChange({
				name: "node_dwell_threshold_hours",
				scope: "flywheel",
				op: "set",
				rawTo: "1.5",
				expectedChangeSeq: 0,
				actor: "fixture",
				reason: "seed corruptible project override",
			}),
		).toMatchObject({ ok: true });
		writer.close();
		const corrupt = new Database(dbPath);
		expect(
			corrupt
				.prepare(
					`UPDATE flag_values SET has_override = 1, raw_value = '-1'
				  WHERE flag_name = 'node_dwell_threshold_hours' AND scope = 'flywheel'`,
				)
				.run().changes,
		).toBe(1);
		corrupt.close();
		await expect(
			readNodeDwellThresholdHours(dbPath, "flywheel"),
		).rejects.toThrow(/NODE_DWELL_UNAVAILABLE threshold_invalid/);

		const comm = new CommDB(commDbPath);
		comm.insertQuestion("exec-open", "flywheel-eng-lead", "approve", {
			id: "q-open",
			checkpoint: "approve_to_ship",
		});
		comm.close();
		const openReadonly = vi.spyOn(CommDB, "openReadonly");
		const getOpen = vi.spyOn(CommDB.prototype, "getOpenGatesByCheckpoint");
		expect(readOpenApproveGates(commDbPath)).toEqual([
			{ questionId: "q-open", fromAgent: "exec-open" },
		]);
		expect(openReadonly).toHaveBeenCalledWith(commDbPath);
		expect(getOpen).toHaveBeenCalledWith("approve_to_ship");
	});

	it("writes an atomic same-issue receipt batch after exact active-node and owner validation", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2210-receipts-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const commDbPath = join(root, "comm.db");
		const store = await StateStore.create(dbPath);
		store.close();
		const state = new Database(dbPath);
		state.exec(`
			INSERT INTO workflow_run(run_id, issue_id, project_name, status, created_at)
			VALUES ('run-1','FLY-2210','flywheel','active',datetime('now'));
			INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
			VALUES
			 ('run-1','implement',1,'running','exec-1',datetime('now','-4 hours')),
			 ('run-1','founder_gate',1,'review','exec-2',datetime('now','-4 hours'));
		`);
		state.close();
		const comm = new CommDB(commDbPath);
		comm.registerSession(
			"exec-1",
			"runner-flywheel:pending",
			"flywheel",
			"FLY-2210",
			"flywheel-eng-lead",
		);
		comm.registerSession(
			"exec-2",
			"runner-flywheel:pending",
			"flywheel",
			"FLY-2210",
			"flywheel-eng-lead",
		);
		comm.close();

		const base = {
			dbPath,
			commDbPath,
			projectName: "flywheel",
			callerLeadId: "flywheel-eng-lead",
			environmentLeadId: "flywheel-eng-lead",
			verdict: "waiting_founder" as const,
			note: "grouped founder reminder delivered",
		};
		await expect(
			writeNodeDwellReviewBatch({
				...base,
				items: [
					{ runId: "run-1", nodeId: "implement", attempt: 1 },
					{ runId: "run-1", nodeId: "missing", attempt: 1 },
				],
			}),
		).rejects.toBeInstanceOf(ReceiptRejectedError);
		const verify = new Database(dbPath, { readonly: true });
		expect(verify.prepare("SELECT * FROM node_dwell_review").all()).toEqual([]);
		verify.close();

		const written = await writeNodeDwellReviewBatch({
			...base,
			items: [
				{ runId: "run-1", nodeId: "implement", attempt: 1 },
				{ runId: "run-1", nodeId: "founder_gate", attempt: 1 },
			],
		});
		expect(written).toMatchObject({
			issueId: "FLY-2210",
			written: 2,
			cycles: [
				{ nodeId: "implement", cycleNo: 1 },
				{ nodeId: "founder_gate", cycleNo: 1 },
			],
		});
		const receipts = new Database(dbPath, { readonly: true })
			.prepare(
				"SELECT node_id, cycle_no, verdict, examined_at, examined_by, note FROM node_dwell_review ORDER BY node_id",
			)
			.all();
		expect(receipts).toEqual([
			expect.objectContaining({
				node_id: "founder_gate",
				cycle_no: 1,
				verdict: "waiting_founder",
				examined_by: "flywheel-eng-lead",
				note: "grouped founder reminder delivered",
				examined_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
			}),
			expect.objectContaining({ node_id: "implement", cycle_no: 1 }),
		]);

		await expect(
			writeNodeDwellReviewBatch({
				...base,
				callerLeadId: "other-lead",
				items: [{ runId: "run-1", nodeId: "implement", attempt: 1 }],
			}),
		).rejects.toBeInstanceOf(ReceiptRejectedError);
	});

	it("returns a stable busy error and never claims a receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2210-receipt-busy-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const commDbPath = join(root, "comm.db");
		const store = await StateStore.create(dbPath);
		store.close();
		const seed = new Database(dbPath);
		seed.exec(`
			INSERT INTO workflow_run(run_id, issue_id, project_name, status, created_at)
			VALUES ('run-busy','FLY-2210','flywheel','active',datetime('now'));
			INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
			VALUES ('run-busy','implement',1,'running','exec-busy',datetime('now','-4 hours'));
		`);
		seed.close();
		const comm = new CommDB(commDbPath);
		comm.registerSession(
			"exec-busy",
			"runner-flywheel:pending",
			"flywheel",
			"FLY-2210",
			"flywheel-eng-lead",
		);
		comm.close();
		const lock = new Database(dbPath);
		lock.exec("BEGIN IMMEDIATE");
		try {
			await expect(
				writeNodeDwellReviewBatch({
					dbPath,
					commDbPath,
					projectName: "flywheel",
					callerLeadId: "flywheel-eng-lead",
					environmentLeadId: "flywheel-eng-lead",
					verdict: "normal",
					items: [{ runId: "run-busy", nodeId: "implement", attempt: 1 }],
					busyTimeoutMs: 1,
				}),
			).rejects.toBeInstanceOf(ReceiptBusyError);
		} finally {
			lock.exec("ROLLBACK");
			lock.close();
		}
	});

	it("writes a founder receipt from durable lineage after session pruning", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2210-pruned-founder-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const commDbPath = join(root, "comm.db");
		const store = await StateStore.create(dbPath);
		store.close();
		const state = new Database(dbPath);
		state.exec(`
			INSERT INTO workflow_run(run_id, issue_id, project_name, status, created_at)
			VALUES ('run-pruned','FLY-2210','flywheel','active',datetime('now'));
			INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
			VALUES ('run-pruned','founder_gate',1,'review','exec-pruned',datetime('now','-4 hours'));
		`);
		state.close();
		const comm = new CommDB(commDbPath);
		comm.registerSession(
			"exec-pruned",
			"runner-flywheel:pending",
			"flywheel",
			"FLY-2210",
			"flywheel-eng-lead",
		);
		comm.close();
		const prune = new Database(commDbPath);
		prune
			.prepare("DELETE FROM sessions WHERE execution_id = ?")
			.run("exec-pruned");
		prune.close();

		await expect(
			writeNodeDwellReviewBatch({
				dbPath,
				commDbPath,
				projectName: "flywheel",
				callerLeadId: "flywheel-eng-lead",
				environmentLeadId: "flywheel-eng-lead",
				verdict: "waiting_founder",
				items: [{ runId: "run-pruned", nodeId: "founder_gate", attempt: 1 }],
			}),
		).resolves.toMatchObject({ written: 1 });
	});

	it("writes a NULL-execution founder receipt from unique issue lineage after all sessions are pruned", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2210-null-exec-founder-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const commDbPath = join(root, "comm.db");
		const store = await StateStore.create(dbPath);
		store.close();
		const state = new Database(dbPath);
		state.exec(`
			INSERT INTO workflow_run(run_id, issue_id, project_name, status, created_at)
			VALUES ('run-null-exec','FLY-2210','flywheel','active',datetime('now'));
			INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
			VALUES ('run-null-exec','founder_gate',1,'review',NULL,datetime('now','-4 hours'));
		`);
		state.close();
		const comm = new CommDB(commDbPath);
		comm.registerSession(
			"exec-lineage-only",
			"runner-flywheel:pending",
			"flywheel",
			"FLY-2210",
			"flywheel-eng-lead",
		);
		comm.close();
		const prune = new Database(commDbPath);
		prune
			.prepare("DELETE FROM sessions WHERE project_name = ? AND issue_id = ?")
			.run("flywheel", "FLY-2210");
		prune.close();

		await expect(
			writeNodeDwellReviewBatch({
				dbPath,
				commDbPath,
				projectName: "flywheel",
				callerLeadId: "flywheel-eng-lead",
				environmentLeadId: "flywheel-eng-lead",
				verdict: "waiting_founder",
				items: [{ runId: "run-null-exec", nodeId: "founder_gate", attempt: 1 }],
			}),
		).resolves.toMatchObject({ written: 1 });

		const receipt = new Database(dbPath, { readonly: true })
			.prepare(
				"SELECT verdict, examined_by FROM node_dwell_review WHERE run_id = ?",
			)
			.get("run-null-exec");
		expect(receipt).toEqual({
			verdict: "waiting_founder",
			examined_by: "flywheel-eng-lead",
		});
	});

	it("prefers the retained historical issue cohort over stale issue lineage", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2210-historical-cohort-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const commDbPath = join(root, "comm.db");
		const store = await StateStore.create(dbPath);
		store.close();
		const state = new Database(dbPath);
		state.exec(`
			INSERT INTO workflow_run(run_id, issue_id, project_name, status, created_at)
			VALUES ('run-historical','FLY-2210','flywheel','active',datetime('now'));
			INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
			VALUES ('run-historical','founder_gate',1,'review',NULL,datetime('now','-4 hours'));
		`);
		state.close();
		const comm = new CommDB(commDbPath);
		comm.registerSession(
			"exec-retired",
			"runner-flywheel:pending",
			"flywheel",
			"FLY-2210",
			"retired-old-lead",
		);
		comm.registerSession(
			"exec-historical",
			"runner-flywheel:pending",
			"flywheel",
			"FLY-2210",
			"flywheel-eng-lead",
		);
		comm.close();
		const historical = new Database(commDbPath);
		historical
			.prepare("DELETE FROM sessions WHERE execution_id = ?")
			.run("exec-retired");
		historical
			.prepare(
				"UPDATE sessions SET status = 'completed', started_at = datetime('now','-1 hour') WHERE execution_id = ?",
			)
			.run("exec-historical");
		historical.close();

		await expect(
			writeNodeDwellReviewBatch({
				dbPath,
				commDbPath,
				projectName: "flywheel",
				callerLeadId: "flywheel-eng-lead",
				environmentLeadId: "flywheel-eng-lead",
				verdict: "waiting_founder",
				items: [
					{ runId: "run-historical", nodeId: "founder_gate", attempt: 1 },
				],
			}),
		).resolves.toMatchObject({ written: 1 });
	});

	it("prefers the retained historical issue cohort over stale exact execution lineage", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2210-exact-lineage-owner-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const commDbPath = join(root, "comm.db");
		const store = await StateStore.create(dbPath);
		store.close();
		const state = new Database(dbPath);
		state.exec(`
			INSERT INTO workflow_run(run_id, issue_id, project_name, status, created_at)
			VALUES ('run-exact-lineage','FLY-2210','flywheel','active',datetime('now'));
			INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
			VALUES ('run-exact-lineage','implement',1,'running','exec-stale',datetime('now','-4 hours'));
		`);
		state.close();
		const comm = new CommDB(commDbPath);
		comm.registerSession(
			"exec-stale",
			"runner-flywheel:pending",
			"flywheel",
			"FLY-2210",
			"retired-old-lead",
		);
		comm.registerSession(
			"exec-historical",
			"runner-flywheel:pending",
			"flywheel",
			"FLY-2210",
			"flywheel-eng-lead",
		);
		comm.close();
		const historical = new Database(commDbPath);
		historical
			.prepare("DELETE FROM sessions WHERE execution_id = ?")
			.run("exec-stale");
		historical
			.prepare(
				"UPDATE sessions SET status = 'completed', started_at = datetime('now','-1 hour') WHERE execution_id = ?",
			)
			.run("exec-historical");
		historical.close();

		await expect(
			writeNodeDwellReviewBatch({
				dbPath,
				commDbPath,
				projectName: "flywheel",
				callerLeadId: "retired-old-lead",
				environmentLeadId: "retired-old-lead",
				verdict: "fixed",
				items: [
					{ runId: "run-exact-lineage", nodeId: "implement", attempt: 1 },
				],
			}),
		).rejects.toMatchObject({ token: "owner_mismatch" });

		await expect(
			writeNodeDwellReviewBatch({
				dbPath,
				commDbPath,
				projectName: "flywheel",
				callerLeadId: "flywheel-eng-lead",
				environmentLeadId: "flywheel-eng-lead",
				verdict: "fixed",
				items: [
					{ runId: "run-exact-lineage", nodeId: "implement", attempt: 1 },
				],
			}),
		).resolves.toMatchObject({ written: 1 });
	});

	it("prefers the current live issue cohort over a stale receipt lineage owner", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2210-stale-lineage-owner-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const commDbPath = join(root, "comm.db");
		const store = await StateStore.create(dbPath);
		store.close();
		const state = new Database(dbPath);
		state.exec(`
			INSERT INTO workflow_run(run_id, issue_id, project_name, status, created_at)
			VALUES ('run-handoff','FLY-2210','flywheel','active',datetime('now'));
			INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
			VALUES ('run-handoff','implement',1,'running','exec-stale',datetime('now','-4 hours'));
		`);
		state.close();
		const stale = new CommDB(commDbPath);
		stale.registerSession(
			"exec-stale",
			"runner-flywheel:pending",
			"flywheel",
			"FLY-2210",
			"retired-old-lead",
		);
		stale.close();
		const prune = new Database(commDbPath);
		prune
			.prepare("DELETE FROM sessions WHERE execution_id = ?")
			.run("exec-stale");
		prune.close();
		const current = new CommDB(commDbPath);
		current.registerSession(
			"exec-current",
			"runner-flywheel:pending",
			"flywheel",
			"FLY-2210",
			"flywheel-eng-lead",
		);
		current.close();

		await expect(
			writeNodeDwellReviewBatch({
				dbPath,
				commDbPath,
				projectName: "flywheel",
				callerLeadId: "flywheel-eng-lead",
				environmentLeadId: "flywheel-eng-lead",
				verdict: "fixed",
				items: [{ runId: "run-handoff", nodeId: "implement", attempt: 1 }],
			}),
		).resolves.toMatchObject({ written: 1 });
	});
});
