/**
 * FLY-929 A1 — the P-identity predicate + digest helpers.
 *
 * P-identity requires BOTH envs; every partial state stays dormant so FLY-928
 * writing the token into .env early can never activate the migration surface.
 */
import { describe, expect, it, vi } from "vitest";
import {
	formatAccountCapOwnerAssignment,
	formatRotationDigest,
	formatSwitchSuccessDigest,
	infraSenderTokenOr,
	postInfraNotifyDigest,
	resolveAccountCapOwnerId,
	resolveInfraNotifyIdentity,
} from "../infra-notify.js";

const BOTH = {
	CLAUDE_INFRA_BOT_TOKEN: "infra-token",
	FLYWHEEL_NOTIFY_CHANNEL: "12345",
};

describe("resolveInfraNotifyIdentity (P-identity)", () => {
	it("both envs set → identity", () => {
		expect(resolveInfraNotifyIdentity(BOTH)).toEqual({
			botToken: "infra-token",
			notifyChannelId: "12345",
		});
	});

	it("token only → dormant (FLY-928 may write the token early)", () => {
		expect(
			resolveInfraNotifyIdentity({ CLAUDE_INFRA_BOT_TOKEN: "infra-token" }),
		).toBeUndefined();
	});

	it("channel only → dormant", () => {
		expect(
			resolveInfraNotifyIdentity({ FLYWHEEL_NOTIFY_CHANNEL: "12345" }),
		).toBeUndefined();
	});

	it("neither → dormant", () => {
		expect(resolveInfraNotifyIdentity({})).toBeUndefined();
	});

	it("blank/whitespace values do not count as set", () => {
		expect(
			resolveInfraNotifyIdentity({
				CLAUDE_INFRA_BOT_TOKEN: "  ",
				FLYWHEEL_NOTIFY_CHANNEL: "12345",
			}),
		).toBeUndefined();
	});
});

describe("infraSenderTokenOr (reports ① / standup ③ sender chain)", () => {
	it("P-identity satisfied → infra token wins over the legacy fallback", () => {
		expect(infraSenderTokenOr("simba-token", BOTH)).toBe("infra-token");
	});

	it("token only → legacy fallback (reverse-compat)", () => {
		expect(
			infraSenderTokenOr("simba-token", {
				CLAUDE_INFRA_BOT_TOKEN: "infra-token",
			}),
		).toBe("simba-token");
	});

	it("nothing set → legacy fallback", () => {
		expect(infraSenderTokenOr("simba-token", {})).toBe("simba-token");
	});

	it("nothing set and no fallback → undefined", () => {
		expect(infraSenderTokenOr(undefined, {})).toBeUndefined();
	});
});

describe("resolveAccountCapOwnerId (A5 predicate)", () => {
	const OWNER = "152321932456152283";
	const ALL = {
		...BOTH,
		FLYWHEEL_ACCOUNT_SELF_HEAL: "1",
		FLYWHEEL_INFRA_BOT_USER_ID: OWNER,
	};

	it("all three preconditions → owner id", () => {
		expect(resolveAccountCapOwnerId(ALL)).toBe(OWNER);
	});

	// FLY-1243: FLYWHEEL_ACCOUNT_SELF_HEAL no longer gates this predicate (the
	// conjunct was removed) — resolveAccountCapOwnerId now gates ONLY on
	// resolveInfraNotifyIdentity(env) + a valid FLYWHEEL_INFRA_BOT_USER_ID.
	// Rewritten to cover the one identity-absence shape the other cases below
	// don't: P-identity ENTIRELY absent (neither token nor channel set), bot
	// user id present → still undefined (legacy founder routing).
	it("P-identity entirely absent (neither token nor channel) → undefined (legacy founder routing)", () => {
		expect(
			resolveAccountCapOwnerId({
				FLYWHEEL_INFRA_BOT_USER_ID: OWNER,
			}),
		).toBeUndefined();
	});

	it("P-identity incomplete (token only) → undefined", () => {
		const { FLYWHEEL_NOTIFY_CHANNEL: _omit, ...rest } = ALL;
		expect(resolveAccountCapOwnerId(rest)).toBeUndefined();
	});

	it("P-identity incomplete (channel only) → undefined", () => {
		const { CLAUDE_INFRA_BOT_TOKEN: _omit, ...rest } = ALL;
		expect(resolveAccountCapOwnerId(rest)).toBeUndefined();
	});

	it("missing bot user id → undefined", () => {
		const { FLYWHEEL_INFRA_BOT_USER_ID: _omit, ...rest } = ALL;
		expect(resolveAccountCapOwnerId(rest)).toBeUndefined();
	});

	it("malformed bot user id (not a snowflake) → undefined", () => {
		expect(
			resolveAccountCapOwnerId({
				...ALL,
				FLYWHEEL_INFRA_BOT_USER_ID: "not-a-snowflake",
			}),
		).toBeUndefined();
	});
});

