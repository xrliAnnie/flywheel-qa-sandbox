import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordTurnCommandSideEffects, turnStatus } from "../commands/turn.js";
import { CommDB } from "../db.js";

describe("TURN wait actor authority (FLY-2507)", () => {
	let dir: string;
	let comm: CommDB;
	let state: Database.Database;
	let stateDbPath: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "turn-actor-"));
		comm = new CommDB(join(dir, "comm.db"));
		stateDbPath = join(dir, "state.db");
		state = new Database(stateDbPath);
		state.exec(`
   CREATE TABLE workflow_run (run_id TEXT PRIMARY KEY, issue_id TEXT, current_node_id TEXT, status TEXT);
   CREATE TABLE workflow_run_node (run_id TEXT, node_id TEXT, attempt INTEGER, state TEXT, execution_id TEXT, ended_at TEXT, PRIMARY KEY(run_id,node_id,attempt));
   CREATE TABLE workflow_execution_binding (execution_id TEXT, run_id TEXT, node_id TEXT, attempt INTEGER);
   INSERT INTO workflow_run VALUES ('run-1','ISSUE-1','founder_gate','active');
   INSERT INTO workflow_run_node VALUES ('run-1','implement',1,'done','impl','done');
   INSERT INTO workflow_run_node VALUES ('run-1','founder_gate',1,'review',NULL,NULL);
   INSERT INTO workflow_execution_binding VALUES ('impl','run-1','implement',1);
  `);
		comm.registerSession("impl", "win:1", "flywheel", "ISSUE-1", "lead");
		comm.grantTurn("ISSUE-1", "qa", "qa", 100, {
			project: "flywheel",
			sourceEventId: "grant-1",
			targetRunId: "run-1",
		});
	});
	afterEach(() => {
		state.close();
		comm.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const observe = (time = 200) =>
		recordTurnCommandSideEffects(comm, "impl", turnStatus(comm, "impl"), {
			observedAtMs: time,
			askAfterMs: 0,
			debugOverride: false,
			stateDbPath,
		});
	it("does not ask for a parked implement body while founder gate has no runner actor", () => {
		expect(observe().waitAsked).toBe(false);
		expect(comm.getPendingQuestions("lead")).toEqual([]);
		const raw = new Database(join(dir, "comm.db"), { readonly: true });
		try {
			expect(
				raw
					.prepare("SELECT suppressed_reason, asked_at FROM turn_wait_ledger")
					.get(),
			).toMatchObject({
				suppressed_reason: expect.stringContaining("founder_gate"),
				asked_at: null,
			});
		} finally {
			raw.close();
		}
	});
	it.each(["pending", "admitted", "running", "review"])(
		"keeps overdue asks for the designated %s actor",
		(actorState) => {
			state
				.prepare(
					"UPDATE workflow_run_node SET state=?, execution_id='impl' WHERE node_id='founder_gate'",
				)
				.run(actorState);
			expect(observe().waitAsked).toBe(true);
			expect(observe(300).waitAsked).toBe(false);
			expect(comm.getPendingQuestions("lead")).toHaveLength(1);
		},
	);
	it("uses latest attempt and restores alerts after rework reservation", () => {
		expect(observe().waitAsked).toBe(false);
		state.exec(`INSERT INTO workflow_run_node VALUES ('run-1','implement',2,'pending','impl',NULL);
   INSERT INTO workflow_execution_binding VALUES ('impl','run-1','implement',2);
   UPDATE workflow_run SET current_node_id='implement';`);
		expect(observe(300).waitAsked).toBe(true);
	});
	it.each([
		"UPDATE workflow_run_node SET state='future_state' WHERE node_id='founder_gate'",
		"DELETE FROM workflow_execution_binding",
		"UPDATE workflow_execution_binding SET run_id='other-run'",
		"DELETE FROM workflow_run_node WHERE node_id='founder_gate'",
		"UPDATE workflow_run SET issue_id='OTHER-ISSUE'",
		"DELETE FROM workflow_run",
	])("retains alerts when authority is unknown: %s", (sql) => {
		state.exec(sql);
		expect(observe().waitAsked).toBe(true);
	});
	it("persists suppression across reopen and clears it when the actor becomes responsible", () => {
		expect(observe().waitAsked).toBe(false);
		comm.close();
		comm = new CommDB(join(dir, "comm.db"));
		expect(observe(300).waitAsked).toBe(false);
		state.exec(
			"UPDATE workflow_run_node SET execution_id='impl' WHERE node_id='founder_gate'",
		);
		expect(observe(400).waitAsked).toBe(true);
		const raw = new Database(join(dir, "comm.db"), { readonly: true });
		try {
			expect(
				raw.prepare("SELECT suppressed_reason FROM turn_wait_ledger").get(),
			).toEqual({ suppressed_reason: null });
		} finally {
			raw.close();
		}
	});
	it.each(["founder_gate", "land"])(
		"uses actor identity rather than the %s node name",
		(node) => {
			state
				.prepare(
					"UPDATE workflow_run_node SET node_id=? WHERE node_id='founder_gate'",
				)
				.run(node);
			state.prepare("UPDATE workflow_run SET current_node_id=?").run(node);
			state
				.prepare(
					"UPDATE workflow_run_node SET execution_id='other' WHERE node_id=?",
				)
				.run(node);
			expect(observe().waitAsked).toBe(false);
		},
	);
	it("does not revive an ended attempt even if its state reads running", () => {
		state.exec(
			"UPDATE workflow_run_node SET state='running', execution_id='impl', ended_at='ended' WHERE node_id='founder_gate'",
		);
		expect(observe().waitAsked).toBe(false);
	});
	it("does not read StateStore or write waits on debug override", () => {
		state.close();
		state = new Database(stateDbPath);
		state.exec("DROP TABLE workflow_run");
		expect(
			recordTurnCommandSideEffects(comm, "impl", turnStatus(comm, "impl"), {
				observedAtMs: 200,
				askAfterMs: 0,
				debugOverride: true,
				stateDbPath,
			}).waitAsked,
		).toBe(false);
		expect(comm.listTurnWaitLedger("impl")).toEqual([]);
	});
});
