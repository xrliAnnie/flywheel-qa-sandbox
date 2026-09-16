import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { customerReleasePolicyDigest } from "../customer-release/activation.js";
import { CustomerReleaseAuthority } from "../customer-release/authority.js";
import { CustomerReleaseStore } from "../customer-release/store.js";

const databases: Database.Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function fixture() {
	const db = new Database(":memory:");
	databases.push(db);
	const store = new CustomerReleaseStore(db);
	store.migrate();
	const config: any = {
		mode: "canary",
		timezone: "America/Los_Angeles",
		weekday: 2,
		notice_local: "08:00",
		deadline_local: "14:00",
		claim_deadline_local: "15:00",
		minimum_veto_minutes: 120,
		policyRevision: "a".repeat(64),
		founderEnableReceiptId: "",
		channelId: "123456789012345678",
		guildId: "223456789012345678",
		applicationId: "323456789012345678",
		botUserId: "423456789012345678",
		bot_token_env: "BOT",
		decision_token_env: "DECISION",
		executor_repository_id: 1,
		executor_workflow_id: 2,
	};
	config.policyRevision = customerReleasePolicyDigest(config);
	const input = {
		config,
		founderId: "523456789012345678",
		endpoint: "https://endpoint.example",
		audience: "payload",
		env: { BOT: "b".repeat(40), DECISION: "d".repeat(40) },
		deploymentDigest: "a".repeat(64),
	};
	let evidence: string | null = "e".repeat(64),
		flag = false;
	const authority = new CustomerReleaseAuthority({
		store,
		input: () => input,
		flag: () => flag,
		healthy: () => true,
		evidence: () => evidence,
		now: () => 2000,
	});
	const enable = () => {
		const snapshot = authority.read()!;
		store.activation.recordDeliveredEnableNotice(
			{
				noticeId: "1".repeat(32),
				epoch: snapshot.target.epoch,
				identityDigest: snapshot.identity.identityDigest,
				evidenceBundleDigest: evidence!,
				applicationId: config.applicationId,
				channelId: config.channelId,
				messageId: "623456789012345678",
				expiresAt: 5000,
			},
			2000,
		);
		store.activation.enable(
			{
				interactionId: "723456789012345678",
				noticeId: "1".repeat(32),
				actorId: input.founderId,
				applicationId: config.applicationId,
				channelId: config.channelId,
				messageId: "623456789012345678",
			},
			2000,
		);
		config.founderEnableReceiptId = "723456789012345678";
		flag = true;
	};
	return {
		store,
		input,
		authority,
		enable,
		evidence: (value: string | null) => {
			evidence = value;
		},
		flag: (value: boolean) => {
			flag = value;
		},
	};
}
it("staging is disabled; actual receipt plus flag grants current authority with unchanged epoch", () => {
	const f = fixture();
	expect(f.authority.read()?.activation.enabled).toBe(false);
	f.enable();
	expect(f.authority.read()?.activation).toMatchObject({
		enabled: true,
		enableReceiptValid: true,
		activationEpoch: 1,
	});
	f.flag(false);
	expect(f.authority.read()?.activation.enabled).toBe(false);
});
it.each(["owner", "token", "deployment"])(
	"%s rotation revokes the durable receipt and bumps epoch",
	(kind) => {
		const f = fixture();
		f.enable();
		if (kind === "owner") f.input.founderId = "823456789012345678";
		if (kind === "token") f.input.env.BOT = "x".repeat(40);
		if (kind === "deployment") f.input.deploymentDigest = "f".repeat(64);
		expect(f.authority.read()?.activation.enabled).toBe(false);
		expect(f.store.activation.get()).toMatchObject({
			enabled: false,
			epoch: 2,
			enableReceiptId: null,
		});
	},
);
it.each(["invalid_config", "evidence_missing", "evidence_changed"])(
	"%s permanently revokes the old grant; recovery does not auto-enable",
	(kind) => {
		const f = fixture();
		f.enable();
		if (kind === "invalid_config") f.input.config.weekday = 9;
		if (kind === "evidence_missing") f.evidence(null);
		if (kind === "evidence_changed") f.evidence("f".repeat(64));
		f.authority.read();
		expect(f.store.activation.get()?.enabled).toBe(false);
		f.input.config.weekday = 2;
		f.evidence("e".repeat(64));
		expect(f.authority.read()?.activation.enabled).toBe(false);
	},
);
it("default off needs no credentials or evidence and stops existing authority", () => {
	const f = fixture();
	f.enable();
	f.input.config = { mode: "off" };
	expect(f.authority.read()).toBeNull();
	expect(f.store.activation.get()?.enabled).toBe(false);
});

it("a failed revocation cannot pretend the persisted grant was removed", () => {
	const f = fixture();
	f.enable();
	const before = f.store.activation.get();
	const original = f.store.invalidateRuntime;
	f.store.invalidateRuntime = () => {
		throw new Error("database failure");
	};
	f.evidence(null);
	expect(() => f.authority.read()).toThrow("database failure");
	expect(f.store.activation.get()).toEqual(before);
	f.store.invalidateRuntime = original;
	expect(f.authority.read()?.activation.enabled).toBe(false);
});

it("invalid configuration also invalidates pending manual work when auto was never enabled", () => {
	const f = fixture();
	f.authority.read();
	let invalidations = 0;
	const original = f.store.invalidateRuntime.bind(f.store);
	f.store.invalidateRuntime = (reason, now) => {
		invalidations++;
		original(reason, now);
	};
	f.input.config.weekday = 9;
	expect(f.authority.read()).toBeNull();
	expect(invalidations).toBe(1);
});
