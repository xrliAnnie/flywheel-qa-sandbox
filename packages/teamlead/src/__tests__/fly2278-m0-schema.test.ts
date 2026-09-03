import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const tempDirs: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("FLY-2278 M0 delivery operation schema migration", () => {
	it("rebuilds a populated resident-expiry table without changing rows or foreign keys", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2278-schema-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "teamlead.db");
		const seed = await StateStore.create(dbPath);
		seed.createWorkflowRun({
			runId: "run-schema-upgrade",
			issueId: "FLY-2278",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		const rootId = "flywheel:FLY-2278:mailbox:schema-upgrade";
		const attemptId = `${rootId}:g1:a1`;
		seed.projectWorkflowDeliveryAttempt({
			rootId,
			attemptId,
			family: "mailbox",
			contractRef: { table: "mailbox", pk: "schema-upgrade" },
			mintedAt: "2026-09-03T12:00:00.000Z",
		});
		seed.close();

		const legacy = new BetterSqlite3(dbPath);
		legacy.pragma("foreign_keys = OFF");
		legacy.exec(`
			DROP INDEX idx_wdo_client_request;
			DROP TABLE workflow_delivery_operation;
			CREATE TABLE workflow_delivery_operation (
				operation_id TEXT PRIMARY KEY,
				kind TEXT NOT NULL CHECK (kind IN ('resident_expiry')),
				run_id TEXT NOT NULL,
				family TEXT,
				root_id TEXT,
				generation INTEGER,
				shape_id TEXT,
				hold_event_uid TEXT,
				source_attempt_id TEXT,
				target_activation_id TEXT,
				client_request_id TEXT NOT NULL UNIQUE,
				canonical_digest TEXT NOT NULL,
				state TEXT NOT NULL CHECK (state IN ('staged','applied','sent','projected','failed')),
				last_error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				FOREIGN KEY (source_attempt_id) REFERENCES workflow_delivery_attempt(attempt_id)
			);
			CREATE UNIQUE INDEX idx_wdo_client_request
			ON workflow_delivery_operation(client_request_id);
		`);
		legacy
			.prepare(
				`INSERT INTO workflow_delivery_operation (
				   operation_id, kind, run_id, family, root_id, generation,
				   source_attempt_id, client_request_id, canonical_digest,
				   state, created_at, updated_at
				 ) VALUES (?, 'resident_expiry', ?, 'mailbox', ?, 1, ?, ?, ?,
				           'staged', ?, ?)`,
			)
			.run(
				"resident-expiry:schema-upgrade",
				"run-schema-upgrade",
				rootId,
				attemptId,
				"resident-expiry:schema-upgrade",
				"resident-expiry-digest",
				"2026-09-03T12:01:00.000Z",
				"2026-09-03T12:01:00.000Z",
			);
		const before = legacy
			.prepare(
				"SELECT * FROM workflow_delivery_operation WHERE operation_id = ?",
			)
			.get("resident-expiry:schema-upgrade");
		const foreignKeysBefore = legacy
			.prepare("PRAGMA foreign_key_list(workflow_delivery_operation)")
			.all();
		legacy.close();

		const store = await StateStore.create(dbPath);
		stores.push(store);
		const raw = (store as unknown as { db: { raw: BetterSqlite3.Database } }).db
			.raw;
		const schema = raw
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_delivery_operation'",
			)
			.get() as { sql: string };
		expect(schema.sql).toContain("'hold_resume'");
		expect(schema.sql).toContain("'reroute'");
		expect(schema.sql).toContain("'resident_expiry'");
		expect(
			raw
				.prepare(
					"SELECT * FROM workflow_delivery_operation WHERE operation_id = ?",
				)
				.get("resident-expiry:schema-upgrade"),
		).toEqual(before);
		expect(
			raw.prepare("PRAGMA foreign_key_list(workflow_delivery_operation)").all(),
		).toEqual(foreignKeysBefore);
		expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(raw.pragma("integrity_check", { simple: true })).toBe("ok");
		expect(
			raw
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_wdo_client_request'",
				)
				.get(),
		).toEqual({ name: "idx_wdo_client_request" });
	});

	it("mints current rework and carrier versions at the baseline boundary", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-version-baseline",
			issueId: "FLY-2278",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		seedVersionAuthorities(store, "baseline", 3, 2);

		expect(
			store.baselineWorkflowDeliveryContracts("2026-09-03T13:00:00.000Z"),
		).toMatchObject({ minted: 2 });
		const refs = Object.fromEntries(
			store
				.listLiveWorkflowDeliveryAttempts()
				.map((attempt) => [
					attempt.family,
					JSON.parse(attempt.contract_ref_json) as Record<string, unknown>,
				]),
		);
		expect(refs.rework).toMatchObject({
			pk: "rework-baseline",
			routeRevision: 3,
		});
		expect(refs.carrier).toMatchObject({
			pk: "carrier-baseline",
			redriveGeneration: 2,
		});
		expect(
			store.settleProjectedWorkflowDeliveryAttempt({
				family: "rework",
				table: "workflow_rework_delivery",
				pk: "rework-baseline",
				version: { routeRevision: 2 },
				reason: "source_terminal",
				now: "2026-09-03T13:01:00.000Z",
			}),
		).toBe(false);
		expect(
			store.settleProjectedWorkflowDeliveryAttempt({
				family: "rework",
				table: "workflow_rework_delivery",
				pk: "rework-baseline",
				version: { routeRevision: 3 },
				reason: "source_terminal",
				now: "2026-09-03T13:02:00.000Z",
			}),
		).toBe(true);
	});

	it("upgrades live legacy attempt JSON once and preserves byte-exact rollback evidence", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2278-versions-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "teamlead.db");
		const seed = await StateStore.create(dbPath);
		seed.createWorkflowRun({
			runId: "run-version-upgrade",
			issueId: "FLY-2278",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		seedVersionAuthorities(seed, "upgrade", 4, 5);
		const reworkRoot = "flywheel:FLY-2278:rework:rework-upgrade";
		const carrierRoot = "flywheel:FLY-2278:carrier:carrier-upgrade";
		seed.projectWorkflowDeliveryAttempt({
			rootId: reworkRoot,
			attemptId: `${reworkRoot}:g1:a1`,
			family: "rework",
			contractRef: { table: "workflow_rework_delivery", pk: "rework-upgrade" },
			mintedAt: "2026-09-03T12:00:00.000Z",
		});
		seed.projectWorkflowDeliveryAttempt({
			rootId: carrierRoot,
			attemptId: `${carrierRoot}:g1:a1`,
			family: "carrier",
			contractRef: {
				table: "workflow_carrier_delivery",
				pk: "carrier-upgrade",
			},
			mintedAt: "2026-09-03T12:00:00.000Z",
		});
		const seedRaw = rawDb(seed);
		const nonCanonicalBefore =
			'{ "table" : "workflow_rework_delivery" , "pk" : "rework-upgrade" }';
		seedRaw
			.prepare(
				"UPDATE workflow_delivery_attempt SET contract_ref_json = ? WHERE attempt_id = ?",
			)
			.run(nonCanonicalBefore, `${reworkRoot}:g1:a1`);
		seed.close();

		const upgraded = await StateStore.create(dbPath);
		const attemptsAfter = upgraded.listLiveWorkflowDeliveryAttempts();
		const reworkAfter = attemptsAfter.find(
			({ family }) => family === "rework",
		)!;
		const carrierAfter = attemptsAfter.find(
			({ family }) => family === "carrier",
		)!;
		expect(JSON.parse(reworkAfter.contract_ref_json)).toMatchObject({
			routeRevision: 4,
		});
		expect(JSON.parse(carrierAfter.contract_ref_json)).toMatchObject({
			redriveGeneration: 5,
		});
		const evidence = upgraded
			.listWorkflowRunEvents("run-version-upgrade")
			.filter(({ kind }) => kind === "delivery_attempt_version_upgraded");
		expect(evidence).toHaveLength(2);
		const reworkEvidence = evidence
			.map(({ payload }) => payload as Record<string, string>)
			.find(({ attemptId }) => attemptId === `${reworkRoot}:g1:a1`)!;
		expect(reworkEvidence.before).toBe(nonCanonicalBefore);
		expect(reworkEvidence.after).toBe(reworkAfter.contract_ref_json);
		upgraded.close();

		const replay = await StateStore.create(dbPath);
		expect(
			replay
				.listWorkflowRunEvents("run-version-upgrade")
				.filter(({ kind }) => kind === "delivery_attempt_version_upgraded"),
		).toHaveLength(2);
		const replayRaw = rawDb(replay);
		expect(
			replayRaw
				.prepare(
					`UPDATE workflow_delivery_attempt SET contract_ref_json = ?
					  WHERE attempt_id = ? AND contract_ref_json = ?`,
				)
				.run(
					reworkEvidence.before,
					reworkEvidence.attemptId,
					reworkEvidence.after,
				).changes,
		).toBe(1);
		expect(
			replayRaw
				.prepare(
					"SELECT contract_ref_json FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(reworkEvidence.attemptId),
		).toEqual({ contract_ref_json: nonCanonicalBefore });
		replay.close();

		const reupgraded = await StateStore.create(dbPath);
		stores.push(reupgraded);
		expect(
			JSON.parse(
				reupgraded
					.listLiveWorkflowDeliveryAttempts()
					.find(({ family }) => family === "rework")!.contract_ref_json,
			),
		).toMatchObject({ routeRevision: 4 });
		expect(
			reupgraded
				.listWorkflowRunEvents("run-version-upgrade")
				.filter(({ kind }) => kind === "delivery_attempt_version_upgraded"),
		).toHaveLength(2);
	});
});

