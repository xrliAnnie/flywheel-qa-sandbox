import type { Kernel } from "flywheel-v2-kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineDriver } from "../driver.js";
import { enqueue, provisionAgentRecipient } from "../enqueue.js";
import { registerAgentTx } from "../registration.js";
import {
	type EngineFixture,
	enqueueMailbox,
	makeEngineFixture,
	testSessionBinding,
} from "./helpers.js";

// QA (FLY-1499) — independent verification of the mapping-v2final.md contract.
//
// These tests deliberately drive the REAL public entry points (EngineDriver.poll /
// submitProposal / reportConversionFailure / registerAgentTx) instead of the
// `selectNext` pure function, because the mapping's fairness, liveness and
// fail-closed claims are about what a shell actually observes, not about the
// selector in isolation. Each durable-predicate test also carries a positive
// control so a green assertion cannot be vacuous.

const LEAD_DRAFT = {
	kind: "lead",
	leadId: "lead-a",
	instanceId: "instance-1",
	sessionBinding: testSessionBinding("instance-1"),
} as const;

function setConfig(fixture: EngineFixture, key: string, value: string): void {
	fixture.kernel.write("qa.set-config", (tx) => {
		tx.cas("UPDATE config SET value=@value WHERE key=@key", { key, value });
	});
}

describe("QA FLY-1499 — config is the single durable truth", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;

	afterEach(() => {
		try {
			driver?.stop();
		} catch {
			// ignore
		}
		fixture?.cleanup();
		driver = undefined;
		fixture = undefined;
	});

	it("reflects a durable poll_interval_ms change in the very next empty result", async () => {
		fixture = makeEngineFixture();
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.registerLead("lead-a", LEAD_DRAFT, async () => ({
			ok: true,
			effects: [],
		}));
		await driver.drain("lead-a");
		expect(driver.poll("lead-a")).toEqual({
			status: "empty",
			retryAfterMs: 1_000,
		});

		setConfig(fixture, "mailbox.poll_interval_ms", "2500");
		expect(driver.poll("lead-a")).toEqual({
			status: "empty",
			retryAfterMs: 2_500,
		});
	});
});

describe("QA FLY-1499 — liveness without doorbell, timer or watchdog", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;

	afterEach(() => {
		try {
			driver?.stop();
		} catch {
			// ignore
		}
		fixture?.cleanup();
		driver = undefined;
		fixture = undefined;
	});

	it("keeps a cold-start address durably detectable until it registers", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "lead-cold",
			agentKind: "lead",
		});

		const coldStart = () =>
			fixture?.kernel.read((tx) => {
				const ageMs = Number(
					tx.get<{ value: string }>(
						"SELECT value FROM config WHERE key='mailbox.cold_start_alert_after_ms'",
					)?.value,
				);
				return tx
					.all<{ agent_id: string }>(
						`SELECT a.agent_id FROM agents a
						 WHERE a.generation=0 AND a.state='offline'
						   AND EXISTS(SELECT 1 FROM mailbox m
						              WHERE m.to_agent=a.agent_id AND m.state='pending'
						                AND m.created_at <= @cutoff)`,
						{
							cutoff: new Date(
								(fixture?.clock.nowMs() ?? 0) - ageMs,
							).toISOString(),
						},
					)
					.map((row) => row.agent_id);
			});

		expect(coldStart()).toEqual([]);
		fixture.clock.advance(5 * 60_000);
		expect(coldStart()).toEqual(["lead-cold"]);

		fixture.kernel.write("qa.cold-start-registers", (tx) =>
			registerAgentTx(tx, fixture?.runtime as never, "lead-cold", {
				kind: "lead",
				leadId: "lead-cold",
				instanceId: "instance-cold",
				sessionBinding: testSessionBinding("instance-cold"),
			}),
		);
		expect(coldStart()).toEqual([]);
	});
});

