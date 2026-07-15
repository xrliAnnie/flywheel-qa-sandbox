import { describe, expect, it, vi } from "vitest";
import { runDiscordSend } from "../discord-send-core.js";
import {
	SendIdempotencyCache,
	SlidingWindowRateLimiter,
} from "../lead-actions/send-guard.js";

const CHAT = "1500600400238084307";
const ROUNDTABLE = "1512578695468941333";
const TOKEN = "bot-token-SECRET-do-not-leak";

/** A fresh deps bundle with injectable post/now/audit and the real guards. */
function makeDeps(
	overrides: Partial<Parameters<typeof runDiscordSend>[2]> = {},
) {
	const audits: Record<string, unknown>[] = [];
	const post = vi.fn(
		async (_channelId: string, _text: string, _token: string) => ({
			ok: true as const,
			messageIds: ["msg-1"],
		}),
	);
	const deps = {
		chatChannelId: CHAT,
		crossDeptChannelIds: [ROUNDTABLE],
		botToken: TOKEN,
		rateLimiter: new SlidingWindowRateLimiter({
			maxPerWindow: 2,
			windowMs: 60_000,
		}),
		idempotency: new SendIdempotencyCache(60_000),
		auditPath: "/tmp/unused-audit.jsonl",
		leadId: "mufasa-lead",
		projectName: "growth",
		now: () => 1_000,
		post,
		appendAudit: (row: Record<string, unknown>) => audits.push(row),
		...overrides,
	};
	return { deps, post, audits };
}

describe("runDiscordSend (FLY-350 shared core)", () => {
	it('resolves "chat" alias server-side and posts to the chat channel', async () => {
		const { deps, post } = makeDeps();
		const r = await runDiscordSend("chat", "hello", deps);
		expect(r.ok).toBe(true);
		expect(r.channelId).toBe(CHAT);
		expect(r.messageId).toBe("msg-1");
		expect(post).toHaveBeenCalledWith(CHAT, "hello", TOKEN, {
			origin: "lead_authored",
		});
	});

	it('resolves "roundtable" alias to the single cross-dept channel', async () => {
		const { deps, post } = makeDeps();
		const r = await runDiscordSend("roundtable", "hi team", deps);
		expect(r.ok).toBe(true);
		expect(r.channelId).toBe(ROUNDTABLE);
		expect(post).toHaveBeenCalledWith(ROUNDTABLE, "hi team", TOKEN, {
			origin: "lead_authored",
		});
	});

	it("REFUSES an unknown alias (fail-closed, no post)", async () => {
		const { deps, post } = makeDeps();
		const r = await runDiscordSend("random", "x", deps);
		expect(r.ok).toBe(false);
		expect(r.isError).toBe(true);
		expect(r.text).toMatch(/REFUSED/);
		expect(post).not.toHaveBeenCalled();
	});

	it("REFUSES a raw channel id (model cannot bypass the alias gate)", async () => {
		const { deps, post } = makeDeps();
		const r = await runDiscordSend(CHAT, "x", deps);
		expect(r.ok).toBe(false);
		expect(r.isError).toBe(true);
		expect(post).not.toHaveBeenCalled();
	});

	it("REFUSES roundtable when there are 0 or multiple cross-dept channels", async () => {
		const { deps: zero } = makeDeps({ crossDeptChannelIds: [] });
		expect((await runDiscordSend("roundtable", "x", zero)).ok).toBe(false);
		const { deps: many } = makeDeps({
			crossDeptChannelIds: [ROUNDTABLE, "999"],
		});
		expect((await runDiscordSend("roundtable", "x", many)).ok).toBe(false);
	});

	it("is idempotent within the TTL — a repeat returns the prior id and does NOT re-post", async () => {
		const { deps, post } = makeDeps();
		const first = await runDiscordSend("chat", "same", deps);
		expect(first.messageId).toBe("msg-1");
		const second = await runDiscordSend("chat", "same", deps);
		expect(second.ok).toBe(true);
		expect(second.text).toMatch(/idempotent/);
		expect(post).toHaveBeenCalledTimes(1); // not re-posted
	});

	it("enforces the per-channel rate limit and audits the refusal", async () => {
		const { deps, post, audits } = makeDeps();
		// distinct text each time so idempotency does not short-circuit
		expect((await runDiscordSend("chat", "a", deps)).ok).toBe(true);
		expect((await runDiscordSend("chat", "b", deps)).ok).toBe(true);
		const third = await runDiscordSend("chat", "c", deps);
		expect(third.ok).toBe(false);
		expect(third.isError).toBe(true);
		expect(third.text).toMatch(/rate limit/);
		expect(post).toHaveBeenCalledTimes(2);
		expect(audits.some((a) => a.outcome === "rate_limited")).toBe(true);
	});

	it("surfaces a failed Discord send without throwing", async () => {
		const post = vi.fn(async () => ({
			ok: false as const,
			error: "discord 500",
		}));
		const { deps } = makeDeps({ post });
		const r = await runDiscordSend("chat", "x", deps);
		expect(r.ok).toBe(false);
		expect(r.isError).toBe(true);
		expect(r.text).toMatch(/discord send failed: discord 500/);
	});

	it("surfaces a thrown Discord send without throwing", async () => {
		const post = vi.fn(async () => {
			throw new Error("network down");
		});
		const { deps } = makeDeps({ post });
		const r = await runDiscordSend("chat", "x", deps);
		expect(r.ok).toBe(false);
		expect(r.isError).toBe(true);
		expect(r.text).toMatch(/threw: network down/);
	});

	it("audits metadata only — NEVER the message text or the bot token (R2-6)", async () => {
		const { deps, audits } = makeDeps();
		await runDiscordSend("chat", "super secret message body", deps);
		const sent = audits.find((a) => a.outcome === "sent");
		expect(sent).toBeTruthy();
		const serialized = JSON.stringify(audits);
		expect(serialized).not.toContain("super secret message body");
		expect(serialized).not.toContain(TOKEN);
		// metadata present: channel + textLen, not the text
		expect(sent?.channelId).toBe(CHAT);
		expect(sent?.textLen).toBe("super secret message body".length);
	});
});

