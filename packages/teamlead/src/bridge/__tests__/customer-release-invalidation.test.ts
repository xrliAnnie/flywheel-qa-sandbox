import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import type { ReleaseHeartbeat } from "../release-readiness/evaluate.js";

const sha = "a".repeat(40),
	now = Date.parse("2026-09-15T15:00:00Z"),
	at = new Date(now).toISOString();
const stores: StateStore[] = [];
beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(now);
});
afterEach(() => {
	for (const state of stores.splice(0)) state.close();
	vi.restoreAllMocks();
});
async function setup(activate = false) {
	const state = await StateStore.create(":memory:");
	stores.push(state);
	const db = (state as unknown as { db: { raw: Database.Database } }).db.raw;
	const reserve = (projectId: string, sourceCommit = sha) =>
		state.customerReleases.reserve({
			projectId,
			slotDate: "2026-09-15",
			releaseId: projectId,
			activationEpoch: 1,
			policyRevision: "c".repeat(64),
			betaVersion: "1.2.3-beta.1",
			manifest: {
				versions: {
					"1.2.3-beta.1": {
						channel: "beta",
						status: "active",
						sourceCommit,
						sha256: "b".repeat(64),
					},
				},
			},
			now,
		});
	if (activate)
		state.customerReleases.activation.synchronize(
			{
				projectId: "flywheel",
				policyRevision: "c".repeat(64),
				founderId: "523456789012345678",
				endpoint: "https://endpoint.example",
				audience: "payload",
				botTokenSha256: "d".repeat(64),
				decisionTokenSha256: "e".repeat(64),
				identityDigest: "f".repeat(64),
			},
			now,
		);
	const cycle = reserve("flywheel");
	const other = reserve("other");
	return { state, db, cycle, other };
}
const heartbeat: ReleaseHeartbeat = {
	tickAt: at,
	sourceCommit: sha,
	baseVersion: "1.2.3",
	w1Freshness: "fresh",
	alertDeliveryEnabled: true,
	claimsDbOk: true,
	ingestOk: true,
	gapsDirOk: true,
	bridgeCaptureFailures: 0,
	rejectedRows: 0,
	backlogAgeS: 0,
	outboxPending: 0,
	outboxInvalid: 0,
};
it.each(["ingest", "attribution"])(
	"T09 heartbeat %s loss stays latched after recovery",
	async (kind) => {
		const { state, cycle, other } = await setup();
		state.appendReleaseHeartbeat({
			...heartbeat,
			...(kind === "ingest" ? { ingestOk: false } : { sourceCommit: null }),
		});
		state.appendReleaseHeartbeat(heartbeat);
		expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("cancelled");
		expect(state.customerReleases.get(other.cycleId)?.state).toBe("evaluating");
	},
);
it("T09 bug-source failure and recovery between ticks cannot erase cancellation", async () => {
	const { state, cycle } = await setup();
	state.recordReleaseBugSourceHealth({
		label: "Bug",
		ok: false,
		error: "offline",
		at,
	});
	state.recordReleaseBugSourceHealth({ label: "Bug", ok: true, at });
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("cancelled");
});
it("only the current activation probe can write health and latch source loss", async () => {
	const { state, cycle } = await setup(true);
	state.recordReleaseBugSourceHealth({
		activationEpoch: 2,
		label: "Bug",
		ok: false,
		error: "stale probe",
		at,
	});
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("evaluating");
	expect(
		state.getReleaseReadinessEvidence(sha, at, at).bugSourceHealth,
	).toBeNull();
	state.recordReleaseBugSourceHealth({
		activationEpoch: 1,
		label: "Bug",
		ok: false,
		error: "canonical source lost",
		at,
	});
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("cancelled");
	state.recordReleaseBugSourceHealth({
		activationEpoch: 1,
		label: "Bug",
		ok: true,
		at,
	});
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("cancelled");
});
it.each(["scan", "down"])(
	"T09 founder %s remains negative after a successful scan",
	async (kind) => {
		const { state, cycle } = await setup();
		state.upsertReleasePublication({
			publicationId: "p1",
			day: "2026-09-15",
			subjectCommit: sha,
			baseVersion: "1.2.3",
			status: "published",
			channelId: "channel",
			messageId: "message",
			intentAt: at,
			publishedAt: at,
			firstScanOkAt: null,
			lastScanOkAt: null,
			lastScanAt: null,
			lastScanError: null,
		});
		state.recordReleaseFounderScan(
			"p1",
			kind === "scan"
				? { at, ok: false, error: "offline" }
				: { at, ok: true, founderUserId: "founder", sentiment: "down" },
		);
		state.recordReleaseFounderScan("p1", {
			at,
			ok: true,
			founderUserId: "founder",
			sentiment: "up",
		});
		expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("cancelled");
	},
);
it("T09 source write and invalidation roll back together when event storage fails", async () => {
	const { state, db, cycle } = await setup();
	db.exec(
		"CREATE TRIGGER fail_source BEFORE INSERT ON customer_release_events WHEN NEW.kind='cycle_cancelled' BEGIN SELECT RAISE(ABORT,'source cancellation failure'); END",
	);
	expect(() =>
		state.appendReleaseHeartbeat({ ...heartbeat, ingestOk: false }),
	).toThrow("source cancellation failure");
	expect(
		db.prepare("SELECT count(*) AS n FROM release_signal_heartbeat").get(),
	).toEqual({ n: 0 });
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("evaluating");
});
it("T09 unrelated healthy sources do not invalidate the cycle", async () => {
	const { state, cycle } = await setup();
	state.appendReleaseHeartbeat(heartbeat);
	state.appendReleaseHeartbeat({
		...heartbeat,
		sourceCommit: "f".repeat(40),
		ingestOk: false,
	});
	state.recordReleaseBugSourceHealth({ label: "Bug", ok: true, at });
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("evaluating");
});

