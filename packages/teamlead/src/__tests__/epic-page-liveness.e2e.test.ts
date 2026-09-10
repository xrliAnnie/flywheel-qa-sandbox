import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { masterOnlyAuthMiddleware } from "../bridge/dependency-route.js";
import { createEpicPagePublisher } from "../bridge/epic-page-publisher.js";
import {
	createEpicPageRefresher,
	createEpicPageSerializer,
	type EpicPageAttemptInput,
	runEpicPageAttempt,
} from "../bridge/epic-page-refresher.js";
import { createEpicPageStatusRouter } from "../bridge/epic-page-route.js";
import { createEpicResidualScan } from "../bridge/epic-residual-scan.js";
import { LinearUpstreamError } from "../bridge/linear-query.js";
import { createReportCriticalSection } from "../bridge/report-critical-section.js";
import { ReportRegistry } from "../bridge/report-registry.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
} from "../epic-page/__tests__/fixtures/epic-shape.js";
import { generateEpicPage } from "../epic-page/generate.js";
import { materializeEpicPage } from "../epic-page/materialize.js";
import { buildEpicPageRenderReceipt } from "../epic-page/receipt.js";
import { readSignals } from "../epic-page/signals.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const project: ProjectEntry = {
	projectName: "example",
	projectRoot: "/tmp/example",
	leads: [],
	linear: { team: "EPX", project: "Example" },
};
const projects = [project];
const schedule = { leadId: "example-eng-lead", intervalMs: 30 * 60_000 };
const eventReasons = [
	"session_started",
	"session_completed",
	"session_failed",
	"run_started",
	"run_resumed",
	"linear_done",
	"dependency_changed",
] as const;

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

async function status(app: express.Application): Promise<Record<string, any>> {
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const port = (server.address() as AddressInfo).port;
		const response = await fetch(
			`http://127.0.0.1:${port}/api/epic-page/status?projectName=example`,
			{ headers: { authorization: "Bearer master" } },
		);
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
		};
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

interface Harness {
	dir: string;
	store: StateStore;
	registry: ReportRegistry;
	blobs: Map<string, string>;
	putEpicPage: ReturnType<typeof vi.fn>;
	refresher: ReturnType<typeof createEpicPageRefresher>;
	scan: ReturnType<typeof createEpicResidualScan>;
	runAttempt: (
		input: EpicPageAttemptInput,
	) => ReturnType<typeof runEpicPageAttempt>;
	setLinearAvailable(available: boolean): void;
	statusApp: express.Application;
}

async function createHarness(): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "fly2143-liveness-"));
	const store = await StateStore.create(":memory:");
	const registry = new ReportRegistry(dir);
	registry.ensureVercelProjectName();
	registry.markHostingMigrated({
		provider: "vercel-blob",
		migratedAt: "2026-09-03T03:00:00.000Z",
		gatewayDeploymentId: "dpl_gateway",
	});
	const blobs = new Map<string, string>();
	const putEpicPage = vi.fn(async (token: string, html: string) => {
		blobs.set(token, html);
		return {
			pathname: `r/${token}/index.html`,
			url: `https://store.private.blob.vercel-storage.com/r/${token}/index.html`,
		};
	});
	const publisher = createEpicPagePublisher({
		store,
		registry,
		blobStore: { putEpicPage },
		criticalSection: createReportCriticalSection(),
		now: () => EPIC_SHAPE_NOW,
	});
	const serializer = createEpicPageSerializer();
	let linearAvailable = true;
	const fetchSnapshot = vi.fn(async () => {
		if (!linearAvailable) throw new LinearUpstreamError("fixture unavailable");
		return epicShapeSnapshot();
	});
	const runAttempt = (input: EpicPageAttemptInput) =>
		runEpicPageAttempt(
			{
				store,
				serializer,
				publisher,
				now: () => EPIC_SHAPE_NOW,
				materialize: (attempt) =>
					materializeEpicPage(
						{
							fetchSnapshot,
							readItemFacts: () => emptyItemFacts(),
							readSignals: (projectName, items, now) =>
								readSignals(
									{
										stateStore: store,
										openCommReadonly: () => ({
											listEpicPageSignals: () => ({
												signals: [],
												truncated: false,
											}),
											close: () => undefined,
										}),
									},
									{ projectName, items, now },
								),
							readLeadNotes: (projectName, ids) =>
								store.getLeadNotes(projectName, ids),
							readFreshness: (projectName) => ({
								history: store.getEpicPageFreshness(projectName),
								publication: store.getEpicPagePublication(projectName),
							}),
							generatePage: generateEpicPage,
							buildReceipt: buildEpicPageRenderReceipt,
							now: () => EPIC_SHAPE_NOW,
						},
						{ ...attempt, scanSchedule: schedule },
					),
			},
			input,
		);
	const refresher = createEpicPageRefresher({
		projects,
		linearApiKey: "linear-key",
		store,
		runAttempt,
		now: () => EPIC_SHAPE_NOW,
	});
	const scan = createEpicResidualScan({
		store,
		projects,
		linearApiKey: "linear-key",
		resolveOwner: () => ({
			agentId: "example-eng-lead",
			matchMethod: "general",
			canSpawn: true,
		}),
		runAttempt,
		now: () => EPIC_SHAPE_NOW,
		log: vi.fn(),
	});
	const statusApp = express();
	statusApp.use(
		"/api/epic-page/status",
		masterOnlyAuthMiddleware("master", "scoped"),
		createEpicPageStatusRouter({
			store,
			projects,
			registry,
			now: () => EPIC_SHAPE_NOW,
			scanSchedule: () => schedule,
		}),
	);
	return {
		dir,
		store,
		registry,
		blobs,
		putEpicPage,
		refresher,
		scan,
		runAttempt,
		setLinearAvailable: (available) => {
			linearAvailable = available;
		},
		statusApp,
	};
}