describe("FLY-676 — proactive roundtable guard (Option B; FLY-680 owns the real engage hook)", () => {
	it("autoContinue ON → REFUSES roundtable BEFORE side effects (no post, deferred audit)", async () => {
		const { deps, post, audits } = makeDeps({ roundtableAutoContinue: true });
		const r = await runDiscordSend("roundtable", "hi team", deps);
		expect(r.ok).toBe(false);
		expect(r.isError).toBe(true);
		expect(r.text).toMatch(/FLY-680/);
		expect(post).not.toHaveBeenCalled();
		// audited with a DISTINCT outcome (not confused with rate_limited)
		expect(audits.at(-1)?.outcome).toBe("roundtable_proactive_deferred");
		expect(audits.some((a) => a.outcome === "rate_limited")).toBe(false);
	});

	it("autoContinue ON → does NOT consume idempotency/rate budget (a later allowed send still posts)", async () => {
		const { deps, post } = makeDeps({
			roundtableAutoContinue: true,
			rateLimiter: new SlidingWindowRateLimiter({
				maxPerWindow: 1,
				windowMs: 60_000,
			}),
		});
		await runDiscordSend("roundtable", "blocked", deps); // refused before side effects
		// the chat channel's single-slot budget must be intact (guard ran before rate-limit)
		const r = await runDiscordSend("chat", "still works", deps);
		expect(r.ok).toBe(true);
		expect(post).toHaveBeenCalledTimes(1);
		expect(post).toHaveBeenCalledWith(CHAT, "still works", TOKEN, {
			origin: "lead_authored",
		});
	});

	it("autoContinue ON → 'chat' is unaffected (only roundtable is guarded)", async () => {
		const { deps, post } = makeDeps({ roundtableAutoContinue: true });
		const r = await runDiscordSend("chat", "hello", deps);
		expect(r.ok).toBe(true);
		expect(post).toHaveBeenCalledWith(CHAT, "hello", TOKEN, {
			origin: "lead_authored",
		});
	});

	it("autoContinue OFF / unset (kill-switch / byte-compat) → roundtable proactive send still posts", async () => {
		const { deps, post } = makeDeps(); // roundtableAutoContinue defaults undefined
		const r = await runDiscordSend("roundtable", "hi team", deps);
		expect(r.ok).toBe(true);
		expect(post).toHaveBeenCalledWith(ROUNDTABLE, "hi team", TOKEN, {
			origin: "lead_authored",
		});
	});
});
