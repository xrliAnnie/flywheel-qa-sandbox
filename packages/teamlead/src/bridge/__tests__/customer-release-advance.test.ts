import Database from "better-sqlite3";
import { deriveVetoBinding, payloadObjectKey } from "flywheel-release-contract";
import { afterEach, expect, it, vi } from "vitest";
import { CustomerReleaseAdvance } from "../customer-release/advance.js";
import { CustomerReleaseNoticeDelivery } from "../customer-release/delivery.js";
import { CustomerReleaseDispatch } from "../customer-release/dispatch.js";
import { CustomerReleaseStore } from "../customer-release/store.js";
import { seedReleaseActivation } from "./customer-release-activation-fixture.js";

const databases: Database.Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
const at = Date.parse("2026-09-15T15:00:00Z"),
	sha = "a".repeat(40),
	hash = "b".repeat(64),
	founder = "423456789012345678";
function fixture() {
	const db = new Database(":memory:");
	databases.push(db);
	const store = new CustomerReleaseStore(db);
	store.migrate();
	db.exec(
		"CREATE TABLE release_readiness_verdicts(verdict_id TEXT,subject_commit TEXT,base_version TEXT,local_deployed_sha TEXT,state TEXT,reasons_json TEXT,evidence_json TEXT,policy_json TEXT,evaluated_at TEXT)",
	);
	seedReleaseActivation(db, {
		founderId: founder,
		policyRevision: "c".repeat(64),
		audience: "payload",
		now: at,
	});
	let deployed: string | null = sha;
	let now = at,
		verdict = "green",
		counter = 0;
	const config: any = {
		mode: "canary",
		timezone: "America/Los_Angeles",
		weekday: 2,
		notice_local: "08:00",
		deadline_local: "14:00",
		claim_deadline_local: "15:00",
		minimum_veto_minutes: 120,
		policyRevision: "c".repeat(64),
		founderEnableReceiptId: "enable-1",
		channelId: "123456789012345678",
		applicationId: "223456789012345678",
		botUserId: "323456789012345678",
		guildId: "523456789012345678",
		bot_token_env: "BOT",
		decision_token_env: "DECISION",
		executor_repository_id: 11,
		executor_workflow_id: 23,
	};
	const prepareWorkflow = {
		repository: "owner/repo",
		repositoryId: 11,
		workflowId: 22,
		workflowPath: ".github/workflows/payload-promote.yml",
		reviewedSha: sha,
	};
	const context = {
		config,
		founderId: founder,
		flagEnabled: true,
		prepareWorkflow,
		executorWorkflow: {
			...prepareWorkflow,
			workflowId: 23,
			workflowPath: ".github/workflows/payload-auto-release.yml",
		},
	};
	const manifest: any = {
		versions: {
			"1.2.3-beta.1": {
				channel: "beta",
				status: "active",
				sourceCommit: sha,
				sha256: "d".repeat(64),
			},
		},
		releaseOps: {},
	};
	const source = {
		manifest: vi.fn(async () => ({
			manifest,
			etag: '"etag"',
			observedAt: now,
		})),
		prepared: vi.fn(async (_manifest: unknown, releaseId: string) => {
			manifest.releaseOps[releaseId] = {
				kind: "release",
				state: "prepared",
				ver: "1.2.3",
				sourceCommit: sha,
				sha256: hash,
				objectKey: payloadObjectKey("1.2.3", hash),
				betaVersion: "1.2.3-beta.1",
			};
			return {
				binding: deriveVetoBinding(manifest, releaseId),
				readbackSha256: hash,
			};
		}),
	};
	const transport = {
		dispatch: vi.fn(async () => 33),
		observe: vi.fn(async () => ({ runId: 33, state: "succeeded" as const })),
	};
	const dispatch = new CustomerReleaseDispatch({
		store,
		transport,
		now: () => now,
	});
	const discord = {
		send: vi.fn(async () => "623456789012345678"),
		findMessage: vi.fn(async () => null),
		verifyMessage: vi.fn(async (messageId: string, messageDigest: string) => ({
			messageId,
			messageDigest,
			channelId: config.channelId,
			applicationId: config.applicationId,
			botUserId: config.botUserId,
			founderId: founder,
			verifiedAt: now,
			accessVerified: true,
			gatewayHealthy: true,
		})),
	};
	const delivery = new CustomerReleaseNoticeDelivery({
		store,
		transport: discord,
		now: () => now,
	});
	const readiness = {
		evaluate: vi.fn(
			(subject: { sourceCommit: string; baseVersion: string }) => {
				const verdictId = `v${++counter}`;
				db.prepare(
					"INSERT INTO release_readiness_verdicts VALUES (?,?,?,?,?,'[]','{}','{}',?)",
				).run(
					verdictId,
					subject.sourceCommit,
					subject.baseVersion,
					sha,
					verdict,
					new Date(now).toISOString(),
				);
				return { verdictId, state: verdict };
			},
		),
	};
	const advance = new CustomerReleaseAdvance({
		store,
		source,
		dispatch,
		delivery,
		readiness,
		context: () => context,
		localDeployedSha: () => deployed,
		now: () => now,
	});
	return {
		deployed: (value: string | null) => {
			deployed = value;
		},
		db,
		store,
		source,
		context,
		transport,
		discord,
		readiness,
		advance,
		time: (value: number) => {
			now = value;
		},
		verdict: (value: string) => {
			verdict = value;
		},
		cycle: () => store.forWeek("flywheel", "2026-09-14"),
	};
}
it("advances one real cycle through preparation and one delivered window; only dispatches the executor after deadline", async () => {
	const f = fixture();
	await f.advance.tick();
	expect(f.cycle()?.state).toBe("window_open");
	expect(f.discord.send).toHaveBeenCalledTimes(1);
	expect(f.transport.dispatch).toHaveBeenCalledTimes(1);
	f.time(at + 6 * 3600_000);
	await f.advance.tick();
	expect(f.cycle()?.state).toBe("awaiting_attempt");
	expect(f.transport.dispatch).toHaveBeenCalledTimes(2);
	await f.advance.tick();
	expect(f.transport.dispatch).toHaveBeenCalledTimes(2);
	expect(f.discord.send).toHaveBeenCalledTimes(1);
	expect(
		f.db.prepare("SELECT count(*) AS n FROM customer_release_decisions").get(),
	).toEqual({ n: 0 });
});
it.each(["hold", "unknown"])(
	"%s cancels before prepare and recovery to green cannot reopen",
	async (value) => {
		const f = fixture();
		f.verdict(value);
		await f.advance.tick();
		expect(f.cycle()?.state).toBe("cancelled");
		f.verdict("green");
		await f.advance.tick();
		expect(f.transport.dispatch).not.toHaveBeenCalled();
		expect(f.discord.send).not.toHaveBeenCalled();
	},
);
it.each(["off", "observe", "disabled", "unapproved"])(
	"%s has no cycle/send/dispatch",
	async (mode) => {
		const f = fixture();
		if (mode === "disabled") f.context.flagEnabled = false;
		else if (mode === "unapproved")
			f.store.activation.disable("723456789012345678", founder, 1, at);
		else f.context.config.mode = mode;
		await f.advance.tick();
		expect(f.cycle()).toBeNull();
		expect(f.transport.dispatch).not.toHaveBeenCalled();
		expect(f.discord.send).not.toHaveBeenCalled();
	},
);
it("source/owner drift during async preparation cancels before delivering a card", async () => {
	const f = fixture();
	f.source.prepared.mockImplementationOnce(async (_m, id) => {
		f.context.founderId = "823456789012345678";
		return {
			binding: {
				releaseId: id,
				betaVersion: "1.2.3-beta.1",
				betaPayloadSha256: "d".repeat(64),
				releaseVersion: "1.2.3",
				releasePayloadSha256: hash,
				sourceCommit: sha,
			},
			readbackSha256: hash,
		};
	});
	await f.advance.tick();
	expect(f.cycle()?.state).toBe("cancelled");
	expect(f.discord.send).not.toHaveBeenCalled();
});
it("late preparation and expired executor queue cannot move the cutoff", async () => {
	const f = fixture();
	f.time(at + 5 * 3600_000);
	await f.advance.tick();
	expect(f.cycle()?.state).toBe("cancelled");
	expect(f.discord.send).not.toHaveBeenCalled();
	const g = fixture();
	await g.advance.tick();
	g.time(at + 7 * 3600_000 + 1);
	await g.advance.tick();
	expect(g.cycle()?.state).toBe("cancelled");
	expect(g.transport.dispatch).toHaveBeenCalledTimes(1);
});

