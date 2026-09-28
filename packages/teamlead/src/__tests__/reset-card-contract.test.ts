import { describe, expect, it } from "vitest";
import {
	parseCedarStatus,
	parseRedeemResponse,
} from "../account-heal/reset-card-contract.js";

/** Sanitized FLY-2864 business sample, at a weekly limit. */
function businessPayload(overrides: Record<string, unknown> = {}) {
	return {
		five_hour: { utilization: 12, resets_at: "2026-09-25T23:00:00+00:00" },
		seven_day: { utilization: 100, resets_at: "2026-10-01T02:00:00+00:00" },
		cedar_ember: {
			eligible: true,
			ineligible_reason: null,
			at_limit: true,
			exhausted: ["seven_day"],
			grants: [
				{
					id: "opus55-launch-promax-20260921",
					label:
						"Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
					resets_total: 1,
					resets_left: 1,
					starts_at: "2026-09-22T16:00:00+00:00",
					ends_at: "2026-10-22T16:00:00+00:00",
					clears: ["five_hour", "seven_day", "seven_day_overage_included"],
					paused: false,
					usable_now: true,
				},
			],
			next_grant_id: "opus55-launch-promax-20260921",
			weekly_resets_at: "2026-10-01T02:00:00+00:00",
			event_props: { surface: "claude_code_cli" },
			...overrides,
		},
	};
}

function grantOverride(patch: Record<string, unknown>) {
	const base = businessPayload().cedar_ember.grants[0] as Record<
		string,
		unknown
	>;
	return businessPayload({ grants: [{ ...base, ...patch }] });
}

describe("parseCedarStatus", () => {
	it("parses the sanitized business sample", () => {
		const parsed = parseCedarStatus(businessPayload());
		expect(parsed).toEqual({
			ok: {
				eligible: true,
				ineligibleReason: null,
				atLimit: true,
				exhausted: ["seven_day"],
				exhaustedUnknown: false,
				grants: [
					{
						id: "opus55-launch-promax-20260921",
						resetsLeft: 1,
						resetsTotal: 1,
						startsAt: "2026-09-22T16:00:00.000Z",
						endsAt: "2026-10-22T16:00:00.000Z",
						clears: ["five_hour", "seven_day", "seven_day_overage_included"],
						blocking: [],
						blockingUnknown: false,
						paused: false,
						usableNow: true,
						useRequiresLimit: true,
					},
				],
				nextGrantId: "opus55-launch-promax-20260921",
				cooldownUntil: null,
			},
		});
	});

	it("applies the CLI defaults for omitted booleans", () => {
		const parsed = parseCedarStatus(
			grantOverride({
				paused: undefined,
				usable_now: undefined,
				use_requires_limit: undefined,
			}),
		);
		expect("ok" in parsed && parsed.ok.grants[0]).toMatchObject({
			paused: false,
			usableNow: false,
			useRequiresLimit: true,
		});
	});

	it("drops unknown limit keys from clears but flags unknown exhausted/blocking keys", () => {
		const parsed = parseCedarStatus(
			businessPayload({
				exhausted: ["seven_day", "seven_day_future_thing"],
				grants: [
					{
						...(businessPayload().cedar_ember.grants[0] as object),
						clears: ["five_hour", "mystery"],
						blocking: ["mystery_block"],
					},
				],
			}),
		);
		if (!("ok" in parsed)) throw new Error("expected ok");
		expect(parsed.ok.exhausted).toEqual(["seven_day"]);
		expect(parsed.ok.exhaustedUnknown).toBe(true);
		expect(parsed.ok.grants[0]?.clears).toEqual(["five_hour"]);
		expect(parsed.ok.grants[0]?.blocking).toEqual([]);
		expect(parsed.ok.grants[0]?.blockingUnknown).toBe(true);
	});

	it("reports absent when the block is missing", () => {
		expect(parseCedarStatus({ five_hour: {} })).toEqual({ error: "absent" });
		expect(parseCedarStatus(null)).toEqual({ error: "absent" });
	});

	it.each([
		["bad grant id", grantOverride({ id: "Has Spaces" })],
		["grant id too long", grantOverride({ id: "a".repeat(41) })],
		["left > total", grantOverride({ resets_left: 2, resets_total: 1 })],
		["negative count", grantOverride({ resets_left: -1 })],
		["count over 1000", grantOverride({ resets_total: 1001 })],
		["bad ends_at", grantOverride({ ends_at: "tomorrow" })],
		["non-boolean paused", grantOverride({ paused: "no" })],
		["non-string clears entry", grantOverride({ clears: [1] })],
		[
			"too many grants",
			businessPayload({
				grants: Array.from({ length: 129 }, () => ({
					...(businessPayload().cedar_ember.grants[0] as object),
				})),
			}),
		],
		["eligible not boolean", businessPayload({ eligible: "yes" })],
		["bad next_grant_id", businessPayload({ next_grant_id: "../x" })],
		["bad cooldown", businessPayload({ cooldown_until: "later" })],
		["grants not array", businessPayload({ grants: {} })],
	])("rejects %s as malformed", (_label, payload) => {
		expect(parseCedarStatus(payload)).toEqual({ error: "malformed" });
	});

	it("keeps a safe ineligible reason and blanks an unsafe one", () => {
		const safe = parseCedarStatus(
			businessPayload({ eligible: false, ineligible_reason: "surface" }),
		);
		const unsafe = parseCedarStatus(
			businessPayload({ eligible: false, ineligible_reason: "<b>x</b>" }),
		);
		expect("ok" in safe && safe.ok.ineligibleReason).toBe("surface");
		expect("ok" in unsafe && unsafe.ok.ineligibleReason).toBe("unknown");
	});
});

