import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	dispatchOnce,
	ringSessionDoorbells,
	type SpawnRequest,
} from "../index.js";
import { appendMailboxTx } from "../mailbox-append.js";
import { makeFixture, makePorts } from "./helpers.js";

async function dispatchedFixture(fixture: ReturnType<typeof makeFixture>) {
	fixture.provision("lead-a", "lead");
	const { ports } = makePorts(fixture.clock);
	await admitIssueDag(fixture.kernel, ports, {
		admissionUid: "doorbell-admission",
		projectId: "project-a",
		issueId: "FLY-BELL",
		notifyAgentId: "lead-a",
		shipWorktreeId: "wt-a",
		worktrees: [
			{
				worktreeId: "wt-a",
				repoIdentity: "owner/repo",
				worktreePath: "/tmp/doorbell-wt",
				branchRef: "refs/heads/feat/bell",
				mergeTargetRef: "refs/heads/main",
			},
		],
		tasks: [
			{
				localId: "implement",
				kindLabel: "implement",
				contract: [{ kind: "verdict" }],
				writesRepo: true,
				worktreeId: "wt-a",
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
	const attempt = (await dispatchOnce(fixture.kernel, ports))
		.dispatched[0] as SpawnRequest;
	return { ports, attempt };
}

function enqueueToSession(
	fixture: ReturnType<typeof makeFixture>,
	sessionRef: string,
	sourceId: string,
	body: string,
) {
	return fixture.kernel.write("test.enqueue-session", (tx) => {
		const epoch = Number(
			tx.get<{ value: string }>(
				"SELECT value FROM meta WHERE key='cutover_epoch'",
			)?.value,
		);
		return appendMailboxTx(tx, {
			sourceKind: "test_ask_response",
			sourceId,
			toAgent: sessionRef,
			kind: "ask_response",
			payload: { v: 1, uid: sourceId, body },
			retentionClass: "business",
			cutoverEpoch: epoch,
			createdAt: fixture.clock.nowIso(),
		});
	});
}

describe("FLY-1547 doorbell — the bell announces, never carries, never settles", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("rings a pointer-only bell, leaves the row pending, and dedups on the seq high-water", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const { ports, attempt } = await dispatchedFixture(fixture);
		const messageUid = enqueueToSession(
			fixture,
			attempt.sessionRef,
			"reply-1",
			"Run pnpm -r build.",
		);
		const pasted: Array<{ sessionRef: string; text: string }> = [];
		const bellPorts = {
			...ports,
			sessionDelivery: {
				async paste(sessionRef: string, text: string) {
					pasted.push({ sessionRef, text });
				},
			},
		};

		const result = await ringSessionDoorbells(fixture.kernel, bellPorts);
		expect(result).toMatchObject({ examined: 1, rung: 1, failed: 0 });
		expect(pasted).toHaveLength(1);
		expect(pasted[0]?.sessionRef).toBe(attempt.sessionRef);
		// Pointer only: the bell names the debt, never the body.
		expect(pasted[0]?.text).toContain("mailbox bell");
		expect(pasted[0]?.text).toContain("kind=ask_response");
		expect(pasted[0]?.text).not.toContain("Run pnpm -r build.");
		// The row stays PENDING — settlement belongs to next/settle alone.
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM mailbox WHERE message_uid=@uid",
						{ uid: messageUid },
					)?.state,
			),
		).toBe("pending");
		expect(
			fixture.kernel.read((tx) =>
				tx.get("SELECT 1 FROM events WHERE kind='session_bell_rung'"),
			),
		).toBeTruthy();

		// Same high-water, not overdue → silent. New mail (higher seq) → rings.
		const again = await ringSessionDoorbells(fixture.kernel, bellPorts);
		expect(again).toMatchObject({ examined: 1, rung: 0 });
		expect(pasted).toHaveLength(1);
		enqueueToSession(fixture, attempt.sessionRef, "reply-1b", "more");
		const third = await ringSessionDoorbells(fixture.kernel, bellPorts);
		expect(third).toMatchObject({ examined: 1, rung: 1 });
		expect(pasted).toHaveLength(2);
	});

	it("rings a remote-attached codex session through its daemon with the stable effect key", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const { ports, attempt } = await dispatchedFixture(fixture);
		enqueueToSession(fixture, attempt.sessionRef, "reply-cx", "body");
		const bells: Array<{ text: string; key: string }> = [];
		const pasted: string[] = [];
		const bellPorts = {
			...ports,
			sessionDelivery: {
				async paste(_sessionRef: string, text: string) {
					pasted.push(text);
				},
				async codexBell(_sessionRef: string, text: string, key: string) {
					bells.push({ text, key });
					return true;
				},
			},
		};
		expect(await ringSessionDoorbells(fixture.kernel, bellPorts)).toMatchObject(
			{ examined: 1, rung: 1 },
		);
		expect(pasted).toEqual([]);
		expect(bells).toHaveLength(1);
		expect(bells[0]?.text).toContain("mailbox bell");
		expect(bells[0]?.text).not.toContain("body");
		expect(bells[0]?.key).toMatch(/^bell:v2dag:.*:\d+$/);
		// The event names the official channel and the row is still pending.
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ payload: string }>(
					"SELECT payload FROM events WHERE kind='session_bell_rung'",
				),
			)?.payload,
		).toContain('"channel":"codex_turn"');
		// A codexBell returning false (no daemon record) falls to the paste.
		enqueueToSession(fixture, attempt.sessionRef, "reply-cx2", "more");
		bellPorts.sessionDelivery.codexBell = async () => false;
		expect(await ringSessionDoorbells(fixture.kernel, bellPorts)).toMatchObject(
			{ examined: 1, rung: 1 },
		);
		expect(pasted).toHaveLength(1);
	});

	it("defers to a healthy official channel without advancing the cursor", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const { ports, attempt } = await dispatchedFixture(fixture);
		enqueueToSession(fixture, attempt.sessionRef, "reply-ch", "body");
		const pasted: string[] = [];
		let healthy = true;
		const bellPorts = {
			...ports,
			sessionDelivery: {
				async paste(_sessionRef: string, text: string) {
					pasted.push(text);
				},
				async channelHealthy() {
					return healthy;
				},
			},
		};
		expect(await ringSessionDoorbells(fixture.kernel, bellPorts)).toMatchObject(
			{ examined: 1, deferred: 1, rung: 0 },
		);
		expect(pasted).toEqual([]);
		// Lease dies later → the SAME debt now rings as last resort.
		healthy = false;
		expect(await ringSessionDoorbells(fixture.kernel, bellPorts)).toMatchObject(
			{ examined: 1, rung: 1 },
		);
		expect(pasted).toHaveLength(1);
	});

	it("caps overdue re-rings at 5 per high-water, records one event, and letters stay pending", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const { ports, attempt } = await dispatchedFixture(fixture);
		const messageUid = enqueueToSession(
			fixture,
			attempt.sessionRef,
			"reply-cap",
			"unanswered",
		);
		const pasted: string[] = [];
		const bellPorts = {
			...ports,
			sessionDelivery: {
				async paste(_sessionRef: string, text: string) {
					pasted.push(text);
				},
			},
		};
		// Initial ring + 5 overdue re-rings = 6 pastes, then silence forever.
		for (let round = 0; round < 9; round++) {
			await ringSessionDoorbells(fixture.kernel, bellPorts);
			fixture.clock.advance(301_000);
		}
		expect(pasted).toHaveLength(6);
		expect(
			fixture.kernel.read((tx) =>
				tx.get("SELECT 1 FROM events WHERE kind='session_bell_rering_capped'"),
			),
		).toBeTruthy();
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM mailbox WHERE message_uid=@uid",
						{ uid: messageUid },
					)?.state,
			),
		).toBe("pending");
		// New mail (advancing high-water) resets the budget and rings again.
		enqueueToSession(fixture, attempt.sessionRef, "reply-cap2", "new debt");
		await ringSessionDoorbells(fixture.kernel, bellPorts);
		expect(pasted).toHaveLength(7);
	});

	it("keeps the row pending with one visible event when the paste fails, and rings again", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const { ports, attempt } = await dispatchedFixture(fixture);
		const messageUid = enqueueToSession(
			fixture,
			attempt.sessionRef,
			"reply-2",
			"still there?",
		);
		let attempts = 0;
		const bellPorts = {
			...ports,
			sessionDelivery: {
				async paste() {
					attempts += 1;
					throw new Error("tmux runner session is absent");
				},
			},
		};
		expect(await ringSessionDoorbells(fixture.kernel, bellPorts)).toMatchObject(
			{ examined: 1, rung: 0, failed: 1 },
		);
		expect(await ringSessionDoorbells(fixture.kernel, bellPorts)).toMatchObject(
			{ examined: 1, failed: 1 },
		);
		expect(attempts).toBe(2);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM mailbox WHERE message_uid=@uid",
						{ uid: messageUid },
					)?.state,
			),
		).toBe("pending");
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM events WHERE kind='session_bell_failed'",
					)?.count,
			),
		).toBe(1);
	});

	it("leaves a row alone when a processing attempt already owns it", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const { ports, attempt } = await dispatchedFixture(fixture);
		const messageUid = enqueueToSession(
			fixture,
			attempt.sessionRef,
			"reply-3",
			"pulled concurrently",
		);
		fixture.kernel.write("test.claim-attempt", (tx) => {
			tx.run(
				`INSERT INTO processing_attempts
				 (attempt_uid,message_uid,attempt_no,instance_id,generation,started_at)
				 VALUES(@attemptUid,@messageUid,1,@instanceId,1,@now)`,
				{
					attemptUid: `${messageUid}#1`,
					messageUid,
					instanceId: attempt.sessionRef,
					now: fixture.clock.nowIso(),
				},
			);
		});
		const pasted: string[] = [];
		const bellPorts = {
			...ports,
			sessionDelivery: {
				async paste(_sessionRef: string, text: string) {
					pasted.push(text);
				},
			},
		};
		const result = await ringSessionDoorbells(fixture.kernel, bellPorts);
		expect(result).toMatchObject({ examined: 0, rung: 0 });
		expect(pasted).toEqual([]);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM mailbox WHERE message_uid=@uid",
						{ uid: messageUid },
					)?.state,
			),
		).toBe("pending");
	});
});
