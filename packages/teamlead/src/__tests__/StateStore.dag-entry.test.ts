/**
 * FLY-1372 M1: StateStore primitives for the pipeline.dag dispatch entry.
 *
 * - `getWorkflowStartReservationForRun(runId)` — read-only recovery accessor
 *   (run_id is UNIQUE on the append-only reservation table).
 * - `workflow_run.entry_kind` — durable entry provenance written atomically in
 *   the materialize transaction; ONLY the pipeline.dag entry sets it, so the
 *   recovery domain can never intercept existing v2 / explicit-v1 runs.
 * - `upsertSession()` behavior-field contract (Codex design R4-1): the three
 *   behavior fields land in the SAME transaction as row creation; undefined
 *   never touches an existing value; explicit false stays representable.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const stores: StateStore[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const DAG_FLAGS_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

async function storeWithEngHeavy(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const seed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	)!;
	store.importWorkflowTemplateSeed(seed);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "*",
		templateId: seed.templateId,
		updatedBy: "lead",
	});
	return store;
}

function materialize(
	store: StateStore,
	options: { runId: string; issueId: string; entryKind?: "pipeline_dag_v1" },
) {
	return store.materializeWorkflowRun({
		runId: options.runId,
		issueId: options.issueId,
		projectName: "flywheel",
		taskCategory: "*",
		claimsReadEnrolled: true,
		actor: "master",
		env: DAG_FLAGS_ON,
		...(options.entryKind ? { entryKind: options.entryKind } : {}),
		startReservation: {
			idempotencyKey: `key-${options.runId}`,
			selectionDigest: `digest-${options.runId}`,
			nodeId: "design",
			attempt: 1,
			executionId: `exec-${options.runId}`,
			createdAt: "2026-07-18T00:00:00.000Z",
		},
	});
}

describe("FLY-1372 getWorkflowStartReservationForRun", () => {
	it("returns the start reservation for a materialized run by run_id", async () => {
		const store = await storeWithEngHeavy();
		materialize(store, { runId: "run-a", issueId: "FLY-A" });
		const reservation = store.getWorkflowStartReservationForRun("run-a");
		expect(reservation).toMatchObject({
			idempotency_key: "key-run-a",
			run_id: "run-a",
			node_id: "design",
			execution_id: "exec-run-a",
		});
	});

	it("returns undefined for an unknown run", async () => {
		const store = await storeWithEngHeavy();
		expect(store.getWorkflowStartReservationForRun("nope")).toBeUndefined();
	});
});

describe("FLY-1372 workflow_run.entry_kind provenance", () => {
	it("persists entry_kind='pipeline_dag_v1' when materialized with entryKind", async () => {
		const store = await storeWithEngHeavy();
		materialize(store, {
			runId: "run-dag",
			issueId: "FLY-DAG",
			entryKind: "pipeline_dag_v1",
		});
		expect(store.getWorkflowRun("run-dag")?.entry_kind).toBe("pipeline_dag_v1");
	});

	it("leaves entry_kind NULL when materialized without entryKind (existing v2/explicit-v1 shape)", async () => {
		const store = await storeWithEngHeavy();
		materialize(store, { runId: "run-plain", issueId: "FLY-PLAIN" });
		expect(store.getWorkflowRun("run-plain")?.entry_kind ?? null).toBeNull();
	});
});

describe("FLY-1372 upsertSession behavior-field contract (R4-1)", () => {
	// The contract is about durable STORAGE — assert the raw columns via a
	// second read-only connection (rowToSession lossily maps 0 → undefined),
	// so a temp-file DB is used instead of :memory:.
	async function fileStore(): Promise<{
		store: StateStore;
		rawSession: (executionId: string) => {
			codex_skip: number;
			doc_tier: string | null;
			issue_url: string | null;
		};
	}> {
		const dir = mkdtempSync(join(tmpdir(), "fly1372-state-"));
		const dbPath = join(dir, "state.db");
		const store = await StateStore.create(dbPath);
		stores.push(store);
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const rawSession = (executionId: string) => {
			const reader = new BetterSqlite3(dbPath, { readonly: true });
			try {
				return reader
					.prepare(
						`SELECT codex_skip, doc_tier, issue_url
						   FROM sessions WHERE execution_id = ?`,
					)
					.get(executionId) as ReturnType<
					Awaited<ReturnType<typeof fileStore>>["rawSession"]
				>;
			} finally {
				reader.close();
			}
		};
		return { store, rawSession };
	}

	const base = {
		issue_id: "FLY-META",
		project_name: "flywheel",
		status: "running",
	} as const;

	it("#15 fresh insert lands all three behavior fields in the same transaction", async () => {
		const { store, rawSession } = await fileStore();
		store.upsertSession({
			execution_id: "meta-1",
			...base,
			doc_tier: "full",
			issue_url: "https://linear.app/x/FLY-META",
			codex_skip: true,
		});
		expect(rawSession("meta-1")).toEqual({
			codex_skip: 1,
			doc_tier: "full",
			issue_url: "https://linear.app/x/FLY-META",
		});
	});

	it("#15 fresh insert with explicit false stays representable (0, not dropped)", async () => {
		const { store, rawSession } = await fileStore();
		store.upsertSession({
			execution_id: "meta-false",
			...base,
			codex_skip: false,
		});
		const row = rawSession("meta-false");
		expect(row.codex_skip).toBe(0);
	});

	it("#15b conflict upsert with undefined inputs leaves existing values untouched", async () => {
		const { store, rawSession } = await fileStore();
		store.upsertSession({
			execution_id: "meta-2",
			...base,
			doc_tier: "plan_only",
			issue_url: "https://linear.app/x/FLY-META",
			codex_skip: true,
		});
		// Repeated started upsert without the fields (e.g. a legacy-shaped
		// writer) must not reset them to the NOT NULL DEFAULT 0.
		store.upsertSession({ execution_id: "meta-2", ...base });
		expect(rawSession("meta-2")).toEqual({
			codex_skip: 1,
			doc_tier: "plan_only",
			issue_url: "https://linear.app/x/FLY-META",
		});
	});
});
