import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflowMenuRouter } from "../bridge/workflow-menu-routes.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SHA = "a".repeat(40);
let server: Server | undefined;

afterEach(
	() =>
		new Promise<void>((resolve) => {
			if (!server) return resolve();
			server.close(() => {
				server = undefined;
				resolve();
			});
		}),
);

async function serve(
	gitHead: (projectRoot: string) => string = () => SHA,
): Promise<string> {
	const app = express();
	app.use(
		"/api/workflow",
		createWorkflowMenuRouter(
			[{ projectName: "flywheel", projectRoot: REPO_ROOT }],
			{ gitHead },
		),
	);
	server = createServer(app);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function getWithHost(
	base: string,
	path: string,
	host: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const target = new URL(path, base);
	return new Promise((resolve, reject) => {
		const outbound = request(
			{
				hostname: target.hostname,
				port: target.port,
				path: `${target.pathname}${target.search}`,
				headers: { host },
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
					}),
				);
			},
		);
		outbound.on("error", reject);
		outbound.end();
	});
}

describe("GET /api/workflow/menus", () => {
	it("returns only the Lead-adopted menus with git-SHA version and resolved aliases", async () => {
		const base = await serve();
		const response = await fetch(
			`${base}/api/workflow/menus?projectName=flywheel&leadId=flywheel-eng-lead`,
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			success: true,
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			menuVersion: SHA,
		});
		expect(body.menus.map((menu: { item: string }) => menu.item)).toEqual([
			"code",
			"simple_code",
			"generic",
		]);
		expect(body.menus[0]).toMatchObject({
			item: "code",
			label: "工程开发",
			templateId: "tpl_code",
		});
		expect(body.menus[0].nodes[0]).toMatchObject({
			id: "eng_design",
			label: "设计(工程)",
			type: "design",
			defaultModel: "fable",
			models: [
				{
					model: "fable",
					resolvedModel: "claude-fable-5",
					receipt: "fable (= claude-fable-5)",
					allowedEfforts: ["low", "medium", "high", "xhigh", "max"],
					defaultEffort: "xhigh",
				},
				{
					model: "codex",
					resolvedModel: "gpt-5.6-sol",
					receipt: "codex (= gpt-5.6-sol)",
				},
			],
		});
		expect(Object.hasOwn(body.menus[0].nodes[0], "role")).toBe(false);
		for (const menu of body.menus) {
			expect(String(menu.label).trim().length).toBeGreaterThan(0);
			for (const node of menu.nodes) {
				expect(String(node.label).trim().length).toBeGreaterThan(0);
			}
		}
	});

	it("returns Honey Lemon's three single-session menus", async () => {
		const base = await serve();
		const response = await fetch(
			`${base}/api/workflow/menus?projectName=flywheel&leadId=flywheel-product-lead`,
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.menus.map((menu: { item: string }) => menu.item)).toEqual([
			"prd",
			"product_design_flow",
			"prototype",
		]);
	});

	it("rejects a non-loopback Host before exposing menu metadata", async () => {
		const base = await serve();
		const response = await getWithHost(
			base,
			"/api/workflow/menus?projectName=flywheel&leadId=flywheel-product-lead",
			"evil.example",
		);
		expect(response.status).toBe(403);
		expect(response.json).toEqual({
			success: false,
			code: "NON_LOOPBACK_HOST",
		});
	});

	it.each([
		[
			"/api/workflow/menus?leadId=flywheel-eng-lead",
			"PROJECT_NAME_REQUIRED",
			["flywheel"],
		],
		[
			"/api/workflow/menus?projectName=missing&leadId=flywheel-eng-lead",
			"MENU_PROJECT_NOT_FOUND",
			["flywheel"],
		],
		[
			"/api/workflow/menus?projectName=flywheel",
			"LEAD_ID_REQUIRED",
			["flywheel-eng-lead", "flywheel-product-lead"],
		],
		[
			"/api/workflow/menus?projectName=flywheel&leadId=missing",
			"LEAD_MENU_ADOPTION_NOT_FOUND",
			["flywheel-eng-lead", "flywheel-product-lead"],
		],
	] as const)("fails loud for %s", async (path, code, legal) => {
		const base = await serve();
		const response = await fetch(`${base}${path}`);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			success: false,
			code,
			legal,
		});
	});

	it("fails closed when the menu version cannot be read as a git SHA", async () => {
		const base = await serve(() => "not-a-sha");
		const response = await fetch(
			`${base}/api/workflow/menus?projectName=flywheel&leadId=flywheel-eng-lead`,
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			success: false,
			code: "MENU_VERSION_UNAVAILABLE",
		});
	});
});