it.each(["evaluating", "manual_ready", "committing"])(
	"T09 non-green verdict is atomic and respects %s authorization",
	async (phase) => {
		const { state, db, cycle } = await setup();
		db.prepare(
			"UPDATE customer_release_cycles SET state=? WHERE cycle_id=?",
		).run(phase, cycle.cycleId);
		const { evaluateReadiness } = await import(
			"../release-readiness/evaluate.js"
		);
		const { readReadinessPolicy } = await import(
			"../release-readiness/policy.js"
		);
		const subject = { baseVersion: "1.2.3", sourceCommit: sha };
		const result = evaluateReadiness({
			subject,
			now: at,
			policy: readReadinessPolicy({}),
			localDeployedSha: null,
			anchor: null,
			events: [],
			gaps: [],
			heartbeats: [],
			bugs: [],
			bugSourceHealth: null,
			publications: [],
			founderVerdicts: [],
			outbox: {
				gapsPending: 0,
				gapsInvalid: 0,
				publicationsPending: 0,
				publicationsInvalid: 0,
				oldestPendingAt: null,
				readErrors: [],
			},
		});
		state.appendReleaseReadinessVerdict({
			...result,
			subject,
			evaluatedAt: at,
		});
		expect(state.customerReleases.get(cycle.cycleId)?.state).toBe(
			phase === "evaluating" ? "cancelled" : phase,
		);
		if (phase === "committing")
			expect(
				state.customerReleases.get(cycle.cycleId)?.invalidatedEventSeq,
			).not.toBeNull();
	},
);

