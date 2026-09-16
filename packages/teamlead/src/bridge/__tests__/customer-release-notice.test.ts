import Database from "better-sqlite3";
import { payloadObjectKey } from "flywheel-release-contract";
import { afterEach, expect, it } from "vitest";
import { CustomerReleaseStore } from "../customer-release/store.js";
import { seedReleaseActivation } from "./customer-release-activation-fixture.js";

const now = Date.parse("2026-09-15T15:00:00.000Z");
const sha = "a".repeat(40),
	hash = "b".repeat(64),
	cleanHash = "d".repeat(64);
const manifest = {
	versions: {
		"1.2.3-beta.1": {
			channel: "beta",
			status: "active",
			sourceCommit: sha,
			sha256: hash,
		},
	},
	releaseOps: {
		"release-1": {
			kind: "release",
			state: "prepared",
			ver: "1.2.3",
			sourceCommit: sha,
			sha256: cleanHash,
			objectKey: payloadObjectKey("1.2.3", cleanHash),
			betaVersion: "1.2.3-beta.1",
		},
	},
};
const intent = {
	noticeId: "1".repeat(32),
	messageDigest: "2".repeat(64),
	channelId: "123456789012345678",
	applicationId: "223456789012345678",
	botUserId: "323456789012345678",
	founderId: "423456789012345678",
	noticeAt: now,
	deadlineAt: now + 4 * 3600_000,
	claimNotAfter: now + 5 * 3600_000,
	minimumVetoMinutes: 120,
};
const proof = {
	workflowRunId: "1234",
	equivalenceVerified: true,
	readbackSha256: cleanHash,
};
const databases: Database.Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function setup() {
	const db = new Database(":memory:");
	databases.push(db);
	const store = new CustomerReleaseStore(db);
	store.migrate();
	const cycle = store.reserve({
		projectId: "flywheel",
		slotDate: "2026-09-15",
		releaseId: "release-1",
		activationEpoch: 1,
		policyRevision: "c".repeat(64),
		betaVersion: "1.2.3-beta.1",
		manifest,
		now,
	});
	// T03 has dedicated persisted-verdict tests; this fixture starts after that transaction.
	db.prepare(
		"UPDATE customer_release_cycles SET state='preparing',revision=1 WHERE cycle_id=?",
	).run(cycle.cycleId);
	return { db, store, id: cycle.cycleId };
}
function prepared() {
	const context = setup();
	expect(
		context.store.completePreparation(
			context.id,
			1,
			manifest,
			proof,
			intent,
			now,
		),
	).toBe(true);
	return context;
}
function delivery() {
	return {
		messageId: "523456789012345678",
		...intent,
		verifiedAt: now,
		accessVerified: true,
		gatewayHealthy: true,
	};
}

it("T04 atomically freezes the final artifact and exactly one notice intent", () => {
	const { store, id } = prepared();
	expect(store.get(id)).toMatchObject({
		state: "notice_pending",
		binding: { releasePayloadSha256: cleanHash, betaPayloadSha256: hash },
		revision: 2,
	});
	expect(store.notice(id)).toMatchObject({
		...intent,
		sendState: "intent",
		messageId: null,
	});
	expect(
		store.completePreparation(
			id,
			1,
			manifest,
			proof,
			{ ...intent, noticeId: "9".repeat(32) },
			now,
		),
	).toBe(false);
	expect(store.notice(id)?.noticeId).toBe(intent.noticeId);
});

it.each([
	{ readbackSha256: hash },
	{ equivalenceVerified: false },
	{ workflowRunId: "" },
])("T05 cancels invalid preparation evidence %j", (patch) => {
	const { store, id } = setup();
	expect(
		store.completePreparation(
			id,
			1,
			manifest,
			{ ...proof, ...patch },
			intent,
			now,
		),
	).toBe(false);
	expect(store.get(id)?.state).toBe("cancelled");
	expect(store.notice(id)).toBeNull();
});

it("T05 rejects candidate drift and insufficient remaining time without publishing a notice", () => {
	for (const late of [false, true]) {
		const { store, id } = setup();
		const changed = structuredClone(manifest);
		if (!late) changed.versions["1.2.3-beta.1"].sha256 = "e".repeat(64);
		expect(
			store.completePreparation(
				id,
				1,
				changed,
				proof,
				intent,
				late ? intent.deadlineAt - 60_000 : now,
			),
		).toBe(false);
		expect(store.notice(id)).toBeNull();
		expect(store.get(id)?.state).toBe("cancelled");
	}
});

