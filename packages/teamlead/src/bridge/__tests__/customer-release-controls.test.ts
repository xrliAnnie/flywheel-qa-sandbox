import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { releaseMessageDigest } from "../customer-release/cards.js";
import {
	activationCard,
	ReleaseActivationActions,
} from "../customer-release/controls.js";
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
	const target = {
		epoch: 1,
		founderId: "123456789012345678",
		applicationId: "223456789012345678",
		channelId: "323456789012345678",
		guildId: "423456789012345678",
		botUserId: "523456789012345678",
	};
	store.activation.synchronize(
		{
			projectId: "flywheel",
			policyRevision: "a".repeat(64),
			founderId: target.founderId,
			endpoint: "https://endpoint.example",
			audience: "payload",
			botTokenSha256: "b".repeat(64),
			decisionTokenSha256: "c".repeat(64),
			identityDigest: "d".repeat(64),
		},
		1000,
	);
	let evidence = "e".repeat(64),
		now = 2000;
	const router = new ReleaseActivationActions({
		store,
		target: () => target,
		evidenceDigest: () => evidence,
		now: () => now,
	});
	const input = {
		action: "enable" as const,
		noticeId: "f".repeat(32),
		epoch: 1,
		identityDigest: "d".repeat(64),
		evidenceBundleDigest: evidence,
		expiresAt: 5000,
		policyRevision: "a".repeat(64),
	};
	const card = activationCard(input);
	const notice = {
		...input,
		applicationId: target.applicationId,
		channelId: target.channelId,
		messageId: "623456789012345678",
		botUserId: target.botUserId,
		messageDigest: releaseMessageDigest(card),
	};
	const event = {
		...card,
		interactionId: "723456789012345678",
		actorId: target.founderId,
		applicationId: target.applicationId,
		guildId: target.guildId,
		channelId: target.channelId,
		messageId: notice.messageId,
		action: input.action,
		nonce: input.noticeId,
		epoch: 1,
	};
	return {
		db,
		store,
		target,
		input,
		card,
		notice,
		event,
		router,
		evidence: (value: string) => {
			evidence = value;
		},
		time: (value: number) => {
			now = value;
		},
	};
}
it("requires an independently delivered immutable card before enabling; same interaction replays once", () => {
	const f = fixture();
	expect(() => f.router.commit(f.event)).toThrow();
	f.store.activation.recordDeliveredControl(f.notice, 1500);
	expect(f.router.commit(f.event)).toContain("已记录");
	expect(f.router.commit(f.event)).toContain("已记录");
	expect(f.store.activation.get()).toMatchObject({
		enabled: true,
		enableReceiptId: f.event.interactionId,
	});
	expect(
		f.db
			.prepare(
				"SELECT count(*) AS n FROM customer_release_activation_events WHERE kind='enabled'",
			)
			.get(),
	).toEqual({ n: 1 });
});
it.each(["content", "evidence", "owner", "epoch", "message", "expired"])(
	"rejects changed %s without enabling",
	(kind) => {
		const f = fixture();
		f.store.activation.recordDeliveredControl(f.notice, 1500);
		if (kind === "content") f.event.content += "changed";
		if (kind === "evidence") f.evidence("0".repeat(64));
		if (kind === "owner") f.target.founderId = "823456789012345678";
		if (kind === "epoch") f.target.epoch = 2;
		if (kind === "message") f.event.messageId = "823456789012345678";
		if (kind === "expired") f.time(5000);
		expect(() => f.router.commit(f.event)).toThrow();
		expect(f.store.activation.get()?.enabled).toBe(false);
	},
);
it("disable uses its own delivered card and prevents replaying the prior enable card", () => {
	const f = fixture();
	f.store.activation.recordDeliveredControl(f.notice, 1500);
	f.router.commit(f.event);
	const input = {
		...f.input,
		action: "disable" as const,
		noticeId: "0".repeat(32),
	};
	const card = activationCard(input);
	f.store.activation.recordDeliveredControl(
		{
			...f.notice,
			...input,
			messageId: "823456789012345678",
			messageDigest: releaseMessageDigest(card),
		},
		2500,
	);
	f.time(3000);
	const result = f.router.commit({
		...f.event,
		...card,
		action: "disable",
		nonce: input.noticeId,
		messageId: "823456789012345678",
		interactionId: "923456789012345678",
	});
	expect(result).toContain("停止新的自动发布");
	expect(f.store.activation.get()?.enabled).toBe(false);
	expect(() => f.router.commit(f.event)).toThrow();
	expect(() =>
		f.router.commit({ ...f.event, interactionId: "113456789012345678" }),
	).toThrow();
});
it("control receipt cannot be rewritten or carry unexpected credentials", () => {
	const f = fixture();
	f.store.activation.recordDeliveredControl(f.notice, 1500);
	expect(() =>
		f.store.activation.recordDeliveredControl(
			{ ...f.notice, messageDigest: "0".repeat(64) },
			1600,
		),
	).toThrow();
	expect(() =>
		f.store.activation.recordDeliveredControl(
			{ ...f.notice, token: "secret" } as typeof f.notice,
			1600,
		),
	).toThrow();
});

