import { FENCE } from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import { pollOnce } from "../consume-loop.js";
import { startAttemptTx } from "../transitions.js";
import {
	type EngineFixture,
	enqueueMailbox,
	makeEngineFixture,
	seedSessionRunner,
} from "./helpers.js";

/**
 * FLY-1563 (lead ruling seq 989): a runner's spawn-injected `task_assignment`
 * processing attempt stays RUNNING from spawn to its final settling proposal —
 * with the old per-recipient resume-first rule, every mid-task `next` resumed
 * that attempt and hit the host's "already handed" fence, so a runner could
 * never read its lead's `ask_response` while working. The relaxation is scoped
 * to exactly one thing: an open dispatch attempt no longer blocks the pull of
 * later NON-dispatch mail. Same-letter settle-before-repull semantics and the
 * per-message `pa_one_running` constraint are untouched.
 */
describe("FLY-1563 — pulls past the open spawn assignment", () => {
	const fixtures: EngineFixture[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	function seedMidTaskRunner(fixture: EngineFixture) {
		const { agent } = seedSessionRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m-assignment",
			agent: agent.agentId,
			agentKind: "runner",
			sourceKind: "dag_task_dispatch",
			kind: "task_assignment",
		});
		// The spawn path starts the assignment attempt before the runner exists.
		const spawned = fixture.kernel.write("test.spawn-start", (tx) =>
			startAttemptTx(tx, fixture.runtime, agent, "m-assignment"),
		);
		expect(spawned?.resumed).toBe(false);
		return { agent, assignmentAttemptUid: spawned?.handle.attemptUid };
	}

	it("serves a later ask_response while the assignment attempt is still running", () => {
		const fixture = makeEngineFixture();
		fixtures.push(fixture);
		const { agent } = seedMidTaskRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m-reply",
			agent: agent.agentId,
			agentKind: "runner",
			sourceKind: "lead",
			kind: "ask_response",
		});

		// Default mode (the spawn/recovery path) still resumes the assignment.
		const resumed = pollOnce(fixture.kernel, fixture.runtime, agent, 0);
		expect(resumed.result).toMatchObject({
			status: "available",
			handle: { messageUid: "m-assignment" },
		});

		// The session pull mode looks PAST the open assignment.
		const beyond = pollOnce(
			fixture.kernel,
			fixture.runtime,
			agent,
			0,
			undefined,
			{
				beyondInjectedAssignment: true,
			},
		);
		expect(beyond.result).toMatchObject({
			status: "available",
			handle: { messageUid: "m-reply" },
		});
		if (beyond.result.status !== "available") throw new Error("unreachable");
		const replyAttemptUid = beyond.result.handle.attemptUid;

		// At-least-once for the SAME letter is untouched: a re-poll resumes the
		// open reply attempt rather than starting a second one.
		const again = pollOnce(
			fixture.kernel,
			fixture.runtime,
			agent,
			0,
			undefined,
			{
				beyondInjectedAssignment: true,
			},
		);
		expect(again.result).toMatchObject({
			status: "available",
			handle: { messageUid: "m-reply", attemptUid: replyAttemptUid },
			resumed: true,
		});

		// pa_one_running (per message) holds: one running attempt per letter.
		expect(
			fixture.kernel.read((tx) =>
				tx
					.all<{ message_uid: string }>(
						`SELECT message_uid FROM processing_attempts
						  WHERE outcome='running' ORDER BY message_uid`,
					)
					.map((row) => row.message_uid),
			),
		).toEqual(["m-assignment", "m-reply"]);

		// Settling the reply frees the lane for the next letter (crash-settle is
		// the digest-free settlement form every recovery path uses).
		fixture.kernel.write("test.settle-reply", (tx) => {
			tx.cas(FENCE.processingAttemptCasRunningSettled, {
				attemptUid: replyAttemptUid,
				outcome: "crashed",
				settledAt: fixture.runtime.clock.nowIso(),
				proposalDigest: null,
			});
			tx.run(
				`UPDATE mailbox SET state='applied',applied_at=@now
				  WHERE message_uid='m-reply'`,
				{ now: fixture.runtime.clock.nowIso() },
			);
		});
		const empty = pollOnce(
			fixture.kernel,
			fixture.runtime,
			agent,
			0,
			undefined,
			{
				beyondInjectedAssignment: true,
			},
		);
		expect(empty.result.status).toBe("empty");
	});

	it("keeps the transient lane serial: a second pending letter waits for the first", () => {
		const fixture = makeEngineFixture();
		fixtures.push(fixture);
		const { agent } = seedMidTaskRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m-reply-1",
			agent: agent.agentId,
			agentKind: "runner",
			sourceKind: "lead",
			kind: "ask_response",
		});
		enqueueMailbox(fixture, {
			uid: "m-reply-2",
			agent: agent.agentId,
			agentKind: "runner",
			sourceKind: "lead",
			kind: "ask_response",
		});
		const first = pollOnce(
			fixture.kernel,
			fixture.runtime,
			agent,
			0,
			undefined,
			{
				beyondInjectedAssignment: true,
			},
		);
		expect(first.result).toMatchObject({
			status: "available",
			handle: { messageUid: "m-reply-1" },
		});
		// Starting the second while the first is open is refused, exactly like the
		// pre-existing per-recipient rule for every non-dispatch letter.
		expect(() =>
			fixture.kernel.write("test.start-second", (tx) =>
				startAttemptTx(tx, fixture.runtime, agent, "m-reply-2", {
					beyondInjectedAssignment: true,
				}),
			),
		).toThrow(/already has running/);
	});

	it("never starts the dispatch assignment itself through the beyond mode", () => {
		const fixture = makeEngineFixture();
		fixtures.push(fixture);
		const { agent } = seedSessionRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m-assignment",
			agent: agent.agentId,
			agentKind: "runner",
			sourceKind: "dag_task_dispatch",
			kind: "task_assignment",
		});
		// No attempt exists yet (pre-spawn shape): the beyond poll must NOT
		// deliver the assignment — that letter belongs to the spawn prompt.
		const beyond = pollOnce(
			fixture.kernel,
			fixture.runtime,
			agent,
			0,
			undefined,
			{
				beyondInjectedAssignment: true,
			},
		);
		expect(beyond.result.status).toBe("empty");
		expect(() =>
			fixture.kernel.write("test.start-dispatch", (tx) =>
				startAttemptTx(tx, fixture.runtime, agent, "m-assignment", {
					beyondInjectedAssignment: true,
				}),
			),
		).toThrow(/spawn-injected/);
	});
});