function rawDb(store: StateStore): BetterSqlite3.Database {
	return (store as unknown as { db: { raw: BetterSqlite3.Database } }).db.raw;
}

function seedVersionAuthorities(
	store: StateStore,
	suffix: string,
	routeRevision: number,
	redriveGeneration: number,
): void {
	const raw = rawDb(store);
	const now = "2026-09-03T12:00:00.000Z";
	const reworkId = `rework-${suffix}`;
	const actorId = `actor-${suffix}`;
	const carrierId = `carrier-${suffix}`;
	raw
		.prepare(
			`INSERT INTO workflow_actor
		   (execution_id, project_name, issue_id, role, created_at)
		 VALUES (?, 'flywheel', 'FLY-2278', 'worker', ?)`,
		)
		.run(actorId, now);
	raw
		.prepare(
			`INSERT INTO workflow_rework_request
		   (request_id, run_id, source_event_id, authority, source_node_id,
		    source_attempt, base_revision, authority_context_json,
		    authority_context_digest, requested_at)
		 VALUES (?, 'run-version-' || ?, 'source:' || ?, 'engine', 'worker',
		         1, ?, '{}', ?, ?)`,
		)
		.run(reworkId, suffix, suffix, "a".repeat(40), "b".repeat(64), now);
	raw
		.prepare(
			`INSERT INTO workflow_rework_route_revision
		   (request_id, revision, target_node_id, target_attempt,
		    preferred_actor_execution_id, invalidation_scope_json,
		    verification_policy_json, interpreted_by, interpretation_reason,
		    created_at)
		 VALUES (?, ?, 'worker', 1, ?, '[]', '{}', 'engine:test', 'fixture', ?)`,
		)
		.run(reworkId, routeRevision, actorId, now);
	raw
		.prepare(
			`INSERT INTO workflow_rework_delivery
		   (request_id, route_revision, state, updated_at)
		 VALUES (?, ?, 'pending', ?)`,
		)
		.run(reworkId, routeRevision, now);
	raw
		.prepare(
			`INSERT INTO workflow_gate_holder
		   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
		    question_id, state, materialization_stage, created_at, updated_at)
		 VALUES ('run-version-' || ?, 'release', 1, ?, ?, ?,
		         'awaiting_review', 'completed', ?, ?)`,
		)
		.run(suffix, "c".repeat(40), actorId, carrierId, now, now);
	raw
		.prepare(
			`INSERT INTO workflow_carrier_delivery
		   (question_id, run_id, gate_node_id, gate_attempt, approved_head,
		    source_execution_id, carrier_activation_id, state,
		    redrive_generation, created_at, updated_at)
		 VALUES (?, 'run-version-' || ?, 'release', 1, ?, ?, ?, 'pending', ?, ?, ?)`,
		)
		.run(
			carrierId,
			suffix,
			"c".repeat(40),
			actorId,
			`activation-${suffix}`,
			redriveGeneration,
			now,
			now,
		);
}
