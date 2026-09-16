import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LeadArtifactStore } from "../artifacts.js";
import { projectBrowserOutput } from "../browser-output.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup() {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2519-browser-output-")),
	);
	dirs.push(root);
	const projectRoot = join(root, "project"),
		workerArtifactRoot = join(root, "private-profile", "artifacts");
	mkdirSync(projectRoot);
	mkdirSync(workerArtifactRoot, { recursive: true, mode: 0o700 });
	const artifactRoot = join(projectRoot, "artifacts");
	mkdirSync(artifactRoot, { mode: 0o700 });
	return {
		root,
		projectRoot,
		workerArtifactRoot,
		store: new LeadArtifactStore({
			projectRoot,
			artifactRoot,
			assertCurrent() {},
		}),
		assertCurrent() {},
	};
}
it("moves a verified screenshot to a project handle without returning worker profile paths", async () => {
	const ctx = setup(),
		handle = "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		path = join(ctx.workerArtifactRoot, `${handle}.png`),
		data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
	writeFileSync(path, data);
	const result = await projectBrowserOutput(
		"take_screenshot",
		{
			result: {
				content: [{ type: "text", text: `Saved screenshot to ${path}.` }],
			},
			artifact: { handle, path, mimeType: "image/png" },
		},
		ctx,
	);
	const parsed = JSON.parse(result.content[0]!.text);
	expect(parsed.artifactHandle).toBeTruthy();
	expect(JSON.stringify(result)).not.toContain(ctx.root);
	expect((await ctx.store.read(parsed.artifactHandle)).data).toEqual(data);
});
it("rejects symlink, outside path and forged image output", async () => {
	const ctx = setup(),
		handle = "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		path = join(ctx.workerArtifactRoot, `${handle}.png`);
	for (const candidate of ["/etc/passwd", path]) {
		if (candidate === path) symlinkSync("/etc/passwd", path);
		await expect(
			projectBrowserOutput(
				"take_screenshot",
				{
					result: { content: [] },
					artifact: { handle, path: candidate, mimeType: "image/png" },
				},
				ctx,
			),
		).rejects.toThrow(/browser/);
	}
	rmSync(path);
	writeFileSync(path, "not a PNG");
	await expect(
		projectBrowserOutput(
			"take_screenshot",
			{
				result: { content: [] },
				artifact: { handle, path, mimeType: "image/png" },
			},
			ctx,
		),
	).rejects.toThrow(/browser/);
});
it("bounds untrusted text, redacts known network header lines, and never forwards embedded resources/errors", async () => {
	const ctx = setup();
	const result = await projectBrowserOutput(
		"get_network_request",
		{
			result: {
				content: [
					{
						type: "text",
						text: "### Request Headers\n- Cookie: session-secret\n- Authorization: auth-secret\n### Response Headers\n- Set-Cookie: response-secret\n- Content-Type: text/html",
					},
				],
			},
		},
		ctx,
	);
	expect(JSON.stringify(result)).not.toMatch(
		/session-secret|auth-secret|response-secret/,
	);
	expect(result.content[0]!.text).toContain("text/html");
	for (const result of [
		{
			content: [
				{
					type: "resource",
					resource: { uri: "file:///etc/passwd", text: "secret" },
				},
			],
		},
		{ content: [{ type: "text", text: "x".repeat(262145) }] },
		{
			content: [
				{ type: "text", text: `saved to ${ctx.workerArtifactRoot}/hidden` },
			],
		},
	])
		await expect(
			projectBrowserOutput("take_snapshot", { result }, ctx),
		).rejects.toThrow(/browser/);
	expect(
		await projectBrowserOutput(
			"click",
			{
				result: {
					isError: true,
					content: [{ type: "text", text: "/host/secret" }],
				},
			},
			ctx,
		),
	).toEqual({
		isError: true,
		content: [{ type: "text", text: "browser_tool_failed" }],
	});
});
