import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { expect, it, vi } from "vitest";
import { LeadArtifactStore } from "../artifacts.js";
import { createUpstreamReadAdapter } from "../handlers/upstream-read.js";

vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({ assertActivationCurrent: () => {} }),
}));
it("retains all 27 reads while keeping xsec tokens in parent handles", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "upstream-read-"))),
		artifactRoot = join(root, "artifacts");
	mkdirSync(artifactRoot, { mode: 0o700 });
	const artifacts = new LeadArtifactStore({
		projectRoot: root,
		artifactRoot,
		assertCurrent: () => {},
	});
	const adapters: Array<{ close(): void }> = [];
	try {
		let count = 0;
		for (const serverId of ["gbrain", "xiaohongshu-mcp"] as const) {
			const snapshot = JSON.parse(
				readFileSync(
					resolve(
						`../../engineering/doc/FLY-2519-codex-lead-parity/upstream-${serverId}-schema.json`,
					),
					"utf8",
				),
			);
			let tools = snapshot.tools;
			let reply: unknown = {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							feeds: [
								{
									id: "feed",
									xsecToken: "XSEC_CANARY",
									url: "https://www.xiaohongshu.com/explore/feed?xsec_token=XSEC_CANARY",
								},
							],
						}),
					},
				],
			};
			const client = {
				getServerVersion: () => snapshot.serverInfo,
				listTools: vi.fn(async () => ({ tools })),
				callTool: vi.fn(async (_args: unknown) => reply),
			};
			const adapter = createUpstreamReadAdapter({
				serverId,
				env: { FLYWHEEL_PROJECT_NAME: "demo", FLYWHEEL_LEAD_ID: "eng" },
				activationId: "a1",
				client: client as unknown as Client,
				artifacts,
				secrets: ["ACCOUNT_SECRET"],
			});
			adapters.push(adapter);
			count += adapter.handlers.size;
			const ctx = {
				projectName: "demo",
				leadId: "eng",
				activationId: "a1",
				requestId: randomUUID(),
				signal: new AbortController().signal,
				assertCurrent: async () => {},
			};
			const list = adapter.handlers.get(
				serverId === "gbrain" ? "knowledge.search" : "xiaohongshu.list_feeds",
			)!;
			const input = serverId === "gbrain" ? { query: "hello" } : {};
			const result = await list.execute(input, ctx);
			expect(result.status).toBe("succeeded");
			if (serverId === "xiaohongshu-mcp") {
				expect(JSON.stringify(result)).not.toContain("XSEC_CANARY");
				const content = (result.data as any).result.content[0];
				const feed = JSON.parse(content.text).feeds[0];
				expect(feed.resourceHandle).toEqual(expect.any(String));
				const detail = adapter.handlers.get("xiaohongshu.get_feed_detail")!;
				expect(
					(
						await detail.execute(
							{ feed_id: "feed", resourceHandle: feed.resourceHandle },
							ctx,
						)
					).status,
				).toBe("succeeded");
				expect(client.callTool.mock.calls.at(-1)![0]).toMatchObject({
					name: "get_feed_detail",
					arguments: { feed_id: "feed", xsec_token: "XSEC_CANARY" },
				});
				expect(
					(
						await detail.execute(
							{ feed_id: "foreign", resourceHandle: feed.resourceHandle },
							ctx,
						)
					).status,
				).not.toBe("succeeded");
			}
			tools = [];
			const before = client.callTool.mock.calls.length;
			expect((await list.execute(input, ctx)).errorCode).toBe("baseline_drift");
			expect(client.callTool).toHaveBeenCalledTimes(before);
			tools = snapshot.tools;
			reply = { content: [{ type: "text", text: "ACCOUNT_SECRET" }] };
			expect((await list.execute(input, ctx)).status).toBe("unknown");
			reply = {
				content: [
					{
						type: "image",
						mimeType: "image/png",
						data: Buffer.from("ACCOUNT_SECRET").toString("base64"),
					},
				],
			};
			expect((await list.execute(input, ctx)).status).toBe("unknown");
			adapter.close();
			expect((await list.execute(input, ctx)).status).not.toBe("succeeded");
		}
		expect(count).toBe(27);
	} finally {
		for (const a of adapters) a.close();
		artifacts.close();
		rmSync(root, { recursive: true, force: true });
	}
});
