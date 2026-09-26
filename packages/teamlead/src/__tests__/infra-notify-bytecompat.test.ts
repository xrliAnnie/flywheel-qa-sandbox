/**
 * FLY-929 M-D — reverse-compat sentinel.
 *
 * The notify-migration surface is keyed on the P-identity predicate:
 * CLAUDE_INFRA_BOT_TOKEN **and** FLYWHEEL_NOTIFY_CHANNEL.
 *
 * This asserts every PARTIAL state — all-unset / token-only / channel-only —
 * stays byte-compatible: legacy sender tokens win, the founder escalation is
 * untouched, no digest is posted. If any of these ever goes green with the
 * envs unset, the dormant-merge guarantee has regressed (same convention as
 * FLY-696's account-selfheal-bytecompat sentinel).
 *
 * FLY-1243: the P-expect gate (FLYWHEEL_NOTIFY_DIGEST_EXPECT) that used to be
 * covered here is retired — writeTokenReportReceipt/notifyDigestExpectTick
 * off-path coverage moved out (see notify-digest-expect.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	infraSenderTokenOr,
	postInfraNotifyDigest,
	resolveAccountCapOwnerId,
	resolveInfraNotifyIdentity,
} from "../bridge/infra-notify.js";

const FLY929_ENVS = [
	"CLAUDE_INFRA_BOT_TOKEN",
	"FLYWHEEL_NOTIFY_CHANNEL",
	"FLYWHEEL_NOTIFY_DIGEST_EXPECT",
	"FLYWHEEL_NOTIFY_RECEIPTS_PATH",
] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
	saved = {};
	for (const k of FLY929_ENVS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

/** The three dormant env states the plan requires the sentinel to cover. */
const DORMANT_STATES: Array<[string, NodeJS.ProcessEnv]> = [
	["all-unset", {}],
	["token-only", { CLAUDE_INFRA_BOT_TOKEN: "infra-token" }],
	["channel-only", { FLYWHEEL_NOTIFY_CHANNEL: "12345" }],
];

describe("FLY-929 reverse-compat sentinel", () => {
	it("the FLY-929 envs are unset in this test environment", () => {
		for (const k of FLY929_ENVS) {
			expect(process.env[k]).toBeUndefined();
		}
	});

	for (const [label, env] of DORMANT_STATES) {
		describe(`dormant state: ${label}`, () => {
			it("P-identity does not resolve", () => {
				expect(resolveInfraNotifyIdentity(env)).toBeUndefined();
			});

			it("reports ① / standup ③ sender = the exact legacy fallback", () => {
				expect(infraSenderTokenOr("legacy-global-token", env)).toBe(
					"legacy-global-token",
				);
				expect(infraSenderTokenOr(undefined, env)).toBeUndefined();
			});

			it("A5 owner routing never activates (founder escalation unchanged), even with self-heal + bot id present", () => {
				expect(
					resolveAccountCapOwnerId({
						...env,
						FLYWHEEL_ACCOUNT_SELF_HEAL: "1",
						FLYWHEEL_INFRA_BOT_USER_ID: "152321932456152283",
					}),
				).toBeUndefined();
			});

			it("digest post is a NO-OP (zero Discord calls)", async () => {
				const postText = vi.fn();
				expect(await postInfraNotifyDigest("digest", { env, postText })).toBe(
					false,
				);
				expect(postText).not.toHaveBeenCalled();
			});
		});
	}

	// FLY-1243: the P-expect gate (FLYWHEEL_NOTIFY_DIGEST_EXPECT) is retired —
	// writeTokenReportReceipt always writes and notifyDigestExpectTick no
	// longer has an "inactive" outcome. Both off-path sentinels formerly
	// living here are deleted; the remaining P-identity byte-compat coverage
	// above (dormant states, digest post NO-OP, A5 owner routing) still holds.
});
