/**
 * FLY-123: CodexAdapter (transport) — flywheel-owned mailbox semantics +
 * external watcher. Replaces the FLY-142 §11 stub contract tests (the stub
 * is de-stubbed by plan item 1.6; Spike-δ validated the underlying
 * semantics on 2026-06-03).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailboxMessage } from "../../types.js";
import { CodexAdapter, CodexMailboxWatcher } from "../CodexAdapter.js";

const TEAM = "product-lead";
const AGENT = "runner-abc12345";

describe("CodexAdapter transport (FLY-123)", () => {
	let dir: string;
	let adapter: CodexAdapter;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly123-codex-transport-"));
		adapter = new CodexAdapter({ teamsDir: dir, watcherPollIntervalMs: 25 });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function payload(content: string, flywheelId?: string) {
		return {
			from: TEAM,
			to: AGENT,
			content,
			...(flywheelId && { metadata: { flywheelId } }),
		};
	}

	it("vendorId + capabilities (external-watcher, soft preflight)", () => {
		expect(adapter.vendorId()).toBe("codex");
		const caps = adapter.capabilities();
		expect(caps.wakeMode).toBe("external-watcher");
		expect(caps.preflightIsHardGate).toBe(false);
		expect(caps.requiresStableAgentIdentity).toBe(true);
	});

	it("getInboxPath sanitizes components under the codex teams root", () => {
		const p = adapter.getInboxPath("lead/../x", "agent name");
		expect(p.startsWith(dir)).toBe(true);
		expect(p).toContain("lead----x");
		expect(p).toContain("agent-name.json");
		expect(p).not.toContain("..");
	});

	it("write → readUnread → ack round-trip", async () => {
		const res = await adapter.write({
			leadName: TEAM,
			recipient: AGENT,
			payload: payload("hello runner"),
		});
		expect(res.idempotent).toBe(false);
		expect(res.finalized).toBe(true);

		const unread = await adapter.readUnread({
			leadName: TEAM,
			agentName: AGENT,
		});
		expect(unread).toHaveLength(1);
		expect(unread[0]?.content).toBe("hello runner");
		expect(unread[0]?.read).toBe(false);

		await adapter.ack({
			leadName: TEAM,
			agentName: AGENT,
			messageIds: [unread[0]?.id as string],
		});
		expect(
			await adapter.readUnread({ leadName: TEAM, agentName: AGENT }),
		).toHaveLength(0);
	});

	it("flywheelId dedupe: second write is idempotent + finalized", async () => {
		await adapter.write({
			leadName: TEAM,
			recipient: AGENT,
			payload: payload("once", "fid-1"),
		});
		const second = await adapter.write({
			leadName: TEAM,
			recipient: AGENT,
			payload: payload("once", "fid-1"),
		});
		expect(second.idempotent).toBe(true);
		expect(second.finalized).toBe(true);
		expect(
			await adapter.readUnread({ leadName: TEAM, agentName: AGENT }),
		).toHaveLength(1);
	});

	it("verifyLastWrite passes on match, throws verify_mismatch otherwise", async () => {
		await adapter.write({
			leadName: TEAM,
			recipient: AGENT,
			payload: payload("the content"),
		});
		await expect(
			adapter.verifyLastWrite({
				leadName: TEAM,
				recipient: AGENT,
				expected: payload("the content"),
			}),
		).resolves.toBeUndefined();
		await expect(
			adapter.verifyLastWrite({
				leadName: TEAM,
				recipient: AGENT,
				expected: payload("different"),
			}),
		).rejects.toMatchObject({ code: "verify_mismatch" });
	});

	it("dedupeKey is the persisted message id (stable across reads)", async () => {
		await adapter.write({
			leadName: TEAM,
			recipient: AGENT,
			payload: payload("x"),
		});
		const [a] = await adapter.readUnread({ leadName: TEAM, agentName: AGENT });
		const [b] = await adapter.readUnread({ leadName: TEAM, agentName: AGENT });
		expect(adapter.dedupeKey(a as MailboxMessage)).toBe(
			adapter.dedupeKey(b as MailboxMessage),
		);
	});

	it("buildLeadSpawnConfig throws (Lead=codex is Phase 3)", () => {
		expect(() =>
			adapter.buildLeadSpawnConfig({ leadName: TEAM, teamName: TEAM }),
		).toThrow(/Phase 3/);
	});

	it("buildRunnerSpawnConfig contributes no claude flags", () => {
		const cfg = adapter.buildRunnerSpawnConfig({
			leadName: TEAM,
			runnerName: AGENT,
			teamName: TEAM,
		});
		expect(cfg.args).toEqual([]);
		expect(cfg.env.FLYWHEEL_RUNNER_VENDOR_ID).toBe("codex");
	});

	it("preflight reports cli presence via injectable exec", async () => {
		const ok = new CodexAdapter({
			teamsDir: dir,
			execFileFn: () => "codex-cli 0.135.0\n",
		});
		const res = await ok.preflight();
		expect(res.ok).toBe(true);

		const missing = new CodexAdapter({
			teamsDir: dir,
			execFileFn: () => {
				throw new Error("ENOENT");
			},
		});
		const bad = await missing.preflight();
		expect(bad.ok).toBe(false);
		expect(bad.availabilitySignals[0]?.name).toBe("codex:cli-not-found");
	});

	describe("CodexMailboxWatcher", () => {
		it("awaits an async delivery callback before acknowledging the message", async () => {
			await adapter.write({
				leadName: TEAM,
				recipient: AGENT,
				payload: payload("durable before ack"),
			});
			const watcher = new CodexMailboxWatcher(adapter, TEAM, AGENT, 60_000);
			let release: (() => void) | undefined;
			const accepted = new Promise<void>((resolve) => {
				release = resolve;
			});
			watcher.onDelivered = vi.fn(async () => accepted);
			(watcher as any).running = true;

			const scan = (watcher as any).scan() as Promise<void>;
			await vi.waitFor(() =>
				expect(watcher.onDelivered).toHaveBeenCalledOnce(),
			);
			expect(
				await adapter.readUnread({ leadName: TEAM, agentName: AGENT }),
			).toHaveLength(1);

			release?.();
			await scan;
			expect(
				await adapter.readUnread({ leadName: TEAM, agentName: AGENT }),
			).toHaveLength(0);
		});

		it("retries the same message when the delivery callback throws", async () => {
			await adapter.write({
				leadName: TEAM,
				recipient: AGENT,
				payload: payload("retry me"),
			});
			const watcher = new CodexMailboxWatcher(adapter, TEAM, AGENT, 60_000);
			const onDelivered = vi
				.fn<(message: MailboxMessage) => void>()
				.mockImplementationOnce(() => {
					throw new Error("queue commit failed");
				});
			watcher.onDelivered = onDelivered;
			(watcher as any).running = true;

			await (watcher as any).scan();
			expect(onDelivered).toHaveBeenCalledTimes(1);
			expect((watcher as any).delivered.size).toBe(0);
			expect(
				await adapter.readUnread({ leadName: TEAM, agentName: AGENT }),
			).toHaveLength(1);

			await (watcher as any).scan();
			expect(onDelivered).toHaveBeenCalledTimes(2);
			expect(
				await adapter.readUnread({ leadName: TEAM, agentName: AGENT }),
			).toHaveLength(0);
		});

		it("delivers new unread messages once, acks them, reports health", async () => {
			const watcher = adapter.createReceiver({
				leadName: TEAM,
				runnerName: AGENT,
				teamName: TEAM,
			}) as CodexMailboxWatcher;
			const delivered: MailboxMessage[] = [];
			watcher.onDelivered = (m) => delivered.push(m);

			await watcher.start();
			await adapter.write({
				leadName: TEAM,
				recipient: AGENT,
				payload: payload("wake up"),
			});

			await vi.waitFor(() => expect(delivered).toHaveLength(1), {
				timeout: 2000,
			});
			expect(delivered[0]?.content).toBe("wake up");

			// acked → no redelivery on subsequent scans
			await new Promise((r) => setTimeout(r, 80));
			expect(delivered).toHaveLength(1);
			expect(
				await adapter.readUnread({ leadName: TEAM, agentName: AGENT }),
			).toHaveLength(0);

			const health = await watcher.health();
			expect(health.ok).toBe(true);
			expect(health.lastEventTs).toBeTruthy();

			await watcher.stop();
			expect((await watcher.health()).ok).toBe(false);
		});

		it("messages written before start are delivered on initial scan", async () => {
			await adapter.write({
				leadName: TEAM,
				recipient: AGENT,
				payload: payload("early"),
			});
			const watcher = adapter.createReceiver({
				leadName: TEAM,
				runnerName: AGENT,
				teamName: TEAM,
			}) as CodexMailboxWatcher;
			const delivered: MailboxMessage[] = [];
			watcher.onDelivered = (m) => delivered.push(m);
			await watcher.start();
			await vi.waitFor(() => expect(delivered).toHaveLength(1), {
				timeout: 2000,
			});
			await watcher.stop();
		});
	});
});
