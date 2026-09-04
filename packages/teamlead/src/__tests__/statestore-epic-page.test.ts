import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpicPageRenderReceipt } from "../epic-page/receipt.js";
import { readEpicItemFacts, StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

const cleanups: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const path of cleanups.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function receiptAt(generatedAt: string): EpicPageRenderReceipt {
	return {
		schema_version: 1,
		project_name: "example",
		generated_at: generatedAt,
		trigger: "manual",
		sources: [
			{
				path: "/items/0/title",
				provenance: {
					kind: "linear",
					entity: "issue",
					id: "child-uuid",
					field: "title",
				},
				observed_at: generatedAt,
				source_updated_at: "2026-09-03T03:00:00Z",
			},
		],
	};
}

function customSnapshot(root: string): string {
	mkdirSync(join(root, "agents"), { recursive: true });
	writeFileSync(join(root, "agents", "custom.md"), "Do the bounded work.\n");
	return JSON.stringify(
		buildWorkflowRunSnapshotV2({
			template: { id: "tpl_custom_epic", revision: 1 },
			canonicalRoot: root,
			manifest: {
				schema_version: 2,
				nodes: [
					{
						id: "custom_step",
						label: "Custom manifest label",
						type: "generic",
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "low",
						agent_file: "agents/custom.md",
					},
					{ id: "founder_gate", type: "gate" },
				],
				edges: [
					{
						id: "done",
						from: "custom_step",
						to: "founder_gate",
						condition: "node_done",
					},
				],
				loops: [],
				terminal_gate: {
					node: "founder_gate",
					predicate: "founder_approved",
				},
				ship_claims: ["founder_approved"],
			},
		}),
	);
}

describe("Epic page render receipts", () => {
	it("stores source-only receipts, rejects computed order, and prunes to 20", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const schema = rawDb(store)
				.prepare(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'epic_page'",
				)
				.get() as { sql: string };
			expect(schema.sql).toContain("PRIMARY KEY (project_name, version)");
			expect(schema.sql).toContain(
				"trigger TEXT NOT NULL CHECK (trigger IN ('manual','event','scan'))",
			);
			const first = store.insertEpicPageRenderReceipt({
				projectName: "example",
				trigger: "manual",
				receipt: receiptAt("2026-09-03T04:00:00Z"),
			});
			const second = store.insertEpicPageRenderReceipt({
				projectName: "example",
				trigger: "event",
				receipt: {
					...receiptAt("2026-09-03T05:00:00Z"),
					trigger: "event",
				},
			});
			expect([first.version, second.version]).toEqual([1, 2]);
			const stored = rawDb(store)
				.prepare(
					"SELECT receipt FROM epic_page WHERE project_name = ? AND version = ?",
				)
				.get("example", 1) as { receipt: string };
			expect(JSON.parse(stored.receipt)).toEqual(
				receiptAt("2026-09-03T04:00:00Z"),
			);
			expect(stored.receipt).not.toMatch(/batch|next_candidate|ready_items/i);

			expect(() =>
				store.insertEpicPageRenderReceipt({
					projectName: "example",
					trigger: "manual",
					receipt: {
						...receiptAt("2026-09-03T06:00:00Z"),
						ready_items: ["EPX-1"],
					} as EpicPageRenderReceipt,
				}),
			).toThrow(/computed order/i);
			expect(() =>
				store.insertEpicPageRenderReceipt({
					projectName: "example",
					trigger: "manual",
					receipt: {
						...receiptAt("2026-09-03T06:00:00Z"),
						sources: [
							{
								...receiptAt("2026-09-03T06:00:00Z").sources[0]!,
								path: "/ready_items",
							},
						],
					},
				}),
			).toThrow(/computed order/i);

			for (let version = 1; version <= 21; version += 1) {
				store.insertEpicPageRenderReceipt({
					projectName: "example",
					trigger: "scan",
					receipt: {
						...receiptAt(
							`2026-09-04T00:00:${String(version).padStart(2, "0")}Z`,
						),
						trigger: "scan",
					},
				});
			}
			const versions = rawDb(store)
				.prepare(
					"SELECT version FROM epic_page WHERE project_name = ? ORDER BY version DESC",
				)
				.all("example") as Array<{ version: number }>;
			expect(versions).toHaveLength(20);
			expect(versions[0]?.version).toBe(23);
			expect(versions.at(-1)?.version).toBe(4);
		} finally {
			store.close();
		}
	});

	it("reopens a file-backed store with the render receipt intact", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2140-epic-page-"));
		cleanups.push(root);
		const dbPath = join(root, "state.db");
		const original = await StateStore.create(dbPath);
		original.insertEpicPageRenderReceipt({
			projectName: "example",
			trigger: "manual",
			receipt: receiptAt("2026-09-03T04:00:00Z"),
		});
		original.close();

		const reopened = await StateStore.create(dbPath);
		try {
			const stored = rawDb(reopened)
				.prepare("SELECT receipt FROM epic_page WHERE project_name = ?")
				.get("example") as { receipt: string };
			expect(JSON.parse(stored.receipt)).toEqual(
				receiptAt("2026-09-03T04:00:00Z"),
			);
		} finally {
			reopened.close();
		}
	});

	it("migrates legacy full documents into source-only receipts", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2140-epic-page-legacy-"));
		cleanups.push(root);
		const dbPath = join(root, "state.db");
		const legacy = new BetterSqlite3(dbPath);
		legacy.exec(`
			CREATE TABLE epic_page (
				project_name TEXT NOT NULL,
				epic_issue_id TEXT NOT NULL,
				epic_identifier TEXT NOT NULL,
				version INTEGER NOT NULL,
				generated_at TEXT NOT NULL,
				trigger TEXT NOT NULL,
				content_digest TEXT NOT NULL,
				document TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (project_name, epic_issue_id, version)
			)
		`);
		legacy
			.prepare(
				`INSERT INTO epic_page
				 (project_name, epic_issue_id, epic_identifier, version, generated_at,
				  trigger, content_digest, document)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"example",
				"epic-uuid",
				"EPX-1",
				1,
				"2026-09-03T04:00:00Z",
				"manual",
				"legacy-digest",
				JSON.stringify({
					key: { project_name: "example" },
					generated_at: "2026-09-03T04:00:00Z",
					generator: { trigger: "manual" },
					ready_items: {
						value: ["EPX-2"],
						provenance: { kind: "derived", rule: "ready.v1", from: [] },
						observed_at: "2026-09-03T04:00:00Z",
					},
					items: [
						{
							title: {
								value: "Child",
								provenance: {
									kind: "linear",
									entity: "issue",
									id: "child-uuid",
									field: "title",
								},
								observed_at: "2026-09-03T04:00:00Z",
								source_updated_at: "2026-09-03T03:00:00Z",
							},
						},
					],
				}),
			);
		legacy.close();

		const migrated = await StateStore.create(dbPath);
		try {
			const stored = rawDb(migrated)
				.prepare("SELECT receipt FROM epic_page WHERE project_name = ?")
				.get("example") as { receipt: string };
			const receipt = JSON.parse(stored.receipt) as EpicPageRenderReceipt;
			expect(receipt.sources).toHaveLength(1);
			expect(receipt.sources[0]?.path).toBe("/items/0/title");
			expect(stored.receipt).not.toMatch(/ready_items|EPX-2/);
		} finally {
			migrated.close();
		}
	});
});

describe("Epic page execution fact projections", () => {
	it("scopes sessions by project and uses julianday, deterministic ties, and all-row live count", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const db = rawDb(store);
			const insert = db.prepare(
				`INSERT INTO sessions
				 (execution_id, issue_id, issue_identifier, project_name, status,
				  started_at, last_activity_at, branch, session_role, last_error)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			insert.run(
				"exec-b-long",
				"child-uuid",
				"EPX-1",
				"example",
				"running",
				"2026-09-03T02:00:00Z",
				"2026-09-03T02:00:00Z",
				"branch-b",
				"implement",
				"/SECRET Bearer token",
			);
			insert.run(
				"exec-a-long",
				"child-uuid",
				"EPX-1",
				"example",
				"completed",
				"2026-09-03 02:00:00",
				"2026-09-03 03:00:00",
				"branch-a",
				"qa",
				null,
			);
			insert.run(
				"exec-cross-project",
				"child-uuid",
				"EPX-1",
				"other",
				"running",
				"2026-09-03 05:00:00",
				"2026-09-03 05:00:00",
				null,
				"main",
				null,
			);

			const fact = store.getEpicPageSessionFact("example", [
				"child-uuid",
				"EPX-1",
			]);
			expect(fact).toEqual({
				value: {
					latest: [
						{
							status: "completed",
							role: "qa",
							branch: "branch-a",
							execution_id8: "exec-a-l",
						},
					],
					ledger_live_count: 1,
				},
				source_updated_at: "2026-09-03T03:00:00Z",
			});
			expect(JSON.stringify(fact)).not.toContain("SECRET");

			db.prepare(
				"UPDATE sessions SET last_activity_at = '2026-09-03 02:00:00' WHERE execution_id = 'exec-a-long'",
			).run();
			expect(
				store.getEpicPageSessionFact("example", ["EPX-1"]).value.latest[0]
					?.execution_id8,
			).toBe("exec-a-l");
		} finally {
			store.close();
		}
	});

	it("projects active run labels from the pinned manifest and RFC3339 attempt times", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2140-snapshot-"));
		cleanups.push(root);
		const store = await StateStore.create(":memory:");
		try {
			const db = rawDb(store);
			db.prepare(
				`INSERT INTO workflow_run
				 (run_id, issue_id, project_name, template_id, snapshot,
				  current_node_id, status)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"run-custom",
				"EPX-1",
				"example",
				"tpl_custom_epic",
				customSnapshot(root),
				"custom_step",
				"active",
			);
			db.prepare(
				`INSERT INTO workflow_run_node (run_id, node_id, attempt, state)
				 VALUES (?, ?, ?, ?)`,
			).run("run-custom", "custom_step", 2, "review");

			const run = store.getEpicPageRunFact("example", ["child-uuid", "EPX-1"]);
			expect(run.value).toEqual([
				{
					run_id: "run-custom",
					status: "active",
					current_node_id: "custom_step",
					current_node_label: "Custom manifest label",
					label_source: "manifest",
					template_id: "tpl_custom_epic",
				},
			]);
			expect(run.source_updated_at).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
			);

			const attempt = store.getEpicPageAttemptFact("run-custom", "custom_step");
			expect(attempt.value).toEqual([
				{ state: "review", attempt: 2, ledger_open: true },
			]);
			expect(attempt.source_updated_at).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
			);
		} finally {
			store.close();
		}
	});

	it("finds current land operations by either identifier or uuid within the project", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const insert = rawDb(store).prepare(
				`INSERT INTO land_operation
				 (operation_id, issue_id, project_name, pr_number, approved_head,
				  state, current_step, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			insert.run(
				"land-identifier",
				"EPX-1",
				"example",
				101,
				"a".repeat(40),
				"running",
				"merge",
				"2026-09-03T01:00:00Z",
				"2026-09-03T01:00:00Z",
			);
			insert.run(
				"land-uuid",
				"child-uuid",
				"example",
				102,
				"b".repeat(40),
				"held",
				null,
				"2026-09-03T02:00:00Z",
				"2026-09-03T02:00:00Z",
			);
			insert.run(
				"land-other",
				"child-uuid",
				"other",
				103,
				"c".repeat(40),
				"running",
				"push",
				"2026-09-03T03:00:00Z",
				"2026-09-03T03:00:00Z",
			);

			expect(store.getEpicPageLandFact("example", ["EPX-1"]).value).toEqual([
				{ pr_number: 101, state: "running", current_step: "merge" },
			]);
			expect(
				store.getEpicPageLandFact("example", ["child-uuid"]).value,
			).toEqual([{ pr_number: 102, state: "held", current_step: null }]);
		} finally {
			store.close();
		}
	});

	it("returns every current land operation newest first with its source time", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const insert = rawDb(store).prepare(
				`INSERT INTO land_operation
				 (operation_id, issue_id, project_name, pr_number, approved_head,
				  state, current_step, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			insert.run(
				"zz-old-hash",
				"EPX-1",
				"example",
				101,
				"a".repeat(40),
				"held",
				null,
				"2026-09-03T01:00:00Z",
				"2026-09-03T01:00:00Z",
			);
			insert.run(
				"aa-new-hash",
				"EPX-1",
				"example",
				102,
				"b".repeat(40),
				"running",
				"merge",
				"2026-09-03T02:00:00Z",
				"2026-09-03T03:00:00Z",
			);

			expect(store.getEpicPageLandFact("example", ["EPX-1"])).toEqual({
				value: [
					{ pr_number: 102, state: "running", current_step: "merge" },
					{ pr_number: 101, state: "held", current_step: null },
				],
				source_updated_at: "2026-09-03T03:00:00Z",
			});
		} finally {
			store.close();
		}
	});

	it("materializes six cells, splits gate/carrier rows, and propagates stable failures", async () => {
		const store = await StateStore.create(":memory:");
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			vi.spyOn(store, "getEpicPageSessionFact").mockReturnValue({
				value: { latest: [], ledger_live_count: 0 },
			});
			const runSpy = vi.spyOn(store, "getEpicPageRunFact").mockReturnValue({
				value: [
					{
						run_id: "run-1",
						status: "active",
						current_node_id: "build",
						current_node_label: "Build",
						label_source: "manifest",
						template_id: "tpl",
					},
				],
			});
			vi.spyOn(store, "getEpicPageAttemptFact").mockReturnValue({ value: [] });
			const authoritySpy = vi
				.spyOn(store, "listOpenGateAuthorities")
				.mockReturnValue([
					{ runId: "run-1", kind: "gate", state: "awaiting_review" },
					{ runId: "run-1", kind: "carrier", state: "pending" },
				]);
			vi.spyOn(store, "getEpicPageLandFact").mockReturnValue({ value: [] });

			const facts = readEpicItemFacts(store, "example", {
				uuid: "child-uuid",
				identifier: "EPX-1",
			});
			expect(facts.gates).toEqual({
				ok: true,
				value: [{ state: "awaiting_review" }],
			});
			expect(facts.carriers).toEqual({
				ok: true,
				value: [{ state: "pending" }],
			});

			runSpy.mockImplementationOnce(() => {
				throw new Error("SECRET Bearer token /Users/private");
			});
			const failed = readEpicItemFacts(store, "example", {
				uuid: "child-uuid",
				identifier: "EPX-1",
			});
			expect(failed.run).toEqual({ ok: false, table: "workflow_run" });
			expect(failed.attempt).toEqual({
				ok: false,
				table: "workflow_run_node",
			});
			expect(failed.gates).toEqual({
				ok: false,
				table: "workflow_gate_holder",
			});
			expect(failed.carriers).toEqual({
				ok: false,
				table: "workflow_carrier_delivery",
			});

			authoritySpy.mockImplementationOnce(() => {
				throw new Error("SECOND_SECRET Bearer token /Users/private");
			});
			const unionFailed = readEpicItemFacts(store, "example", {
				uuid: "child-uuid",
				identifier: "EPX-1",
			});
			expect(unionFailed.attempt).toEqual({ ok: true, value: [] });
			expect(unionFailed.gates).toEqual({
				ok: false,
				table: "workflow_gate_holder",
			});
			expect(unionFailed.carriers).toEqual({
				ok: false,
				table: "workflow_carrier_delivery",
			});
			expect(JSON.stringify(failed)).not.toMatch(/SECRET|Bearer|\/Users/);
			expect(JSON.stringify(unionFailed)).not.toMatch(
				/SECOND_SECRET|Bearer|\/Users/,
			);
			expect(log).toHaveBeenCalled();
		} finally {
			store.close();
		}
	});
});
