import { afterEach, describe, expect, it } from "vitest";
import {
	failureRecurrenceKey,
	MAX_RECURRENCE_NOTICES,
	MAX_RECURRENCE_SAMPLES,
} from "../dispatch.js";
import {
	admitIssueDag,
	dispatchOnce,
	recoverPendingLaunches,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

/**
 * FLY-1503 item 4 — an executor with no matching `agents` row must still be
 * reachable by launch recovery.
 *
 * Historically `requestForSession` INNER JOINed `agents` on the task payload's
 * executor identity; when that row was absent the join produced no row,
 * `requestForSession` returned null, and `recoverableClaims` silently dropped
 * the claim. The engine could then never recover the attempt and an operator
 * had to reap it by hand (production: agent id `code`, FLY-1503 gap #4).
 */
async function admitUnregisteredExecutor(
	fixture: ReturnType<typeof makeFixture>,
	ports: ReturnType<typeof makePorts>["ports"],
) {
	return await admitIssueDag(fixture.kernel, ports, {
		admissionUid: "fly1503-gap4",
		projectId: "project-a",
		issueId: "issue-fly1503-gap4",
		notifyAgentId: "lead-a",
		shipWorktreeId: "wt-a",
		worktrees: [
			{
				worktreeId: "wt-a",
				repoIdentity: "owner/repo",
				worktreePath: "/tmp/wt-a",
				branchRef: "refs/heads/feature",
				mergeTargetRef: "refs/heads/main",
			},
		],
		tasks: [
			{
				localId: "node",
				kindLabel: "opaque",
				contract: [],
				writesRepo: false,
				worktreeId: null,
				executor: {
					family: "family-a",
					vendor: "vendor",
					model: "model",
					effort: "high",
				},
			},
		],
		edges: [],
	});
}

function claimKeys(fixture: ReturnType<typeof makeFixture>): string[] {
	return fixture.kernel.read((tx) =>
		tx
			.all<{ key: string }>(
				"SELECT key FROM meta WHERE key LIKE 'launch_claim:%' ORDER BY key",
			)
			.map((row) => row.key),
	);
}

describe("FLY-1503 gap 4 — recovery covers a missing agents row", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("examines a stranded claim whose executor agent was never registered", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		// deliberately NOT provisioning the executor: this is the production
		// shape where project config named an agent id that was never registered.
		const { ports } = makePorts(fixture.clock, {
			// The launcher rejects an agent id absent from project config, so the
			// launch fails *before* registerAgentTx can create the agents row.
			spawn: {
				async spawn() {
					throw new Error(
						"agent id ghost-agent unregistered in project config",
					);
				},
			},
		});
		await admitUnregisteredExecutor(fixture, ports);

		// Dispatch leaves a durable launch claim behind even though the executor
		// could not be launched or registered.
		await dispatchOnce(fixture.kernel, ports).catch(() => undefined);
		expect(claimKeys(fixture).length).toBe(1);
		// Precondition for the gap: no agents row exists for the executor.
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM agents WHERE agent_id='ghost-agent'",
					)?.count,
			),
		).toBe(0);

		fixture.clock.advance(60_001);
		const recovered = await recoverPendingLaunches(fixture.kernel, ports);

		// RED before the fix: requestForSession INNER JOINed agents, returned
		// null, and recoverableClaims silently dropped the claim -> examined 0,
		// so the engine could never recover and an operator had to reap by hand.
		expect(recovered.examined).toBe(1);
	});
});

