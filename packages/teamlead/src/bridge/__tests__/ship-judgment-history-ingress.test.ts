import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { expect, it, vi } from "vitest";
import { InMemoryInboundCursorStore } from "../../lead-backends/codex/InboundCursorStore.js";
import {
	bindingFixture,
	CHANNEL,
} from "../../ship-judgment/__tests__/binding-fixture.js";
import { GatePoller } from "../gate-poller.js";
import * as capture from "../session-capture.js";

it("scans a historical clarification thread with no live sessions or pending questions", async () => {
	const { store } = await bindingFixture(),
		dir = mkdtempSync(join(tmpdir(), "fly2399-history-ingress-"));
	try {
		const path = join(dir, "comm.db");
		new CommDB(path).close();
		vi.spyOn(capture, "defaultGetCommDbPath").mockReturnValue(path);
		expect(store.listNonTerminalSessions()).toEqual([]);
		const threadId = "123456789012345679",
			cursorStore = new InMemoryInboundCursorStore();
		cursorStore.save(threadId, "123456789012345680");
		const network = vi.fn(async (_url: unknown) => new Response("[]"));
		const poller = new GatePoller({
			pollIntervalMs: 3000,
			store,
			projects: [
				{
					projectName: "flywheel",
					projectRoot: "/tmp/fixture",
					leads: [
						{
							agentId: "lead",
							summaryRole: "engineering",
							chatChannel: CHANNEL,
							botToken: "fixture-token",
						},
					],
				},
			],
			runtimeRegistry: {} as never,
			chatThreadsEnabled: true,
			discordOwnerUserId: "123456789012345690",
			cursorStore,
			fetchImpl: network,
			listShipJudgmentReplyThreads: () => ({
				threads: [
					{
						threadId,
						issueId: "FLY-2399",
						projectName: "flywheel",
						leadId: "lead",
					},
				],
				nextCursor: threadId,
			}),
		});
		await (
			poller as unknown as { founderReplyDeliverPass(): Promise<void> }
		).founderReplyDeliverPass();
		expect(network).toHaveBeenCalledOnce();
		expect(String(network.mock.calls[0]?.[0])).toContain(
			`/channels/${threadId}/messages`,
		);
	} finally {
		vi.restoreAllMocks();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