it("T06 starts one send at the scheduled time and opens once only with an exact verified delivery", () => {
	const { store, id } = prepared();
	expect(store.startNotice(id, now - 1)).toBe(false);
	expect(store.startNotice(id, now)).toBe(true);
	expect(store.startNotice(id, now)).toBe(false);
	expect(store.openWindow(id, delivery(), now)).toBe(true);
	expect(store.get(id)).toMatchObject({
		state: "window_open",
		windowOpenedAt: now,
		deadlineAt: intent.deadlineAt,
	});
	expect(store.notice(id)).toMatchObject({
		sendState: "delivered",
		messageId: delivery().messageId,
	});
	expect(store.openWindow(id, delivery(), now + 1)).toBe(false);
	expect(
		store.events(id).filter((event) => event.kind === "window_opened"),
	).toHaveLength(1);
});

it("T07 ambiguous send can only recover the original intent, never send again", () => {
	const { store, id } = prepared();
	store.startNotice(id, now);
	expect(store.markNoticeUncertain(id)).toBe(true);
	expect(store.startNotice(id, now + 1)).toBe(false);
	expect(store.openWindow(id, delivery(), now)).toBe(true);
});

it.each([
	{ channelId: "623456789012345678" },
	{ applicationId: "623456789012345678" },
	{ botUserId: "623456789012345678" },
	{ founderId: "623456789012345678" },
	{ messageDigest: "f".repeat(64) },
	{ noticeId: "3".repeat(32) },
	{ accessVerified: false },
	{ gatewayHealthy: false },
	{ messageId: "" },
	{ verifiedAt: now - 30_001 },
	{ verifiedAt: now + 1 },
	{ deadlineAt: intent.deadlineAt + 1 },
])(
	"T07 rejects unusable delivery %j and cannot reopen after recovery",
	(patch) => {
		const { store, id } = prepared();
		store.startNotice(id, now);
		expect(store.openWindow(id, { ...delivery(), ...patch }, now)).toBe(false);
		expect(store.get(id)?.state).toBe("cancelled");
		expect(store.openWindow(id, delivery(), now)).toBe(false);
	},
);

it("T07 late receipt cannot shorten the minimum window", () => {
	const { store, id } = prepared();
	store.startNotice(id, now);
	const late = intent.deadlineAt - 120 * 60_000 + 1;
	expect(store.openWindow(id, { ...delivery(), verifiedAt: late }, late)).toBe(
		false,
	);
	expect(store.get(id)?.windowOpenedAt).toBeNull();
});

it("T04 audit failure rolls back both binding and notice intent", () => {
	const { db, store, id } = setup();
	db.exec(
		"CREATE TRIGGER fail_prepared BEFORE INSERT ON customer_release_events WHEN NEW.kind='artifact_prepared' BEGIN SELECT RAISE(ABORT,'injected prepare receipt failure'); END",
	);
	expect(() =>
		store.completePreparation(id, 1, manifest, proof, intent, now),
	).toThrow("injected prepare receipt failure");
	expect(store.get(id)).toMatchObject({ state: "preparing", binding: null });
	expect(store.notice(id)).toBeNull();
});

it("T06 failed audit commits no delivery receipt and cannot rewrite a frozen deadline", () => {
	const { db, store, id } = prepared();
	store.startNotice(id, now);
	db.exec(
		"CREATE TRIGGER fail_window BEFORE INSERT ON customer_release_events WHEN NEW.kind='window_opened' BEGIN SELECT RAISE(ABORT,'injected window failure'); END",
	);
	expect(() => store.openWindow(id, delivery(), now)).toThrow(
		"injected window failure",
	);
	expect(store.get(id)).toMatchObject({
		state: "notice_pending",
		windowOpenedAt: null,
	});
	expect(store.notice(id)).toMatchObject({
		sendState: "sending",
		messageId: null,
		deliveredAt: null,
	});
	expect(() =>
		db
			.prepare(
				"UPDATE customer_release_cycles SET deadline_at=? WHERE cycle_id=?",
			)
			.run(intent.deadlineAt + 1, id),
	).toThrow("immutable deadline");
});