describe("FLY-1503 item 5 — a recurring launch failure stays observable", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("notifies on a repeat even though the event ledger stays deduped", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		const { ports } = makePorts(fixture.clock, {
			spawn: {
				async spawn() {
					throw new Error("launcher is unavailable");
				},
			},
		});
		await admitUnregisteredExecutor(fixture, ports);

		// First failed launch: audited, event written, Lead notified.
		await dispatchOnce(fixture.kernel, ports).catch(() => undefined);
		fixture.clock.advance(60_001);
		await recoverPendingLaunches(fixture.kernel, ports);
		const afterFirst = fixture.kernel.read((tx) => ({
			events:
				tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='task_dispatch_invalid'",
				)?.count ?? 0,
			repeats:
				tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE source_kind LIKE '%_repeat'",
				)?.count ?? 0,
		}));
		expect(afterFirst.events).toBe(1);
		expect(afterFirst.repeats).toBe(0);

		// The next attempt fails exactly the same way: same task, same payload
		// digest, same stage, same error class, so the same event uid.
		fixture.clock.advance(60_001);
		await dispatchOnce(fixture.kernel, ports).catch(() => undefined);
		const afterSecond = fixture.kernel.read((tx) => ({
			events:
				tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='task_dispatch_invalid'",
				)?.count ?? 0,
			repeats:
				tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE source_kind LIKE '%_repeat'",
				)?.count ?? 0,
		}));

		// The ledger stays deduped ...
		expect(afterSecond.events).toBe(1);
		// ... but the recurrence is now reported.
		// RED before the fix: auditTaskFailure returned early on the duplicate
		// eventUid, skipping appendEvent *and* appendMailboxTx, so every repeat was
		// completely silent while callers were still told it had been audited.
		expect(afterSecond.repeats).toBeGreaterThan(afterFirst.repeats);
	});

	function recurrenceProbe(fixture: ReturnType<typeof makeFixture>) {
		const pending = () =>
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM mailbox WHERE kind LIKE '%!_repeat' ESCAPE '!' AND state='pending'",
					)?.count ?? 0,
			);
		const total = () =>
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM mailbox WHERE kind LIKE '%!_repeat' ESCAPE '!'",
					)?.count ?? 0,
			);
		// Codex R2 MEDIUM-3 asked for the Lead to CONSUME the notice between rounds:
		// bounding only the pending set would still let history grow forever.
		const consume = () =>
			fixture.kernel.write("test.consume-repeats", (tx) => {
				tx.run(
					"UPDATE mailbox SET state='applied' WHERE kind LIKE '%!_repeat' ESCAPE '!' AND state='pending'",
				);
			});
		const aggregateRaw = () =>
			fixture.kernel.read((tx) => {
				const row = tx.get<{ value: string }>(
					"SELECT value FROM meta WHERE key LIKE 'dag_failure_recurrence:%'",
				);
				return row
					? (
							JSON.parse(row.value) as {
								data: { undelivered_signal: boolean };
							}
						).data
					: undefined;
			});
		const aggregate = () =>
			fixture.kernel.read((tx) => {
				const row = tx.get<{ value: string }>(
					"SELECT value FROM meta WHERE key LIKE 'dag_failure_recurrence:%'",
				);
				return row
					? (
							JSON.parse(row.value) as {
								data: {
									occurrences: number;
									notices_created: number;
									notice_cap_reached: boolean;
									distinct_diagnostics_dropped: number;
									samples: Array<{ digest: string; error: string }>;
								};
							}
						).data
					: undefined;
			});
		const latestNotice = () =>
			fixture.kernel.read((tx) => {
				const row = tx.get<{ payload: string }>(
					`SELECT payload FROM mailbox
					  WHERE kind LIKE '%!_repeat' ESCAPE '!'
					  ORDER BY source_id DESC LIMIT 1`,
				);
				return row
					? (JSON.parse(row.payload) as {
							occurrences: number;
							notice_index: number;
							distinct_diagnostics_dropped: number;
							carries_deferred_signal: boolean;
							samples: Array<{ error: string }>;
						})
					: undefined;
			});
		return { pending, total, consume, aggregate, aggregateRaw, latestNotice };
	}

	it("bounds total notices for an identical failure and keeps counting past the cap", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		const { ports } = makePorts(fixture.clock, {
			spawn: {
				async spawn() {
					throw new Error("launcher is unavailable");
				},
			},
		});
		await admitUnregisteredExecutor(fixture, ports);
		const probe = recurrenceProbe(fixture);

		// Far more failing rounds than the notice cap, each notice drained.
		for (let round = 0; round < MAX_RECURRENCE_NOTICES + 12; round += 1) {
			await dispatchOnce(fixture.kernel, ports).catch(() => undefined);
			fixture.clock.advance(60 * 60 * 1000 + 1);
			await recoverPendingLaunches(fixture.kernel, ports);
			expect(probe.pending()).toBeLessThanOrEqual(1);
			probe.consume();
		}

		// Mailbox history is capped ...
		expect(probe.total()).toBeLessThanOrEqual(MAX_RECURRENCE_NOTICES);
		const aggregate = probe.aggregate();
		expect(aggregate?.notice_cap_reached).toBe(true);
		// ... while the aggregate keeps the full count, so hitting the cap silences
		// the notifications but not the record.
		expect(aggregate?.occurrences).toBeGreaterThan(MAX_RECURRENCE_NOTICES);
		// One diagnostic, so exactly one retained sample and nothing dropped.
		expect(aggregate?.samples).toHaveLength(1);
		expect(aggregate?.distinct_diagnostics_dropped).toBe(0);
	});

	it("stays bounded when every failure carries a unique diagnostic", async () => {
		// Codex R3 MEDIUM-3 negative case 1: a diagnostic containing a uuid, request
		// id, temp path or timestamp produced a NEW digest each time, so the previous
		// digest-keyed scheme added a permanent mailbox row per failure -- unbounded
		// in total even though only one was ever pending.
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		let attempt = 0;
		const { ports } = makePorts(fixture.clock, {
			spawn: {
				async spawn() {
					attempt += 1;
					throw new Error(
						`launcher is unavailable (request 2f8a-${attempt}, at ${attempt * 1000})`,
					);
				},
			},
		});
		await admitUnregisteredExecutor(fixture, ports);
		const probe = recurrenceProbe(fixture);

		for (let round = 0; round < 30; round += 1) {
			await dispatchOnce(fixture.kernel, ports).catch(() => undefined);
			fixture.clock.advance(60 * 60 * 1000 + 1);
			await recoverPendingLaunches(fixture.kernel, ports);
			probe.consume();
		}

		expect(attempt).toBeGreaterThan(MAX_RECURRENCE_NOTICES);
		expect(probe.total()).toBeLessThanOrEqual(MAX_RECURRENCE_NOTICES);
		const aggregate = probe.aggregate();
		// Samples are capped, and the diagnostics that did not fit are COUNTED
		// rather than silently discarded.
		expect(aggregate?.samples.length).toBe(MAX_RECURRENCE_SAMPLES);
		expect(aggregate?.distinct_diagnostics_dropped).toBeGreaterThan(0);
		expect(aggregate?.occurrences).toBe(
			(aggregate?.samples.length ?? 0) +
				(aggregate?.distinct_diagnostics_dropped ?? 0),
		);
	});

	it("does not lose a diagnostic that changes while a notice is pending", async () => {
		// Codex R3 MEDIUM-3 negative case 2: a one-off different diagnostic that
		// arrived while an earlier notice was still pending used to be dropped
		// outright, so if it never recurred the Lead never saw it at all.
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		let diagnostic = "connection refused";
		const { ports } = makePorts(fixture.clock, {
			spawn: {
				async spawn() {
					throw new Error(diagnostic);
				},
			},
		});
		await admitUnregisteredExecutor(fixture, ports);
		const probe = recurrenceProbe(fixture);

		const round = async () => {
			await dispatchOnce(fixture.kernel, ports).catch(() => undefined);
			fixture.clock.advance(60 * 60 * 1000 + 1);
			await recoverPendingLaunches(fixture.kernel, ports);
		};

		// Round 1 writes the event; the next round raises the first notice.
		await round();
		await round();
		expect(probe.pending()).toBe(1);
		const before = probe.aggregate()?.occurrences ?? 0;

		// The reason changes while that notice is STILL pending, and never recurs.
		diagnostic = "invalid configuration";
		await round();
		diagnostic = "connection refused";

		// The changed diagnostic really was audited ...
		expect(probe.aggregate()?.occurrences).toBeGreaterThan(before);
		// ... and no new row was created: the pending notice still holds the slot.
		expect(probe.pending()).toBe(1);
		// But the aggregate already records it, so it is not lost.
		expect(probe.aggregate()?.samples.map((sample) => sample.error)).toContain(
			"invalid configuration",
		);

		// Codex R4 MEDIUM-4: the aggregate also marks that a diagnostic is recorded
		// which no notice has carried yet, so the obligation is durable state rather
		// than something only a future failure would surface.
		expect(probe.aggregateRaw()?.undelivered_signal).toBe(true);

		// And once the Lead drains, the next notice carries it and clears the flag.
		probe.consume();
		await round();
		expect(probe.pending()).toBe(1);
		expect(
			probe.latestNotice()?.samples.map((sample) => sample.error),
		).toContain("invalid configuration");
		expect(probe.latestNotice()?.carries_deferred_signal).toBe(true);
		expect(probe.aggregateRaw()?.undelivered_signal).toBe(false);
	});

	it("cannot let one failure's notice suppress another whose id is a prefix of it", () => {
		// Codex R3 MEDIUM-3 negative case 3: the pending-notice lookup compares a
		// prefix, so an event uid that is a string prefix of another used to be able
		// to suppress it. The key is now a fixed-length digest, which makes that
		// structurally impossible rather than a comparison to get right.
		const shorter = "task_dispatch_invalid:t1:digest:launch:Error";
		const longer = `${shorter}-extended`;
		const a = failureRecurrenceKey(shorter);
		const b = failureRecurrenceKey(longer);
		expect(a).not.toBe(b);
		expect(a).toHaveLength(64);
		expect(b).toHaveLength(64);
		// Neither prefixes the other, so `substr(source_id,1,65)='<key>:'` can only
		// ever match the notices of one failure.
		expect(b.startsWith(a)).toBe(false);
		expect(a.startsWith(b)).toBe(false);
	});
});
