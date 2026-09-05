import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
} from "../../epic-page/__tests__/fixtures/epic-shape.js";
import { generateEpicPage } from "../../epic-page/generate.js";
import { EpicPageSchemaError } from "../../epic-page/model.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import {
	createEpicResidualScan,
	epicResidualBootWarnings,
} from "../epic-residual-scan.js";
import {
	ActiveScopeNotFoundError,
	EpicSnapshotTruncatedError,
} from "../linear-epic-query.js";
import { LinearUpstreamError } from "../linear-query.js";

const projects: ProjectEntry[] = [
	{
		projectName: "example",
		projectRoot: "/tmp/example",
		leads: [],
		linear: { team: "EPX", project: "Example" },
	},
	{
		projectName: "unbound",
		projectRoot: "/tmp/unbound",
		leads: [],
		linear: null,
	},
];

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

describe("createEpicResidualScan", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
		vi.restoreAllMocks();
	});

	it("omits the residual fact without reading Linear when the project has no binding", async () => {
		const fetchSnapshot = vi.fn();
		const scan = createEpicResidualScan({
			store,
			projects,
			linearApiKey: "linear-key",
			resolveOwner: () => ({
				agentId: "example-eng-lead",
				matchMethod: "general",
				canSpawn: true,
			}),
			fetchSnapshot,
		});

		await expect(
			scan.materializeForScan(projects[1]!),
		).resolves.toBeUndefined();
		expect(fetchSnapshot).not.toHaveBeenCalled();
	});

	it("omits the residual fact without reading Linear when the API key is missing", async () => {
		const fetchSnapshot = vi.fn();
		const scan = createEpicResidualScan({
			store,
			projects,
			resolveOwner: () => ({
				agentId: "example-eng-lead",
				matchMethod: "general",
				canSpawn: true,
			}),
			fetchSnapshot,
		});

		await expect(
			scan.materializeForScan(projects[0]!),
		).resolves.toBeUndefined();
		expect(fetchSnapshot).not.toHaveBeenCalled();
	});

	it("materializes one scan page and writes its scan receipt", async () => {
		const fetchSnapshot = vi.fn(async () => epicShapeSnapshot());
		const insert = vi.spyOn(store, "insertEpicPageRenderReceipt");
		const scan = createEpicResidualScan({
			store,
			projects,
			linearApiKey: "linear-key",
			resolveOwner: () => ({
				agentId: "example-eng-lead",
				matchMethod: "general",
				canSpawn: true,
			}),
			fetchSnapshot,
			now: () => EPIC_SHAPE_NOW,
		});

		const result = await scan.materializeForScan(projects[0]!);

		expect(result).toMatchObject({
			kind: "ok",
			materialized: {
				page: { generator: { trigger: "scan" } },
				snapshot: { fetchedAt: "2026-09-03T04:00:00Z" },
			},
		});
		expect(fetchSnapshot).toHaveBeenCalledWith("linear-key", {
			team: "EPX",
			project: "Example",
		});
		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({
				projectName: "example",
				trigger: "scan",
				receipt: expect.objectContaining({ trigger: "scan" }),
			}),
		);
		const rows = rawDb(store)
			.prepare(
				"SELECT project_name, trigger, receipt FROM epic_page ORDER BY version",
			)
			.all() as Array<{
			project_name: string;
			trigger: string;
			receipt: string;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			project_name: "example",
			trigger: "scan",
		});
		expect(JSON.parse(rows[0]!.receipt)).toMatchObject({
			project_name: "example",
			trigger: "scan",
		});
	});

	it("logs the project, item count, and elapsed time after a successful scan", async () => {
		const log = vi.fn();
		const scan = createEpicResidualScan({
			store,
			projects,
			linearApiKey: "linear-key",
			resolveOwner: () => ({
				agentId: "example-eng-lead",
				matchMethod: "general",
				canSpawn: true,
			}),
			fetchSnapshot: vi.fn(async () => epicShapeSnapshot()),
			now: () => EPIC_SHAPE_NOW,
			log,
		});

		await scan.materializeForScan(projects[0]!);

		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(
				/^\[patrol_tick\] epic scan project=example items=\d+ ms=\d+$/,
			),
		);
	});

	it("keeps the materialized fact when writing the optional scan receipt fails", async () => {
		vi.spyOn(store, "insertEpicPageRenderReceipt").mockImplementation(() => {
			throw new Error("receipt disk full");
		});
		const log = vi.fn();
		const scan = createEpicResidualScan({
			store,
			projects,
			linearApiKey: "linear-key",
			resolveOwner: () => ({
				agentId: "example-eng-lead",
				matchMethod: "general",
				canSpawn: true,
			}),
			fetchSnapshot: vi.fn(async () => epicShapeSnapshot()),
			now: () => EPIC_SHAPE_NOW,
			log,
		});

		await expect(scan.materializeForScan(projects[0]!)).resolves.toMatchObject({
			kind: "ok",
		});
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("receipt disk full"),
		);
	});

	it("turns a Linear failure into the canonical unavailable fact without leaking its message", async () => {
		const log = vi.fn();
		const scan = createEpicResidualScan({
			store,
			projects,
			linearApiKey: "linear-key",
			resolveOwner: () => ({
				agentId: "example-eng-lead",
				matchMethod: "general",
				canSpawn: true,
			}),
			fetchSnapshot: vi.fn(async () => {
				throw new LinearUpstreamError("upstream secret detail");
			}),
			log,
		});

		const result = await scan.materializeForScan(projects[0]!);

		expect(result).toEqual({
			kind: "unavailable",
			token: "transient: linear_unavailable",
		});
		expect(JSON.stringify(result)).not.toContain("upstream secret detail");
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("upstream secret detail"),
		);
	});

	it("classifies an absent active scope as a structural unavailable fact", async () => {
		const scan = createEpicResidualScan({
			store,
			projects,
			linearApiKey: "linear-key",
			resolveOwner: () => ({
				agentId: "example-eng-lead",
				matchMethod: "general",
				canSpawn: true,
			}),
			fetchSnapshot: vi.fn(async () => {
				throw new ActiveScopeNotFoundError();
			}),
			log: vi.fn(),
		});

		await expect(scan.materializeForScan(projects[0]!)).resolves.toEqual({
			kind: "unavailable",
			token: "structural: active_scope_not_found",
		});
	});

	it("applies the shared 500-item guard to injected snapshot fetchers", async () => {
		const oversized = epicShapeSnapshot();
		oversized.items = Array.from({ length: 501 }, (_, index) => ({
			...oversized.items[0]!,
			id: `id-${index}`,
			identifier: `EPX-${index + 1}`,
		}));
		const scan = createEpicResidualScan({
			store,
			projects,
			linearApiKey: "linear-key",
			resolveOwner: () => ({
				agentId: "example-eng-lead",
				matchMethod: "general",
				canSpawn: true,
			}),
			fetchSnapshot: vi.fn(async () => oversized),
			log: vi.fn(),
		});

		await expect(scan.materializeForScan(projects[0]!)).resolves.toEqual({
			kind: "unavailable",
			token: "structural: scope_too_large",
		});
	});

	it("classifies a truncated scope snapshot without exposing partial facts", async () => {
		const scan = createEpicResidualScan({
			store,
			projects,
			linearApiKey: "linear-key",
			resolveOwner: () => ({
				agentId: "example-eng-lead",
				matchMethod: "general",
				canSpawn: true,
			}),
			fetchSnapshot: vi.fn(async () => {
				throw new EpicSnapshotTruncatedError("relation page overflow");
			}),
			log: vi.fn(),
		});

		await expect(scan.materializeForScan(projects[0]!)).resolves.toEqual({
			kind: "unavailable",
			token: "structural: scope_snapshot_truncated",
		});
	});

	it("classifies an invalid generated Epic page as a structural unavailable fact", async () => {
		const scan = createEpicResidualScan({
			store,
			projects,
			linearApiKey: "linear-key",
			resolveOwner: () => ({
				agentId: "example-eng-lead",
				matchMethod: "general",
				canSpawn: true,
			}),
			fetchSnapshot: vi.fn(async () => epicShapeSnapshot()),
			generatePage: vi.fn(() => {
				throw new EpicPageSchemaError("bad generated page");
			}),
			log: vi.fn(),
		});

		await expect(scan.materializeForScan(projects[0]!)).resolves.toEqual({
			kind: "unavailable",
			token: "structural: epic_page_invalid",
		});
	});

	it("never rejects and classifies an unexpected scan failure as transient", async () => {
		const scan = createEpicResidualScan({
			store,
			projects,
			linearApiKey: "linear-key",
			resolveOwner: () => ({
				agentId: "example-eng-lead",
				matchMethod: "general",
				canSpawn: true,
			}),
			fetchSnapshot: vi.fn(async () => {
				throw new Error("unexpected failure");
			}),
			log: vi.fn(),
		});

		await expect(scan.materializeForScan(projects[0]!)).resolves.toEqual({
			kind: "unavailable",
			token: "transient: epic_scan_failed",
		});
	});

	it("turns a pre-materialization unavailable result into a fact with null timestamps", () => {
		const scan = createEpicResidualScan({
			store,
			projects,
			linearApiKey: "linear-key",
			resolveOwner: () => ({
				agentId: "example-eng-lead",
				matchMethod: "general",
				canSpawn: true,
			}),
		});

		expect(
			scan.summarizeForLead(
				{ kind: "unavailable", token: "transient: linear_unavailable" },
				"example-eng-lead",
				"roster",
			),
		).toEqual({
			schemaVersion: 1,
			kind: "unavailable",
			token: "transient: linear_unavailable",
			trigger: "roster",
			generatedAt: null,
			linearObservedAt: null,
		});
	});

	it("summarizes one materialized page for the requested Lead and trigger", async () => {
		const scan = createEpicResidualScan({
			store,
			projects,
			linearApiKey: "linear-key",
			resolveOwner: (_projectName, labels) => ({
				agentId: labels.includes("product")
					? "example-product-lead"
					: "example-eng-lead",
				matchMethod: labels.includes("product") ? "label" : "general",
				canSpawn: true,
			}),
			fetchSnapshot: vi.fn(async () => epicShapeSnapshot()),
			now: () => EPIC_SHAPE_NOW,
		});
		const materialized = await scan.materializeForScan(projects[0]!);

		expect(
			scan.summarizeForLead(materialized, "example-eng-lead", "roster"),
		).toMatchObject({
			kind: "available",
			trigger: "roster",
			remaining: 5,
			ready: 2,
			readyForLeadTotal: 2,
		});
	});

	it("fails closed on an unreadable session cell while preserving true observation times", () => {
		const snapshot = epicShapeSnapshot();
		const itemFacts = snapshot.items.map(() => emptyItemFacts());
		itemFacts[0]!.session = { ok: false, table: "sessions" };
		const page = generateEpicPage({
			snapshot,
			itemFacts,
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "scan",
		});
		const log = vi.fn();
		const scan = createEpicResidualScan({
			store,
			projects,
			linearApiKey: "linear-key",
			resolveOwner: () => ({
				agentId: "example-eng-lead",
				matchMethod: "general",
				canSpawn: true,
			}),
			log,
		});

		expect(
			scan.summarizeForLead(
				{ kind: "ok", materialized: { page, snapshot } },
				"example-eng-lead",
				"roster",
			),
		).toEqual({
			schemaVersion: 1,
			kind: "unavailable",
			token: "transient: session_ledger_unreadable",
			trigger: "roster",
			generatedAt: "2026-09-03T04:00:01.000Z",
			linearObservedAt: "2026-09-03T04:00:00Z",
		});
		expect(log).toHaveBeenCalledWith(
			"[patrol_tick] epic residual project=example lead=example-eng-lead unavailable=transient: session_ledger_unreadable",
		);
	});

	it("maps a residual assertion failure without discarding materialization times", () => {
		const snapshot = epicShapeSnapshot();
		const page = generateEpicPage({
			snapshot,
			itemFacts: snapshot.items.map(() => emptyItemFacts()),
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "scan",
		});
		const scan = createEpicResidualScan({
			store,
			projects,
			linearApiKey: "linear-key",
			resolveOwner: () => ({
				agentId: "example-eng-lead",
				matchMethod: "invalid" as "label",
				canSpawn: true,
			}),
		});

		expect(
			scan.summarizeForLead(
				{ kind: "ok", materialized: { page, snapshot } },
				"example-eng-lead",
				"roster",
			),
		).toEqual({
			schemaVersion: 1,
			kind: "unavailable",
			token: "structural: epic_residual_invalid",
			trigger: "roster",
			generatedAt: "2026-09-03T04:00:01.000Z",
			linearObservedAt: "2026-09-03T04:00:00Z",
		});
	});
});