function vetoRequest(store: CustomerReleaseStore, id: string) {
	return {
		interactionId: "623456789012345678",
		actorId: intent.founderId,
		applicationId: intent.applicationId,
		channelId: intent.channelId,
		messageId: delivery().messageId,
		noticeId: intent.noticeId,
		bindingDigest: store.notice(id)!.bindingDigest,
	};
}
it("T08 founder veto commits action and cancellation once, including a retry after the deadline", () => {
	const { store, id } = prepared();
	store.startNotice(id, now);
	store.openWindow(id, delivery(), now);
	const action = vetoRequest(store, id);
	const receipt = store.veto(id, action, intent.founderId, now + 1);
	expect(receipt).toMatchObject({
		result: "cancelled",
		actorId: intent.founderId,
		effectiveAt: now + 1,
	});
	expect(store.get(id)?.state).toBe("cancelled");
	expect(
		store.veto(id, action, intent.founderId, intent.deadlineAt + 1),
	).toEqual(receipt);
	expect(
		store.events(id).filter((event) => event.kind === "founder_veto"),
	).toHaveLength(1);
});
it.each([
	"actorId",
	"applicationId",
	"channelId",
	"messageId",
	"noticeId",
	"bindingDigest",
] as const)("T08 rejects a mismatched %s without cancelling", (field) => {
	const { store, id } = prepared();
	store.startNotice(id, now);
	store.openWindow(id, delivery(), now);
	expect(() =>
		store.veto(
			id,
			{
				...vetoRequest(store, id),
				[field]: "7".repeat(
					field.endsWith("Digest") ? 64 : field === "noticeId" ? 32 : 18,
				),
			},
			intent.founderId,
			now + 1,
		),
	).toThrow("veto binding rejected");
	expect(store.get(id)?.state).toBe("window_open");
});
it("T08 fails closed when current canonical founder differs from the frozen owner", () => {
	const { store, id } = prepared();
	store.startNotice(id, now);
	store.openWindow(id, delivery(), now);
	expect(() =>
		store.veto(id, vetoRequest(store, id), "723456789012345678", now + 1),
	).toThrow("veto binding rejected");
});
it("T20 late veto records post-claim intervention without claiming the publication was stopped", () => {
	const { db, store, id } = prepared();
	store.startNotice(id, now);
	store.openWindow(id, delivery(), now);
	db.prepare(
		"UPDATE customer_release_cycles SET state='committing' WHERE cycle_id=?",
	).run(id);
	expect(
		store.veto(id, vetoRequest(store, id), intent.founderId, now + 1).result,
	).toBe("post_claim");
	expect(store.get(id)).toMatchObject({
		state: "committing",
		invalidatedEventSeq: expect.any(Number),
	});
});
it("T08 storage failure rolls back the action and cancellation before any success receipt", () => {
	const { db, store, id } = prepared();
	store.startNotice(id, now);
	store.openWindow(id, delivery(), now);
	db.exec(
		"CREATE TRIGGER fail_action BEFORE INSERT ON customer_release_actions BEGIN SELECT RAISE(ABORT,'injected action failure'); END",
	);
	expect(() =>
		store.veto(id, vetoRequest(store, id), intent.founderId, now + 1),
	).toThrow("injected action failure");
	expect(store.get(id)?.state).toBe("window_open");
	expect(store.events(id).some((event) => event.kind === "founder_veto")).toBe(
		false,
	);
});

