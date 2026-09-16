import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LeadArtifactStore } from "../artifacts.js";
import { createBrowserHandlers } from "../handlers/browser.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup() {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2519-browser-handler-")),
	);
	dirs.push(root);
	const artifactRoot = join(root, "artifacts");
	mkdirSync(artifactRoot, { mode: 0o700 });
	const generation = "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		call = vi.fn(async () => ({
			result: { content: [{ type: "text", text: "page" }] },
		}));
	const handlers = createBrowserHandlers({
		activationId: "activation",
		generation,
		worker: { call },
		workerArtifactRoot: join(root, "private", "artifacts"),
		store: new LeadArtifactStore({
			projectRoot: root,
			artifactRoot,
			assertCurrent() {},
		}),
		assertCurrent() {},
	});
	const context = {
		projectName: "p",
		leadId: "l",
		activationId: "activation",
		requestId: "bbbb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		signal: new AbortController().signal,
		assertCurrent: vi.fn(async () => {}),
	};
	return { handlers, generation, call, context };
}
it("binds exact generation and activation before calling the worker and projects its output", async () => {
	const { handlers, generation, call, context } = setup(),
		handler = handlers.get("browser.click")!;
	await handler.authorize({ generation, arguments: { uid: "1" } }, context);
	const result = await handler.execute(
		{ generation, arguments: { uid: "1" } },
		context,
	);
	expect(result).toMatchObject({
		status: "succeeded",
		data: { content: [{ type: "text", text: "page" }] },
	});
	expect(result.providerRef).toContain(context.requestId);
	expect(call).toHaveBeenCalledWith(
		generation,
		"click",
		{ uid: "1" },
		context.signal,
	);
	for (const [input, ctx] of [
		[{ generation: "stale", arguments: {} }, context],
		[{ generation, arguments: { uid: "1", filePath: "/etc/passwd" } }, context],
		[
			{ generation, arguments: { uid: "1" } },
			{ ...context, activationId: "other" },
		],
	])
		await expect(
			handler.authorize(input, ctx as typeof context),
		).rejects.toThrow(/browser/);
	expect(call).toHaveBeenCalledOnce();
	expect(handlers.has("browser.upload_file")).toBe(false);
});
it("returns unknown on lost output without replaying the worker", async () => {
	const { handlers, generation, call, context } = setup();
	call.mockRejectedValueOnce(Error("private failure"));
	expect(
		await handlers
			.get("browser.click")!
			.execute({ generation, arguments: { uid: "1" } }, context),
	).toEqual({ status: "unknown" });
	expect(call).toHaveBeenCalledOnce();
});

it.each(["browser_tool_denied", "browser_egress_denied"])(
	"reports pre-dispatch browser policy denial %s as rejected",
	async (errorCode) => {
		const { handlers, generation, call, context } = setup();
		call.mockRejectedValueOnce(new Error(errorCode));
		expect(
			await handlers
				.get("browser.navigate_page")!
				.execute(
					{ generation, arguments: { url: "file:///private" } },
					context,
				),
		).toEqual({ status: "rejected", errorCode });
	},
);