describe("format helpers", () => {
	it("owner assignment carries the mention + ARC/T2 handoff + reason", () => {
		const s = formatAccountCapOwnerAssignment("111", "所有账号都已用尽。");
		expect(s).toContain("<@111>");
		expect(s).toContain("请认领");
		expect(s).toContain("T2");
		expect(s).toContain("所有账号都已用尽。");
	});

	it("switch digest renders from/to + scope + reset, no @-mention", () => {
		const s = formatSwitchSuccessDigest({
			from: "personal",
			to: "school",
			scope: "5h",
			resetAt: "2026-07-08T02:00:00Z",
		});
		expect(s).toContain("personal → school");
		expect(s).toContain("5h 到");
		expect(s).toContain("reset 2026-07-08T02:00:00Z");
		expect(s).not.toContain("@");
	});

	it("switch digest degrades without from/scope/reset", () => {
		const s = formatSwitchSuccessDigest({ to: "school" });
		expect(s).toContain("→ school");
		expect(s).not.toMatch(/reset \d/);
		expect(s).not.toContain("到）");
	});

	it("rotation digest is built from the structured payload", () => {
		const s = formatRotationDigest({
			provider: "codex",
			from: "acct-a",
			to: "acct-b",
			reason: "rate_limit",
			resetAt: "2026-07-08T02:00:00Z",
		});
		expect(s).toContain("Codex");
		expect(s).toContain("acct-a → acct-b");
		expect(s).toContain("额度/限流");
		expect(s).toContain("reset 2026-07-08T02:00:00Z");
		expect(s).not.toContain("@");
	});
});

describe("postInfraNotifyDigest", () => {
	it("P-identity dormant → no post at all", async () => {
		const postText = vi.fn();
		const ok = await postInfraNotifyDigest("hello", { env: {}, postText });
		expect(ok).toBe(false);
		expect(postText).not.toHaveBeenCalled();
	});

	it("P-identity satisfied → posts with the infra token to the notify channel", async () => {
		const postText = vi
			.fn()
			.mockResolvedValue({ ok: true, messageIds: ["m1"] });
		const ok = await postInfraNotifyDigest("hello", { env: BOTH, postText });
		expect(ok).toBe(true);
		expect(postText).toHaveBeenCalledWith("12345", "hello", "infra-token");
	});

	it("delivery failure → logged, returns false, never throws", async () => {
		const log = vi.fn();
		const postText = vi.fn().mockResolvedValue({ ok: false, error: "403" });
		const ok = await postInfraNotifyDigest("hello", {
			env: BOTH,
			postText,
			log,
		});
		expect(ok).toBe(false);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("403"));
	});

	it("delivery throw → logged, returns false, never throws", async () => {
		const log = vi.fn();
		const postText = vi.fn().mockRejectedValue(new Error("network down"));
		const ok = await postInfraNotifyDigest("hello", {
			env: BOTH,
			postText,
			log,
		});
		expect(ok).toBe(false);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("network down"));
	});
});
