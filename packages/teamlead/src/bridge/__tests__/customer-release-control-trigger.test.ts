import { expect, it, vi } from "vitest";
import { ReleaseControlTrigger } from "../customer-release/control-trigger.js";

function fixture() {
	const snapshot: any = {
		config: { mode: "canary", policyRevision: "a".repeat(64) },
		identity: {
			identityDigest: "b".repeat(64),
			policyRevision: "a".repeat(64),
		},
		target: {
			epoch: 1,
			founderId: "123456789012345678",
			applicationId: "223456789012345678",
			channelId: "323456789012345678",
			guildId: "423456789012345678",
			botUserId: "523456789012345678",
		},
		evidenceDigest: "c".repeat(64),
	};
	const request: any = {
		schemaVersion: 1,
		action: "enable",
		noticeId: "d".repeat(32),
		epoch: 1,
		identityDigest: "b".repeat(64),
		evidenceBundleDigest: "c".repeat(64),
		expiresAt: 10000,
	};
	const deliver = vi.fn(async (_intent: unknown) => null);
	let now = 2000;
	const trigger = new ReleaseControlTrigger({
		snapshot: () => snapshot,
		read: () => request,
		delivery: { deliver },
		now: () => now,
	});
	return {
		snapshot,
		request,
		deliver,
		trigger,
		time: (value: number) => {
			now = value;
		},
	};
}
it("an explicit frozen request creates only a card intent and repeated ticks are throttled", async () => {
	const f = fixture();
	await f.trigger.tick();
	expect(f.deliver).toHaveBeenCalledTimes(1);
	expect(f.deliver.mock.calls[0]?.[0]).toMatchObject({
		noticeId: f.request.noticeId,
		action: "enable",
		epoch: 1,
		expiresAt: 10000,
		evidenceBundleDigest: f.snapshot.evidenceDigest,
	});
	await f.trigger.tick();
	expect(f.deliver).toHaveBeenCalledTimes(1);
});
it.each(["observe", "owner_epoch", "identity", "evidence", "expired", "extra"])(
	"rejects %s before any card delivery",
	async (kind) => {
		const f = fixture();
		if (kind === "observe") f.snapshot.config.mode = "observe";
		if (kind === "owner_epoch") f.request.epoch = 2;
		if (kind === "identity") f.request.identityDigest = "0".repeat(64);
		if (kind === "evidence") f.snapshot.evidenceDigest = null;
		if (kind === "expired") f.time(10000);
		if (kind === "extra") f.request.token = "bad";
		await f.trigger.tick();
		expect(f.deliver).not.toHaveBeenCalled();
	},
);
it("disable card can be requested after evidence loss; it cannot grant enable authority", async () => {
	const f = fixture();
	f.request.action = "disable";
	f.snapshot.evidenceDigest = null;
	await f.trigger.tick();
	expect(f.deliver).toHaveBeenCalledTimes(1);
	expect(f.deliver.mock.calls[0]?.[0]).toMatchObject({ action: "disable" });
});

it("the file trigger reads bounded regular JSON and rejects symlinks and oversized inputs", async () => {
	const fs = await import("node:fs"),
		{ tmpdir } = await import("node:os"),
		{ join } = await import("node:path");
	const { readReleaseControlRequest } = await import(
		"../customer-release/control-trigger.js"
	);
	const root = fs.realpathSync(
		fs.mkdtempSync(join(tmpdir(), "release-control-")),
	);
	try {
		expect(readReleaseControlRequest(root)).toBeNull();
		fs.writeFileSync(
			join(root, "control.json"),
			JSON.stringify({ schemaVersion: 1 }),
		);
		expect(readReleaseControlRequest(root)).toEqual({ schemaVersion: 1 });
		fs.rmSync(join(root, "control.json"));
		fs.writeFileSync(join(root, "other.json"), "{}");
		fs.symlinkSync("other.json", join(root, "control.json"));
		expect(readReleaseControlRequest(root)).toBeNull();
		fs.rmSync(join(root, "control.json"));
		fs.writeFileSync(join(root, "control.json"), " ".repeat(16385));
		expect(readReleaseControlRequest(root)).toBeNull();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
