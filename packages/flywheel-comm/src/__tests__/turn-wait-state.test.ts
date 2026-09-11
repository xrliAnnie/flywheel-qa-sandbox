import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordTurnCommandSideEffects, turnStatus } from "../commands/turn.js";
import { CommDB } from "../db.js";
import { resolveTurnWaitStateDbPath } from "../turn-wait-state.js";

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
   CREATE TABLE workflow_gate_holder (run_id TEXT, gate_node_id TEXT, attempt INTEGER, head_sha TEXT, source_execution_id TEXT, question_id TEXT UNIQUE, authority_mode TEXT, state TEXT);
   CREATE TABLE workflow_carrier_delivery (question_id TEXT PRIMARY KEY, run_id TEXT, gate_node_id TEXT, gate_attempt INTEGER, approved_head TEXT, source_execution_id TEXT, state TEXT);
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
	it("restores overdue alerts for the approved ship carrier while the gate node has no actor", () => {
		expect(observe().waitAsked).toBe(false);
		state.exec(`
   INSERT INTO workflow_gate_holder VALUES ('run-1','founder_gate',1,'head','impl','ship-question','runner_ship','approved');
   INSERT INTO workflow_carrier_delivery VALUES ('ship-question','run-1','founder_gate',1,'head','impl','pending');
  `);
		expect(observe(300).waitAsked).toBe(true);
		expect(observe(400).waitAsked).toBe(false);
		expect(comm.getPendingQuestions("lead")).toHaveLength(1);
	});
	it.each([
		["DELETE FROM workflow_carrier_delivery", true],
		["UPDATE workflow_carrier_delivery SET state='completed'", true],
		["UPDATE workflow_carrier_delivery SET state='held'", true],
		[
			"UPDATE workflow_carrier_delivery SET source_execution_id='replacement'",
			false,
		],
		["UPDATE workflow_gate_holder SET state='awaiting_review'", false],
		["UPDATE workflow_gate_holder SET state='superseded'", false],
		["UPDATE workflow_gate_holder SET authority_mode='land'", false],
		["UPDATE workflow_gate_holder SET run_id='old-run'", false],
		["UPDATE workflow_gate_holder SET attempt=2", false],
		["UPDATE workflow_run SET status='completed'", false],
	])(
		"scopes ship responsibility to current approved authority: %s",
		(sql, asked) => {
			state.exec(`
   INSERT INTO workflow_gate_holder VALUES ('run-1','founder_gate',1,'head','impl','ship-question','runner_ship','approved');
   INSERT INTO workflow_carrier_delivery VALUES ('ship-question','run-1','founder_gate',1,'head','impl','pending');
  `);
			state.exec(sql);
			expect(observe().waitAsked).toBe(asked);
		},
	);
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
	it("wires explicit StateStore into the real turn CLI without changing stdout", () => {
		comm.observeTurnWait({
			executionId: "impl",
			holderExecId: "qa",
			phase: "qa",
			epoch: 1,
			observedAtMs: Date.now() - 30 * 60_000,
			askAfterMs: 60 * 60_000,
		});
		const result = spawnSync(
			process.execPath,
			[
				"dist/index.js",
				"turn",
				"--db",
				join(dir, "comm.db"),
				"--state-db",
				stateDbPath,
				"--json",
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					FLYWHEEL_EXEC_ID: "impl",
					FLYWHEEL_TURN_WAIT_ASK_MINUTES: "5",
				},
			},
		);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			answer: "not-yours",
			holderExecId: "qa",
			epoch: 1,
		});
		expect(comm.getPendingQuestions("lead")).toEqual([]);
	});
	it("accepts the production CommDB path even when supplied by an environment override", () => {
		const production = join(
			homedir(),
			".flywheel",
			"comm",
			"flywheel",
			"comm.db",
		);
		expect(
			resolveTurnWaitStateDbPath(production, "flywheel", undefined, {
				FLYWHEEL_COMM_DB: production,
			}),
		).toBe(join(homedir(), ".flywheel", "teamlead.db"));
	});
	it("requires an explicit StateStore for isolated or project-less paths", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(
				resolveTurnWaitStateDbPath(
					join(dir, "comm.db"),
					"flywheel",
					undefined,
					{},
				),
			).toBeUndefined();
			expect(
				resolveTurnWaitStateDbPath(
					join(dir, "comm.db"),
					undefined,
					undefined,
					{},
				),
			).toBeUndefined();
			expect(
				resolveTurnWaitStateDbPath(
					join(dir, "comm.db"),
					undefined,
					stateDbPath,
					{},
				),
			).toBe(stateDbPath);
			expect(
				resolveTurnWaitStateDbPath(join(dir, "comm.db"), undefined, undefined, {
					TEAMLEAD_DB_PATH: stateDbPath,
				}),
			).toBe(stateDbPath);
			expect(log).toHaveBeenCalledTimes(2);
		} finally {
			log.mockRestore();
		}
	});
	it("retains alerts with a diagnostic when the StateStore schema is unavailable", () => {
		state.exec("DROP TABLE workflow_run");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(observe().waitAsked).toBe(true);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("workflow actor unavailable"),
			);
		} finally {
			log.mockRestore();
		}
	});
	it.each(["held", "terminated"])(
		"keeps actor responsibility while run is %s",
		(status) => {
			state.prepare("UPDATE workflow_run SET status=?").run(status);
			state.exec(
				"UPDATE workflow_run_node SET execution_id='impl' WHERE node_id='founder_gate'",
			);
			expect(observe().waitAsked).toBe(true);
		},
	);
	it("suppresses a completed run even if an old node still names the waiter", () => {
		state.exec(
			"UPDATE workflow_run SET status='completed'; UPDATE workflow_run_node SET execution_id='impl' WHERE node_id='founder_gate'",
		);
		expect(observe().waitAsked).toBe(false);
	});
});
