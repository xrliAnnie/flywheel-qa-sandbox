import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../workflow-run-snapshot.js";
import { legacyEngineeringManifest } from "./fixtures/legacy-workflow-manifests.js";

const T0 = Date.parse("2026-09-11T00:00:00.000Z");
const VERDICT_AT = "2026-09-11T00:45:00.000Z";
const HEAD = "a".repeat(40);

const stores: StateStore[] = [];
const roots: string[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

async function verdictStore() {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-2478",
		projectName: "flywheel",
		claimsReadEnrolled: false,
		snapshotJson: JSON.stringify(
			buildWorkflowRunSnapshotV1({
				template: { id: "resident-release", revision: 1 },
				manifest: legacyEngineeringManifest(),
			}),
		),
	});
	const admitted = store.admitWorkflowExecution({
		runId: "run-1",
		nodeId: "implement",
		executionId: "impl-1",
		attempt: 1,
		family: "review_verdict",
		expiresAt: "2026-09-11T03:00:00.000Z",
		absoluteDeadlineAt: "2026-09-11T04:00:00.000Z",
		now: new Date(T0).toISOString(),
	});
	if (!admitted.ok) throw new Error(admitted.reason);
	store.upsertSession({
		execution_id: "impl-1",
		issue_id: "FLY-2478",
		project_name: "flywheel",
		status: "ship_parked",
		adapter_type: "codex-tmux",
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "impl-1",
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "qa",
		attempt: 1,
		state: "running",
		executionId: "qa-1",
	});
	rawDb(store)
		.prepare(
			"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'qa' WHERE run_id = 'run-1'",
		)
		.run();
	const entered = store.enterResidentHold({
		executionId: "impl-1",
		activationId: "activation:impl-1:run-1:implement:1",
		nodeId: "implement",
		boundarySeq: 1,
		nowMs: T0,
	});
	if (!entered.ok) throw new Error(entered.reason);
	return store;
}

function verdict(store: StateStore, outcome: "qa_pass" | "qa_fail") {
	return store.commitWorkflowTransitionTx({
		nodeReuseEnabled: false,
		runId: "run-1",
		nodeId: "qa",
		attempt: 1,
		executionId: "qa-1",
		outcome,
		subjectDigest: HEAD,
		now: VERDICT_AT,
	});
}

