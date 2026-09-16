import Database from "better-sqlite3";
import { payloadObjectKey } from "flywheel-release-contract";
import { afterEach, expect, it, vi } from "vitest";
import {
	releaseCard,
	releaseMessageDigest,
} from "../customer-release/cards.js";
import { CustomerReleaseNoticeDelivery } from "../customer-release/delivery.js";
import { CustomerReleaseStore } from "../customer-release/store.js";

const databases: Database.Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
const at = Date.parse("2026-09-15T15:00:00Z"),
	messageId = "623456789012345678";
function fixture() {
	const db = new Database(":memory:");
	databases.push(db);
	const store = new CustomerReleaseStore(db);
	store.migrate();
	let now = at;
	const sourceCommit = "a".repeat(40),
		hash = "b".repeat(64),
		nonce = "c".repeat(32);
	const card = releaseCard({
		kind: "veto",
		nonce,
		epoch: 1,
		timezone: "America/Los_Angeles",
		betaVersion: "1.2.3-beta.1",
		releaseVersion: "1.2.3",
		sourceCommit,
		payloadSha256: hash,
		deadlineAt: at + 4 * 3600_000,
	});
	const manifest = {
		versions: {
			"1.2.3-beta.1": {
				channel: "beta",
				status: "active",
				sourceCommit,
				sha256: "d".repeat(64),
			},
		},
		releaseOps: {
			r1: {
				kind: "release",
				state: "prepared",
				ver: "1.2.3",
				sourceCommit,
				sha256: hash,
				objectKey: payloadObjectKey("1.2.3", hash),
				betaVersion: "1.2.3-beta.1",
			},
		},
	};
	const cycle = store.reserve({
		projectId: "flywheel",
		slotDate: "2026-09-15",
		releaseId: "r1",
		activationEpoch: 1,
		policyRevision: "e".repeat(64),
		betaVersion: "1.2.3-beta.1",
		manifest,
		now,
	});
	db.prepare(
		"UPDATE customer_release_cycles SET state='preparing',revision=1 WHERE cycle_id=?",
	).run(cycle.cycleId);
	const notice = {
		noticeId: nonce,
		messageDigest: releaseMessageDigest(card),
		channelId: "123456789012345678",
		applicationId: "223456789012345678",
		botUserId: "323456789012345678",
		founderId: "423456789012345678",
		noticeAt: at,
		deadlineAt: at + 4 * 3600_000,
		claimNotAfter: at + 5 * 3600_000,
		minimumVetoMinutes: 120,
	};
	store.completePreparation(
		cycle.cycleId,
		1,
		manifest,
		{ workflowRunId: "1234", equivalenceVerified: true, readbackSha256: hash },
		notice,
		now,
	);
	const proof = {
		messageId,
		messageDigest: notice.messageDigest,
		channelId: notice.channelId,
		applicationId: notice.applicationId,
		botUserId: notice.botUserId,
		founderId: notice.founderId,
		verifiedAt: now,
		accessVerified: true,
		gatewayHealthy: true,
	};
	const transport = {
		send: vi.fn(async () => messageId),
		findMessage: vi.fn(async (): Promise<string | null> => messageId),
		verifyMessage: vi.fn(async () => ({ ...proof, verifiedAt: now })),
	};
	const delivery = new CustomerReleaseNoticeDelivery({
		store,
		transport,
		now: () => now,
	});
	return {
		store,
		db,
		cycle,
		card,
		notice,
		transport,
		delivery,
		time: (value: number) => {
			now = value;
		},
	};
}
it("persists sending before the only POST; opens only after readback and never reopens", async () => {
	const f = fixture();
	f.transport.send.mockImplementation(async () => {
		expect(f.store.notice(f.cycle.cycleId)?.sendState).toBe("sending");
		expect(f.store.get(f.cycle.cycleId)?.state).toBe("notice_pending");
		return messageId;
	});
	expect(await f.delivery.deliver(f.cycle.cycleId, f.card)).toMatchObject({
		messageId,
	});
	expect(f.store.get(f.cycle.cycleId)?.state).toBe("window_open");
	await f.delivery.deliver(f.cycle.cycleId, f.card);
	expect(f.transport.send).toHaveBeenCalledTimes(1);
	expect(f.store.get(f.cycle.cycleId)?.windowOpenedAt).toBe(at);
});
it.each(["lost_response", "restart_sending", "restart_uncertain"])(
	"recovers %s using the same card without a second POST",
	async (fault) => {
		const f = fixture();
		if (fault === "lost_response")
			f.transport.send.mockRejectedValue(new Error("lost"));
		else {
			f.store.startNotice(f.cycle.cycleId, at);
			if (fault === "restart_uncertain")
				f.store.markNoticeUncertain(f.cycle.cycleId);
		}
		expect(await f.delivery.deliver(f.cycle.cycleId, f.card)).toMatchObject({
			messageId,
		});
		expect(f.transport.send).toHaveBeenCalledTimes(
			fault === "lost_response" ? 1 : 0,
		);
		expect(f.transport.findMessage).toHaveBeenCalledTimes(1);
	},
);
it.each(["absent", "ambiguous", "bad_probe"])(
	"unproven %s cancels this cycle and never reposts",
	async (fault) => {
		const f = fixture();
		f.store.startNotice(f.cycle.cycleId, at);
		if (fault === "absent") f.transport.findMessage.mockResolvedValue(null);
		if (fault === "ambiguous")
			f.transport.findMessage.mockRejectedValue(new Error("duplicate"));
		if (fault === "bad_probe")
			f.transport.verifyMessage.mockRejectedValue(new Error("edited"));
		expect(await f.delivery.deliver(f.cycle.cycleId, f.card)).toBeNull();
		expect(f.store.get(f.cycle.cycleId)?.state).toBe("cancelled");
		await f.delivery.deliver(f.cycle.cycleId, f.card);
		expect(f.transport.send).not.toHaveBeenCalled();
	},
);
it("pre-notice never sends, and late receipt never shortens the promised window", async () => {
	const f = fixture();
	f.time(at - 1);
	expect(await f.delivery.deliver(f.cycle.cycleId, f.card)).toBeNull();
	expect(f.transport.send).not.toHaveBeenCalled();
	f.time(at);
	f.transport.verifyMessage.mockImplementation(async () => {
		f.time(at + 3 * 3600_000);
		return {
			...f.notice,
			messageId,
			verifiedAt: at + 3 * 3600_000,
			accessVerified: true,
			gatewayHealthy: true,
		};
	});
	expect(await f.delivery.deliver(f.cycle.cycleId, f.card)).toBeNull();
	expect(f.store.get(f.cycle.cycleId)?.state).toBe("cancelled");
});
it("probe failure during the window latches cancellation even if the next probe is healthy", async () => {
	const f = fixture();
	await f.delivery.deliver(f.cycle.cycleId, f.card);
	f.transport.verifyMessage.mockRejectedValueOnce(new Error("access revoked"));
	expect(await f.delivery.probe(f.cycle.cycleId)).toBeNull();
	expect(f.store.get(f.cycle.cycleId)?.state).toBe("cancelled");
	expect(await f.delivery.probe(f.cycle.cycleId)).toBeNull();
});

it("a stale or mismatched probe is itself a cancellation event", async () => {
	for (const patch of [
		{ verifiedAt: at - 30001 },
		{ accessVerified: false },
		{ channelId: "723456789012345678" },
	]) {
		const f = fixture();
		await f.delivery.deliver(f.cycle.cycleId, f.card);
		f.transport.verifyMessage.mockImplementation(async () => ({
			...f.notice,
			messageId,
			verifiedAt: at,
			accessVerified: true,
			gatewayHealthy: true,
			...patch,
		}));
		expect(await f.delivery.probe(f.cycle.cycleId)).toBeNull();
		expect(f.store.get(f.cycle.cycleId)?.state).toBe("cancelled");
	}
});
