import { describe, expect, it, vi } from "vitest";
import { startCodexLeadGateway } from "../codex-lead-runtime.js";
import { startCodexLeadTuiGateway } from "../codex-lead-tui-runtime.js";

for (const [name, start] of [
	["headless", startCodexLeadGateway],
	["TUI", startCodexLeadTuiGateway],
] as const) {
	describe(`${name} production gateway startup`, () => {
		it("never starts inbound traffic if restore fails", async () => {
			const gateway = {
				start: vi.fn(async () => {}),
				stop: vi.fn(async () => {}),
			};
			const subscriptions = {
				restoreState: vi.fn(async () => {
					throw Error("disk full");
				}),
				activateSource: vi.fn(async () => {}),
			};
			await expect(start(gateway, subscriptions)).rejects.toThrow("disk full");
			expect(gateway.start).not.toHaveBeenCalled();
			expect(subscriptions.activateSource).not.toHaveBeenCalled();
		});
		it("restores before backlog ingestion and activates only after gateway installs handler", async () => {
			const events: string[] = [];
			const subscriptions = {
				restoreState: async () => {
					events.push("restore");
				},
				activateSource: async () => {
					events.push("activate");
				},
			};
			const gateway = {
				start: async () => {
					events.push("durable backlog ingest");
				},
				stop: async () => {},
			};
			await start(gateway, subscriptions);
			expect(events).toEqual(["restore", "durable backlog ingest", "activate"]);
		});
	});
}

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReplyInThreadWiring } from "../roundtable-reply-in-thread-wiring.js";
import {
	ledgerPath,
	persistSnapshot,
} from "../roundtable-subscription-ledger.js";

const RT = "99999999999999999",
	A = "11111111111111111",
	B = "22222222222222222",
	C = "33333333333333333";
for (const [name, start] of [
	["headless", startCodexLeadGateway],
	["TUI", startCodexLeadTuiGateway],
] as const) {
	it(`${name}: failed normalization preserves A/B; retry restores before backlog adds C`, async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "rt-wrapper-"));
		try {
			const snapshot = {
				version: 1 as const,
				entries: [A, B].map((threadId) => ({
					threadId,
					parentChannelId: RT,
					source: "mention" as const,
					subscribedAt: new Date(1000).toISOString(),
					lastActivityAt: new Date(1000).toISOString(),
					expiresAt: new Date(5000).toISOString(),
				})),
			};
			persistSnapshot(ledgerPath(stateDir), snapshot);
			const original = readFileSync(ledgerPath(stateDir), "utf8");
			let fail = true;
			const make = () =>
				buildReplyInThreadWiring({
					stateDir,
					cfg: {
						enabled: true,
						parentChannelId: RT,
						cap: 5,
						subscriptionTtlMs: 1000,
					},
					botToken: "tok",
					botUserId: "bot",
					crossDeptChannelIds: [RT],
					now: () => 2000,
					setTimer: () => ({ cancel: () => {} }),
					source: {
						addChannel: async () => {},
						removeChannel: () => {},
						isSubscribed: () => false,
					},
					persistSnapshot: (p, s) => {
						if (fail) throw Error("disk full");
						persistSnapshot(p, s);
					},
				})!;
			const failed = make();
			const blockedGateway = {
				start: vi.fn(async () => {}),
				stop: vi.fn(async () => {}),
			};
			await expect(start(blockedGateway, failed)).rejects.toThrow("disk full");
			expect(blockedGateway.start).not.toHaveBeenCalled();
			expect(readFileSync(ledgerPath(stateDir), "utf8")).toBe(original);
			fail = false;
			const retry = make();
			await start(
				{
					start: async () => {
						expect(retry.registry.list()).toEqual([B, A]);
						await retry.onTopicEngaged({
							kind: "roundtable_thread_from_message",
							threadId: C,
							sourceMessageId: C,
							parentChannelId: RT,
						});
					},
					stop: async () => {},
				},
				retry,
			);
			expect(
				JSON.parse(readFileSync(ledgerPath(stateDir), "utf8"))
					.entries.map((e: { threadId: string }) => e.threadId)
					.sort(),
			).toEqual([A, B, C]);
			await retry.stop();
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});
}