it("one-second runtime ticks do not repeat the 30-second notice/workflow probes", async () => {
	const f = fixture();
	await f.advance.tick();
	const probes = f.discord.verifyMessage.mock.calls.length;
	f.time(at + 1000);
	await f.advance.tick();
	expect(f.discord.verifyMessage).toHaveBeenCalledTimes(probes);
	f.time(at + 6 * 3600_000);
	await f.advance.tick();
	const observations = f.transport.observe.mock.calls.length;
	f.time(at + 6 * 3600_000 + 1000);
	await f.advance.tick();
	expect(f.transport.observe).toHaveBeenCalledTimes(observations);
});

it.each(["no_candidate", "unknown"])(
	"persists %s before a candidate exists and never reopens that week after recovery",
	async (reason) => {
		const f = fixture();
		if (reason === "no_candidate")
			f.source.manifest.mockResolvedValueOnce({
				manifest: { versions: {}, releaseOps: {} },
				etag: '"empty"',
				observedAt: at,
			});
		else
			f.source.manifest.mockRejectedValueOnce(new Error("source unavailable"));
		await f.advance.tick();
		expect(f.cycle()).toBeNull();
		expect(
			f.db
				.prepare(
					"SELECT kind,payload_json FROM customer_release_activation_events WHERE kind='cycle_slot_missed'",
				)
				.all(),
		).toEqual([
			{
				kind: "cycle_slot_missed",
				payload_json: JSON.stringify({
					projectId: "flywheel",
					weekStart: "2026-09-14",
					reason,
				}),
			},
		]);
		f.time(at + 1000);
		await f.advance.tick();
		expect(f.cycle()).toBeNull();
		expect(f.source.manifest).toHaveBeenCalledTimes(1);
		expect(f.transport.dispatch).not.toHaveBeenCalled();
		expect(f.discord.send).not.toHaveBeenCalled();
	},
);

