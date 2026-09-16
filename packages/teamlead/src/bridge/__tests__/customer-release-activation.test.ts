import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
	customerReleaseIdentity,
	customerReleasePolicyDigest,
} from "../customer-release/activation.js";
import { CustomerReleaseActivationStore } from "../customer-release/activation-store.js";

const config = {
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
	decision_token_env: "RELEASE_DECISION_TOKEN",
	executor_repository_id: 123,
	executor_workflow_id: 456,
};
const input = () => ({
	config: { ...config, policyRevision: customerReleasePolicyDigest(config) },
	founderId: "523456789012345678",
	endpoint: "https://endpoint.example",
	audience: "payload",
	env: {
		RELEASE_BOT_TOKEN: "bot".repeat(20),
		RELEASE_DECISION_TOKEN: "decision".repeat(8),
	},
});
it("policy digest is stable across key order and excludes only self-reference and enable receipt", () => {
	const reversed = Object.fromEntries(Object.entries(config).reverse());
	expect(customerReleasePolicyDigest(reversed)).toBe(
		customerReleasePolicyDigest(config),
	);
	expect(
		customerReleasePolicyDigest({
			...config,
			policyRevision: "b".repeat(64),
			founderEnableReceiptId: "enable-1",
		}),
	).toBe(customerReleasePolicyDigest(config));
	expect(
		customerReleasePolicyDigest({ ...config, deadline_local: "14:00" }),
	).not.toBe(customerReleasePolicyDigest(config));
});
it("identity binds owner, policy, endpoint audience and credential rotation without retaining raw credentials", () => {
	const value = input();
	const before = customerReleaseIdentity(value);
	expect(before.policyRevision).toBe(value.config.policyRevision);
	expect(JSON.stringify(before)).not.toContain(value.env.RELEASE_BOT_TOKEN);
	expect(JSON.stringify(before)).not.toContain(
		value.env.RELEASE_DECISION_TOKEN,
	);
	for (const patch of [
		{ founderId: "623456789012345678" },
		{ endpoint: "https://other.example" },
		{ audience: "other" },
		{ env: { ...value.env, RELEASE_BOT_TOKEN: "rotated".repeat(8) } },
		{ env: { ...value.env, RELEASE_DECISION_TOKEN: "rotated".repeat(8) } },
	])
		expect(
			customerReleaseIdentity({ ...value, ...patch }).identityDigest,
		).not.toBe(before.identityDigest);
});
it("missing owner/credentials, duplicate roles, stale policy digest and unsafe endpoint fail without secret text", () => {
	const value = input();
	for (const patch of [
		{ founderId: null },
		{ config: { ...value.config, weekday: 3 } },
		{ env: {} },
		{
			env: {
				...value.env,
				RELEASE_DECISION_TOKEN: value.env.RELEASE_BOT_TOKEN,
			},
		},
		{ endpoint: "https://user:password@endpoint.example" },
		{ endpoint: "http://remote.example" },
		{ endpoint: "https://endpoint.example/path" },
		{ audience: "../other" },
	])
		expect(() => customerReleaseIdentity({ ...value, ...patch })).toThrow(
			"customer release activation identity invalid",
		);
});

it("copying the actual founder receipt into staged canary leaves the exact identity unchanged", () => {
	const value = input();
	const staged = {
		...value.config,
		mode: "canary",
		founderEnableReceiptId: "",
	};
	staged.policyRevision = customerReleasePolicyDigest(staged);
	const before = customerReleaseIdentity({ ...value, config: staged });
	const after = customerReleaseIdentity({
		...value,
		config: { ...staged, founderEnableReceiptId: "723456789012345678" },
	});
	expect(after).toEqual(before);
	const db = new Database(":memory:");
	try {
		const store = new CustomerReleaseActivationStore(db, {
			invalidateRuntime: () => {},
		});
		store.migrate();
		store.synchronize(before, 1000);
		store.recordDeliveredEnableNotice(
			{
				noticeId: "1".repeat(32),
				epoch: 1,
				identityDigest: before.identityDigest,
				evidenceBundleDigest: "e".repeat(64),
				applicationId: staged.applicationId,
				channelId: staged.channelId,
				messageId: "623456789012345678",
				expiresAt: 5000,
			},
			1500,
		);
		store.enable(
			{
				interactionId: "723456789012345678",
				noticeId: "1".repeat(32),
				actorId: value.founderId,
				applicationId: staged.applicationId,
				channelId: staged.channelId,
				messageId: "623456789012345678",
			},
			2000,
		);
		expect(store.synchronize(after, 2500)).toMatchObject({
			epoch: 1,
			enabled: true,
			enableReceiptId: "723456789012345678",
		});
	} finally {
		db.close();
	}
});