it.each([
	"evaluating",
	"preparing",
	"notice_pending",
	"window_open",
	"awaiting_attempt",
])(
	"startup cancels residual %s without reopening the weekly slot",
	async (phase) => {
		const { state, db, cycle, other } = await setup();
		db.prepare(
			"UPDATE customer_release_cycles SET state=? WHERE cycle_id=?",
		).run(phase, cycle.cycleId);
		expect(state.customerReleases.recoverAfterRestart("flywheel", now)).toEqual(
			[],
		);
		expect(state.customerReleases.get(cycle.cycleId)).toMatchObject({
			state: "cancelled",
			cancelReason: "bridge_restart",
		});
		expect(state.customerReleases.get(other.cycleId)?.state).toBe("evaluating");
		const before = state.customerReleases.events(cycle.cycleId);
		state.customerReleases.recoverAfterRestart("flywheel", now + 1);
		expect(state.customerReleases.events(cycle.cycleId)).toEqual(before);
	},
);
it.each(["committing", "commit_unknown"])(
	"startup retains %s for reconciliation, even with activation off",
	async (phase) => {
		const { state, db, cycle } = await setup();
		db.prepare(
			"UPDATE customer_release_cycles SET state=? WHERE cycle_id=?",
		).run(phase, cycle.cycleId);
		const before = state.customerReleases.get(cycle.cycleId);
		expect(state.customerReleases.recoverAfterRestart("flywheel", now)).toEqual(
			[before],
		);
		expect(state.customerReleases.get(cycle.cycleId)).toEqual(before);
	},
);
it("startup cancellation audit failure rolls back the entire recovery batch", async () => {
	const { state, db, cycle } = await setup();
	db.exec(
		"CREATE TRIGGER fail_restart BEFORE INSERT ON customer_release_events WHEN NEW.kind='cycle_cancelled' BEGIN SELECT RAISE(ABORT,'restart audit failure'); END",
	);
	expect(() =>
		state.customerReleases.recoverAfterRestart("flywheel", now),
	).toThrow("restart audit failure");
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("evaluating");
});

it("deployment switch cancels the old frozen source, and rollback cannot restore its window", async () => {
	const { state, cycle } = await setup();
	state.insertDeploymentEvent({
		projectName: "flywheel",
		environment: "production",
		source: "self-ship",
		deployedSha: "f".repeat(40),
		sourceEventId: "switch",
		deployedAt: at,
	});
	state.insertDeploymentEvent({
		projectName: "flywheel",
		environment: "production",
		source: "self-ship",
		deployedSha: sha,
		sourceEventId: "rollback",
		deployedAt: new Date(now + 1).toISOString(),
	});
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("cancelled");
});
it("late historical deployment and non-production records cannot invalidate the currently deployed candidate", async () => {
	const { state, cycle } = await setup();
	state.insertDeploymentEvent({
		projectName: "flywheel",
		environment: "production",
		source: "self-ship",
		deployedSha: sha,
		sourceEventId: "current",
		deployedAt: at,
	});
	state.insertDeploymentEvent({
		projectName: "flywheel",
		environment: "production",
		source: "self-ship",
		deployedSha: "f".repeat(40),
		sourceEventId: "late",
		deployedAt: new Date(now - 1).toISOString(),
	});
	state.insertDeploymentEvent({
		projectName: "flywheel",
		environment: "staging",
		source: "self-ship",
		deployedSha: "f".repeat(40),
		sourceEventId: "staging",
		deployedAt: new Date(now + 1).toISOString(),
	});
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("evaluating");
});
it("a deployment with unknown attribution cancels automatic work", async () => {
	const { state, cycle } = await setup();
	state.insertDeploymentEvent({
		projectName: "flywheel",
		source: "self-ship",
		sourceEventId: "unknown",
		deployedAt: at,
	});
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("cancelled");
});
it("deployment evidence and cancellation roll back together", async () => {
	const { state, db, cycle } = await setup();
	db.exec(
		"CREATE TRIGGER fail_deploy BEFORE INSERT ON customer_release_events WHEN NEW.kind='cycle_cancelled' BEGIN SELECT RAISE(ABORT,'deploy cancellation failure'); END",
	);
	expect(() =>
		state.insertDeploymentEvent({
			projectName: "flywheel",
			source: "self-ship",
			sourceEventId: "switch",
			deployedSha: "f".repeat(40),
			deployedAt: at,
		}),
	).toThrow("deploy cancellation failure");
	expect(
		db.prepare("SELECT count(*) AS n FROM deployment_events").get(),
	).toEqual({ n: 0 });
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("evaluating");
});

