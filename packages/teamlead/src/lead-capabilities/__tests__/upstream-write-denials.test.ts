import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { LeadCapabilityBroker } from "../broker.js";
import { getLeadCapability, LEAD_CAPABILITY_CATALOG } from "../catalog.js";
import { createUpstreamWriteDenials } from "../handlers/upstream-write-denials.js";

vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({ assertActivationCurrent: () => {} }),
}));
it("preserves every captured upstream row and records explicit denied writes through the real broker", async () => {
	for (const [server, prefix] of [
		["gbrain", "knowledge"],
		["xiaohongshu-mcp", "xiaohongshu"],
	]) {
		const snapshot = JSON.parse(
			readFileSync(
				resolve(
					`../../engineering/doc/FLY-2519-codex-lead-parity/upstream-${server}-schema.json`,
				),
				"utf8",
			),
		);
		expect(
			LEAD_CAPABILITY_CATALOG.filter(
				(op) =>
					op.operationId.startsWith(`${prefix}.`) &&
					!op.operationId.startsWith("xiaohongshu.write."),
			)
				.map((op) => op.operationId)
				.sort(),
		).toEqual(
			snapshot.tools
				.map((tool: { name: string }) => `${prefix}.${tool.name}`)
				.sort(),
		);
	}
	const store = new SqliteJournalStore(":memory:");
	const handlers = createUpstreamWriteDenials({
		env: { FLYWHEEL_PROJECT_NAME: "demo", FLYWHEEL_LEAD_ID: "eng" },
		activationId: "a1",
	});
	const broker = new LeadCapabilityBroker({
		projectName: "demo",
		leadId: "eng",
		activationId: "a1",
		receipts: store.operationReceipts,
		allowedOperationIds: () => new Set(handlers.keys()),
		assertCurrent: async () => {},
		handlers,
		secrets: [],
	});
	try {
		expect(handlers.size).toBe(19);
		for (const [operationId, input, errorCode] of [
			[
				"xiaohongshu.like_feed",
				{ feed_id: "feed", resourceHandle: "handle" },
				"founder_write_gate_absent",
			],
			[
				"xiaohongshu.publish_content",
				{ title: "title", content: "body", artifactHandles: ["artifact"] },
				"founder_write_gate_absent",
			],
			[
				"knowledge.put_page",
				{ slug: "page", content: "body" },
				"unclassified_write",
			],
			["xiaohongshu.delete_cookies", {}, "unclassified_write"],
			[
				"knowledge.put_raw_data",
				{ slug: "page", source: "fixture", data: { nested: { value: 1 } } },
				"unclassified_write",
			],
		] as const) {
			const requestId = randomUUID();
			const request = { schemaVersion: 1, operationId, requestId, input };
			expect(await broker.execute(request)).toMatchObject({
				status: "rejected",
				errorCode,
			});
			expect(
				store.operationReceipts.get({
					projectName: "demo",
					leadId: "eng",
					operationId,
					requestId,
				}),
			).toMatchObject({ state: "rejected", errorCode });
			expect(await broker.execute(request)).toMatchObject({
				status: "rejected",
				errorCode,
			});
		}
		expect(
			getLeadCapability("xiaohongshu.get_feed_detail")!.inputSchema.safeParse({
				feed_id: "feed",
				xsec_token: "raw-secret",
			}).success,
		).toBe(false);
		expect(
			getLeadCapability("xiaohongshu.publish_content")!.inputSchema.safeParse({
				title: "t",
				content: "c",
				images: ["/private/secret"],
			}).success,
		).toBe(false);
	} finally {
		await broker.close();
		store.close();
	}
});
