import type Database from "better-sqlite3";
import { payloadObjectKey } from "flywheel-release-contract";
import { afterEach, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { CustomerReleaseDecisionPump } from "../customer-release/pump.js";

import { seedReleaseActivation } from "./customer-release-activation-fixture.js";

const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
const sha = "a".repeat(40),
	betaHash = "b".repeat(64),
	hash = "d".repeat(64),
	policyRevision = "c".repeat(64);
const start = Date.parse("2026-09-15T15:00:00.000Z"),
	now = start + 4 * 3600_000;
const founder = "423456789012345678";
async function setup() {
	const state = await StateStore.create(":memory:");
	stores.push(state);
	const db = (state as unknown as { db: { raw: Database.Database } }).db.raw;
	const store = state.customerReleases;
	const manifest = {
		versions: {
			"1.2.3-beta.1": {
				channel: "beta",
				status: "active",
				sourceCommit: sha,
				sha256: betaHash,
			},
		},
		releaseOps: {
			r1: {
				kind: "release",
				state: "prepared",
				ver: "1.2.3",
				sourceCommit: sha,
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
		policyRevision,
		betaVersion: "1.2.3-beta.1",
		manifest,
		now: start,
	});
	const id = cycle.cycleId;
	db.prepare(
		"UPDATE customer_release_cycles SET state='preparing',revision=1 WHERE cycle_id=?",
	).run(id);
	const notice = {
		noticeId: "1".repeat(32),
		messageDigest: "2".repeat(64),
		channelId: "123456789012345678",
		applicationId: "223456789012345678",
		botUserId: "323456789012345678",
		founderId: founder,
		noticeAt: start,
		deadlineAt: now,
		claimNotAfter: now + 3600_000,
		minimumVetoMinutes: 120,
	};
	store.completePreparation(
		id,
		1,
		manifest,
		{ workflowRunId: "1234", equivalenceVerified: true, readbackSha256: hash },
		notice,
		start,
	);
	store.startNotice(id, start);
	const delivery = {
		...notice,
		messageId: "523456789012345678",
		verifiedAt: start,
		accessVerified: true,
		gatewayHealthy: true,
	};
	store.openWindow(id, delivery, start);
	let count = 0;
	const evaluate = () => {
		const verdictId = `rr-${++count}`;
		db.prepare(
			"INSERT INTO release_readiness_verdicts VALUES (?,?,?,?,'green','[]','{}','{}',?)",
		).run(verdictId, sha, "1.2.3", sha, new Date(now).toISOString());
		return verdictId;
	};
	const probe = { ...delivery, verifiedAt: now };
	store.awaitAttempt(id, 3, probe, now, evaluate);
	seedReleaseActivation(db, {
		founderId: founder,
		policyRevision,
		audience: "payload-flywheel",
		now: start,
	});
	const authority = () => ({
		mode: "canary",
		enabled: true,
		enableReceiptValid: true,
		sourcesHealthy: true,
		evidenceBundleDigest: "e".repeat(64),
		activationEpoch: 1,
		policyRevision,
		founderId: founder,
		enableReceiptId: "enable-1",
		audience: "payload-flywheel",
	});
	const attempt = {
		attemptId: "3".repeat(32),
		nonce: "4".repeat(64),
		audience: "payload-flywheel",
		projectId: "flywheel",
		activationEpoch: 1,
		cycleId: id,
		fullBinding: store.get(id)!.binding!,
		readbackSha256: hash,
		baseEtag: "etag-1",
		readyAt: now,
	};
	const claim = (
		attemptInput = attempt,
		receipt = probe,
		at = now,
		evaluateInput = evaluate,
		authorityInput: () => ReturnType<typeof authority> = authority,
	) =>
		store.claimAuto(
			id,
			4,
			attemptInput,
			manifest,
			receipt,
			at,
			authorityInput,
			evaluateInput,
		);
	return {
		db,
		store,
		id,
		attempt,
		probe,
		authority,
		evaluate,
		claim,
		manifest,
	};
}

it("T11 persists one exact permit and replays identical bytes without reevaluating", async () => {
	const f = await setup();
	const decision = f.claim(f.attempt, f.probe, now, f.evaluate, f.authority)!;
	expect(decision).toMatchObject({
		attemptId: f.attempt.attemptId,
		nonce: f.attempt.nonce,
		fullBinding: f.attempt.fullBinding,
		trigger: "silence_auto",
		claimedAt: now,
		notAfter: now + 30_000,
		baseEtag: "etag-1",
	});
	expect(f.store.get(f.id)?.state).toBe("committing");
	expect(
		f.claim(
			f.attempt,
			f.probe,
			now + 1,
			() => {
				throw new Error("must not reevaluate replay");
			},
			f.authority,
		),
	).toEqual(decision);
	expect(
		f.db.prepare("SELECT count(*) AS n FROM customer_release_decisions").get(),
	).toEqual({ n: 1 });
});

it.each(["off", "flag", "epoch", "policy", "founder", "receipt", "audience"])(
	"T11 denies invalid activation %s",
	async (kind) => {
		const f = await setup();
		const value = f.authority();
		const changed = {
			...value,
			...(kind === "off"
				? { mode: "off" }
				: kind === "flag"
					? { enabled: false }
					: kind === "epoch"
						? { activationEpoch: 2 }
						: kind === "policy"
							? { policyRevision: "f".repeat(64) }
							: kind === "founder"
								? { founderId: "723456789012345678" }
								: kind === "audience"
									? { audience: "other" }
									: { enableReceiptId: "missing" }),
		};
		expect(
			f.claim(f.attempt, f.probe, now, f.evaluate, () => changed),
		).toBeNull();
		expect(
			f.db
				.prepare("SELECT count(*) AS n FROM customer_release_decisions")
				.get(),
		).toEqual({ n: 0 });
	},
);
it.each(["hash", "nonce", "epoch", "audience", "project", "stale", "future"])(
	"T11 rejects an invalid ready attempt %s",
	async (kind) => {
		const f = await setup();
		const attempt = {
			...f.attempt,
			...(kind === "hash"
				? {
						fullBinding: {
							...f.attempt.fullBinding,
							releasePayloadSha256: betaHash,
						},
					}
				: kind === "nonce"
					? { nonce: "" }
					: kind === "epoch"
						? { activationEpoch: 2 }
						: kind === "audience"
							? { audience: "other" }
							: kind === "project"
								? { projectId: "other" }
								: { readyAt: now + (kind === "future" ? 5001 : -30_001) }),
		};
		expect(f.claim(attempt, f.probe, now, f.evaluate, f.authority)).toBeNull();
	},
);
it("T11 accepts neither a stale delivery proof nor an expired cycle", async () => {
	for (const expired of [false, true]) {
		const f = await setup();
		expect(
			f.claim(
				f.attempt,
				expired ? f.probe : { ...f.probe, verifiedAt: start },
				expired ? now + 3600_001 : now,
				f.evaluate,
				f.authority,
			),
		).toBeNull();
	}
});
it("T11 a negative event during fresh evaluation wins over green and prevents the permit", async () => {
	const f = await setup();
	expect(
		f.claim(
			f.attempt,
			f.probe,
			now,
			() => {
				f.store.invalidate(
					f.id,
					f.store.get(f.id)!.revision,
					"source_unknown",
					now,
				);
				return f.evaluate();
			},
			f.authority,
		),
	).toBeNull();
	expect(f.store.get(f.id)?.state).toBe("cancelled");
});
it("T11 refuses hold/unknown at execution time even though T10 was green", async () => {
	for (const state of ["hold", "unknown"]) {
		const f = await setup();
		expect(
			f.claim(
				f.attempt,
				f.probe,
				now,
				() => {
					const id = f.evaluate();
					f.db
						.prepare(
							"UPDATE release_readiness_verdicts SET state=? WHERE verdict_id=?",
						)
						.run(state, id);
					return id;
				},
				f.authority,
			),
		).toBeNull();
	}
});
it("T11 audit failure rolls back cycle, decision and fresh verdict together", async () => {
	const f = await setup();
	f.db.exec(
		"CREATE TRIGGER fail_claim BEFORE INSERT ON customer_release_events WHEN NEW.kind='release_claimed' BEGIN SELECT RAISE(ABORT,'injected claim failure'); END",
	);
	expect(() =>
		f.claim(f.attempt, f.probe, now, f.evaluate, f.authority),
	).toThrow("injected claim failure");
	expect(f.store.get(f.id)?.state).toBe("awaiting_attempt");
	expect(
		f.db.prepare("SELECT count(*) AS n FROM customer_release_decisions").get(),
	).toEqual({ n: 0 });
});

async function claimed() {
	const f = await setup();
	const permit = f.claim()!;
	const result = {
		attemptId: permit.attemptId,
		decisionId: permit.decisionId,
		nonce: permit.nonce,
		baseEtag: permit.baseEtag,
		kind: "unknown" as const,
	};
	const terminalManifest = (opState: string) => ({
		releaseOps: {
			r1: {
				kind: "release",
				state: opState,
				ver: "1.2.3",
				sourceCommit: sha,
				sha256: hash,
				betaVersion: "1.2.3-beta.1",
				objectKey: payloadObjectKey("1.2.3", hash),
			},
		},
		versions: {
			"1.2.3": {
				channel: "release",
				status: "withdrawn",
				sourceCommit: sha,
				sha256: hash,
			},
		},
	});
	return { ...f, permit, result, terminalManifest };
}
it("T14 unknown remains unresolved after expiry and never authorizes another attempt", async () => {
	const f = await claimed();
	expect(f.store.recordAttemptResult(f.id, f.result, now + 60_000)).toBe(
		"commit_unknown",
	);
	expect(f.store.recordAttemptResult(f.id, f.result, now + 120_000)).toBe(
		"commit_unknown",
	);
	expect(
		f.store.claimAuto(
			f.id,
			f.store.get(f.id)!.revision,
			{ ...f.attempt, attemptId: "new" },
			{},
			f.probe,
			now,
			f.authority,
			f.evaluate,
		),
	).toBeNull();
	expect(
		f.store.events(f.id).filter((e) => e.kind === "commit_unknown"),
	).toHaveLength(1);
});
it.each([false, true])(
	"T12/T15 exact committed op proves publication even after withdrawal; unknown=%s",
	async (unknown) => {
		const f = await claimed();
		if (unknown) f.store.recordAttemptResult(f.id, f.result, now + 1);
		const result = {
			...f.result,
			kind: "published" as const,
			manifest: f.terminalManifest("committed"),
			manifestEtag: "after",
		};
		expect(f.store.recordAttemptResult(f.id, result, now + 60_000)).toBe(
			"published",
		);
		expect(f.store.recordAttemptResult(f.id, result, now + 120_000)).toBe(
			"published",
		);
		expect(
			f.store.events(f.id).filter((e) => e.kind === "release_published"),
		).toHaveLength(1);
	},
);
it("T16 exact abandon fences the unknown attempt without treating prepared as stopped", async () => {
	const f = await claimed();
	f.store.recordAttemptResult(f.id, f.result, now);
	expect(() =>
		f.store.recordAttemptResult(
			f.id,
			{
				...f.result,
				kind: "fenced",
				manifest: f.terminalManifest("prepared"),
				manifestEtag: "after",
			},
			now,
		),
	).toThrow();
	expect(f.store.get(f.id)?.state).toBe("commit_unknown");
	expect(
		f.store.recordAttemptResult(
			f.id,
			{
				...f.result,
				kind: "fenced",
				manifest: f.terminalManifest("abandoned"),
				manifestEtag: "after",
			},
			now,
		),
	).toBe("cancelled");
});
it.each([false, true])(
	"T13 no_write retry respects sticky post-claim negative=%s",
	async (negative) => {
		const f = await claimed();
		if (negative)
			f.store.invalidate(
				f.id,
				f.store.get(f.id)!.revision,
				"source_unknown",
				now,
			);
		expect(
			f.store.recordAttemptResult(
				f.id,
				{ ...f.result, kind: "no_write", reason: "cas_conflict" },
				now,
			),
		).toBe(negative ? "cancelled" : "awaiting_attempt");
		expect(f.store.get(f.id)?.windowOpenedAt).toBe(start);
	},
);
it("T12 rejects wrong tuple and nonce without losing unresolved state", async () => {
	const f = await claimed();
	const manifest = f.terminalManifest("committed");
	manifest.releaseOps.r1.sha256 = betaHash;
	for (const result of [
		{ ...f.result, nonce: "other" },
		{
			...f.result,
			kind: "published" as const,
			manifest,
			manifestEtag: "after",
		},
	]) {
		expect(() => f.store.recordAttemptResult(f.id, result, now)).toThrow();
	}
	expect(f.store.get(f.id)?.state).toBe("committing");
});
it("T12 result audit failure rolls back publication and allows exact recovery", async () => {
	const f = await claimed();
	f.db.exec(
		"CREATE TRIGGER fail_result BEFORE INSERT ON customer_release_events WHEN NEW.kind='release_published' BEGIN SELECT RAISE(ABORT,'result event failure'); END",
	);
	expect(() =>
		f.store.recordAttemptResult(
			f.id,
			{
				...f.result,
				kind: "published",
				manifest: f.terminalManifest("committed"),
				manifestEtag: "after",
			},
			now,
		),
	).toThrow("result event failure");
	expect(f.store.get(f.id)?.state).toBe("committing");
});

it("T13 permits only three fresh retries and old results cannot reset a new claim", async () => {
	const f = await claimed();
	let permit = f.permit;
	const old = {
		...f.result,
		kind: "no_write" as const,
		reason: "cas_conflict" as const,
	};
	for (let i = 0; i < 4; i++) {
		const result = {
			...old,
			attemptId: permit.attemptId,
			decisionId: permit.decisionId,
		};
		expect(f.store.recordAttemptResult(f.id, result, now)).toBe(
			i < 3 ? "awaiting_attempt" : "cancelled",
		);
		if (i === 3) break;
		permit = f.store.claimAuto(
			f.id,
			f.store.get(f.id)!.revision,
			{ ...f.attempt, attemptId: `retry-${i}` },
			f.manifest,
			f.probe,
			now,
			f.authority,
			f.evaluate,
		)!;
		expect(permit).not.toBeNull();
		f.store.recordAttemptResult(f.id, old, now);
		expect(f.store.get(f.id)?.state).toBe("committing");
	}
	expect(f.store.get(f.id)?.cancelReason).toBe("retry_exhausted");
	expect(
		f.store.events(f.id).filter((e) => e.kind === "window_opened"),
	).toHaveLength(1);
});
it("T13 a new attempt requires fresh green after confirmed zero write", async () => {
	const f = await claimed();
	f.store.recordAttemptResult(
		f.id,
		{ ...f.result, kind: "no_write", reason: "guard_rejected" },
		now,
	);
	expect(
		f.store.claimAuto(
			f.id,
			f.store.get(f.id)!.revision,
			{ ...f.attempt, attemptId: "retry" },
			f.manifest,
			f.probe,
			now,
			f.authority,
			() => {
				const verdictId = f.evaluate();
				f.db
					.prepare(
						"UPDATE release_readiness_verdicts SET state='unknown' WHERE verdict_id=?",
					)
					.run(verdictId);
				return verdictId;
			},
		),
	).toBeNull();
	expect(f.store.get(f.id)?.state).toBe("cancelled");
});

async function manualFixture() {
	const f = await setup();
	f.store.cancel(f.id, f.store.get(f.id)!.revision, "readiness_hold", now);
	const manifest = {
		...f.manifest,
		releaseOps: {
			...f.manifest.releaseOps,
			manual1: { ...f.manifest.releaseOps.r1 },
		},
	};
	const card = {
		requestId: "9".repeat(32),
		activationEpoch: 1,
		policyRevision,
		releaseId: "manual1",
		channelId: f.probe.channelId,
		applicationId: f.probe.applicationId,
		botUserId: f.probe.botUserId,
		founderId: founder,
		messageDigest: "8".repeat(64),
		expiresAt: now + 3600_000,
	};
	const prepare = () =>
		f.store.manual.prepare(
			f.id,
			manifest,
			{
				workflowRunId: "1234",
				equivalenceVerified: true,
				readbackSha256: hash,
			},
			card,
			now,
		);
	const delivery = {
		messageId: "923456789012345678",
		messageDigest: card.messageDigest,
		channelId: card.channelId,
		applicationId: card.applicationId,
		botUserId: card.botUserId,
		founderId: founder,
		verifiedAt: now,
		accessVerified: true,
		gatewayHealthy: true,
	};
	const action = {
		interactionId: "823456789012345678",
		actorId: founder,
		requestId: card.requestId,
		messageId: delivery.messageId,
		applicationId: card.applicationId,
		channelId: card.channelId,
	};
	return { ...f, manifest, card, prepare, delivery, action };
}
it("T17 manual go binds a new request while preserving the original auto binding and consumed window", async () => {
	const f = await manualFixture();
	const before = f.store.get(f.id)!;
	const request = f.prepare();
	expect(request.binding.releaseId).toBe("manual1");
	expect(f.store.get(f.id)).toEqual(before);
	expect(
		f.store.manual.go(f.card.requestId, f.action, f.delivery, founder, now),
	).toMatchObject({ result: "manual_ready", actorId: founder });
	expect(f.store.get(f.id)).toMatchObject({
		state: "manual_ready",
		binding: before.binding,
		windowOpenedAt: before.windowOpenedAt,
		invalidatedEventSeq: before.invalidatedEventSeq,
	});
	expect(
		f.store.manual.go(f.card.requestId, f.action, f.delivery, founder, now + 1),
	).toEqual(
		f.store.manual.go(f.card.requestId, f.action, f.delivery, founder, now),
	);
});
it.each(["actor", "founder", "message", "digest", "app", "access", "expired"])(
	"T17 rejects %s without accepting manual go",
	async (kind) => {
		const f = await manualFixture();
		f.prepare();
		const action = {
			...f.action,
			...(kind === "actor"
				? { actorId: "723456789012345678" }
				: kind === "message"
					? { messageId: "723456789012345678" }
					: kind === "app"
						? { applicationId: "723456789012345678" }
						: {}),
		};
		const delivery = {
			...f.delivery,
			...(kind === "digest"
				? { messageDigest: "f".repeat(64) }
				: kind === "access"
					? { accessVerified: false }
					: {}),
		};
		expect(() =>
			f.store.manual.go(
				f.card.requestId,
				action,
				delivery,
				kind === "founder" ? null : founder,
				kind === "expired" ? f.card.expiresAt : now,
			),
		).toThrow();
		expect(f.store.get(f.id)?.state).toBe("cancelled");
	},
);
it("T17 refuses the abandoned auto releaseId and bad prepared artifact", async () => {
	const f = await manualFixture();
	for (const mode of ["old", "hash"]) {
		expect(() =>
			f.store.manual.prepare(
				f.id,
				f.manifest,
				{
					workflowRunId: "1234",
					equivalenceVerified: true,
					readbackSha256: mode === "hash" ? betaHash : hash,
				},
				{ ...f.card, releaseId: mode === "old" ? "r1" : "manual1" },
				now,
			),
		).toThrow();
	}
});
it("T17 manual action persistence failure rolls back readiness and actor receipt", async () => {
	const f = await manualFixture();
	f.prepare();
	f.db.exec(
		"CREATE TRIGGER fail_manual BEFORE INSERT ON customer_release_actions WHEN NEW.action='go' BEGIN SELECT RAISE(ABORT,'manual action failure'); END",
	);
	expect(() =>
		f.store.manual.go(f.card.requestId, f.action, f.delivery, founder, now),
	).toThrow("manual action failure");
	expect(f.store.get(f.id)?.state).toBe("cancelled");
});

it("T17 a replacement manual card never inherits the previous go", async () => {
	const f = await manualFixture();
	f.prepare();
	f.store.manual.go(f.card.requestId, f.action, f.delivery, founder, now);
	f.store.cancel(
		f.id,
		f.store.get(f.id)!.revision,
		"manual_execution_failed",
		now,
	);
	const manifest = {
		...f.manifest,
		releaseOps: {
			...f.manifest.releaseOps,
			manual2: { ...f.manifest.releaseOps.manual1 },
		},
	};
	const card = { ...f.card, requestId: "7".repeat(32), releaseId: "manual2" };
	f.store.manual.prepare(
		f.id,
		manifest,
		{ workflowRunId: "1234", equivalenceVerified: true, readbackSha256: hash },
		card,
		now,
	);
	expect(f.store.manual.get(card.requestId)?.status).toBe("waiting");
	expect(f.store.get(f.id)?.state).toBe("cancelled");
	f.store.manual.go(f.card.requestId, f.action, f.delivery, founder, now);
	expect(f.store.get(f.id)?.state).toBe("cancelled");
});
it("T17 manual preparation works after cancellation before any auto artifact existed", async () => {
	const f = await manualFixture();
	const cycle = f.store.reserve({
		projectId: "other-project",
		slotDate: "2026-09-15",
		releaseId: "never-prepared",
		activationEpoch: 1,
		policyRevision,
		betaVersion: "1.2.3-beta.1",
		manifest: f.manifest,
		now,
	});
	f.store.cancel(cycle.cycleId, 0, "readiness_hold", now);
	const request = f.store.manual.prepare(
		cycle.cycleId,
		f.manifest,
		{ workflowRunId: "1234", equivalenceVerified: true, readbackSha256: hash },
		f.card,
		now,
	);
	expect(request.binding.releaseId).toBe("manual1");
	expect(f.store.get(cycle.cycleId)?.binding).toBeNull();
});

it("T17 release identity cannot be shared between independent auto and manual requests", async () => {
	for (const manualFirst of [false, true]) {
		const f = await manualFixture();
		const reserve = () =>
			f.store.reserve({
				projectId: "other",
				slotDate: "2026-09-15",
				releaseId: "manual1",
				activationEpoch: 1,
				policyRevision,
				betaVersion: "1.2.3-beta.1",
				manifest: f.manifest,
				now,
			});
		if (manualFirst) {
			f.prepare();
			expect(reserve).toThrow("release identity already reserved");
		} else {
			reserve();
			expect(f.prepare).toThrow("release identity already reserved");
		}
	}
});

async function manualReady() {
	const f = await manualFixture();
	f.prepare();
	f.store.manual.go(f.card.requestId, f.action, f.delivery, founder, now);
	const attempt = {
		...f.attempt,
		attemptId: "manual-attempt",
		fullBinding: f.store.manual.get(f.card.requestId)!.binding,
	};
	const authority = () => ({
		founderId: founder,
		projectId: "flywheel",
		audience: attempt.audience,
		activationEpoch: 1,
		policyRevision,
		executionEnabled: true,
	});
	const claim = (evaluate = f.evaluate) =>
		f.store.manual.claim(
			f.card.requestId,
			attempt,
			f.manifest,
			now,
			authority,
			evaluate,
		);
	return { ...f, attempt, authority, claim };
}
it.each(["green", "hold", "unknown"])(
	"T18 manual %s persists the actor and original readiness without rewriting auto identity",
	async (readiness) => {
		const f = await manualReady();
		const permit = f.claim(() => {
			const id = f.evaluate();
			f.db
				.prepare(
					"UPDATE release_readiness_verdicts SET state=?,reasons_json=? WHERE verdict_id=?",
				)
				.run(readiness, '["operator_review"]', id);
			return id;
		});
		expect(permit).toMatchObject({
			trigger: readiness === "green" ? "founder_go" : "founder_override",
			actor: founder,
			manualRequestId: f.card.requestId,
			readiness: { state: readiness, reasons: ["operator_review"] },
			fullBinding: { releaseId: "manual1" },
		});
		expect(f.store.get(f.id)?.binding?.releaseId).toBe("r1");
		expect(
			f.claim(() => {
				throw new Error("no repeat evaluation");
			}),
		).toEqual(permit);
	},
);
it.each(["hash", "beta", "actor", "epoch", "disabled", "stale"])(
	"T18 founder go does not override %s",
	async (kind) => {
		const f = await manualReady();
		if (kind === "hash") f.attempt.readbackSha256 = betaHash;
		if (kind === "beta")
			f.manifest.versions["1.2.3-beta.1"].status = "withdrawn";
		const authority = {
			...f.authority(),
			...(kind === "actor"
				? { founderId: "other" }
				: kind === "epoch"
					? { activationEpoch: 2 }
					: kind === "disabled"
						? { executionEnabled: false }
						: {}),
		};
		expect(
			f.store.manual.claim(
				f.card.requestId,
				f.attempt,
				f.manifest,
				kind === "stale" ? now + 3600_000 : now,
				() => authority,
				f.evaluate,
			),
		).toBeNull();
	},
);
it("T18 cancellation during evidence collection wins over manual override", async () => {
	const f = await manualReady();
	expect(
		f.claim(() => {
			f.store.cancel(f.id, f.store.get(f.id)!.revision, "founder_veto", now);
			return f.evaluate();
		}),
	).toBeNull();
	expect(f.store.get(f.id)?.state).toBe("cancelled");
});
it("T18 manual no-write returns to manual readiness but post-claim veto requires a new go", async () => {
	for (const negative of [false, true]) {
		const f = await manualReady();
		const permit = f.claim()!;
		if (negative)
			f.store.invalidate(
				f.id,
				f.store.get(f.id)!.revision,
				"founder_veto",
				now,
			);
		expect(
			f.store.recordAttemptResult(
				f.id,
				{
					attemptId: permit.attemptId,
					decisionId: permit.decisionId,
					nonce: permit.nonce,
					baseEtag: permit.baseEtag,
					kind: "no_write",
					reason: "cas_conflict",
				},
				now,
			),
		).toBe(negative ? "cancelled" : "manual_ready");
	}
});

it("T18 requires the durable go action, not just an accepted request state", async () => {
	const f = await manualReady();
	f.db.prepare("DELETE FROM customer_release_actions WHERE action='go'").run();
	expect(f.claim()).toBeNull();
});
it("T18 manual artifact result is reconciled independently of the original auto artifact", async () => {
	const f = await manualReady();
	const permit = f.claim()!;
	const manifest = {
		...f.manifest,
		releaseOps: {
			...f.manifest.releaseOps,
			manual1: { ...f.manifest.releaseOps.manual1, state: "committed" },
		},
		versions: {
			...f.manifest.versions,
			"1.2.3": {
				channel: "release",
				status: "active",
				sha256: hash,
				sourceCommit: sha,
			},
		},
	};
	expect(
		f.store.recordAttemptResult(
			f.id,
			{
				attemptId: permit.attemptId,
				decisionId: permit.decisionId,
				nonce: permit.nonce,
				baseEtag: permit.baseEtag,
				kind: "published",
				manifest,
				manifestEtag: "after-manual",
			},
			now,
		),
	).toBe("published");
	expect(f.store.get(f.id)?.binding?.releaseId).toBe("r1");
});

it("runtime reads the durable unresolved permit across unknown and drops it only after terminal no-write evidence", async () => {
	const f = await setup();
	expect(f.store.unresolvedDecision("flywheel")).toBeNull();
	const permit = f.claim()!;
	expect(f.store.unresolvedDecision("flywheel")).toEqual(permit);
	expect(f.store.unresolvedDecision("other")).toBeNull();
	const result = {
		attemptId: permit.attemptId,
		decisionId: permit.decisionId,
		nonce: permit.nonce,
		baseEtag: permit.baseEtag,
		kind: "unknown" as const,
	};
	f.store.recordAttemptResult(f.id, result, now + 1);
	expect(f.store.unresolvedDecision("flywheel")).toEqual(permit);
	expect(f.store.hasPostClaimIntervention(permit)).toBe(false);
	f.store.invalidate(
		f.id,
		f.store.get(f.id)!.revision,
		"gateway_lost",
		now + 2,
	);
	expect(f.store.hasPostClaimIntervention(permit)).toBe(true);
	f.store.recordAttemptResult(
		f.id,
		{ ...result, kind: "no_write", reason: "guard_rejected" },
		now + 3,
	);
	expect(f.store.unresolvedDecision("flywheel")).toBeNull();
});

it("decision pump uses the real transaction and a veto arriving during the remote probe prevents delivery", async () => {
	for (const vetoDuringProbe of [false, true]) {
		const f = await setup();
		const delivered: unknown[] = [];
		const pump = new CustomerReleaseDecisionPump({
			store: f.store,
			mailbox: {
				pending: async () => ({ attempts: [f.attempt], cursor: null }),
				observe: async () => null,
				deliverPermit: async (permit) => {
					delivered.push(permit);
				},
				requestFence: async () => {
					throw new Error("unexpected fence");
				},
			},
			now: () => now,
			probe: async () => {
				if (vetoDuringProbe)
					f.store.invalidate(
						f.id,
						f.store.get(f.id)!.revision,
						"gateway_lost",
						now,
					);
				return { manifest: f.manifest, receipt: f.probe };
			},
			readActivation: f.authority,
			evaluate: f.evaluate,
		});
		expect(await pump.tick()).toBe(vetoDuringProbe ? "idle" : "claimed");
		expect(delivered).toHaveLength(vetoDuringProbe ? 0 : 1);
		expect(f.store.unresolvedDecision("flywheel")).toEqual(
			vetoDuringProbe ? null : delivered[0],
		);
	}
});

it("pump resolves the accepted manual request and claims its binding independently of the cancelled auto window", async () => {
	for (const invalidateDuringProbe of [false, true]) {
		const f = await manualReady();
		const delivered: unknown[] = [];
		const pump = new CustomerReleaseDecisionPump({
			store: f.store,
			mailbox: {
				pending: async () => ({ attempts: [f.attempt], cursor: null }),
				observe: async () => null,
				deliverPermit: async (permit) => {
					delivered.push(permit);
				},
				requestFence: async () => {},
			},
			now: () => now,
			probe: async () => {
				throw new Error("must not reuse auto-window delivery");
			},
			readActivation: () => {
				throw new Error("auto remains disabled");
			},
			evaluate: () => {
				throw new Error("manual frozen binding has its own evaluator");
			},
			manual: {
				probe: async () => {
					if (invalidateDuringProbe)
						f.store.invalidate(
							f.id,
							f.store.get(f.id)!.revision,
							"gateway_lost",
							now,
						);
					return f.manifest;
				},
				readAuthority: f.authority,
				evaluate: (request) => {
					expect(request.card.requestId).toBe(f.card.requestId);
					return f.evaluate();
				},
			},
		});
		expect(await pump.tick()).toBe(invalidateDuringProbe ? "idle" : "claimed");
		expect(delivered).toHaveLength(invalidateDuringProbe ? 0 : 1);
		if (!invalidateDuringProbe)
			expect(delivered[0]).toMatchObject({
				manualRequestId: f.card.requestId,
				trigger: "founder_go",
				actor: founder,
				fullBinding: f.attempt.fullBinding,
			});
	}
});

it("lifecycle invalidation retires an unclaimed manual go but preserves an exposed permit for recovery", async () => {
	for (const claimed of [false, true]) {
		const f = await manualReady();
		const permit = claimed ? f.claim()! : null;
		f.store.invalidateRuntime("runtime_stopping", now + 1);
		expect(f.store.get(f.id)?.state).toBe(claimed ? "committing" : "cancelled");
		expect(f.store.unresolvedDecision("flywheel")).toEqual(permit);
		if (permit) expect(f.store.hasPostClaimIntervention(permit)).toBe(true);
	}
	const f = await manualReady();
	f.store.recoverAfterRestart("flywheel", now + 1);
	expect(f.store.get(f.id)).toMatchObject({
		state: "cancelled",
		cancelReason: "bridge_restart",
	});
});

it("legacy cycle enable rows cannot substitute for the independent activation authority", async () => {
	const f = await setup();
	f.db.prepare("DELETE FROM customer_release_activation").run();
	f.db
		.prepare(
			"INSERT INTO customer_release_actions VALUES ('enable-1',?,'enable',?,'',?,'{}',?)",
		)
		.run(
			f.id,
			founder,
			JSON.stringify({
				projectId: "flywheel",
				policyRevision,
				activationEpoch: 1,
				evidenceBundleDigest: "e".repeat(64),
			}),
			start,
		);
	expect(f.claim()).toBeNull();
});

it("empty staged receipt cannot mint a permit; a matched durable receipt still requires flag-enabled authority", async () => {
	const staged = await setup();
	expect(
		staged.claim(staged.attempt, staged.probe, now, staged.evaluate, () => ({
			...staged.authority(),
			enableReceiptId: "",
			enableReceiptValid: false,
		})),
	).toBeNull();
	expect(staged.store.unresolvedDecision("flywheel")).toBeNull();
	const disabled = await setup();
	expect(
		disabled.claim(
			disabled.attempt,
			disabled.probe,
			now,
			disabled.evaluate,
			() => ({ ...disabled.authority(), enabled: false }),
		),
	).toBeNull();
	const enabled = await setup();
	const epoch = enabled.store.activation.get()!.epoch;
	expect(enabled.claim()?.trigger).toBe("silence_auto");
	expect(enabled.store.activation.get()!.epoch).toBe(epoch);
});

it("fence recovery acknowledges the exact endpoint intent before one durable workflow dispatch, including after restart", async () => {
	const { CustomerReleaseFenceRecovery } = await import(
		"../customer-release/fence-recovery.js"
	);
	const { CustomerReleaseDispatch } = await import(
		"../customer-release/dispatch.js"
	);
	const f = await setup();
	const permit = f.claim()!;
	expect(permit).toBeTruthy();
	const calls: string[] = [];
	const transport = {
		dispatch: async (
			_binding: unknown,
			request: { inputs: Record<string, string> },
		) => {
			calls.push("dispatch");
			expect(request.inputs).toEqual({
				operation: "fence",
				"cycle-id": permit.cycleId,
				"release-id": permit.fullBinding.releaseId,
				"binding-digest": (await import("node:crypto"))
					.createHash("sha256")
					.update(JSON.stringify(permit.fullBinding))
					.digest("hex"),
				"attempt-id": permit.attemptId,
			});
			return 1;
		},
		observe: async () => ({ runId: 1, state: "succeeded" as const }),
	};
	const workflow = {
		repository: "owner/repo",
		repositoryId: 1,
		workflowId: 2,
		workflowPath: ".github/workflows/payload-auto-release.yml",
		reviewedSha: sha,
	};
	const options = {
		store: f.store,
		mailbox: {
			requestFence: async () => {
				calls.push("intent");
			},
		},
		dispatch: new CustomerReleaseDispatch({
			store: f.store,
			transport,
			now: () => now,
		}),
		workflow,
		now: () => now,
	};
	const activeRecovery = new CustomerReleaseFenceRecovery(options);
	await activeRecovery.requestFence(permit, "release_intervention");
	await activeRecovery.requestFence(permit, "release_intervention");
	await new CustomerReleaseFenceRecovery(options).requestFence(
		permit,
		"release_intervention",
	);
	expect(calls).toEqual(["intent", "dispatch", "intent"]);
	expect(f.store.unresolvedDecision("flywheel")?.decisionId).toBe(
		permit.decisionId,
	);
});
it("fence intent ambiguity or substituted permit never starts a recovery workflow", async () => {
	const { CustomerReleaseFenceRecovery } = await import(
		"../customer-release/fence-recovery.js"
	);
	const f = await setup();
	const permit = f.claim()!;
	let dispatched = 0;
	const recovery = new CustomerReleaseFenceRecovery({
		store: f.store,
		mailbox: {
			requestFence: async () => {
				throw new Error("ambiguous endpoint intent");
			},
		},
		dispatch: {
			tick: async () => {
				dispatched++;
				return null;
			},
		},
		workflow: {
			repository: "owner/repo",
			repositoryId: 1,
			workflowId: 2,
			workflowPath: ".github/workflows/payload-auto-release.yml",
			reviewedSha: sha,
		},
		now: () => now,
	});
	await expect(
		recovery.requestFence(permit, "release_intervention"),
	).rejects.toThrow();
	await expect(
		recovery.requestFence(
			{ ...permit, decisionId: "other" },
			"release_intervention",
		),
	).rejects.toThrow();
	expect(dispatched).toBe(0);
});

it("manual card delivery persists before POST, recovers without resending, and supplies fresh proof for go", async () => {
	const { ManualReleaseCardDelivery } = await import(
		"../customer-release/manual-delivery.js"
	);
	const { releaseCard, releaseMessageDigest } = await import(
		"../customer-release/cards.js"
	);
	const f = await manualFixture();
	f.card.messageDigest = releaseMessageDigest(
		releaseCard({
			kind: "go",
			nonce: f.card.requestId,
			epoch: 1,
			timezone: "America/Los_Angeles",
			betaVersion: "1.2.3-beta.1",
			releaseVersion: "1.2.3",
			sourceCommit: sha,
			payloadSha256: hash,
			deadlineAt: f.card.expiresAt,
		}),
	);
	f.prepare();
	let posts = 0;
	const cache = new Map();
	const options = {
		store: f.store,
		target: () => ({
			epoch: 1,
			founderId: founder,
			applicationId: f.card.applicationId,
			channelId: f.card.channelId,
			botUserId: f.card.botUserId,
			guildId: "123456789012345678",
		}),
		timezone: () => "America/Los_Angeles",
		now: () => now,
		cache,
		transport: {
			send: async () => {
				posts++;
				expect(f.store.manual.deliveryIntent(f.card.requestId)).not.toBeNull();
				throw new Error("lost response");
			},
			findMessage: async () => f.action.messageId,
			verifyMessage: async () => ({
				...f.delivery,
				messageDigest: f.card.messageDigest,
				verifiedAt: now,
			}),
		},
	};
	await new ManualReleaseCardDelivery(options).tick();
	await new ManualReleaseCardDelivery(options).tick();
	expect(posts).toBe(1);
	expect(cache.get(f.card.requestId)).toMatchObject({
		messageDigest: f.card.messageDigest,
		verifiedAt: now,
	});

	const freshProbe = options.transport.verifyMessage;
	options.transport.verifyMessage = async () => ({
		...f.delivery,
		messageDigest: f.card.messageDigest,
		verifiedAt: now - 30001,
	});
	await new ManualReleaseCardDelivery(options).tick();
	expect(cache.has(f.card.requestId)).toBe(false);
	options.transport.verifyMessage = freshProbe;
	await new ManualReleaseCardDelivery(options).tick();
	expect(posts).toBe(1);
	f.store.manual.go(
		f.card.requestId,
		f.action,
		cache.get(f.card.requestId),
		founder,
		now,
	);
	expect(f.store.manual.get(f.card.requestId)?.status).toBe("accepted");
});

it("only accepted manual go dispatches its new artifact once, including after executor reconstruction", async () => {
	const { ManualReleaseExecutor } = await import(
		"../customer-release/manual-executor.js"
	);
	const { CustomerReleaseDispatch } = await import(
		"../customer-release/dispatch.js"
	);
	const f = await manualFixture();
	f.prepare();
	let posts = 0;
	const options = {
		store: f.store,
		authority: () => ({
			founderId: founder,
			projectId: "flywheel",
			audience: "payload-flywheel",
			activationEpoch: 1,
			policyRevision,
			executionEnabled: true,
		}),
		workflow: {
			repository: "owner/repo",
			repositoryId: 1,
			workflowId: 2,
			workflowPath: ".github/workflows/payload-auto-release.yml",
			reviewedSha: sha,
		},
		now: () => now,
		dispatch: new CustomerReleaseDispatch({
			store: f.store,
			now: () => now,
			transport: {
				dispatch: async (
					_workflow: unknown,
					request: { inputs: Record<string, string> },
				) => {
					posts++;
					expect(request.inputs["release-id"]).toBe("manual1");
					expect(request.inputs.operation).toBe("execute");
					return 1;
				},
				observe: async () => ({ runId: 1, state: "pending" as const }),
			},
		}),
	};
	await new ManualReleaseExecutor(options).tick();
	expect(posts).toBe(0);
	f.store.manual.go(f.card.requestId, f.action, f.delivery, founder, now);
	await new ManualReleaseExecutor(options).tick();
	await new ManualReleaseExecutor(options).tick();
	expect(posts).toBe(1);
	expect(f.store.unresolvedDecision("flywheel")).toBeNull();
});
it("manual execution loses eligibility after canonical owner drift and does not dispatch", async () => {
	const { ManualReleaseExecutor } = await import(
		"../customer-release/manual-executor.js"
	);
	const f = await manualFixture();
	f.prepare();
	f.store.manual.go(f.card.requestId, f.action, f.delivery, founder, now);
	let posts = 0;
	await new ManualReleaseExecutor({
		store: f.store,
		authority: () => ({
			founderId: "923456789012345678",
			projectId: "flywheel",
			audience: "payload-flywheel",
			activationEpoch: 1,
			policyRevision,
			executionEnabled: true,
		}),
		workflow: {
			repository: "owner/repo",
			repositoryId: 1,
			workflowId: 2,
			workflowPath: ".github/workflows/payload-auto-release.yml",
			reviewedSha: sha,
		},
		now: () => now,
		dispatch: {
			tick: async () => {
				posts++;
				return null;
			},
		},
	}).tick();
	expect(posts).toBe(0);
	expect(f.store.get(f.id)?.state).toBe("cancelled");
});

it.each(["prepare", "rebind"])(
	"manual %s trigger prepares a new card but never accepts go or mints a permit",
	async (operation) => {
		const { ManualReleasePreparation } = await import(
			"../customer-release/manual-preparation.js"
		);
		const { deriveVetoBinding } = await import("flywheel-release-contract");
		const f = await manualFixture();
		let posts = 0;
		const request = {
			schemaVersion: 1,
			operation,
			requestId: f.card.requestId,
			cycleId: f.id,
			releaseId: "manual1",
			epoch: 1,
			identityDigest: "d".repeat(64),
			requestedAt: now,
			expiresAt: now + 3600000,
			sourceBindingDigest:
				operation === "rebind"
					? (await import("node:crypto"))
							.createHash("sha256")
							.update(JSON.stringify(f.store.get(f.id)!.binding))
							.digest("hex")
					: null,
		};
		const snapshot: any = {
			config: { mode: "canary", timezone: "America/Los_Angeles" },
			identity: {
				identityDigest: "d".repeat(64),
				policyRevision,
				founderId: founder,
			},
			target: {
				epoch: 1,
				founderId: founder,
				applicationId: f.card.applicationId,
				channelId: f.card.channelId,
				botUserId: f.card.botUserId,
			},
		};
		const preparation = new ManualReleasePreparation({
			store: f.store,
			read: () => request,
			snapshot: () => snapshot,
			source: {
				manifest: async () => ({
					manifest: f.manifest as any,
					etag: '"etag"',
					observedAt: now,
				}),
				prepared: async () => ({
					binding: deriveVetoBinding(f.manifest as any, "manual1"),
					readbackSha256: hash,
				}),
			},
			dispatch: {
				tick: async (_id, _binding, dispatch) => {
					posts++;
					expect(dispatch.inputs.mode).toBe(operation);
					return { runId: 1234, state: "succeeded" };
				},
			},
			workflow: {
				repository: "owner/repo",
				repositoryId: 1,
				workflowId: 2,
				workflowPath: ".github/workflows/payload-promote.yml",
				reviewedSha: sha,
			},
			now: () => now,
		});
		await preparation.tick();
		await preparation.tick();
		expect(posts).toBe(1);
		expect(f.store.manual.get(f.card.requestId)?.status).toBe("waiting");
		expect(f.store.get(f.id)?.state).toBe("cancelled");
		expect(f.store.unresolvedDecision("flywheel")).toBeNull();
		request.requestId = "8".repeat(32);
		snapshot.config.mode = "observe";
		await preparation.tick();
		expect(posts).toBe(1);
		snapshot.config.mode = "canary";
		request.expiresAt = now;
		await preparation.tick();
		expect(posts).toBe(1);
	},
);