describe("FLY-2143 Epic page liveness E2E", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const harness of harnesses) {
			harness.store.close();
			rmSync(harness.dir, { recursive: true, force: true });
		}
		harnesses.length = 0;
		vi.restoreAllMocks();
	});

	async function harness(): Promise<Harness> {
		const value = await createHarness();
		harnesses.push(value);
		return value;
	}

	it("coalesces an event burst, then republishes a scan at the same stable token", async () => {
		const subject = await harness();
		for (const reason of [...eventReasons, "dependency_changed"] as const) {
			subject.refresher.requestRefresh("example", reason);
		}
		await subject.refresher.flushForTest();

		const eventRows = rawDb(subject.store)
			.prepare(
				"SELECT reason FROM epic_page_refresh WHERE trigger = 'event' ORDER BY rowid",
			)
			.all() as Array<{ reason: string }>;
		expect(eventRows.length).toBeGreaterThanOrEqual(1);
		expect(eventRows.length).toBeLessThanOrEqual(2);
		expect(new Set(eventRows.flatMap((row) => row.reason.split(",")))).toEqual(
			new Set(eventReasons),
		);
		const firstPublication = subject.store.getEpicPagePublication("example")!;

		await expect(
			subject.scan.materializeForScan(project),
		).resolves.toMatchObject({
			kind: "ok",
		});
		const secondPublication = subject.store.getEpicPagePublication("example")!;
		expect(secondPublication.token).toBe(firstPublication.token);
		expect(secondPublication.last_version).toBeGreaterThan(
			firstPublication.last_version!,
		);
		expect(subject.registry.list()).toHaveLength(1);
		expect(subject.blobs.has(firstPublication.token)).toBe(true);
		expect(subject.putEpicPage).toHaveBeenCalledTimes(2);
		expect(subject.putEpicPage.mock.calls.map(([token]) => token)).toEqual([
			firstPublication.token,
			firstPublication.token,
		]);
	});

	it("lets the scan road recover no-op events while both absent roads leave no trace", async () => {
		const scanFallback = await harness();
		const noOpEventHook = vi.fn();
		for (const reason of eventReasons) noOpEventHook("example", reason);
		expect(
			rawDb(scanFallback.store)
				.prepare("SELECT COUNT(*) AS count FROM epic_page_refresh")
				.get(),
		).toEqual({ count: 0 });

		await scanFallback.scan.materializeForScan(project);
		expect(
			rawDb(scanFallback.store)
				.prepare("SELECT trigger, outcome FROM epic_page_refresh")
				.get(),
		).toMatchObject({ trigger: "scan", outcome: "ok:1" });

		const bothOff = await harness();
		for (const reason of eventReasons) noOpEventHook("example", reason);
		expect(
			rawDb(bothOff.store)
				.prepare("SELECT COUNT(*) AS count FROM epic_page_refresh")
				.get(),
		).toEqual({ count: 0 });
		expect(bothOff.registry.list()).toEqual([]);
		expect(bothOff.putEpicPage).not.toHaveBeenCalled();
	});

	it("reports scan failure live, preserves manual history, and clears it only after republish", async () => {
		const subject = await harness();
		const initial = await subject.runAttempt({
			projectName: "example",
			binding: project.linear!,
			apiKey: "linear-key",
			trigger: "event",
			reasons: ["run_started"],
		});
		if (initial.kind === "unavailable") throw initial.error;
		expect(initial).toMatchObject({ kind: "materialized", outcome: "ok:1" });
		const stableToken = subject.store.getEpicPagePublication("example")!.token;

		subject.setLinearAvailable(false);
		await expect(subject.scan.materializeForScan(project)).resolves.toEqual({
			kind: "unavailable",
			token: "transient: linear_unavailable",
		});
		const failed = await status(subject.statusApp);
		expect(failed).toMatchObject({
			status: 200,
			body: {
				freshness: {
					last_generated: { version: 1, trigger: "event" },
					last_published: { version: 1, trigger: "event" },
					publish_failures_since_last_published: 1,
					last_failure: { token: "transient: linear_unavailable" },
					last_publish_failure: { token: "transient: linear_unavailable" },
				},
				publication: { published: true },
			},
		});

		subject.setLinearAvailable(true);
		const manual = await subject.runAttempt({
			projectName: "example",
			binding: project.linear!,
			apiKey: "linear-key",
			trigger: "manual",
			reasons: ["manual"],
		});
		expect(manual).toMatchObject({
			kind: "materialized",
			outcome: "ok_unpublished:2:manual",
		});
		expect(subject.store.getEpicPageFreshness("example")).toMatchObject({
			last_generated: { version: 2, trigger: "manual" },
			last_published: { version: 1, trigger: "event" },
			publish_failures_since_last_published: 1,
		});

		const recovered = await subject.runAttempt({
			projectName: "example",
			binding: project.linear!,
			apiKey: "linear-key",
			trigger: "event",
			reasons: ["session_completed"],
		});
		expect(recovered).toMatchObject({
			kind: "materialized",
			materialized: {
				page: {
					freshness: { publish_failures: { value: { count: 1 } } },
				},
			},
		});
		expect(subject.store.getEpicPageFreshness("example")).toMatchObject({
			publish_failures_since_last_published: 0,
			last_published: { version: 3, trigger: "event" },
		});
		expect(subject.store.getEpicPagePublication("example")!.token).toBe(
			stableToken,
		);
	});

	it("keeps the generated timestamp static and passes the hosted HTML --self-check", async () => {
		vi.useRealTimers();
		const subject = await harness();
		const initial = await subject.runAttempt({
			projectName: "example",
			binding: project.linear!,
			apiKey: "linear-key",
			trigger: "event",
			reasons: ["linear_done"],
		});
		if (initial.kind === "unavailable") throw initial.error;
		expect(initial).toMatchObject({ kind: "materialized", outcome: "ok:1" });
		const token = subject.store.getEpicPagePublication("example")!.token;
		const html = subject.blobs.get(token)!;
		expect(html).toContain(EPIC_SHAPE_NOW.toISOString());
		const htmlPath = join(subject.dir, "hosted-epic.html");
		writeFileSync(htmlPath, html, "utf8");
		const probe = join(
			__dirname,
			"..",
			"..",
			"scripts",
			"epic-page-html-self-check.mjs",
		);

		const normal = JSON.parse(
			execFileSync(process.execPath, [probe, "--file", htmlPath], {
				encoding: "utf8",
			}),
		);
		const selfCheck = JSON.parse(
			execFileSync(
				process.execPath,
				[probe, "--file", htmlPath, "--self-check"],
				{ encoding: "utf8" },
			),
		);
		expect(normal).toMatchObject({ ok: true, dynamicAgeChanged: true });
		expect(selfCheck).toMatchObject({
			ok: true,
			blockedScriptFailed: true,
			hiddenElementFailed: true,
		});
	});
});
