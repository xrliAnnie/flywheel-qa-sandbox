/**
 * FLY-929 M-D — reverse-compat sentinel.
 *
 * The ENTIRE notify-migration surface is keyed on two predicates:
 *   - P-identity: CLAUDE_INFRA_BOT_TOKEN **and** FLYWHEEL_NOTIFY_CHANNEL
 *   - P-expect:   FLYWHEEL_NOTIFY_DIGEST_EXPECT=1
 *
 * This asserts every PARTIAL state — all-unset / token-only / channel-only —
 * stays byte-compatible: legacy sender tokens win, the founder escalation is
 * untouched, no digest is posted, no receipt file appears, and the expect tick
 * does not even read the filesystem. If any of these ever goes green with the
 * envs unset, the dormant-merge guarantee has regressed (same convention as
 * FLY-696's account-selfheal-bytecompat sentinel).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	infraSenderTokenOr,
	postInfraNotifyDigest,
	resolveAccountCapOwnerId,
	resolveInfraNotifyIdentity,
} from "../bridge/infra-notify.js";
import { notifyDigestExpectTick } from "../bridge/notify-digest-expect.js";
import { writeTokenReportReceipt } from "../bridge/notify-receipts.js";

const FLY929_ENVS = [
	"CLAUDE_INFRA_BOT_TOKEN",
	"FLYWHEEL_NOTIFY_CHANNEL",
	"FLYWHEEL_NOTIFY_DIGEST_EXPECT",
	"FLYWHEEL_NOTIFY_RECEIPTS_PATH",
] as const;

let saved: Record<string, string | undefined>;
let dir: string;
beforeEach(() => {
	saved = {};
	for (const k of FLY929_ENVS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	dir = mkdtempSync(join(tmpdir(), "fly929-sentinel-"));
});
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dir, { recursive: true, force: true });
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

	describe("P-expect unset (regardless of P-identity)", () => {
		it("receipt write is a NO-OP — zero new files", () => {
			const path = join(dir, "notify-receipts.json");
			writeTokenReportReceipt(
				{ date: "2026-07-06", messageId: "m1" },
				{ env: {}, path },
			);
			expect(existsSync(path)).toBe(false);
			expect(existsSync(dir)).toBe(true); // only the pre-existing temp dir
		});

		it("expect tick is inactive — receipts never read, zero alerts", async () => {
			const readReceipts = vi.fn();
			const alert = vi.fn();
			const outcome = await notifyDigestExpectTick({
				now: new Date("2026-07-07T09:00:00Z"), // well past the deadline
				tz: "America/Los_Angeles",
				receiptsPath: join(dir, "notify-receipts.json"),
				alert,
				env: {},
				readReceipts,
			});
			expect(outcome).toBe("inactive");
			expect(readReceipts).not.toHaveBeenCalled();
			expect(alert).not.toHaveBeenCalled();
		});
	});
});
