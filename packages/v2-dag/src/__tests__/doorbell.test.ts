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

describe("FLY-1544 doorbell — lead→runner mail is pasted, then settled", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("pastes pending session mail into the terminal and settles the row", async () => {
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
		expect(result).toMatchObject({ examined: 1, pasted: 1, failed: 0 });
		expect(pasted).toHaveLength(1);
		expect(pasted[0]?.sessionRef).toBe(attempt.sessionRef);
		expect(pasted[0]?.text).toContain("kind=ask_response");
		expect(pasted[0]?.text).toContain("do NOT submit/ack");
		expect(pasted[0]?.text).toContain("Run pnpm -r build.");
		// 贴完销账: the row is applied, and the event trail shows the paste.
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM mailbox WHERE message_uid=@uid",
						{ uid: messageUid },
					)?.state,
			),
		).toBe("applied");
		expect(
			fixture.kernel.read((tx) =>
				tx.get("SELECT 1 FROM events WHERE event_uid=@uid", {
					uid: `session_mail_pasted:${messageUid}`,
				}),
			),
		).toBeTruthy();

		// The spawn assignment row is NEVER pasted (spawn-prompt-embedded) and a
		// second ring finds nothing new.
		const again = await ringSessionDoorbells(fixture.kernel, bellPorts);
		expect(again).toMatchObject({ examined: 0, pasted: 0 });
		expect(pasted).toHaveLength(1);
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
			{ examined: 1, pasted: 0, failed: 1 },
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
						"SELECT count(*) AS count FROM events WHERE kind='session_mail_paste_failed'",
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
		expect(result).toMatchObject({ examined: 0, pasted: 0 });
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