function freshReadiness(db: Database.Database, at: number, state = "green") {
	// Same persisted columns consumed from B3; full StateStore schema is covered in policy tests.
	db.exec(
		"CREATE TABLE IF NOT EXISTS release_readiness_verdicts(verdict_id TEXT,subject_commit TEXT,base_version TEXT,local_deployed_sha TEXT,state TEXT,evaluated_at TEXT)",
	);
	db.prepare(
		"INSERT INTO release_readiness_verdicts VALUES ('fresh',?,'1.2.3',?,?,?)",
	).run(sha, sha, state, new Date(at).toISOString());
	return "fresh";
}
it("T10 requests an executor only after the veto deadline and does not issue a permit", () => {
	const { db, store, id } = prepared();
	store.startNotice(id, now);
	store.openWindow(id, delivery(), now);
	const at = intent.deadlineAt;
	const receipt = { ...delivery(), verifiedAt: at };
	expect(
		store.awaitAttempt(id, 3, receipt, at - 1, () => {
			throw new Error("too early");
		}),
	).toBe(false);
	expect(store.get(id)?.state).toBe("window_open");
	expect(
		store.awaitAttempt(id, 3, receipt, at, () => freshReadiness(db, at)),
	).toBe(true);
	expect(store.get(id)).toMatchObject({
		state: "awaiting_attempt",
		windowOpenedAt: now,
		claimNotAfter: intent.claimNotAfter,
	});
	expect(store.events(id).at(-1)?.kind).toBe("attempt_requested");
	expect(store.awaitAttempt(id, 3, receipt, at, () => "fresh")).toBe(false);
});
it.each(["hold", "unknown", "expired", "stale_receipt", "changed_message"])(
	"T10 fails closed on %s",
	(mode) => {
		const { db, store, id } = prepared();
		store.startNotice(id, now);
		store.openWindow(id, delivery(), now);
		const at =
			mode === "expired" ? intent.claimNotAfter + 1 : intent.deadlineAt;
		const receipt = {
			...delivery(),
			verifiedAt: mode === "stale_receipt" ? now : at,
			messageId:
				mode === "changed_message"
					? "723456789012345678"
					: delivery().messageId,
		};
		expect(
			store.awaitAttempt(id, 3, receipt, at, () =>
				freshReadiness(
					db,
					at,
					mode === "hold" || mode === "unknown" ? mode : "green",
				),
			),
		).toBe(false);
		expect(store.get(id)?.state).toBe("cancelled");
		expect(
			store.events(id).some((event) => event.kind === "attempt_requested"),
		).toBe(false);
	},
);
it("T10 veto received during fresh evaluation wins and leaves no executor intent", () => {
	const { db, store, id } = prepared();
	store.startNotice(id, now);
	store.openWindow(id, delivery(), now);
	const at = intent.deadlineAt;
	expect(
		store.awaitAttempt(id, 3, { ...delivery(), verifiedAt: at }, at, () => {
			store.veto(id, vetoRequest(store, id), intent.founderId, at);
			return freshReadiness(db, at);
		}),
	).toBe(false);
	expect(store.get(id)?.state).toBe("cancelled");
});

function awaiting() {
	const context = prepared();
	const { db, store, id } = context;
	store.startNotice(id, now);
	store.openWindow(id, delivery(), now);
	const at = intent.deadlineAt;
	const receipt = { ...delivery(), verifiedAt: at };
	store.awaitAttempt(id, 3, receipt, at, () => freshReadiness(db, at));
	const activation = {
		mode: "canary",
		enabled: true,
		enableReceiptValid: true,
		founderId: intent.founderId,
		enableReceiptId: "enable-1",
		evidenceBundleDigest: "e".repeat(64),
		activationEpoch: 1,
		policyRevision: "c".repeat(64),
		audience: "payload-flywheel",
		sourcesHealthy: true,
	};
	seedReleaseActivation(db, {
		founderId: intent.founderId,
		policyRevision: activation.policyRevision,
		audience: activation.audience,
		now,
	});
	const attempt = {
		attemptId: "attempt-1",
		cycleId: id,
		projectId: "flywheel",
		audience: activation.audience,
		activationEpoch: 1,
		nonce: "f".repeat(64),
		baseEtag: "etag-1",
		readyAt: at,
		fullBinding: store.get(id)!.binding!,
		readbackSha256: cleanHash,
	};
	const claim = (evaluate = () => freshReadiness(db, at)) =>
		store.claimAuto(
			id,
			4,
			attempt,
			manifest,
			receipt,
			at,
			() => activation,
			evaluate,
		);
	return { ...context, at, receipt, activation, attempt, claim };
}
it("T11 persists a single immutable permit; replay returns identical bytes even after disable", () => {
	const { db, store, id, activation, claim, at, attempt } = awaiting();
	const permit = claim();
	expect(permit).toMatchObject({
		...attempt,
		action: "commit",
		trigger: "silence_auto",
		claimedAt: at,
		notAfter: at + 30_000,
	});
	expect(store.get(id)?.state).toBe("committing");
	activation.enabled = false;
	expect(
		claim(() => {
			throw new Error("replay must not mint");
		}),
	).toEqual(permit);
	expect(
		store.events(id).filter((e) => e.kind === "release_claimed"),
	).toHaveLength(1);
	expect(() =>
		db.prepare("UPDATE customer_release_decisions SET permit_json='{}'").run(),
	).toThrow("immutable decision");
});
it.each([
	"disabled",
	"observe",
	"enable_missing",
	"epoch",
	"policy",
	"sources",
	"audience",
	"tuple",
	"hash",
	"clock",
	"notice",
	"hold",
	"unknown",
])("T11 refuses %s without a decision", (mode) => {
	const { db, store, id, activation, attempt, receipt, claim, at } = awaiting();
	if (mode === "disabled") activation.enabled = false;
	if (mode === "observe") activation.mode = "observe";
	if (mode === "enable_missing") activation.enableReceiptValid = false;
	if (mode === "epoch") activation.activationEpoch++;
	if (mode === "policy") activation.policyRevision = "e".repeat(64);
	if (mode === "sources") activation.sourcesHealthy = false;
	if (mode === "audience") attempt.audience = "other";
	if (mode === "tuple") attempt.fullBinding.releasePayloadSha256 = hash;
	if (mode === "hash") attempt.readbackSha256 = hash;
	if (mode === "clock") attempt.readyAt = at + 5001;
	if (mode === "notice") receipt.accessVerified = false;
	expect(
		claim(() =>
			freshReadiness(
				db,
				at,
				["hold", "unknown"].includes(mode) ? mode : "green",
			),
		),
	).toBeNull();
	expect(store.get(id)?.state).toBe("cancelled");
	expect(
		db.prepare("SELECT count(*) AS n FROM customer_release_decisions").get(),
	).toEqual({ n: 0 });
});
it("T11 veto during evaluation commits cancellation and no permit", () => {
	const { store, db, id, claim, at } = awaiting();
	expect(
		claim(() => {
			store.veto(id, vetoRequest(store, id), intent.founderId, at);
			return freshReadiness(db, at);
		}),
	).toBeNull();
	expect(store.get(id)?.state).toBe("cancelled");
});
it("T11 rechecks activation after evaluation", () => {
	const { activation, claim, db, at } = awaiting();
	expect(
		claim(() => {
			activation.enabled = false;
			return freshReadiness(db, at);
		}),
	).toBeNull();
});
it("T11 failed event write rolls back decision and claim", () => {
	const { db, store, id, claim } = awaiting();
	db.exec(
		"CREATE TRIGGER fail_claim BEFORE INSERT ON customer_release_events WHEN NEW.kind='release_claimed' BEGIN SELECT RAISE(ABORT,'claim event failure'); END",
	);
	expect(() => claim()).toThrow("claim event failure");
	expect(store.get(id)?.state).toBe("awaiting_attempt");
	expect(
		db.prepare("SELECT count(*) AS n FROM customer_release_decisions").get(),
	).toEqual({ n: 0 });
});
it("T11 rejects an attempt replay with changed binding", () => {
	const { claim, attempt } = awaiting();
	claim();
	attempt.baseEtag = "other";
	expect(() => claim()).toThrow("attempt replay mismatch");
});