describe("epicResidualBootWarnings", () => {
	it("returns one startup warning per unbound project when Linear is configured", () => {
		const unboundProjects: ProjectEntry[] = Array.from(
			{ length: 6 },
			(_, index) => ({
				projectName: `project-${index + 1}`,
				projectRoot: `/tmp/project-${index + 1}`,
				leads: [],
				linear: null,
			}),
		);

		expect(epicResidualBootWarnings(unboundProjects, true)).toEqual(
			unboundProjects.map(
				(project) =>
					`[patrol_tick] epic residual scan disabled for project=${project.projectName}: no linear binding in projects.json`,
			),
		);
	});

	it("returns one fleet-wide warning when LINEAR_API_KEY is not configured", () => {
		expect(epicResidualBootWarnings(projects, false)).toEqual([
			"[patrol_tick] epic residual scan disabled fleet-wide: LINEAR_API_KEY not configured",
		]);
	});

	it("returns no startup warnings when every project has a binding and Linear is configured", () => {
		const boundProjects: ProjectEntry[] = projects.map((project, index) => ({
			...project,
			linear: {
				team: `TEAM-${index + 1}`,
				project: `Project ${index + 1}`,
			},
		}));

		expect(epicResidualBootWarnings(boundProjects, true)).toEqual([]);
	});
});
