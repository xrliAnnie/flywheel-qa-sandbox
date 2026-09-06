import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EPIC_SHAPE_NOW,
	epicShapeSnapshot,
} from "../../epic-page/__tests__/fixtures/epic-shape.js";
import { generateEpicPage } from "../../epic-page/generate.js";
import { EpicPageSchemaError } from "../../epic-page/model.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { masterOnlyAuthMiddleware } from "../dependency-route.js";
import {
	createEpicPageRouter,
	createEpicPageStatusRouter,
} from "../epic-page-route.js";
import {
	ActiveScopeNotFoundError,
	EpicSnapshotTruncatedError,
	EpicTooLargeError,
} from "../linear-epic-query.js";
import { LinearUpstreamError } from "../linear-query.js";
import { scheduledAtOrBefore } from "../patrol-tick.js";
import { tokenAuthMiddleware } from "../plugin.js";

const projects: ProjectEntry[] = [
	{
		projectName: "example",
		projectRoot: "/tmp/example",
		leads: [],
		linear: { team: "EPX", project: "Example", label: "Scope" },
	},
	{
		projectName: "unbound",
		projectRoot: "/tmp/unbound",
		leads: [],
	},
];

async function request(
	app: express.Application,
	options: { token?: string; body?: unknown } = {},
) {
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		const response = await fetch(`${base}/api/epic-page/generate`, {
			method: "POST",
			headers: {
				...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
				...(options.body !== undefined
					? { "content-type": "application/json" }
					: {}),
			},
			...(options.body !== undefined
				? { body: JSON.stringify(options.body) }
				: {}),
		});
		const text = await response.text();
		return {
			status: response.status,
			contentType: response.headers.get("content-type") ?? "",
			text,
			body: response.headers.get("content-type")?.includes("json")
				? (JSON.parse(text) as Record<string, unknown>)
				: undefined,
		};
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

async function requestStatus(
	app: express.Application,
	options: { token?: string; projectName?: string } = {},
) {
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		const query =
			options.projectName === undefined
				? ""
				: `?projectName=${encodeURIComponent(options.projectName)}`;
		const response = await fetch(`${base}/api/epic-page/status${query}`, {
			headers: options.token
				? { authorization: `Bearer ${options.token}` }
				: {},
		});
		const text = await response.text();
		return {
			status: response.status,
			text,
			body: JSON.parse(text) as Record<string, unknown>,
		};
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

describe("Epic page router", () => {
	let store: StateStore;
	let insert: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		insert = vi.spyOn(store, "insertEpicPageRenderReceipt");
	});

	afterEach(() => {
		store.close();
		vi.restoreAllMocks();
	});

	function app(
		overrides: Partial<Parameters<typeof createEpicPageRouter>[0]> = {},
	) {
		const application = express();
		application.use(express.json());
		application.use(
			"/api/epic-page",
			tokenAuthMiddleware("master", "scoped"),
			createEpicPageRouter({
				store,
				projects,
				linearApiKey: "linear-key",
				fetchSnapshot: vi.fn(async () => epicShapeSnapshot()),
				now: () => EPIC_SHAPE_NOW,
				...overrides,
			}),
		);
		return application;
	}

	it("requires the master token and rejects the scoped token", async () => {
		const application = app();
		expect(
			(await request(application, { body: { projectName: "example" } })).status,
		).toBe(401);
		expect(
			(
				await request(application, {
					token: "scoped",
					body: { projectName: "example" },
				})
			).status,
		).toBe(403);
		expect(insert).not.toHaveBeenCalled();
	});

	it.each([
		[{}, 400, "project_required"],
		[{ projectName: "" }, 400, "project_required"],
		[{ projectName: 7 }, 400, "project_required"],
		[{ projectName: "missing" }, 404, "unknown_project"],
		[{ projectName: "unbound" }, 404, "project_unbound"],
		[{ projectName: "example", format: "pdf" }, 400, "invalid_format"],
		[{ projectName: "example", epic: "EPX-100" }, 400, "unsupported_option"],
		[{ projectName: "example", version: 1 }, 400, "unsupported_option"],
	] as const)("rejects invalid input %#", async (body, status, error) => {
		const response = await request(app(), { token: "master", body });
		expect(response).toMatchObject({ status, body: { error } });
		expect(insert).not.toHaveBeenCalled();
	});

	it("passes the configured Linear boundary into live scope discovery", async () => {
		const fetchSnapshot = vi.fn(async () => epicShapeSnapshot());
		const response = await request(app({ fetchSnapshot }), {
			token: "master",
			body: { projectName: "example" },
		});
		expect(response.status).toBe(200);
		expect(fetchSnapshot).toHaveBeenCalledWith("linear-key", {
			team: "EPX",
			project: "Example",
			label: "Scope",
		});
	});

	it.each([
		[new ActiveScopeNotFoundError(), 422, "active_scope_not_found"],
		[new EpicTooLargeError(), 422, "scope_too_large"],
		[
			new EpicSnapshotTruncatedError("labels overflow"),
			422,
			"scope_snapshot_truncated",
		],
		[new LinearUpstreamError("timeout"), 502, "linear_unavailable"],
	] as const)("maps live scope failure %#", async (failure, status, error) => {
		store.insertEpicPageRefresh({
			projectName: "example",
			attemptedAt: "2026-09-03T03:00:00.000Z",
			trigger: "scan",
			reasons: ["scan"],
			outcome: "ok:2",
		});
		const response = await request(
			app({
				fetchSnapshot: vi.fn(async () => {
					throw failure;
				}),
			}),
			{ token: "master", body: { projectName: "example" } },
		);
		expect(response).toMatchObject({
			status,
			body: {
				error,
				last_generated: {
					version: 2,
					trigger: "scan",
					attempted_at: "2026-09-03T03:00:00.000Z",
				},
				last_published: {
					version: 2,
					trigger: "scan",
					attempted_at: "2026-09-03T03:00:00.000Z",
				},
			},
		});
		expect(insert).not.toHaveBeenCalled();
	});

	it.each([
		[new EpicPageSchemaError("too large", "size"), "epic_page_too_large"],
		[new EpicPageSchemaError("bad document"), "epic_page_invalid"],
	] as const)(
		"does not write an invalid generated page",
		async (failure, error) => {
			const response = await request(
				app({
					generatePage: vi.fn(() => {
						throw failure;
					}),
				}),
				{ token: "master", body: { projectName: "example" } },
			);
			expect(response).toMatchObject({ status: 422, body: { error } });
			expect(insert).not.toHaveBeenCalled();
		},
	);

	it("returns internal_error without a document when receipt insertion fails", async () => {
		insert.mockImplementation(() => {
			throw new Error("receipt write failed");
		});

		const response = await request(app(), {
			token: "master",
			body: { projectName: "example" },
		});

		expect(response).toMatchObject({
			status: 500,
			body: { error: "internal_error" },
		});
		expect(response.body).not.toHaveProperty("document");
	});

	it("fails without Linear config and rejects an oversized returned scope", async () => {
		const missingKey = await request(app({ linearApiKey: undefined }), {
			token: "master",
			body: { projectName: "example" },
		});
		expect(missingKey).toMatchObject({
			status: 501,
			body: { error: "linear_not_configured" },
		});
		const oversized = epicShapeSnapshot();
		oversized.items = Array.from({ length: 501 }, (_, index) => ({
			...oversized.items[0]!,
			id: `id-${index}`,
			identifier: `EPX-${index + 1}`,
		}));
		const tooLarge = await request(
			app({ fetchSnapshot: vi.fn(async () => oversized) }),
			{ token: "master", body: { projectName: "example" } },
		);
		expect(tooLarge).toMatchObject({
			status: 422,
			body: { error: "scope_too_large" },
		});
		expect(insert).not.toHaveBeenCalled();
	});

	it("recomputes JSON, Markdown, and HTML live and stores no computed order", async () => {
		const fetchSnapshot = vi.fn(async () => epicShapeSnapshot());
		const application = app({ fetchSnapshot });
		const json = await request(application, {
			token: "master",
			body: { projectName: "example", format: "json" },
		});
		expect(json).toMatchObject({
			status: 200,
			contentType: expect.stringContaining("application/json"),
			body: {
				receipt: { version: 1 },
				document: { schema_version: 1 },
			},
		});
		expect(
			(json.body?.document as { ready_items: { value: string[] } }).ready_items
				.value,
		).toEqual(["EPX-1", "EPX-5"]);

		const markdown = await request(application, {
			token: "master",
			body: { projectName: "example", format: "md" },
		});
		expect(markdown.status).toBe(200);
		expect(markdown.contentType).toContain("text/markdown");
		expect(markdown.text).toContain("现在可以开始");

		const html = await request(application, {
			token: "master",
			body: { projectName: "example", format: "html" },
		});
		expect(html.status).toBe(200);
		expect(html.contentType).toContain("text/html");
		expect(html.text).toContain("<!doctype html>");
		expect(fetchSnapshot).toHaveBeenCalledTimes(3);
		expect(insert).toHaveBeenCalledTimes(3);

		const rows = rawDb(store)
			.prepare("SELECT receipt FROM epic_page ORDER BY version")
			.all() as Array<{ receipt: string }>;
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(row.receipt).not.toMatch(/batch|next_candidate|ready_items/i);
			expect(JSON.parse(row.receipt)).toHaveProperty("sources");
		}
	});

	it("records manual generation without invoking the hosted publisher", async () => {
		const publishHosted = vi.fn(async () => "ok:1" as const);
		const response = await request(app({ publisher: { publishHosted } }), {
			token: "master",
			body: { projectName: "example" },
		});

		expect(response.status).toBe(200);
		expect(publishHosted).not.toHaveBeenCalled();
		expect(
			rawDb(store)
				.prepare(
					"SELECT trigger, reason, outcome FROM epic_page_refresh ORDER BY rowid",
				)
				.all(),
		).toEqual([
			{
				trigger: "manual",
				reason: "manual",
				outcome: "ok_unpublished:1:manual",
			},
		]);
	});

	it("embeds the production patrol phase in manual page freshness", async () => {
		const intervalMs = 30 * 60_000;
		const response = await request(
			app({
				scanSchedule: () => ({
					leadId: "example-eng-lead",
					intervalMs,
				}),
			}),
			{ token: "master", body: { projectName: "example" } },
		);
		const expectedSeconds = Math.ceil(
			(scheduledAtOrBefore(
				EPIC_SHAPE_NOW.getTime(),
				"example-eng-lead",
				intervalMs,
			) +
				intervalMs -
				EPIC_SHAPE_NOW.getTime()) /
				1_000,
		);

		expect(response).toMatchObject({
			status: 200,
			body: {
				document: {
					freshness: {
						next_scan: {
							value: { expected_in_seconds: expectedSeconds },
						},
					},
				},
			},
		});
	});

	it("serializes concurrent live generation by project", async () => {
		let active = 0;
		let maxActive = 0;
		const fetchSnapshot = vi.fn(async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 10));
			active -= 1;
			return epicShapeSnapshot();
		});
		const application = app({ fetchSnapshot, generatePage: generateEpicPage });
		const calls = await Promise.all([
			request(application, {
				token: "master",
				body: { projectName: "example" },
			}),
			request(application, {
				token: "master",
				body: { projectName: "example" },
			}),
		]);
		expect(
			calls.map(
				(call) =>
					(call.body?.receipt as { version: number } | undefined)?.version,
			),
		).toEqual([1, 2]);
		expect(maxActive).toBe(1);
	});

	it("serves freshness, stable publication URL, and the next scan without generating", async () => {
		store.insertEpicPageRefresh({
			projectName: "example",
			attemptedAt: "2026-09-03T03:00:00.000Z",
			trigger: "scan",
			reasons: ["scan"],
			outcome: "ok:3",
		});
		const { token } = store.reserveEpicPageToken("example");
		store.commitEpicPagePublication({
			projectName: "example",
			token,
			publishedAt: "2026-09-03T03:00:01.000Z",
			version: 3,
		});
		const statusApp = express();
		const readFreshness = vi.spyOn(store, "getEpicPageFreshness");
		const readPublication = vi.spyOn(store, "getEpicPagePublication");
		statusApp.use(
			"/api/epic-page/status",
			masterOnlyAuthMiddleware("master", "scoped"),
			createEpicPageStatusRouter({
				store,
				projects,
				registry: {
					hosting: () => ({
						provider: "vercel-blob",
						migratedAt: "2026-09-03T02:00:00.000Z",
						gatewayDeploymentId: "dep-1",
					}),
					vercelProjectName: () => "fw-reports-test",
				},
				now: () => new Date("2026-09-03T04:00:00.000Z"),
				scanSchedule: () => ({
					leadId: "example-eng-lead",
					intervalMs: 30 * 60_000,
				}),
			}),
		);

		const response = await requestStatus(statusApp, {
			token: "master",
			projectName: "example",
		});

		const nextScanExpectedAt = new Date(
			scheduledAtOrBefore(
				Date.parse("2026-09-03T04:00:00.000Z"),
				"example-eng-lead",
				30 * 60_000,
			) +
				30 * 60_000,
		).toISOString();
		expect(response).toMatchObject({
			status: 200,
			body: {
				freshness: {
					last_generated: { version: 3, trigger: "scan" },
					last_published: { version: 3, trigger: "scan" },
				},
				publication: {
					token8: token.slice(0, 8),
					published: true,
					url: `https://fw-reports-test.vercel.app/r/${token}/`,
					last_published_at: "2026-09-03T03:00:01.000Z",
					last_version: 3,
				},
				next_scan_expected_at: nextScanExpectedAt,
			},
		});
		expect(response.text).not.toContain(`"token":"${token}"`);
		expect(readFreshness).toHaveBeenCalledOnce();
		expect(readPublication).toHaveBeenCalledOnce();
		expect(insert).not.toHaveBeenCalled();
	});

	it("never advertises an unpublished or host-override Epic page", async () => {
		const { token } = store.reserveEpicPageToken("example");
		const statusApp = (hostOverride = false) => {
			const application = express();
			application.use(
				"/api/epic-page/status",
				masterOnlyAuthMiddleware("master", "scoped"),
				createEpicPageStatusRouter({
					store,
					projects,
					registry: {
						hosting: () => ({
							provider: "vercel-blob",
							migratedAt: "2026-09-03T02:00:00.000Z",
							gatewayDeploymentId: "dep-1",
						}),
						vercelProjectName: () => "fw-reports-test",
					},
					...(hostOverride
						? {
								hostOverride: {
									apiBaseUrl: "http://127.0.0.1:9999",
									publicBaseUrl: "http://127.0.0.1:9999",
								},
							}
						: {}),
				}),
			);
			return application;
		};

		expect(
			await requestStatus(statusApp(), {
				token: "master",
				projectName: "example",
			}),
		).toMatchObject({
			status: 200,
			body: { publication: { published: false, url: null } },
		});

		store.commitEpicPagePublication({
			projectName: "example",
			token,
			publishedAt: "2026-09-03T03:00:01.000Z",
			version: 1,
		});
		expect(
			await requestStatus(statusApp(true), {
				token: "master",
				projectName: "example",
			}),
		).toMatchObject({
			status: 200,
			body: { publication: { published: false, url: null } },
		});
	});

	it("fails status closed for scoped credentials and missing master-token config", async () => {
		const statusRouter = () =>
			createEpicPageStatusRouter({
				store,
				projects,
				registry: {
					hosting: () => undefined,
					vercelProjectName: () => undefined,
				},
			});
		const scopedApp = express();
		scopedApp.use(
			"/api/epic-page/status",
			masterOnlyAuthMiddleware("master", "scoped"),
			statusRouter(),
		);
		const unconfiguredApp = express();
		unconfiguredApp.use(
			"/api/epic-page/status",
			masterOnlyAuthMiddleware(undefined, "scoped"),
			statusRouter(),
		);

		expect(
			await requestStatus(scopedApp, {
				token: "scoped",
				projectName: "example",
			}),
		).toMatchObject({ status: 403 });
		expect(
			await requestStatus(unconfiguredApp, {
				token: "master",
				projectName: "example",
			}),
		).toMatchObject({ status: 503 });
	});
});