it("persists the control send intent before network, then recovers a lost POST without resending", async () => {
	const { ReleaseControlDelivery } = await import(
		"../customer-release/control-delivery.js"
	);
	const f = fixture();
	let posts = 0;
	const transport = {
		send: async () => {
			posts++;
			expect(
				f.db
					.prepare(
						"SELECT count(*) AS n FROM customer_release_activation_events WHERE kind='control_sending'",
					)
					.get(),
			).toEqual({ n: 1 });
			throw new Error("lost response");
		},
		findMessage: async (_nonce: string, since: number) => {
			expect(since).toBe(2000);
			return f.notice.messageId;
		},
		verifyMessage: async () => ({
			messageId: f.notice.messageId,
			messageDigest: f.notice.messageDigest,
			channelId: f.target.channelId,
			applicationId: f.target.applicationId,
			botUserId: f.target.botUserId,
			founderId: f.target.founderId,
			accessVerified: true,
			gatewayHealthy: true,
			verifiedAt: 2000,
		}),
	};
	const options = {
		store: f.store,
		target: () => f.target,
		evidenceDigest: () => f.input.evidenceBundleDigest,
		transport,
		now: () => 2000,
	};
	const { messageId: _, ...intent } = f.notice;
	expect(await new ReleaseControlDelivery(options).deliver(intent)).toEqual(
		f.notice,
	);
	expect(await new ReleaseControlDelivery(options).deliver(intent)).toEqual(
		f.notice,
	);
	expect(posts).toBe(1);
});
it("does not record delivered authority when owner changes during control readback", async () => {
	const { ReleaseControlDelivery } = await import(
		"../customer-release/control-delivery.js"
	);
	const f = fixture();
	const transport = {
		send: async () => f.notice.messageId,
		findMessage: async () => null,
		verifyMessage: async () => {
			f.target.founderId = "823456789012345678";
			return {
				messageId: f.notice.messageId,
				messageDigest: f.notice.messageDigest,
				channelId: f.target.channelId,
				applicationId: f.target.applicationId,
				botUserId: f.target.botUserId,
				founderId: f.target.founderId,
				accessVerified: true,
				gatewayHealthy: true,
				verifiedAt: 2000,
			};
		},
	};
	const { messageId: _, ...intent } = f.notice;
	const delivery = new ReleaseControlDelivery({
		store: f.store,
		target: () => f.target,
		evidenceDigest: () => f.input.evidenceBundleDigest,
		transport,
		now: () => 2000,
	});
	expect(await delivery.deliver(intent)).toBeNull();
	expect(f.store.activation.controlNotice(intent.noticeId)).toBeNull();
});
