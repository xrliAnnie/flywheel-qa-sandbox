import { afterEach, describe, expect, it } from "vitest";
import { pollOnce } from "../consume-loop.js";
import { reportConversionFailure, submitProposal } from "../settlement.js";
import type { PollResult } from "../types.js";
import {
	type EngineFixture,
	enqueueMailbox,
	makeEngineFixture,
	seedSessionRunner,
} from "./helpers.js";

function runningDelivery(fixture: EngineFixture): {
	agentId: string;
	result: Extract<PollResult, { status: "available" }>;
} {
	const { agent } = seedSessionRunner(fixture);
	enqueueMailbox(fixture, {
		uid: "m1",
		agent: agent.agentId,
		agentKind: "runner",
	});
	const result = pollOnce(fixture.kernel, fixture.runtime, agent, 0).result;
	if (result.status !== "available") throw new Error("expected available");
	return { agentId: agent.agentId, result };
}

describe("transactional session mailbox settlement", () => {
	let fixture: EngineFixture | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it("commits effects, mailbox applied, and attempt succeeded atomically", () => {
		fixture = makeEngineFixture();
		const { result } = runningDelivery(fixture);
		submitProposal(fixture.kernel, fixture.runtime, {
			handle: result.handle,
			effects: [
				{
					kind: "task",
					taskKind: "follow-up",
					state: "ready",
					payload: "{}",
					projectId: "project-a",
				},
			],
		});

		expect(
			fixture.kernel.read((tx) => ({
				mailbox: tx.get<{ state: string }>(
					"SELECT state FROM mailbox WHERE message_uid='m1'",
				)?.state,
				attempt: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
				tasks: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM tasks WHERE kind='follow-up'",
				)?.count,
				appliedEvents: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='mailbox.applied'",
				)?.count,
			})),
		).toEqual({
			mailbox: "applied",
			attempt: "succeeded",
			tasks: 1,
			appliedEvents: 1,
		});
	});

	it("rolls prior effects and settlement writes back on a later task FK failure", () => {
		fixture = makeEngineFixture();
		const { result } = runningDelivery(fixture);
		expect(() =>
			submitProposal(
				(fixture as EngineFixture).kernel,
				(fixture as EngineFixture).runtime,
				{
					handle: result.handle,
					effects: [
						{
							kind: "event",
							eventKind: "proposal.prelude",
							payload: "{}",
						},
						{
							kind: "task",
							taskKind: "invalid-follow-up",
							state: "ready",
							payload: "{}",
							projectId: "project-a",
							lineageRootTaskId: "missing-root",
						},
					],
				},
			),
		).toThrow();
		expect(
			fixture.kernel.read((tx) => ({
				mailbox: tx.get<{ state: string }>(
					"SELECT state FROM mailbox WHERE message_uid='m1'",
				)?.state,
				attempt: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
				priorEvents: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='proposal.prelude'",
				)?.count,
				invalidTasks: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM tasks WHERE kind='invalid-follow-up'",
				)?.count,
				appliedEvents: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='mailbox.applied'",
				)?.count,
			})),
		).toEqual({
			mailbox: "pending",
			attempt: "running",
			priorEvents: 0,
			invalidTasks: 0,
			appliedEvents: 0,
		});
	});

	it("uses durable max-attempts and emits one session-scoped dead event", () => {
		fixture = makeEngineFixture();
		const { agentId, result } = runningDelivery(fixture);
		fixture.kernel.write("test.configure-dead", (tx) => {
			tx.run("UPDATE config SET value='2' WHERE key='mailbox.max_attempts'");
			tx.run("UPDATE mailbox SET retry_count=1 WHERE message_uid='m1'");
		});

		reportConversionFailure(
			fixture.kernel,
			fixture.runtime,
			result.handle,
			"conversion failed",
		);
		expect(
			fixture.kernel.read((tx) => ({
				mailbox: tx.get<{ state: string; retry_count: number }>(
					"SELECT state,retry_count FROM mailbox WHERE message_uid='m1'",
				),
				attempt: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
				event: tx.get<{
					event_uid: string;
					kind: string;
					source_kind: string;
					source_id: string;
					payload: string;
				}>(
					`SELECT event_uid,kind,source_kind,source_id,payload
					 FROM events WHERE event_uid='mailbox:m1:dead'`,
				),
			})),
		).toEqual({
			mailbox: { state: "dead", retry_count: 2 },
			attempt: "failed",
			event: {
				event_uid: "mailbox:m1:dead",
				kind: "mailbox.dead",
				source_kind: "agent",
				source_id: agentId,
				payload: '{"message_uid":"m1","attempt_uid":"m1#1","generation":1}',
			},
		});
		expect(() =>
			reportConversionFailure(
				(fixture as EngineFixture).kernel,
				(fixture as EngineFixture).runtime,
				result.handle,
				"late replay",
			),
		).toThrow();
	});

	it("rolls attempt and mailbox back when the dead event collides", () => {
		fixture = makeEngineFixture();
		const { agentId, result } = runningDelivery(fixture);
		fixture.kernel.write("test.seed-collision", (tx) => {
			tx.run("UPDATE config SET value='2' WHERE key='mailbox.max_attempts'");
			tx.run("UPDATE mailbox SET retry_count=1 WHERE message_uid='m1'");
			tx.run(
				`INSERT INTO events
				 (event_uid,kind,source_kind,source_id,payload,cutover_epoch,created_at)
				 VALUES ('mailbox:m1:dead','wrong','agent',@agentId,'{}',1,@now)`,
				{ agentId, now: fixture?.clock.nowIso() },
			);
		});

		expect(() =>
			reportConversionFailure(
				(fixture as EngineFixture).kernel,
				(fixture as EngineFixture).runtime,
				result.handle,
				"conversion failed",
			),
		).toThrow(/dead event collision/);
		expect(
			fixture.kernel.read((tx) => ({
				mailbox: tx.get<{ state: string; retry_count: number }>(
					"SELECT state,retry_count FROM mailbox WHERE message_uid='m1'",
				),
				attempt: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
			})),
		).toEqual({
			mailbox: { state: "pending", retry_count: 1 },
			attempt: "running",
		});
	});
});