it("unknown deployed identity latches even if it becomes known later", async () => {
	const f = fixture();
	f.deployed(null);
	await f.advance.tick();
	expect(
		f.db
			.prepare(
				"SELECT kind FROM customer_release_activation_events WHERE kind='cycle_slot_missed'",
			)
			.all(),
	).toEqual([{ kind: "cycle_slot_missed" }]);
	f.deployed(sha);
	await f.advance.tick();
	expect(f.cycle()).toBeNull();
});
it("does not consume the weekly slot before its configured notice time", async () => {
	const f = fixture();
	f.time(at - 1);
	await f.advance.tick();
	expect(f.source.manifest).not.toHaveBeenCalled();
	expect(f.cycle()).toBeNull();
	f.time(at);
	await f.advance.tick();
	expect(f.cycle()?.state).toBe("window_open");
});

it("missed-slot evidence survives adapter reconstruction and epoch changes, remains immutable and does not consume next week", () => {
	const f = fixture();
	f.store.activation.recordMissedSlot("2026-09-14", "unknown", at);
	const recovered = new CustomerReleaseStore(f.db);
	recovered.migrate();
	const previous = recovered.activation.get()!;
	recovered.activation.synchronize(
		{
			...previous.identity,
			founderId: "823456789012345678",
			identityDigest: "e".repeat(64),
		},
		at + 1,
	);
	recovered.activation.recordMissedSlot("2026-09-14", "no_candidate", at + 2);
	expect(recovered.activation.missedSlot("2026-09-14")?.reason).toBe("unknown");
	expect(recovered.activation.missedSlot("2026-09-21")).toBeNull();
	expect(() =>
		f.db
			.prepare(
				"UPDATE customer_release_activation_events SET kind='changed' WHERE kind='cycle_slot_missed'",
			)
			.run(),
	).toThrow("immutable");
	expect(() =>
		f.db
			.prepare(
				"DELETE FROM customer_release_activation_events WHERE kind='cycle_slot_missed'",
			)
			.run(),
	).toThrow("immutable");
});

