import { describe, expect, it } from "vitest";
import type { ProfileIdentityResult } from "../account-heal/account-identity.js";
import { classifyAccountLiveness } from "../account-heal/account-liveness.js";
import type { AccountUsageResult } from "../account-heal/quota-usage-api.js";

const identity = (
	status: string,
	organizationType = "claude_max",
): ProfileIdentityResult => ({
	email: "profile@example.test",
	uuid: "profile-uuid",
	subscription: { status, organizationType },
});

const usageOk: AccountUsageResult = {
	ok: {
		raw: {
			five_hour: { utilization: 1, resets_at: null },
			seven_day: { utilization: 2, resets_at: null },
		},
		fiveH: { pct: 1, resetsAt: null },
		sevenD: { pct: 2, resetsAt: null },
	},
};

describe("classifyAccountLiveness", () => {
	it.each<
		[
			string,
			AccountUsageResult,
			ProfileIdentityResult,
			{ verdict: "dead" | "alive" | "unknown"; reason?: string },
		]
	>([
		[
			"accepts the observed usage permission code as terminal evidence",
			{
				error: "forbidden",
				errorCode: "oauth_not_allowed_for_organization",
			},
			{ error: "profile_network" },
			{
				verdict: "dead",
				reason: "usage_forbidden:oauth_not_allowed_for_organization",
			},
		],
		[
			"accepts a canceled profile when the forbidden code is unknown",
			{ error: "forbidden", errorCode: "future_permission_error" },
			identity("canceled"),
			{ verdict: "dead", reason: "profile_canceled" },
		],
		[
			"fails closed for an unconfirmed forbidden response",
			{ error: "forbidden", errorCode: null },
			{ error: "profile_network" },
			{ verdict: "unknown", reason: "forbidden_unconfirmed" },
		],
		[
			"accepts a canceled profile after a non-forbidden usage failure",
			{ error: "rate_limited", retryAfterMs: 60_000 },
			identity("canceled"),
			{ verdict: "dead", reason: "profile_canceled" },
		],
		[
			"treats an active paid organization as alive",
			{ error: "network" },
			identity("active", "claude_max"),
			{ verdict: "alive" },
		],
		[
			"does not infer paid liveness for an active free organization",
			{ error: "unauthorized" },
			identity("active", "claude_free"),
			{ verdict: "unknown", reason: "free_org_unconfirmed" },
		],
		[
			"fails closed for unproven subscription states",
			{ error: "network" },
			identity("past_due"),
			{ verdict: "unknown", reason: "profile_past_due" },
		],
		[
			"treats a successful usage read as authoritative",
			usageOk,
			identity("canceled"),
			{ verdict: "alive" },
		],
	])("%s", (_label, usage, profile, expected) => {
		expect(classifyAccountLiveness(usage, profile)).toEqual(expected);
	});

	it.each([
		["unpaid", "profile_unpaid"],
		["incomplete", "profile_incomplete"],
		["future_state", "profile_future_state"],
	])("keeps %s fail-closed", (status, reason) => {
		expect(
			classifyAccountLiveness({ error: "network" }, identity(status)),
		).toEqual({ verdict: "unknown", reason });
	});

	it("reports missing subscription evidence without guessing", () => {
		expect(
			classifyAccountLiveness(
				{ error: "network" },
				{ email: "profile@example.test", uuid: "profile-uuid" },
			),
		).toEqual({ verdict: "unknown", reason: "profile_missing" });
	});
});
