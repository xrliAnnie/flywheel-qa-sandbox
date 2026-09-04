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
import { createEpicPageRouter } from "../epic-page-route.js";
import {
	ActiveScopeNotFoundError,
	EpicSnapshotTruncatedError,
	EpicTooLargeError,
} from "../linear-epic-query.js";
import { LinearUpstreamError } from "../linear-query.js";
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
		const response = await request(
			app({
				fetchSnapshot: vi.fn(async () => {
					throw failure;
				}),
			}),
			{ token: "master", body: { projectName: "example" } },
		);
		expect(response).toMatchObject({ status, body: { error } });
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
});
