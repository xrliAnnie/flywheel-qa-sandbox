import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BROWSER_TOOL_SCHEMAS, BrowserToolPolicy } from "../browser-tools.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function setup() {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2519-browser-tools-")),
	);
	dirs.push(root);
	const artifactRoot = join(root, "artifacts");
	mkdirSync(artifactRoot, { mode: 0o700 });
	const assertCurrent = vi.fn();
	const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
	return {
		artifactRoot,
		assertCurrent,
		lookup,
		policy: new BrowserToolPolicy({ artifactRoot, assertCurrent, lookup }),
	};
}
it("denies raw upload, arbitrary output paths and unaudited tools before any provider work", async () => {
	const { policy, lookup } = setup();
	for (const [name, args] of [
		["upload_file", { uid: "1", filePaths: ["/etc/passwd"] }],
		["install_extension", {}],
		["evaluate_script", { function: "()=>1", filePath: "/tmp/out" }],
		["get_network_request", { reqid: 1, responseFilePath: "/tmp/out" }],
		["take_screenshot", { filePath: "/tmp/out" }],
		[
			"fill_form",
			{ elements: [{ uid: "1", value: "a", filePath: "/tmp/out" }] },
		],
	] as const)
		await expect(policy.prepare(name, args)).rejects.toThrow(/browser/);
	expect(lookup).not.toHaveBeenCalled();
	expect(Object.keys(BROWSER_TOOL_SCHEMAS)).not.toContain("upload_file");
});
it("permits QA interactions and allocates screenshot destinations in the private artifact area", async () => {
	const { policy, artifactRoot } = setup();
	expect(await policy.prepare("click", { uid: "1_2" })).toMatchObject({
		name: "click",
		arguments: { uid: "1_2" },
	});
	const a = await policy.prepare("take_screenshot", {
			format: "png",
			fullPage: true,
		}),
		b = await policy.prepare("take_screenshot", {});
	expect(a.artifact?.path).toBe(
		join(artifactRoot, `${a.artifact?.handle}.png`),
	);
	expect(a.arguments.filePath).toBe(a.artifact?.path);
	expect(a.artifact?.handle).not.toBe(b.artifact?.handle);
});
it.each([
	"file:///etc/passwd",
	"about:blank",
	"data:text/html,foo",
	"javascript:1",
	"chrome://settings",
	"https://@example.com/",
	"http://127.0.0.1:5555/",
	"http://2130706433/",
])("rejects model navigation to %s", async (url) => {
	await expect(setup().policy.prepare("new_page", { url })).rejects.toThrow(
		/browser/,
	);
});
it("rechecks authority after DNS and bounds navigation/interaction input", async () => {
	const { policy, lookup, assertCurrent } = setup();
	expect(
		await policy.prepare("new_page", { url: "https://example.com/report" }),
	).toMatchObject({ arguments: { url: "https://example.com/report" } });
	lookup.mockImplementationOnce(async () => {
		assertCurrent.mockImplementation(() => {
			throw Error("revoked");
		});
		return [{ address: "93.184.216.34", family: 4 }];
	});
	await expect(
		policy.prepare("navigate_page", { url: "https://example.com/report" }),
	).rejects.toThrow(/browser/);
	for (const args of [
		{},
		{ type: "back", url: "https://example.com" },
		{ type: "url" },
		{ type: "reload", timeout: 999999 },
	])
		await expect(setup().policy.prepare("navigate_page", args)).rejects.toThrow(
			/browser/,
		);
});

it("matches every exposed tool against installed pinned upstream schemas without launching Chrome", async () => {
	const { createRequire } = await import("node:module");
	const { dirname } = await import("node:path");
	const { pathToFileURL } = await import("node:url");
	const root = dirname(
		createRequire(import.meta.url).resolve("chrome-devtools-mcp/package.json"),
	);
	const { createTools } = await import(
		pathToFileURL(join(root, "build/src/tools/tools.js")).href
	);
	const { zod } = await import(
		pathToFileURL(join(root, "build/src/third_party/index.js")).href
	);
	const upstream = new Map(
		createTools({ javascriptEvaluation: true }).map(
			(tool: { name: string; schema: unknown }) => [tool.name, tool],
		),
	);
	const samples: Record<string, Record<string, unknown>> = {
		list_pages: {},
		select_page: { pageId: 1 },
		close_page: { pageId: 2 },
		new_page: { url: "https://example.com" },
		navigate_page: { type: "reload" },
		resize_page: { width: 1024, height: 768 },
		handle_dialog: { action: "dismiss" },
		click: { uid: "1" },
		hover: { uid: "1" },
		fill: { uid: "1", value: "v" },
		fill_form: { elements: [{ uid: "1", value: "v" }] },
		press_key: { key: "Enter" },
		drag: { from_uid: "1", to_uid: "2" },
		wait_for: { text: ["ready"] },
		take_snapshot: { verbose: true },
		take_screenshot: { format: "jpeg" },
		evaluate_script: { function: "()=>document.title" },
		list_console_messages: { pageSize: 100, types: ["warn", "issue"] },
		get_console_message: { msgid: 1 },
		list_network_requests: { pageSize: 100, resourceTypes: ["fetch"] },
		get_network_request: { reqid: 1 },
	};
	expect(Object.keys(samples).sort()).toEqual(
		Object.keys(BROWSER_TOOL_SCHEMAS).sort(),
	);
	const { policy } = setup();
	for (const [name, args] of Object.entries(samples)) {
		const prepared = await policy.prepare(name, args);
		const tool = upstream.get(name) as
			| { schema: Record<string, unknown> }
			| undefined;
		expect(tool, name).toBeDefined();
		expect(
			zod.object(tool!.schema).strict().safeParse(prepared.arguments).success,
			name,
		).toBe(true);
	}
});