it("T11 durable replay survives reopening and never extends permit expiry", () => {
	const { db, claim, id, attempt, receipt, at } = awaiting();
	const original = claim();
	const reopened = new Database(db.serialize());
	databases.push(reopened);
	const store = new CustomerReleaseStore(reopened);
	store.migrate();
	store.migrate();
	const mustNotCollect = () => {
		throw new Error("unexpected collection on replay");
	};
	expect(
		store.claimAuto(
			id,
			4,
			attempt,
			manifest,
			receipt,
			at + 60_000,
			mustNotCollect,
			mustNotCollect,
		),
	).toEqual(original);
});
it("T11 respects the frozen admission deadline and caps the permit at it", () => {
	for (const remaining of [0, 1000]) {
		const { store, db, id, activation, attempt, receipt } = awaiting();
		const at = intent.claimNotAfter - remaining;
		const permit = store.claimAuto(
			id,
			4,
			{ ...attempt, readyAt: at },
			manifest,
			{ ...receipt, verifiedAt: at },
			at,
			() => activation,
			() => freshReadiness(db, at),
		);
		if (remaining === 0) expect(permit).toBeNull();
		else expect(permit?.notAfter).toBe(intent.claimNotAfter);
	}
});
it("T11 refuses an inactive beta or abandoned artifact at execution time", () => {
	for (const kind of ["beta", "artifact"]) {
		const { store, db, id, activation, attempt, receipt, at } = awaiting();
		const changed = structuredClone(manifest);
		if (kind === "beta") changed.versions["1.2.3-beta.1"].status = "withdrawn";
		else changed.releaseOps["release-1"].state = "abandoned";
		expect(
			store.claimAuto(
				id,
				4,
				attempt,
				changed,
				receipt,
				at,
				() => activation,
				() => freshReadiness(db, at),
			),
		).toBeNull();
		expect(store.get(id)?.state).toBe("cancelled");
	}
});
it("T11 unknown attempt fields cannot disappear into a successful replay", () => {
	const { claim, attempt } = awaiting();
	claim();
	Object.assign(attempt.fullBinding, { extra: "unsupported" });
	expect(() => claim()).toThrow("attempt invalid");
});