describe("QA FLY-1499 — deleted disposal semantics stay deleted at runtime", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;

	afterEach(() => {
		try {
			driver?.stop();
		} catch {
			// ignore
		}
		fixture?.cleanup();
		driver = undefined;
		fixture = undefined;
	});

	it("structurally rejects the removed tombstoned mailbox state", () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		expect(() =>
			fixture?.kernel.write("qa.try-tombstone", (tx) => {
				tx.run("UPDATE mailbox SET state='tombstoned' WHERE message_uid='m1'");
			}),
		).toThrow(/CHECK constraint failed/);
	});
});

describe("QA FLY-1499 — admission boundary is really typed and FK-backed", () => {
	let fixture: EngineFixture | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it("keeps the recipient trigger as the last line of defense under a raw insert", () => {
		fixture = makeEngineFixture();
		// enqueue() rejects unknown recipients itself; this asserts the structural
		// backstop the mapping relies on when a future writer bypasses that check.
		expect(() =>
			fixture?.kernel.write("qa.raw-unknown-recipient", (tx) => {
				tx.run(
					`INSERT INTO mailbox
					 (message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
					  retention_class,cutover_epoch,state,retry_count,created_at)
					 VALUES ('x','lead','sx','{}','digest','nobody','instruction','business',
					  1,'pending',0,@now)`,
					{ now: fixture?.clock.nowIso() },
				);
			}),
		).toThrow(/mailbox recipient must be a lead or an active session/);
	});

	it("measures notice admission against the recipient's whole pending backlog", () => {
		fixture = makeEngineFixture();
		provisionAgentRecipient(fixture.kernel, "lead-a", "lead");
		setConfig(fixture, "mailbox.notice_pending_limit", "2");
		const post = (sourceId: string, retentionClass: "business" | "notice") =>
			enqueue(fixture?.kernel as Kernel, fixture?.runtime as never, {
				sourceKind: "lead",
				sourceId,
				payload: "{}",
				toAgent: "lead-a",
				kind: "instruction",
				retentionClass,
				expectedCutoverEpoch: 1,
			});

		for (const id of ["biz-1", "biz-2", "biz-3"]) {
			expect(post(id, "business").status).toBe("enqueued");
		}
		// Documented consequence of counting every pending row: a business backlog
		// above the notice水位 throttles notices for that recipient. Business itself
		// is never throttled by the same水位 — asserted immediately below.
		expect(post("notice-1", "notice")).toEqual({
			status: "rejected",
			reason: "overload",
		});
		expect(post("biz-4", "business").status).toBe("enqueued");
	});
});

describe("QA FLY-1499 — one message is converted exactly once", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;

	afterEach(() => {
		try {
			driver?.stop();
		} catch {
			// ignore
		}
		fixture?.cleanup();
		driver = undefined;
		fixture = undefined;
	});

	it("does not re-convert an in-flight lead message when the shell polls with a stale uid", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		let release: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const converter = vi.fn(async () => {
			await blocked;
			return { ok: true as const, effects: [] };
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.registerLead("lead-a", LEAD_DRAFT, converter);
		await vi.waitFor(() => expect(converter).toHaveBeenCalledTimes(1));

		// A shell that lost track of its own attempt uid must be handed the same
		// in-flight attempt back (documented stale-hint behaviour), never a second
		// message and never a second conversion of the same one.
		const stale = driver.poll("lead-a", "does-not-exist#9");
		expect(stale.status).toBe("available");
		if (stale.status !== "available") throw new Error("unreachable");
		expect(stale.handle.attemptUid).toBe("m1#1");
		expect(stale.resumed).toBe(true);
		expect(converter).toHaveBeenCalledTimes(1);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM processing_attempts",
					)?.count,
			),
		).toBe(1);

		release?.();
		await driver.drain("lead-a");
		expect(converter).toHaveBeenCalledTimes(1);
		expect(
			fixture.kernel.read((tx) => ({
				mailbox: tx.get<{ state: string }>(
					"SELECT state FROM mailbox WHERE message_uid='m1'",
				)?.state,
				applied: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='mailbox.applied'",
				)?.count,
			})),
		).toEqual({ mailbox: "applied", applied: 1 });
	});
});
