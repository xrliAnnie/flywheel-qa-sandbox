import { describe, expect, it } from "vitest";
import { ConfigLoader } from "../ConfigLoader.js";
import { parseCustomerReleaseConfig } from "../customer-release-config.js";

const configured = {
	mode: "observe",
	timezone: "America/Los_Angeles",
	weekday: 2,
	notice_local: "08:00",
	deadline_local: "15:00",
	claim_deadline_local: "16:00",
	minimum_veto_minutes: 120,
	policyRevision: "a".repeat(64),
	channelId: "123456789012345678",
	guildId: "223456789012345678",
	applicationId: "323456789012345678",
	botUserId: "423456789012345678",
	bot_token_env: "RELEASE_BOT_TOKEN",
	decision_token_env: "FW_RELEASE_DECISION_TOKEN",
	executor_repository_id: 123,
	executor_workflow_id: 456,
};

describe("customer release configuration", () => {
	it("defaults to off without inventing a production schedule", () => {
		expect(parseCustomerReleaseConfig(undefined)).toEqual({ mode: "off" });
		expect(parseCustomerReleaseConfig({})).toEqual({ mode: "off" });
		expect(parseCustomerReleaseConfig({ mode: "off" })).toEqual({
			mode: "off",
		});
	});

	it("accepts explicit observe configuration and canary receipt reference", () => {
		expect(parseCustomerReleaseConfig(configured)).toEqual(configured);
		const canary = {
			...configured,
			mode: "canary",
			founderEnableReceiptId: "enable-123",
		};
		expect(parseCustomerReleaseConfig(canary)).toEqual(canary);
		expect(() =>
			parseCustomerReleaseConfig({ ...configured, mode: "canary" }),
		).toThrow(/customer_release/);
	});

	it("requires every enabled configuration field rather than guessing", () => {
		for (const key of Object.keys(configured).filter((key) => key !== "mode")) {
			const missing: Record<string, unknown> = { ...configured };
			delete missing[key];
			expect(() => parseCustomerReleaseConfig(missing), key).toThrow(
				/customer_release/,
			);
		}
	});

	it("rejects malformed, unsafe and unknown input without echoing its values", () => {
		const invalid = [
			null,
			[],
			"private-secret",
			true,
			{ ...configured, mode: "enabled" },
			{ ...configured, timezone: "private-secret" },
			{ ...configured, timezone: "+08:00" },
			{ ...configured, weekday: 0 },
			{ ...configured, weekday: 8 },
			{ ...configured, weekday: 1.5 },
			{ ...configured, notice_local: "8:00" },
			{ ...configured, notice_local: "12:00" },
			{ ...configured, deadline_local: "11:59" },
			{ ...configured, deadline_local: "24:00" },
			{ ...configured, claim_deadline_local: "15:00" },
			{ ...configured, claim_deadline_local: "14:00" },
			{ ...configured, claim_deadline_local: "18:00" },
			{ ...configured, notice_local: "11:30", deadline_local: "12:00" },
			{ ...configured, minimum_veto_minutes: 119 },
			{ ...configured, minimum_veto_minutes: 481 },
			{ ...configured, minimum_veto_minutes: "120" },
			{ ...configured, policyRevision: "private-secret" },
			{ ...configured, channelId: "0" },
			{ ...configured, bot_token_env: "private-secret" },
			{ ...configured, decision_token_env: "private-secret" },
			{ ...configured, executor_repository_id: -1 },
			{ ...configured, executor_workflow_id: Number.MAX_SAFE_INTEGER + 1 },
			{ ...configured, founderEnableReceiptId: "private-secret/../../" },
			{ ...configured, token: "private-secret" },
			{ mode: "off", token: "private-secret" },
		];
		for (const value of invalid) {
			expect(() => parseCustomerReleaseConfig(value)).toThrow(
				/customer_release/,
			);
			try {
				parseCustomerReleaseConfig(value);
			} catch (error) {
				expect(String(error)).not.toContain("private-secret");
			}
		}
	});

	it("validates through the project loader and exports the same parser", async () => {
		const base = `project: test
linear: {team_id: T}
runners: {default: claude, available: {claude: {type: claude}}}
teams: [{name: dev}]
decision_layer: {autonomy_level: observer, escalation_channel: dev}
`;
		const load = (value: unknown) =>
			new ConfigLoader(
				async () => `${base}customer_release: ${JSON.stringify(value)}`,
			).load("/project");
		expect((await load({})).customer_release).toEqual({ mode: "off" });
		expect((await load(configured)).customer_release).toEqual(configured);
		await expect(load({ mode: "canary" })).rejects.toThrow(/customer_release/);
		const exported = await import("../index.js");
		expect(exported.parseCustomerReleaseConfig).toBe(
			parseCustomerReleaseConfig,
		);
	});
});

it("rejects the store-managed switch in YAML configuration", () => {
	for (const value of [true, false, "true"]) {
		expect(() =>
			parseCustomerReleaseConfig({ auto_release_on_silence_enabled: value }),
		).toThrow(/customer_release.fields/);
	}
});

it("accepts an explicitly empty staged canary receipt without inventing authority", () => {
	const staged = { ...configured, mode: "canary", founderEnableReceiptId: "" };
	expect(parseCustomerReleaseConfig(staged)).toEqual(staged);
	expect(parseCustomerReleaseConfig(staged).founderEnableReceiptId).toBe("");
});