describe("parseRedeemResponse", () => {
	it("only 200 + result:reset proves a spend", () => {
		expect(
			parseRedeemResponse(200, {
				result: "reset",
				resets_left: 0,
				cleared: ["five_hour", "seven_day", "whatever"],
			}),
		).toEqual({
			kind: "reset",
			resetsLeft: 0,
			cleared: ["five_hour", "seven_day"],
		});
	});

	it.each(["not_limited", "cooldown", "ineligible"] as const)(
		"200 + %s is contract evidence of no spend",
		(result) => {
			expect(parseRedeemResponse(200, { result })).toEqual({
				kind: "not_spent",
				cause: result,
			});
		},
	);

	it("429 / 401 / 403 are contract evidence of no spend", () => {
		expect(parseRedeemResponse(429, null)).toEqual({
			kind: "not_spent",
			cause: "rate_limited",
		});
		expect(parseRedeemResponse(401, null)).toEqual({
			kind: "not_spent",
			cause: "auth_error",
		});
		expect(parseRedeemResponse(403, {})).toEqual({
			kind: "not_spent",
			cause: "auth_error",
		});
	});

	it("200 + already_used is not attributed to this request", () => {
		expect(parseRedeemResponse(200, { result: "already_used" })).toEqual({
			kind: "already_used",
		});
	});

	it.each([
		[200, { result: "unavailable" }, "unavailable"],
		[200, { result: "who_knows" }, "malformed"],
		[200, "not json object", "malformed"],
		[200, null, "malformed"],
		[500, null, "http_5xx"],
		[503, { result: "reset" }, "http_5xx"],
		[400, null, "http_4xx_other"],
		[408, null, "http_4xx_other"],
		[409, { result: "not_limited" }, "http_4xx_other"],
	])("status %s body %j → unconfirmed %s", (status, body, cause) => {
		expect(parseRedeemResponse(status, body)).toEqual({
			kind: "unconfirmed",
			cause,
		});
	});

	it("a malformed resets_left on a reset result still proves the spend", () => {
		expect(
			parseRedeemResponse(200, { result: "reset", resets_left: -3 }),
		).toEqual({ kind: "reset", resetsLeft: null, cleared: [] });
	});
});