it("staged canary never starts a cycle; copying the durable receipt allows the same epoch to advance", async () => {
	const f = fixture();
	f.context.config.founderEnableReceiptId = "";
	const epoch = f.store.activation.get()!.epoch;
	await f.advance.tick();
	expect(f.cycle()).toBeNull();
	expect(f.transport.dispatch).not.toHaveBeenCalled();
	f.context.config.founderEnableReceiptId = "enable-1";
	await f.advance.tick();
	expect(f.store.activation.get()!.epoch).toBe(epoch);
	expect(f.cycle()?.state).toBe("window_open");
});

it.each(["off", "disabled"])(
	"%s preserves founder manual-ready work but Gateway/restart still cancel it",
	async (mode) => {
		const f = fixture();
		await f.advance.tick();
		const cycle = f.cycle()!;
		// The durable state written by manual.go before its executor becomes ready.
		f.db
			.prepare(
				"UPDATE customer_release_cycles SET state='manual_ready' WHERE cycle_id=?",
			)
			.run(cycle.cycleId);
		if (mode === "off") f.context.config.mode = "off";
		else f.context.flagEnabled = false;
		f.transport.dispatch.mockClear();
		f.discord.send.mockClear();
		await f.advance.tick();
		expect(f.cycle()?.state).toBe("manual_ready");
		expect(f.transport.dispatch).not.toHaveBeenCalled();
		expect(f.discord.send).not.toHaveBeenCalled();
		f.store.invalidateRuntime("gateway_unavailable", at);
		expect(f.cycle()?.state).toBe("cancelled");
		const g = fixture();
		await g.advance.tick();
		g.db
			.prepare(
				"UPDATE customer_release_cycles SET state='manual_ready' WHERE cycle_id=?",
			)
			.run(g.cycle()!.cycleId);
		g.store.recoverAfterRestart("flywheel", at);
		expect(g.cycle()?.state).toBe("cancelled");
	},
);
it("auto disable still cancels an already open automatic window", async () => {
	const f = fixture();
	await f.advance.tick();
	f.context.flagEnabled = false;
	await f.advance.tick();
	expect(f.cycle()?.state).toBe("cancelled");
});

it.each(["committing", "commit_unknown"])(
	"auto disable preserves a manual %s decision; Gateway failure still records intervention",
	async (phase) => {
		const f = fixture();
		await f.advance.tick();
		const cycle = f.cycle()!;
		f.db
			.prepare("UPDATE customer_release_cycles SET state=? WHERE cycle_id=?")
			.run(phase, cycle.cycleId);
		f.db
			.prepare(
				"INSERT INTO customer_release_decisions(decision_id,cycle_id,attempt_id,attempt_json,permit_json,claimed_at) VALUES (?,?,?,?,?,?)",
			)
			.run(
				"decision",
				cycle.cycleId,
				"attempt",
				"{}",
				JSON.stringify({ manualRequestId: "founder-go" }),
				at,
			);
		f.context.flagEnabled = false;
		await f.advance.tick();
		expect(f.cycle()?.state).toBe(phase);
		expect(f.cycle()?.invalidatedEventSeq).toBeNull();
		f.store.invalidateRuntime("gateway_unavailable", at);
		expect(f.cycle()?.state).toBe(phase);
		expect(f.cycle()?.invalidatedEventSeq).not.toBeNull();
	},
);

it.each(["manual_ready", "window_open"])(
	"automatic schedule failure preserves manual work and cancels automatic work (%s)",
	async (state) => {
		const f = fixture();
		await f.advance.tick();
		const cycle = f.cycle()!;
		if (state === "manual_ready")
			f.db
				.prepare(
					"UPDATE customer_release_cycles SET state='manual_ready' WHERE cycle_id=?",
				)
				.run(cycle.cycleId);
		f.context.config.timezone = "invalid/timezone";
		f.transport.dispatch.mockClear();
		f.discord.send.mockClear();
		await f.advance.tick();
		expect(f.cycle()?.state).toBe(
			state === "manual_ready" ? "manual_ready" : "cancelled",
		);
		expect(f.cycle()?.cancelReason).toBe(
			state === "manual_ready" ? null : "automatic_advance_failed",
		);
		expect(f.transport.dispatch).not.toHaveBeenCalled();
		expect(f.discord.send).not.toHaveBeenCalled();
	},
);
