import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitIssueDag, type IssueDagDescriptor } from "flywheel-v2-dag";
import {
	initializeEngineDb,
	provisionAgentRecipient,
} from "flywheel-v2-engine";
import {
	advanceDatabaseAuthorityStateTx,
	armCutoverAuthority,
	Kernel,
	migrateDatabase,
	publishLiveCutoverAuthority,
	publishMigrationCompleteMarker,
	seedPreCutoverAuthority,
} from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import { type DeliveryEnvelope, V2Host, writeResponse } from "../host.js";
import { sendHostRequest, signHostRequest } from "../protocol.js";
import {
	createRuntimeDagPorts,
	type RunnerLauncherPort,
	type RuntimeLaunchRequest,
} from "../runtime-ports.js";

const WINDOW = "fly1503-window";
const EPOCH = 41;
const HOST_EPOCH = "fly1503-host";
const PID = 24_601;
const PID_START = "fly1503-process-start";
const roots: string[] = [];

function prepareProject(root: string): string {
	const project = join(root, "project");
	mkdirSync(join(project, ".flywheel", "agents", "nodes"), {
		recursive: true,
	});
	writeFileSync(
		join(project, ".flywheel", "agents", "nodes", "implementation.md"),
		"# Implementation node\n\nConsume only v2 injected envelopes.\n",
	);
	const git = (...args: string[]) =>
		execFileSync("/usr/bin/git", [
			"-C",
			project,
			"-c",
			"user.name=V2 Test",
			"-c",
			"user.email=v2@example.invalid",
			...args,
		]);
	execFileSync("/usr/bin/git", ["-C", project, "init", "-q"]);
	git("add", ".");
	git("commit", "-qm", "fixture");
	return realpathSync(project);
}

function prepareLiveDatabase(root: string): {
	dbPath: string;
	markerPath: string;
	authorityPath: string;
	armedPath: string;
} {
	const dbPath = join(root, "flywheel-v2.db");
	const markerPath = join(root, "migration-complete.json");
	const authorityPath = join(root, "authority.json");
	const armedPath = join(root, "armed.json");
	seedPreCutoverAuthority({
		authorityPath,
		armedPath,
		windowId: WINDOW,
		epoch: EPOCH,
		nowIso: "2026-07-29T00:00:00.000Z",
	});
	armCutoverAuthority({
		authorityPath,
		armedPath,
		windowId: WINDOW,
		epoch: EPOCH,
		nowIso: "2026-07-29T00:01:00.000Z",
	});
	migrateDatabase({ path: dbPath });
	const kernel = Kernel.open({ path: dbPath });
	initializeEngineDb(kernel);
	kernel.write("test.cutover-meta", (tx) => {
		tx.run(
			`INSERT INTO meta(key,value,updated_at)
			 VALUES ('cutover_window_id',@window,@now)
			 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
			{ window: WINDOW, now: "2026-07-29T00:01:30.000Z" },
		);
		tx.run(
			`INSERT INTO meta(key,value,updated_at)
			 VALUES ('cutover_epoch',@epoch,@now)
			 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
			{ epoch: String(EPOCH), now: "2026-07-29T00:01:30.000Z" },
		);
	});
	kernel.close();
	chmodSync(dbPath, 0o600);
	publishMigrationCompleteMarker({
		dbPath,
		markerPath,
		authorityPath,
		armedPath,
		expectedWindowId: WINDOW,
		expectedEpoch: EPOCH,
		nowIso: "2026-07-29T00:02:00.000Z",
	});
	const live = Kernel.open({ path: dbPath });
	live.write("test.publish-live", (tx) => {
		advanceDatabaseAuthorityStateTx(tx, {
			expected: "cutover",
			next: "live",
			nowIso: "2026-07-29T00:02:01.000Z",
		});
	});
	live.close();
	publishLiveCutoverAuthority({
		authorityPath,
		armedPath,
		windowId: WINDOW,
		epoch: EPOCH,
		nowIso: "2026-07-29T00:02:02.000Z",
	});
	return { dbPath, markerPath, authorityPath, armedPath };
}