it.each(["closed", "replaced"])(
	"a %s deployment anchor invalidates the frozen source",
	async (kind) => {
		const { state, cycle } = await setup();
		state.upsertReleaseDeploymentAnchor(
			{ sourceCommit: sha, episodeFrom: at, episodeTo: null },
			at,
		);
		state.upsertReleaseDeploymentAnchor(
			kind === "closed"
				? {
						sourceCommit: sha,
						episodeFrom: at,
						episodeTo: new Date(now + 1).toISOString(),
					}
				: {
						sourceCommit: "f".repeat(40),
						episodeFrom: new Date(now + 1).toISOString(),
						episodeTo: null,
					},
			new Date(now + 1).toISOString(),
		);
		expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("cancelled");
	},
);
it("a historical anchor closure cannot displace a newer live deployment", async () => {
	const { state, cycle } = await setup();
	state.upsertReleaseDeploymentAnchor(
		{ sourceCommit: sha, episodeFrom: at, episodeTo: null },
		at,
	);
	state.upsertReleaseDeploymentAnchor(
		{
			sourceCommit: "f".repeat(40),
			episodeFrom: new Date(now - 10).toISOString(),
			episodeTo: new Date(now - 1).toISOString(),
		},
		at,
	);
	state.insertDeploymentEvent({
		projectName: "flywheel",
		source: "self-ship",
		sourceEventId: "older-record",
		deployedSha: "f".repeat(40),
		deployedAt: new Date(now - 5).toISOString(),
	});
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("evaluating");
});

it("a pending bug intent latches unknown even when abandoned before the next tick", async () => {
	const { state, cycle } = await setup();
	state.insertReleaseBugIntent({
		intentId: "pending",
		sourceCommit: sha,
		baseVersion: "1.2.3",
		reporter: null,
		createdAt: at,
	});
	state.resolveReleaseBugIntent({
		intentId: "pending",
		resolvedBy: "master-api-token",
		resolvedAt: at,
		abandon: true,
		reason: "duplicate",
	});
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("cancelled");
});
it("an unattributed pending bug invalidates automatic work, while another source does not", async () => {
	const { state, cycle } = await setup();
	state.insertReleaseBugIntent({
		intentId: "other-source",
		sourceCommit: "f".repeat(40),
		baseVersion: "1.2.3",
		reporter: null,
		createdAt: at,
	});
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("evaluating");
	state.insertReleaseBugIntent({
		intentId: "unattributed",
		sourceCommit: null,
		baseVersion: null,
		reporter: null,
		createdAt: at,
	});
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("cancelled");
});
it("pending bug insertion and invalidation share one transaction", async () => {
	const { state, db, cycle } = await setup();
	db.exec(
		"CREATE TRIGGER fail_bug BEFORE INSERT ON customer_release_events WHEN NEW.kind='cycle_cancelled' BEGIN SELECT RAISE(ABORT,'bug cancellation failure'); END",
	);
	expect(() =>
		state.insertReleaseBugIntent({
			intentId: "pending",
			sourceCommit: sha,
			baseVersion: "1.2.3",
			reporter: null,
			createdAt: at,
		}),
	).toThrow("bug cancellation failure");
	expect(
		db.prepare("SELECT count(*) AS n FROM release_bug_reports").get(),
	).toEqual({ n: 0 });
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("evaluating");
});

it("a historical bug intent outside the B3 evidence window does not cancel today's cycle", async () => {
	const { state, cycle } = await setup();
	state.insertReleaseBugIntent({
		intentId: "historical",
		sourceCommit: sha,
		baseVersion: "1.2.3",
		reporter: null,
		createdAt: "2000-01-01T00:00:00.000Z",
	});
	expect(state.customerReleases.get(cycle.cycleId)?.state).toBe("evaluating");
});

// B3 evidence lasts 14 days; the unrelated recovery window is only 15 minutes.
it.each([
	[14 * 24 * 3600_000 - 1, "cancelled"],
	[14 * 24 * 3600_000, "cancelled"],
	[14 * 24 * 3600_000 + 1, "evaluating"],
] as const)(
	"pending Bug age %i follows the B3 evidence boundary",
	async (age, expected) => {
		const { state, cycle } = await setup();
		state.insertReleaseBugIntent({
			intentId: "boundary",
			sourceCommit: sha,
			baseVersion: "1.2.3",
			reporter: null,
			createdAt: new Date(now - age).toISOString(),
		});
		expect(state.customerReleases.get(cycle.cycleId)?.state).toBe(expected);
	},
);
