import { registerAgentTx } from "flywheel-v2-engine";
import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	dispatchOnce,
	ringSessionDoorbells,
	type SpawnRequest,
} from "../index.js";
import { appendMailboxTx } from "../mailbox-append.js";
import { makeFixture, makePorts } from "./helpers.js";

/** FLY-1563: a lead recipient becomes bell-addressable by REGISTERING — the
 * agents row carries the session binding whose pid locates its tmux pane. */
function registerLead(
	fixture: ReturnType<typeof makeFixture>,
	leadId: string,
	pid = 4242,
) {
	fixture.kernel.write("test.register-lead", (tx) => {
		registerAgentTx(tx, { clock: fixture.clock }, leadId, {
			kind: "lead",
			leadId,
			instanceId: `${leadId}-instance-1`,
			sessionBinding: {
				v: 1,
				hostEpoch: "host-1",
				sessionId: `${leadId}-claude-session`,
				pid,
				pidStart: `start:${leadId}`,
			},
		});
	});
}

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

	// ------------------------------------------------------------------
	// FLY-1563 ③: the bell reaches LEAD recipients — a runner ask must wake
	// the lead through its own pane/channel, never wait for a patrol.
	// ------------------------------------------------------------------

	it("rings a registered lead through its pane pid with the lead-form pointer", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const { ports } = makePorts(fixture.clock);
		registerLead(fixture, "lead-bell", 91274);
		const messageUid = enqueueToSession(
			fixture,
			"lead-bell",
			"ask-1",
			"which port should the QA slot use?",
		);
		const leadPastes: Array<{
			agentId: string;
			pid: number;
			pidStart: string;
			text: string;
		}> = [];
		const pasted: string[] = [];
		const codexBells: string[] = [];
		const bellPorts = {
			...ports,
			sessionDelivery: {
				async paste(_sessionRef: string, text: string) {
					pasted.push(text);
				},
				async leadPaste(
					agentId: string,
					pid: number,
					pidStart: string,
					text: string,
				) {
					leadPastes.push({ agentId, pid, pidStart, text });
				},
				async codexBell(_sessionRef: string, text: string, _key: string) {
					codexBells.push(text);
					return true;
				},
			},
		};
		const result = await ringSessionDoorbells(fixture.kernel, bellPorts);
		expect(result).toMatchObject({ examined: 1, rung: 1, failed: 0 });
		// The lead route is the lead pane — never the runner session name, and
		// never the codex daemon turn (that channel is session-scoped).
		expect(pasted).toEqual([]);
		expect(codexBells).toEqual([]);
		expect(leadPastes).toHaveLength(1);
		expect(leadPastes[0]?.agentId).toBe("lead-bell");
		expect(leadPastes[0]?.pid).toBe(91274);
		// The binding's start identity travels with the pid (pid reuse guard).
		expect(leadPastes[0]?.pidStart).toBe("start:lead-bell");
		// Pointer only, in the LEAD pull form (a lead has no session ref).
		expect(leadPastes[0]?.text).toContain("mailbox bell");
		expect(leadPastes[0]?.text).toContain("kind=ask_response");
		expect(leadPastes[0]?.text).not.toContain("FLYWHEEL_V2_SESSION_REF");
		expect(leadPastes[0]?.text).toContain("--agent");
		expect(leadPastes[0]?.text).not.toContain("which port");
		// The row stays pending; the wake record is durable.
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
				tx.get<{ payload: string }>(
					`SELECT payload FROM events
					  WHERE kind='session_bell_rung' AND source_id='lead-bell'`,
				),
			)?.payload,
		).toContain('"channel":"lead_paste"');
		// Same high-water → silent; new mail → rings again.
		expect(await ringSessionDoorbells(fixture.kernel, bellPorts)).toMatchObject(
			{ examined: 1, rung: 0 },
		);
		enqueueToSession(fixture, "lead-bell", "ask-2", "more");
		expect(await ringSessionDoorbells(fixture.kernel, bellPorts)).toMatchObject(
			{ examined: 1, rung: 1 },
		);
		expect(leadPastes).toHaveLength(2);
	});

	it("defers a lead bell to a healthy official channel", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const { ports } = makePorts(fixture.clock);
		registerLead(fixture, "lead-ch");
		enqueueToSession(fixture, "lead-ch", "ask-ch", "body");
		const leadPastes: string[] = [];
		let healthy = true;
		const bellPorts = {
			...ports,
			sessionDelivery: {
				async paste() {},
				async leadPaste(
					_agentId: string,
					_pid: number,
					_pidStart: string,
					text: string,
				) {
					leadPastes.push(text);
				},
				async channelHealthy() {
					return healthy;
				},
			},
		};
		expect(await ringSessionDoorbells(fixture.kernel, bellPorts)).toMatchObject(
			{ examined: 1, deferred: 1, rung: 0 },
		);
		expect(leadPastes).toEqual([]);
		healthy = false;
		expect(await ringSessionDoorbells(fixture.kernel, bellPorts)).toMatchObject(
			{ examined: 1, rung: 1 },
		);
		expect(leadPastes).toHaveLength(1);
	});

	it("never rings a provisioned-only lead (no registration binding)", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const { ports } = makePorts(fixture.clock);
		fixture.provision("lead-unbound", "lead");
		enqueueToSession(fixture, "lead-unbound", "ask-ub", "body");
		const leadPastes: string[] = [];
		const bellPorts = {
			...ports,
			sessionDelivery: {
				async paste() {},
				async leadPaste(
					_agentId: string,
					_pid: number,
					_pidStart: string,
					text: string,
				) {
					leadPastes.push(text);
				},
			},
		};
		expect(await ringSessionDoorbells(fixture.kernel, bellPorts)).toMatchObject(
			{ examined: 0, rung: 0 },
		);
		expect(leadPastes).toEqual([]);
	});

	it("fails loud when the delivery port cannot paste to a lead pane", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const { ports } = makePorts(fixture.clock);
		registerLead(fixture, "lead-noport");
		const messageUid = enqueueToSession(
			fixture,
			"lead-noport",
			"ask-np",
			"body",
		);
		const bellPorts = {
			...ports,
			sessionDelivery: {
				async paste() {
					throw new Error("must not fall back to the runner session route");
				},
			},
		};
		expect(await ringSessionDoorbells(fixture.kernel, bellPorts)).toMatchObject(
			{ examined: 1, rung: 0, failed: 1 },
		);
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
						`SELECT count(*) AS count FROM events
						  WHERE kind='session_bell_failed' AND source_id='lead-noport'`,
					)?.count,
			),
		).toBe(1);
	});
});