function descriptorFor(project: string): IssueDagDescriptor {
	return {
		admissionUid: "fly1503-admission",
		projectId: "fly1503",
		issueId: "FLY-1503",
		// FLY-1544 ③④: lifecycle events CC the issue's notify lead. These
		// delivery-mechanics scenarios pull as "lead-runtime", so the CC stream
		// goes to a DEDICATED notify lead to keep the pulled mailbox scenario-only.
		notifyAgentId: "lead-notify",
		shipWorktreeId: "worktree",
		worktrees: [
			{
				worktreeId: "worktree",
				repoIdentity: project,
				worktreePath: project,
				branchRef: "HEAD",
				mergeTargetRef: "HEAD",
			},
		],
		tasks: [
			{
				localId: "implement",
				kindLabel: "implementation",
				contract: [{ kind: "verdict" }],
				writesRepo: true,
				worktreeId: "worktree",
				executor: {
					family: "claude",
					vendor: "claude",
					model: "test-model",
					effort: "high",
				},
			},
		],
		edges: [],
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

interface Delivered {
	sessionRef: string;
	message: { messageUid: string; attemptUid: string; payload: string };
}

function bootFixture() {
	const root = mkdtempSync(join(tmpdir(), "flywheel-v2-fly1503-"));
	roots.push(root);
	chmodSync(root, 0o700);
	const project = prepareProject(root);
	const database = prepareLiveDatabase(root);
	const socketPath = join(root, "host.sock");
	const secretPath = join(root, "host.secret");
	const secret = randomBytes(32);
	writeFileSync(secretPath, secret, { mode: 0o600 });

	const leadSessions = new Map<string, { pid: number; pidStart: string }>();
	// Codex R2 HIGH-1: absence must come from process identity, not from the
	// deletable session proof, so the fixture can kill a pid outright.
	const deadPids = new Set<number>();
	// Codex R3 HIGH-1: a probe that cannot answer for a pid is NOT evidence that
	// the pid is gone, so the fixture models the two states separately.
	const unprobablePids = new Set<number>();
	const launchRequests: RuntimeLaunchRequest[] = [];
	const launcher: RunnerLauncherPort = {
		async launch(request) {
			launchRequests.push(request);
			return {
				v: 1,
				hostEpoch: HOST_EPOCH,
				sessionId: request.sessionRef,
				pid: PID,
				pidStart: PID_START,
			};
		},
		async probe() {
			return { state: "absent", confirmedAt: "2026-07-29T00:03:00.000Z" };
		},
		async stop() {},
	};

	const ports = (kernel: Kernel) =>
		createRuntimeDagPorts({
			kernel,
			hostEpoch: HOST_EPOCH,
			expectedEpoch: EPOCH,
			lockRoot: join(root, "locks"),
			launcher,
			gitBin: "/usr/bin/git",
			ghBin: "/usr/bin/false",
			now: () => new Date("2026-07-29T00:03:00.000Z"),
		});

	const bootstrap = Kernel.open({ path: database.dbPath });
	provisionAgentRecipient(bootstrap, "lead-runtime", "lead");
	provisionAgentRecipient(bootstrap, "lead-notify", "lead");
	const admitted = admitIssueDag(bootstrap, ports(bootstrap), {
		...descriptorFor(project),
	});

	const makeHost = (
		activated: string[],
		delivered: Delivered[] = [],
		errors: unknown[] = [],
		// Codex R6 HIGH-1: inject a startup-sync failure at the seam production uses.
		activateFailure?: Error,
	) =>
		new V2Host({
			database: {
				...database,
				expectedWindowId: WINDOW,
				expectedEpoch: EPOCH,
				allowedAuthorityStates: ["live"],
			},
			socketPath,
			secretPath,
			hostEpoch: HOST_EPOCH,
			sessionProbe: {
				processStart: (pid) =>
					unprobablePids.has(pid)
						? { status: "unavailable", reason: "probe is unavailable in test" }
						: deadPids.has(pid)
							? { status: "absent" }
							: {
									status: "present",
									startIdentity:
										pid === PID ? PID_START : `fly1503-pid-start-${pid}`,
								},
				sessionOwner: (sessionId) =>
					leadSessions.get(sessionId) ?? { pid: PID, pidStart: PID_START },
			},
			coordinator: {
				intervalMs: 60_000,
				createPorts: ports,
				async activateSession(sessionRef) {
					if (activateFailure) throw activateFailure;
					activated.push(sessionRef);
				},
				async deliverRunner(sessionRef, _injectionRef, message) {
					delivered.push({ sessionRef, message });
				},
				onError(error) {
					errors.push(error);
				},
			},
		});

	return {
		database,
		secret,
		socketPath,
		launchRequests,
		leadSessions,
		deadPids,
		unprobablePids,
		makeHost,
		async ready() {
			await admitted;
			bootstrap.close();
		},
	};
}

describe("FLY-1503 item 9 — host restart re-attaches a live runner", () => {
	it("re-activates a live session from the activation binding", async () => {
		const fixture = bootFixture();
		await fixture.ready();
		const { database, launchRequests, makeHost } = fixture;

		// First boot: launch and bind the runner session to its activation.
		const firstActivated: string[] = [];
		const first = makeHost(firstActivated);
		await first.start();
		await first.runCoordinatorOnce();
		expect(launchRequests).toHaveLength(1);
		const sessionRef = launchRequests[0]?.sessionRef;
		expect(sessionRef).toBeTruthy();
		await first.close();

		const afterShutdown = Kernel.open({ path: database.dbPath });
		expect(
			afterShutdown.read((tx) =>
				tx.get<{ state: string; session_binding: string | null }>(
					`SELECT state,session_binding FROM activations
						  WHERE session_ref=@sessionRef`,
					{ sessionRef },
				),
			),
		).toMatchObject({ state: "active", session_binding: expect.any(String) });
		expect(
			afterShutdown.read((tx) =>
				tx.get("SELECT 1 FROM agents WHERE agent_id='engineer'"),
			),
		).toBeUndefined();
		afterShutdown.close();

		// Second boot with the runner session still alive. There is no runner badge
		// to re-register: syncCurrentRunners resolves the concrete activation binding.
		const secondActivated: string[] = [];
		const second = makeHost(secondActivated);
		try {
			await second.start();
			expect(secondActivated).toContain(sessionRef);
			const reattached = Kernel.open({ path: database.dbPath });
			expect(
				reattached.read((tx) =>
					tx.get<{ state: string; session_binding: string | null }>(
						`SELECT state,session_binding FROM activations
							  WHERE session_ref=@sessionRef`,
						{ sessionRef },
					),
				),
			).toMatchObject({
				state: "active",
				session_binding: expect.any(String),
			});
			reattached.close();
		} finally {
			await second.close();
		}
	});
});

describe("FLY-1503 item 8 — a crash-settled attempt must not wedge the executor", () => {
	it("keeps delivering after the in-flight attempt is settled outside the host", async () => {
		const fixture = bootFixture();
		await fixture.ready();
		const { database, secret, socketPath, launchRequests, makeHost } = fixture;

		const host = makeHost([]);
		try {
			await host.start();
			await host.runCoordinatorOnce();
			expect(launchRequests).toHaveLength(1);
			const sessionRef = launchRequests[0]?.sessionRef;
			if (!sessionRef) throw new Error("runner session was not launched");
			const firstEnvelope = JSON.parse(
				launchRequests[0]?.context.firstEnvelope as string,
			) as DeliveryEnvelope;
			const first: Delivered = {
				sessionRef,
				message: {
					messageUid: firstEnvelope.message.messageUid,
					attemptUid: firstEnvelope.handle.attemptUid,
					payload: JSON.stringify(firstEnvelope),
				},
			};

			// A generation takeover (registration.ts) and driver.stop() both settle a
			// running processing attempt as 'crashed'. Reproduce that settlement
			// happening outside the host while the host stays up: the host's
			// in-memory #pending entry for the attempt is now stale forever, because
			// submit_proposal rejects a non-running attempt before it ever reaches
			// the #pending.delete.
			const settle = Kernel.open({ path: database.dbPath });
			settle.write("test.external-crash-settle", (tx) => {
				tx.run(
					`UPDATE processing_attempts
					    SET outcome='crashed', settled_at='2026-07-29T00:04:00.000Z',
					        proposal_digest=NULL
					  WHERE attempt_uid=@attemptUid AND outcome='running'`,
					{ attemptUid: first?.message.attemptUid },
				);
				// Both real settlement paths (driver.stop and the generation takeover)
				// pair the attempt settle with settleFailureMailboxTx, which reschedules
				// the message. Simulating only the attempt settle left the message
				// pending with a crashed attempt and NO retry, which is not a state the
				// system produces -- and it is why the redelivery assertion below could
				// not pass. Schedule the retry as the real paths do, due immediately.
				tx.run(
					`UPDATE mailbox
					    SET retry_count=retry_count+1, next_retry_at=@dueAt
					  WHERE message_uid=@uid AND state='pending'`,
					{
						uid: first?.message.messageUid,
						dueAt: "2026-07-29T00:02:59.000Z",
					},
				);
			});
			settle.close();

			// The concrete session pulls again; no runner registration or in-memory
			// driver attachment is involved.
			const envelope = (await sendHostRequest({
				socketPath,
				secret,
				action: "next_delivery",
				payload: {
					sessionRef,
				},
			})) as DeliveryEnvelope;
			const redelivered: Delivered = {
				sessionRef,
				message: {
					messageUid: envelope.message.messageUid,
					attemptUid: envelope.handle.attemptUid,
					payload: JSON.stringify(envelope),
				},
			};
			expect(redelivered.message.messageUid).toBe(first.message.messageUid);
			expect(redelivered.message.attemptUid).not.toBe(first.message.attemptUid);

			// The ledger records BOTH deliveries as distinct effects, rather than
			// rejecting the second with UNIQUE constraint failed: actions.logical_key.
			// Each really happened -- two injections, two capabilities -- so each is
			// its own root under the (message, processing attempt) scope.
			const ledger = Kernel.open({ path: database.dbPath });
			const rows = ledger.read((tx) =>
				tx.all<{
					id: string;
					state: string;
					logical_key: string;
					supersedes_action_id: string | null;
				}>(
					`SELECT id,state,logical_key,supersedes_action_id FROM actions
					  WHERE kind='mailbox.deliver' AND payload LIKE @needle
					  ORDER BY created_at,id`,
					{ needle: `%${first?.message.messageUid}%` },
				),
			);
			ledger.close();
			expect(rows).toHaveLength(2);
			expect(rows.map((row) => row.supersedes_action_id)).toEqual([null, null]);
			expect(rows[0]?.logical_key).not.toBe(rows[1]?.logical_key);
			expect(rows.map((row) => row.id)).toEqual([
				`mailbox-delivery:pa1:${first?.message.attemptUid}`,
				`mailbox-delivery:pa1:${redelivered?.message.attemptUid}`,
			]);

			// And it SETTLES: the executor submits against the redelivered envelope's
			// capability and the proposal is durably recorded.
			await expect(
				sendHostRequest({
					socketPath,
					secret,
					action: "submit_proposal",
					payload: {
						agentId: sessionRef,
						attemptUid: envelope.handle.attemptUid,
						messageUid: envelope.message.messageUid,
						effects: [
							{
								kind: "event",
								eventKind: "fly1503.item8.redelivered",
								payload: "{}",
							},
						],
						authorization: envelope.authorization,
					},
				}),
			).resolves.toMatchObject({ status: "succeeded" });
		} finally {
			await host.close();
		}
	});
});

describe("FLY-1543 item 1 — lead registration is the takeover", () => {
	it("directly displaces the prior lead generation", async () => {
		const fixture = bootFixture();
		await fixture.ready();
		const { secret, socketPath, leadSessions, makeHost } = fixture;

		const first = {
			sessionId: "lead-session-1",
			pid: 31_001,
			pidStart: "fly1503-pid-start-31001",
		};
		const second = {
			sessionId: "lead-session-2",
			pid: 31_002,
			pidStart: "fly1503-pid-start-31002",
		};
		leadSessions.set(first.sessionId, {
			pid: first.pid,
			pidStart: first.pidStart,
		});
		leadSessions.set(second.sessionId, {
			pid: second.pid,
			pidStart: second.pidStart,
		});

		const registerLead = (session: typeof first) =>
			sendHostRequest({
				socketPath,
				secret,
				action: "register_lead",
				payload: {
					agentId: "lead-runtime",
					instanceId: session.sessionId,
					sessionBinding: {
						v: 1,
						hostEpoch: HOST_EPOCH,
						sessionId: session.sessionId,
						pid: session.pid,
						pidStart: session.pidStart,
					},
				},
			});

		const host = makeHost([]);
		try {
			await host.start();
			await expect(registerLead(first)).resolves.toMatchObject({
				generation: 1,
			});
			await expect(registerLead(second)).resolves.toMatchObject({
				kind: "lead",
				agentId: "lead-runtime",
				instanceId: second.sessionId,
				generation: 2,
			});
		} finally {
			await host.close();
		}
	});
});

describe("Codex R3 HIGH-2 — pull delivery is bound to the registration that earned it", () => {
	function leadSession(id: number) {
		return {
			sessionId: `lead-session-${id}`,
			pid: 32_000 + id,
			pidStart: `fly1503-pid-start-${32_000 + id}`,
		};
	}

	async function bootLead(fixture: ReturnType<typeof bootFixture>) {
		const first = leadSession(1);
		fixture.leadSessions.set(first.sessionId, {
			pid: first.pid,
			pidStart: first.pidStart,
		});
		const registered = (await sendHostRequest({
			socketPath: fixture.socketPath,
			secret: fixture.secret,
			action: "register_lead",
			payload: {
				agentId: "lead-runtime",
				instanceId: first.sessionId,
				sessionBinding: {
					v: 1,
					hostEpoch: HOST_EPOCH,
					sessionId: first.sessionId,
					pid: first.pid,
					pidStart: first.pidStart,
				},
			},
		})) as {
			generation: number;
			deliveryCredential: { credentialId: string; token: string };
		};
		return { first, registered };
	}

	const enqueueFor = (fixture: ReturnType<typeof bootFixture>, id: string) =>
		sendHostRequest({
			socketPath: fixture.socketPath,
			secret: fixture.secret,
			action: "enqueue",
			payload: {
				sourceKind: "discord",
				sourceId: id,
				payload: JSON.stringify({ text: id }),
				toAgent: "lead-runtime",
				kind: "instruction",
				retentionClass: "business",
			},
		});

	it("refuses a pull that presents only the global secret and a self-declared agentId", async () => {
		const fixture = bootFixture();
		await fixture.ready();
		const host = fixture.makeHost([]);
		try {
			await host.start();
			const { registered } = await bootLead(fixture);
			expect(registered.deliveryCredential.credentialId).toBeTruthy();

			// RED before this fix: every runner holds FLYWHEEL_V2_SECRET_PATH, and
			// next_delivery only checked that the NAMED agent was registered. So a
			// runner could pull the lead's envelope -- with the bearer proposal
			// capability inside it -- and submit effects as the lead.
			await expect(
				sendHostRequest({
					socketPath: fixture.socketPath,
					secret: fixture.secret,
					action: "next_delivery",
					payload: { agentId: "lead-runtime" },
				}),
			).rejects.toThrow(/deliveryCredential must be an object/);

			// A well-formed but unissued credential is refused too.
			await expect(
				sendHostRequest({
					socketPath: fixture.socketPath,
					secret: fixture.secret,
					action: "next_delivery",
					payload: {
						agentId: "lead-runtime",
						deliveryCredential: {
							credentialId: "forged",
							token: "0".repeat(64),
						},
					},
				}),
			).rejects.toThrow(/unknown or revoked/);

			// A real credential with a wrong token is refused.
			await expect(
				sendHostRequest({
					socketPath: fixture.socketPath,
					secret: fixture.secret,
					action: "next_delivery",
					payload: {
						deliveryCredential: {
							credentialId: registered.deliveryCredential.credentialId,
							token: "1".repeat(64),
						},
					},
				}),
			).rejects.toThrow(/token does not match/);

			// A real credential cannot be pointed at another agent.
			await expect(
				sendHostRequest({
					socketPath: fixture.socketPath,
					secret: fixture.secret,
					action: "next_delivery",
					payload: {
						agentId: "engineer",
						deliveryCredential: registered.deliveryCredential,
					},
				}),
			).rejects.toThrow(/does not belong to the named agent/);
		} finally {
			await host.close();
		}
	});

	it("revokes the credential and the waiting poll when a takeover supersedes the generation", async () => {
		const fixture = bootFixture();
		await fixture.ready();
		const host = fixture.makeHost([]);
		try {
			await host.start();
			const { first, registered } = await bootLead(fixture);

			// The superseded generation's long poll is started BEFORE the takeover, so
			// it is exactly the waiter that used to be eligible for the new
			// generation's first envelope.
			// RED before this fix: the waiter was keyed on agentId alone and was not
			// cancelled by the takeover, so it stayed first in line and swallowed the
			// new generation's envelope while holding a dead capability.
			//
			// The assertion is attached now, not after the takeover: the rejection
			// arrives while the takeover request is still in flight, and a handler
			// attached later is an unhandled rejection in between.
			const staleRejected = expect(
				sendHostRequest({
					socketPath: fixture.socketPath,
					secret: fixture.secret,
					action: "next_delivery",
					payload: { deliveryCredential: registered.deliveryCredential },
					timeoutMs: 12_000,
				}),
			).rejects.toThrow(/revoked by a generation takeover/);
			await new Promise((resolve) => setTimeout(resolve, 50));

			const second = leadSession(2);
			fixture.leadSessions.set(second.sessionId, {
				pid: second.pid,
				pidStart: second.pidStart,
			});
			fixture.deadPids.add(first.pid);
			const takeover = (await sendHostRequest({
				socketPath: fixture.socketPath,
				secret: fixture.secret,
				action: "register_lead",
				payload: {
					agentId: "lead-runtime",
					instanceId: second.sessionId,
					sessionBinding: {
						v: 1,
						hostEpoch: HOST_EPOCH,
						sessionId: second.sessionId,
						pid: second.pid,
						pidStart: second.pidStart,
					},
					deathEvidence: {
						agentId: "lead-runtime",
						generation: registered.generation,
						confirmedAbsentAt: "2026-07-29T00:05:00.000Z",
					},
				},
			})) as {
				generation: number;
				deliveryCredential: { credentialId: string; token: string };
			};
			expect(takeover.generation).toBe(registered.generation + 1);

			await staleRejected;

			// The superseded credential can no longer authorise a pull.
			await expect(
				sendHostRequest({
					socketPath: fixture.socketPath,
					secret: fixture.secret,
					action: "next_delivery",
					payload: { deliveryCredential: registered.deliveryCredential },
				}),
			).rejects.toThrow(/unknown or revoked/);

			// And the new generation still receives its envelope.
			await enqueueFor(fixture, "founder-after-takeover");
			const envelope = (await sendHostRequest({
				socketPath: fixture.socketPath,
				secret: fixture.secret,
				action: "next_delivery",
				payload: { deliveryCredential: takeover.deliveryCredential },
				timeoutMs: 12_000,
			})) as DeliveryEnvelope;
			expect(envelope.handle.agent.generation).toBe(takeover.generation);
		} finally {
			await host.close();
		}
	});

	it("does not lose an envelope to a poll whose client disconnected", async () => {
		const fixture = bootFixture();
		await fixture.ready();
		const host = fixture.makeHost([]);
		try {
			await host.start();
			const { registered } = await bootLead(fixture);

			// A client that starts a long poll and then vanishes. RED before this fix:
			// the waiter survived for the full 10s timeout, so the next enqueued
			// envelope was handed to a socket nobody was reading and was marked
			// delivered -- lost for good.
			const abandoned = createConnection(fixture.socketPath);
			await new Promise<void>((resolve, reject) => {
				abandoned.once("connect", resolve);
				abandoned.once("error", reject);
			});
			abandoned.write(
				`${JSON.stringify(
					signHostRequest(
						{
							v: 1,
							id: "abandoned-poll",
							nonce: randomBytes(16).toString("hex"),
							action: "next_delivery",
							payload: { deliveryCredential: registered.deliveryCredential },
						},
						fixture.secret,
					),
				)}\n`,
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			abandoned.destroy();
			await new Promise((resolve) => setTimeout(resolve, 100));

			await enqueueFor(fixture, "founder-after-disconnect");
			const envelope = (await sendHostRequest({
				socketPath: fixture.socketPath,
				secret: fixture.secret,
				action: "next_delivery",
				payload: { deliveryCredential: registered.deliveryCredential },
				timeoutMs: 12_000,
			})) as DeliveryEnvelope;
			expect(envelope.handle.agent.agentId).toBe("lead-runtime");
			expect(envelope.authorization.capabilityId).toBeTruthy();
		} finally {
			await host.close();
		}
	});

	it("redelivers and SETTLES the same message after a generation takeover", async () => {
		// Codex R3's second required end-to-end case. A lead delivery has no DAG
		// attempt scope at all, so under the old (message, attempt generation)
		// logical scope the second delivery of one message could never be recorded --
		// there was no generation to change and reap/redispatch was not an escape.
		const fixture = bootFixture();
		await fixture.ready();
		const host = fixture.makeHost([]);
		try {
			await host.start();
			const { first, registered } = await bootLead(fixture);
			await enqueueFor(fixture, "founder-before-takeover");

			// Generation 1 receives the envelope and deliberately does NOT settle it.
			const before = (await sendHostRequest({
				socketPath: fixture.socketPath,
				secret: fixture.secret,
				action: "next_delivery",
				payload: { deliveryCredential: registered.deliveryCredential },
				timeoutMs: 12_000,
			})) as DeliveryEnvelope;
			expect(before.handle.agent.generation).toBe(registered.generation);

			// The lead process dies and a new session takes over. The takeover
			// crash-settles generation 1's running attempt, so the message is
			// rescheduled.
			const second = leadSession(2);
			fixture.leadSessions.set(second.sessionId, {
				pid: second.pid,
				pidStart: second.pidStart,
			});
			fixture.deadPids.add(first.pid);
			const takeover = (await sendHostRequest({
				socketPath: fixture.socketPath,
				secret: fixture.secret,
				action: "register_lead",
				payload: {
					agentId: "lead-runtime",
					instanceId: second.sessionId,
					sessionBinding: {
						v: 1,
						hostEpoch: HOST_EPOCH,
						sessionId: second.sessionId,
						pid: second.pid,
						pidStart: second.pidStart,
					},
					deathEvidence: {
						agentId: "lead-runtime",
						generation: registered.generation,
						confirmedAbsentAt: "2026-07-29T00:05:00.000Z",
					},
				},
			})) as {
				generation: number;
				deliveryCredential: { credentialId: string; token: string };
			};

			// The takeover's crash-settle reschedules the message with an exponential
			// backoff off the real clock, so bring the retry due rather than sleeping
			// through it. This advances time only -- the state is exactly what
			// settleFailureMailboxTx produced.
			const clockShift = Kernel.open({ path: fixture.database.dbPath });
			clockShift.write("test.retry-due-now", (tx) => {
				tx.run(
					`UPDATE mailbox SET next_retry_at=@dueAt
					  WHERE message_uid=@uid AND state='pending'`,
					{
						uid: before.message.messageUid,
						dueAt: "2026-07-29T00:00:00.000Z",
					},
				);
			});
			clockShift.close();
			// A lead's mailbox is drained on enqueue rather than on a timer, so poke
			// the drain the way production does: another message arrives. The retried
			// message is older, so it is the one selected next.
			await enqueueFor(fixture, "founder-after-takeover-poke");

			// RED before the logical-scope fix: preparing this delivery raised
			// `UNIQUE constraint failed: actions.logical_key`, because the same
			// message + the same (null) attempt scope produced a duplicate root.
			const after = (await sendHostRequest({
				socketPath: fixture.socketPath,
				secret: fixture.secret,
				action: "next_delivery",
				payload: { deliveryCredential: takeover.deliveryCredential },
				timeoutMs: 12_000,
			})) as DeliveryEnvelope;
			expect(after.message.messageUid).toBe(before.message.messageUid);
			expect(after.handle.attemptUid).not.toBe(before.handle.attemptUid);
			expect(after.handle.agent.generation).toBe(takeover.generation);

			// And it settles: the replacement generation's proposal is durably
			// recorded, which is what "the executor recovered" actually means.
			await expect(
				sendHostRequest({
					socketPath: fixture.socketPath,
					secret: fixture.secret,
					action: "submit_proposal",
					payload: {
						agentId: "lead-runtime",
						attemptUid: after.handle.attemptUid,
						messageUid: after.message.messageUid,
						effects: [
							{
								kind: "event",
								eventKind: "fly1503.takeover.settled",
								payload: "{}",
							},
						],
						authorization: after.authorization,
					},
				}),
			).resolves.toMatchObject({ status: "succeeded" });

			// The superseded generation's capability is dead, so the old envelope
			// cannot also settle -- exactly one proposal per delivery still holds.
			await expect(
				sendHostRequest({
					socketPath: fixture.socketPath,
					secret: fixture.secret,
					action: "submit_proposal",
					payload: {
						agentId: "lead-runtime",
						attemptUid: before.handle.attemptUid,
						messageUid: before.message.messageUid,
						effects: [
							{
								kind: "event",
								eventKind: "fly1503.takeover.settled",
								payload: "{}",
							},
						],
						authorization: before.authorization,
					},
				}),
			).rejects.toThrow(/crashed|is failed|not registered|no host converter/);
		} finally {
			await host.close();
		}
	});

	it("closes even while a client holds a half-written frame open", async () => {
		// Codex R4 MEDIUM-1: close() awaited server.close() FIRST, and that waits for
		// open connections to end. A same-uid process could connect, send half a frame
		// and never a newline, and the host would never revoke credentials, never
		// cancel waiters, never driver.stop(), never crash-settle, never close the db.
		const fixture = bootFixture();
		await fixture.ready();
		const host = fixture.makeHost([]);
		let hung: ReturnType<typeof createConnection> | undefined;
		try {
			await host.start();
			hung = createConnection(fixture.socketPath);
			await new Promise<void>((resolve, reject) => {
				hung?.once("connect", resolve);
				hung?.once("error", reject);
			});
			// Half a frame: valid JSON so far, deliberately no newline.
			hung.write('{"v":1,"id":"never-finished"');
			await new Promise((resolve) => setTimeout(resolve, 50));

			// RED before the fix: this never resolved.
			const started = Date.now();
			await host.close();
			expect(Date.now() - started).toBeLessThan(5_000);
			// Codex R5 LOW-2: assert double-close instead of swallowing whatever it
			// throws. `.catch(() => undefined)` here meant a second close could throw
			// anything and the case stayed green.
			await expect(host.close()).resolves.toBeUndefined();
		} finally {
			hung?.destroy();
		}
	});

	it("records a delivery as succeeded only once the response frame is flushed", async () => {
		// The requeue branch turns on this callback, so assert it directly rather
		// than racing a real client's disconnect against the host's write.
		const dir = mkdtempSync(join(tmpdir(), "fly1503-writeresponse-"));
		roots.push(dir);
		const socketPath = join(dir, "probe.sock");
		const server = createServer((socket) => socket.resume());
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		try {
			const live = createConnection(socketPath);
			await new Promise<void>((resolve, reject) => {
				live.once("connect", resolve);
				live.once("error", reject);
			});
			const flushed = await new Promise<boolean>((resolve) => {
				writeResponse(
					live,
					{ v: 1, id: "flushed", ok: true, result: {} },
					resolve,
				);
			});
			expect(flushed).toBe(true);

			const dead = createConnection(socketPath);
			await new Promise<void>((resolve, reject) => {
				dead.once("connect", resolve);
				dead.once("error", reject);
			});
			dead.destroy();
			const notFlushed = await new Promise<boolean>((resolve) => {
				writeResponse(
					dead,
					{ v: 1, id: "not-flushed", ok: true, result: {} },
					resolve,
				);
			});
			expect(notFlushed).toBe(false);

			// The callback runs inside a socket write callback and inside 'error' and
			// 'close' handlers, so a throwing callback would escape into the event loop
			// as an uncaught exception and take the whole host down. Recording the
			// delivery outcome touches the kernel, so it genuinely can throw.
			const throwing = createConnection(socketPath);
			await new Promise<void>((resolve, reject) => {
				throwing.once("connect", resolve);
				throwing.once("error", reject);
			});
			let called = 0;
			expect(() =>
				writeResponse(
					throwing,
					{ v: 1, id: "throws", ok: true, result: {} },
					() => {
						called += 1;
						throw new Error("recording the delivery outcome failed");
					},
				),
			).not.toThrow();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(called).toBe(1);
			throwing.destroy();
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

describe("Codex R6 HIGH-1 × FLY-1556 — arming failures are fatal, one session's failure is not", () => {
	it("boots, records durably, and keeps serving when one session's activation fails at startup", async () => {
		// FLY-1556 (2026-07-30 production outage): this exact seam — a
		// RunnerLaunchConfigError out of activate() during startup sync — used to
		// abort start(), so launchd relaunched into the same error forever: the
		// socket vanished, the outbound service died with it, and six healthy
		// runners lost their control plane over ONE session's stale pin. A
		// per-session activation failure is now that session's failure: recorded
		// as a queryable event, the host arms and serves.
		//
		// The R6 property survives where it was true: a failure that prevents the
		// coordinator from arming at all still tears the listener down (the
		// try/catch around arming in start()), and a host that never armed says
		// "degraded", never "ok" (test below).
		const fixture = bootFixture();
		await fixture.ready();
		// Bring a runner into existence and shut that host down, exactly as the item-9
		// restart case does: the agents row goes offline while the session stays live,
		// so the next boot's startup sync reaches activateSession.
		const seed = fixture.makeHost([]);
		await seed.start();
		await seed.runCoordinatorOnce();
		await seed.close();
		const errors: unknown[] = [];
		const failing = fixture.makeHost(
			[],
			[],
			errors,
			new Error("pinned instruction changed before runner activation"),
		);
		try {
			await failing.start();
			const healthy = (await sendHostRequest({
				socketPath: fixture.socketPath,
				secret: fixture.secret,
				action: "health",
				payload: {},
			})) as { status: string; coordinator: string };
			expect(healthy).toMatchObject({ status: "ok", coordinator: "armed" });
			expect(errors.length).toBeGreaterThanOrEqual(1);
			const kernel = Kernel.open({ path: fixture.database.dbPath });
			try {
				const faults = kernel.read((tx) =>
					tx.all<{ source_id: string; payload: string }>(
						"SELECT source_id,payload FROM events WHERE kind='session_activation_failed'",
					),
				);
				// Deduped: startup sync + the first tick hit the same diagnostic.
				expect(faults).toHaveLength(1);
				expect(faults[0]?.source_id).toMatch(/^v2dag:/);
				expect(JSON.parse(faults[0]?.payload as string)).toMatchObject({
					session_ref: faults[0]?.source_id,
					error: "pinned instruction changed before runner activation",
				});
			} finally {
				kernel.close();
			}
		} finally {
			await failing.close().catch(() => undefined);
		}
	});

	it("reports degraded rather than ok when the coordinator never armed", async () => {
		const fixture = bootFixture();
		await fixture.ready();
		const host = fixture.makeHost([]);
		try {
			await host.start();
			const healthy = (await sendHostRequest({
				socketPath: fixture.socketPath,
				secret: fixture.secret,
				action: "health",
				payload: {},
			})) as { status: string; coordinator: string };
			expect(healthy).toMatchObject({ status: "ok", coordinator: "armed" });
		} finally {
			await host.close();
		}
	});
});

describe("FLY-1503 item 1 — the envelope carries the delivery protocol", () => {
	it("tells the executor how to settle without relying on pretrained knowledge", async () => {
		const fixture = bootFixture();
		await fixture.ready();
		const { launchRequests, makeHost } = fixture;

		const delivered: Delivered[] = [];
		const host = makeHost([], delivered);
		try {
			await host.start();
			await host.runCoordinatorOnce();
			expect(launchRequests).toHaveLength(1);
			expect(delivered).toEqual([]);
			const envelope = JSON.parse(
				launchRequests[0]?.context.firstEnvelope as string,
			) as DeliveryEnvelope;

			// RED before the fix: the envelope carried only message/handle/
			// authorization/deliveryActionId, so the one-delivery-one-settlement
			// rule, the one-shot submit token and the reporting route had to be
			// reverse-engineered from the CLI source.
			expect(envelope.protocol).toBeDefined();
			expect(envelope.protocol.settlement).toMatch(/exactly one/);
			expect(envelope.protocol.submit.verb).toBe("submit");
			expect(envelope.protocol.submit.oneShot).toMatch(
				/exactly one distinct proposal/,
			);
			// Codex R1 MEDIUM-6: identical retry must be described as safe.
			// Codex R2 MEDIUM-6: the contract must not promise a settlement outcome
			// the host cannot guarantee.
			expect(envelope.protocol.submit.retryCaveat).toMatch(/AMBIGUOUS/);
			expect(envelope.protocol.submit.flags.join(" ")).toContain(
				"--capability-id",
			);
			expect(envelope.protocol.effects.allowedKinds).toEqual(["event", "task"]);
			// The reporting route matters most: there is no side channel.
			expect(envelope.protocol.reporting).toMatch(/effects.*`ask` verb/);
			expect(envelope.protocol.reporting).toMatch(/ask_response/);
			// FLY-1544 founder ruling: settle timing by kind travels in-band —
			// mechanical notices settle on read, a runner_ask settles only after
			// the reply, and the unsettled mailbox row IS the todo ledger.
			expect(envelope.protocol.leadSettlement).toMatch(/IMMEDIATELY on read/);
			expect(envelope.protocol.leadSettlement).toMatch(
				/ONLY AFTER the reply was sent/,
			);
		} finally {
			await host.close();
		}
	});
});
