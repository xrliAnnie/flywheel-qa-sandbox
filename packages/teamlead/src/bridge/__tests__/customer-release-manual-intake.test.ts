import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { ManualReleaseIntake } from "../customer-release/manual-intake.js";
import { CustomerReleaseStore } from "../customer-release/store.js";

const dbs: Database.Database[] = [];
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
});
function fixture() {
	const db = new Database(":memory:");
	dbs.push(db);
	const store = new CustomerReleaseStore(db);
	store.migrate();
	const now = Date.parse("2026-09-15T15:00:00Z"),
		sha = "a".repeat(40);
	const request: any = {
		schemaVersion: 1,
		requestId: "b".repeat(32),
		betaVersion: "1.2.3-beta.1",
		slotDate: "2026-09-15",
		releaseId: "manual1",
		epoch: 1,
		identityDigest: "c".repeat(64),
		requestedAt: now,
		expiresAt: now + 3600000,
	};
	const snapshot: any = {
		config: {
			mode: "canary",
			timezone: "America/Los_Angeles",
			weekday: 2,
			notice_local: "08:00",
			deadline_local: "14:00",
			claim_deadline_local: "15:00",
			minimum_veto_minutes: 120,
		},
		target: {
			epoch: 1,
			founderId: "123456789012345678",
			applicationId: "223456789012345678",
			channelId: "323456789012345678",
			botUserId: "423456789012345678",
		},
		identity: {
			identityDigest: request.identityDigest,
			policyRevision: "d".repeat(64),
		},
	};
	const manifest: any = {
		versions: {
			"1.2.3-beta.1": {
				channel: "beta",
				status: "active",
				sourceCommit: sha,
				sha256: "e".repeat(64),
			},
		},
	};
	let deployed: string | null = sha;
	const intake = new ManualReleaseIntake({
		store,
		read: () => request,
		snapshot: () => snapshot,
		source: {
			manifest: async () => ({ manifest, etag: '"etag"', observedAt: now }),
		},
		localDeployedSha: () => deployed,
		now: () => now,
	});
	return {
		manifest,
		store,
		intake,
		request,
		snapshot,
		deployed: (v: string | null) => {
			deployed = v;
		},
	};
}
it("fresh manual intake reserves a real beta, atomically cancels with a label, and leaves auto authority untouched", async () => {
	const f = fixture();
	await f.intake.tick();
	const cycle = f.store.forWeek("flywheel", "2026-09-14")!;
	expect(cycle).toMatchObject({
		state: "cancelled",
		cancelReason: "manual_intake",
		windowOpenedAt: null,
		binding: null,
	});
	expect(f.store.activation.get()).toBeNull();
	expect(f.store.notice(cycle.cycleId)).toBeNull();
	expect(f.store.unresolvedDecision("flywheel")).toBeNull();
	expect(f.intake.preparedRequest()).toMatchObject({
		operation: "prepare",
		cycleId: cycle.cycleId,
		releaseId: "manual1",
	});
	expect(f.store.manual.get(f.request.requestId)).toBeNull();
	await f.intake.tick();
	expect(f.store.get(cycle.cycleId)).toEqual(cycle);
	f.request.requestId = "f".repeat(32);
	f.request.releaseId = "manual2";
	await f.intake.tick();
	expect(f.intake.preparedRequest()).toBeNull();
	expect(f.store.get(cycle.cycleId)).toEqual(cycle);
});
it.each(["unknown", "mismatch", "slot", "observe"])(
	"%s cannot consume a manual intake slot",
	async (kind) => {
		const f = fixture();
		if (kind === "unknown") f.deployed(null);
		if (kind === "mismatch") f.deployed("f".repeat(40));
		if (kind === "slot") f.request.slotDate = "2026-09-22";
		if (kind === "observe") f.snapshot.config.mode = "observe";
		await f.intake.tick();
		expect(f.store.forWeek("flywheel", "2026-09-14")).toBeNull();
	},
);

it("fresh intake flows into a waiting prepared card and still requires a new founder go", async () => {
	const { ManualReleasePreparation } = await import(
		"../customer-release/manual-preparation.js"
	);
	const { deriveVetoBinding, payloadObjectKey } = await import(
		"flywheel-release-contract"
	);
	const f = fixture();
	await f.intake.tick();
	const hash = "f".repeat(64),
		sourceCommit = "a".repeat(40);
	const manifest = {
		...f.manifest,
		releaseOps: {
			manual1: {
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
	await new ManualReleasePreparation({
		store: f.store,
		read: () => f.intake.preparedRequest(),
		snapshot: () => f.snapshot,
		source: {
			manifest: async () => ({
				manifest,
				etag: '"etag"',
				observedAt: f.request.requestedAt,
			}),
			prepared: async () => ({
				binding: deriveVetoBinding(manifest, "manual1"),
				readbackSha256: hash,
			}),
		},
		dispatch: { tick: async () => ({ runId: 1234, state: "succeeded" }) },
		workflow: {
			repository: "owner/repo",
			repositoryId: 1,
			workflowId: 2,
			workflowPath: ".github/workflows/payload-promote.yml",
			reviewedSha: sourceCommit,
		},
		now: () => f.request.requestedAt,
	}).tick();
	expect(f.store.manual.get(f.request.requestId)?.status).toBe("waiting");
	expect(f.store.activation.get()).toBeNull();
	expect(f.store.unresolvedDecision("flywheel")).toBeNull();
});

it("intake cancellation failure rolls back the slot reservation and label together", async () => {
	const f = fixture();
	f.store.cancel = () => {
		throw new Error("cancel failed");
	};
	await f.intake.tick();
	expect(f.store.forWeek("flywheel", "2026-09-14")).toBeNull();
	expect(f.intake.preparedRequest()).toBeNull();
});
