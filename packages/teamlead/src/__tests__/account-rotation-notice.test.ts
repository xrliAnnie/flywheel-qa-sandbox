/**
 * FLY-696 M1/④ — formatAccountRotationNotice: the one-line Alerts notice for a
 * Codex per-runner rotation. Pure; the Bridge /events branch that posts it is a
 * tiny call over this.
 */
import { describe, expect, it } from "vitest";
import { formatAccountRotationNotice } from "../account-heal/account-rotation-notice.js";

describe("formatAccountRotationNotice", () => {
	it("renders provider label + from→to + mapped reason", () => {
		expect(
			formatAccountRotationNotice({
				provider: "codex",
				from: "school",
				to: "business",
				reason: "rate_limit",
			}),
		).toBe("🔁 Codex 账号轮转：school → business（额度/限流）");
	});

	it("maps auth_expired and model_unsupported to human labels", () => {
		expect(
			formatAccountRotationNotice({
				provider: "codex",
				from: "a",
				to: "b",
				reason: "auth_expired",
			}),
		).toContain("认证过期");
		expect(
			formatAccountRotationNotice({
				provider: "codex",
				from: "a",
				to: "b",
				reason: "model_unsupported",
			}),
		).toContain("模型不支持");
	});

	it("appends resetAt when present", () => {
		expect(
			formatAccountRotationNotice({
				provider: "codex",
				from: "a",
				to: "b",
				reason: "rate_limit",
				resetAt: "2026-07-03T21:30:00-05:00",
			}),
		).toBe(
			"🔁 Codex 账号轮转：a → b（额度/限流，reset 2026-07-03T21:30:00-05:00）",
		);
	});

	it("omits the from arrow prefix when from is absent", () => {
		expect(
			formatAccountRotationNotice({ provider: "codex", to: "business" }),
		).toBe("🔁 Codex 账号轮转：→ business");
	});

	it("passes an unknown reason through verbatim", () => {
		expect(
			formatAccountRotationNotice({
				provider: "codex",
				to: "b",
				reason: "some_new_reason",
			}),
		).toBe("🔁 Codex 账号轮转：→ b（some_new_reason）");
	});

	it("title-cases known providers, passes others through", () => {
		expect(formatAccountRotationNotice({ provider: "claude", to: "x" })).toBe(
			"🔁 Claude 账号轮转：→ x",
		);
		expect(formatAccountRotationNotice({ provider: "gemini", to: "x" })).toBe(
			"🔁 gemini 账号轮转：→ x",
		);
	});
});