describe("FLY-2478 resident release", () => {
	it("requests release at the committed pass verdict and replays once", async () => {
		const store = await verdictStore();
		expect(verdict(store, "qa_pass")).toMatchObject({ ok: true });
		expect(store.getResidentHold("impl-1")).toMatchObject({
			state: "resident",
			grace_expires_at: VERDICT_AT,
			release_cause: "verdict_pass",
			release_source: expect.stringMatching(/^workflow_transition:/),
		});
		expect(verdict(store, "qa_pass")).toMatchObject({
			ok: true,
			idempotentReplay: true,
		});
		expect(
			rawDb(store)
				.prepare(
					"SELECT * FROM workflow_run_event WHERE kind = 'resident_hold_release_requested'",
				)
				.all(),
		).toHaveLength(1);
	});

	it("keeps the original resident actor available for a fail verdict", async () => {
		const store = await verdictStore();
		const before = store.getResidentHold("impl-1");
		const result = verdict(store, "qa_fail");
		expect(result).toMatchObject({
			ok: true,
			reworkRequestId: expect.any(String),
		});
		if (!result.ok || !result.reworkRequestId)
			throw new Error("missing rework request");
		expect(
			store.getLatestWorkflowReworkRoute(result.reworkRequestId),
		).toMatchObject({ preferred_actor_execution_id: "impl-1" });
		expect(store.getResidentHold("impl-1")).toEqual(before);
	});

	it("does not release a woken actor when a pass arrives", async () => {
		const store = await verdictStore();
		expect(store.wakeResidentHold("impl-1", 1, T0 + 1)).toBe(true);
		const before = store.getResidentHold("impl-1");
		expect(verdict(store, "qa_pass")).toMatchObject({ ok: true });
		expect(store.getResidentHold("impl-1")).toEqual(before);
	});

	it("does not interpret founder kickback as a release verdict", async () => {
		const store = await verdictStore();
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "founder_gate",
			attempt: 1,
			state: "running",
			executionId: "qa-1",
		});
		rawDb(store)
			.prepare(
				"UPDATE workflow_run SET current_node_id = 'founder_gate' WHERE run_id = 'run-1'",
			)
			.run();
		const before = store.getResidentHold("impl-1");
		expect(
			store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
				runId: "run-1",
				nodeId: "founder_gate",
				attempt: 1,
				executionId: "qa-1",
				outcome: "founder_feedback_kickback",
				subjectDigest: HEAD,
				founderFeedback: "Please revise",
				now: VERDICT_AT,
			}),
		).toMatchObject({ ok: true });
		expect(store.getResidentHold("impl-1")).toEqual(before);
	});

	it("releases only the verdict loop target and leaves other resident nodes unchanged", async () => {
		const store = await verdictStore();
		const admitted = store.admitWorkflowExecution({
			runId: "run-1",
			nodeId: "design",
			executionId: "design-1",
			attempt: 1,
			family: "review_verdict",
			expiresAt: "2026-09-11T03:00:00.000Z",
			absoluteDeadlineAt: "2026-09-11T04:00:00.000Z",
			now: new Date(T0).toISOString(),
		});
		if (!admitted.ok) throw new Error(admitted.reason);
		store.upsertSession({
			execution_id: "design-1",
			issue_id: "FLY-2478",
			project_name: "flywheel",
			status: "ship_parked",
			adapter_type: "codex-tmux",
		});
		expect(
			store.enterResidentHold({
				executionId: "design-1",
				activationId: "activation:design-1:run-1:design:1",
				nodeId: "design",
				boundarySeq: 1,
				nowMs: T0,
			}),
		).toMatchObject({ ok: true });
		const before = store.getResidentHold("design-1");
		expect(verdict(store, "qa_pass")).toMatchObject({ ok: true });
		expect(store.getResidentHold("design-1")).toEqual(before);
		expect(store.getResidentHold("impl-1")?.release_cause).toBe("verdict_pass");
	});

	it("rolls the release request back with a failed transition transaction", async () => {
		const store = await verdictStore();
		rawDb(
			store,
		).exec(`CREATE TRIGGER reject_release_event BEFORE INSERT ON workflow_run_event
			WHEN NEW.kind = 'resident_hold_release_requested' BEGIN SELECT RAISE(ABORT, 'injected release failure'); END;`);
		const before = store.getResidentHold("impl-1");
		expect(() => verdict(store, "qa_pass")).toThrow("injected release failure");
		expect(store.getResidentHold("impl-1")).toEqual(before);
		expect(store.getWorkflowRunNode("run-1", "qa", 1)?.state).toBe("running");
	});

	it("migrates legacy holds without changing their state and survives reopening", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2478-migration-"));
		roots.push(root);
		const path = join(root, "state.db");
		const legacy = new Database(path);
		legacy.exec(`CREATE TABLE workflow_resident_hold (
			execution_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
			attempt INTEGER NOT NULL CHECK (attempt > 0), activation_id TEXT NOT NULL,
			vendor TEXT NOT NULL CHECK (vendor IN ('claude','codex')),
			revision INTEGER NOT NULL CHECK (revision > 0), boundary_seq INTEGER NOT NULL CHECK (boundary_seq > 0),
			state TEXT NOT NULL CHECK (state IN ('resident','woken','expired','closed')),
			grace_started_at TEXT NOT NULL, grace_expires_at TEXT NOT NULL,
			closed_reason TEXT, updated_at TEXT NOT NULL);
			INSERT INTO workflow_resident_hold VALUES ('old-exec','old-run','repair',1,'old-activation','codex',1,1,
			'resident','2026-09-11T00:00:00.000Z','2026-09-11T00:30:00.000Z',NULL,'2026-09-11T00:00:00.000Z');`);
		legacy.close();
		for (let reopen = 0; reopen < 2; reopen++) {
			const store = await StateStore.create(path);
			try {
				expect(
					rawDb(store).prepare("SELECT * FROM workflow_resident_hold").get(),
				).toMatchObject({
					execution_id: "old-exec",
					state: "resident",
					revision: 1,
					grace_expires_at: "2026-09-11T00:30:00.000Z",
					release_cause: null,
					release_source: null,
				});
			} finally {
				store.close();
			}
		}
	});
});
