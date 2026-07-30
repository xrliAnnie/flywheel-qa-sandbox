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
import { type DeliveryEnvelope, V2Host } from "../host.js";
import { sendHostRequest } from "../protocol.js";
import {
	createRuntimeDagPorts,
	type RunnerLauncherPort,
	type RuntimeLaunchRequest,
} from "../runtime-ports.js";

const WINDOW = "runner-injection-window";
const EPOCH = 23;
const HOST_EPOCH = "runner-injection-host";
const PID = 12_345;
const PID_START = "runner-injection-process-start";
const roots: string[] = [];

function prepareProject(root: string): string {
	const project = join(root, "project");
	mkdirSync(join(project, ".flywheel", "agents"), { recursive: true });
	writeFileSync(
		join(project, ".flywheel", "config.yaml"),
		"project: runner-injection\nagents:\n  engineer:\n    agent_file: .flywheel/agents/engineer.md\n",
	);
	writeFileSync(
		join(project, ".flywheel", "agents", "engineer.md"),
		"# Engineer\n\nConsume only v2 injected envelopes.\n",
	);
	execFileSync("/usr/bin/git", ["-C", project, "init", "-q"]);
	execFileSync("/usr/bin/git", [
		"-C",
		project,
		"-c",
		"user.name=V2 Test",
		"-c",
		"user.email=v2@example.invalid",
		"add",
		".",
	]);
	execFileSync("/usr/bin/git", [
		"-C",
		project,
		"-c",
		"user.name=V2 Test",
		"-c",
		"user.email=v2@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
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

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("host runner bootstrap loop", () => {
	it("activates the session runner with its first envelope and settles its proposal", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-v2-runner-injection-"));
		roots.push(root);
		chmodSync(root, 0o700);
		const project = prepareProject(root);
		const database = prepareLiveDatabase(root);
		const socketPath = join(root, "host.sock");
		const secretPath = join(root, "host.secret");
		const secret = randomBytes(32);
		writeFileSync(secretPath, secret, { mode: 0o600 });
		const launchRequests: RuntimeLaunchRequest[] = [];
		const activated: string[] = [];
		const coordinatorErrors: unknown[] = [];
		const delivered: Array<{
			sessionRef: string;
			injectionRef: string;
			message: { messageUid: string; attemptUid: string; payload: string };
		}> = [];
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
				return {
					state: "absent",
					confirmedAt: "2026-07-29T00:03:00.000Z",
				};
			},
			async stop() {},
		};
		const bootstrap = Kernel.open({ path: database.dbPath });
		provisionAgentRecipient(bootstrap, "lead-runtime", "lead");
		const bootstrapPorts = createRuntimeDagPorts({
			kernel: bootstrap,
			hostEpoch: HOST_EPOCH,
			expectedEpoch: EPOCH,
			lockRoot: join(root, "locks"),
			launcher,
			gitBin: "/usr/bin/git",
			ghBin: "/usr/bin/false",
			now: () => new Date("2026-07-29T00:03:00.000Z"),
		});
		const descriptor: IssueDagDescriptor = {
			admissionUid: "runner-injection-admission",
			projectId: "runner-injection",
			issueId: "FLY-RUNNER-INJECTION",
			notifyAgentId: "lead-runtime",
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
						logicalAgentId: "engineer",
						family: "codex",
						vendor: "codex",
						model: "test-model",
						effort: "high",
					},
				},
			],
			edges: [],
		};
		await admitIssueDag(bootstrap, bootstrapPorts, descriptor);
		bootstrap.close();

		const host = new V2Host({
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
					pid === PID
						? { status: "present", startIdentity: PID_START }
						: { status: "absent" },
				sessionOwner: () => ({ pid: PID, pidStart: PID_START }),
			},
			coordinator: {
				intervalMs: 60_000,
				createPorts: (kernel) =>
					createRuntimeDagPorts({
						kernel,
						hostEpoch: HOST_EPOCH,
						expectedEpoch: EPOCH,
						lockRoot: join(root, "locks"),
						launcher,
						gitBin: "/usr/bin/git",
						ghBin: "/usr/bin/false",
						now: () => new Date("2026-07-29T00:03:00.000Z"),
					}),
				async activateSession(sessionRef) {
					activated.push(sessionRef);
				},
				async deliverRunner(sessionRef, injectionRef, message) {
					delivered.push({ sessionRef, injectionRef, message });
				},
				onError(error) {
					coordinatorErrors.push(error);
				},
			},
		});
		try {
			await host.start();
			await host.runCoordinatorOnce();
			expect(launchRequests).toHaveLength(1);
			expect(activated.length).toBeGreaterThanOrEqual(1);
			expect(new Set(activated)).toEqual(
				new Set([launchRequests[0]?.sessionRef]),
			);
			expect(coordinatorErrors).toEqual([]);
			expect(delivered).toEqual([]);
			const envelope = JSON.parse(
				launchRequests[0]?.context.firstEnvelope as string,
			) as DeliveryEnvelope;
			expect(envelope).toMatchObject({
				v: 1,
				message: {
					kind: "task_assignment",
					payload: expect.any(String),
				},
				handle: {
					agent: {
						kind: "runner",
						agentId: launchRequests[0]?.sessionRef,
					},
				},
				authorization: {
					capabilityId: expect.any(String),
					token: expect.any(String),
				},
			});
			expect(JSON.parse(envelope.message.payload)).toMatchObject({
				v: 1,
				issue_id: "FLY-RUNNER-INJECTION",
				project_id: "runner-injection",
				task_kind: "implementation",
				attempt_id: launchRequests[0]?.attemptId,
				activation_id: launchRequests[0]?.activationId,
				session_ref: launchRequests[0]?.sessionRef,
			});
			await expect(
				sendHostRequest({
					socketPath,
					secret,
					action: "submit_proposal",
					payload: {
						agentId: launchRequests[0]?.sessionRef,
						attemptUid: envelope.handle.attemptUid,
						messageUid: envelope.handle.messageUid,
						effects: [],
						authorization: envelope.authorization,
					},
				}),
			).resolves.toMatchObject({ status: "succeeded" });
			const lead = (await sendHostRequest({
				socketPath,
				secret,
				action: "register_lead",
				payload: {
					agentId: "lead-runtime",
					instanceId: "lead-runtime-session",
					sessionBinding: {
						v: 1,
						hostEpoch: HOST_EPOCH,
						sessionId: "lead-runtime-session",
						pid: PID,
						pidStart: PID_START,
					},
				},
			})) as {
				deliveryCredential: { credentialId: string; token: string };
			};
			const asked = (await sendHostRequest({
				socketPath,
				secret,
				action: "ask",
				payload: {
					sessionRef: launchRequests[0]?.sessionRef,
					askKind: "ask",
					payload: "Which acceptance command should I run?",
				},
			})) as { uid: string };
			const leadEnvelope = (await sendHostRequest({
				socketPath,
				secret,
				action: "next_delivery",
				payload: {
					agentId: "lead-runtime",
					deliveryCredential: lead.deliveryCredential,
				},
			})) as DeliveryEnvelope;
			expect(leadEnvelope.message).toMatchObject({
				kind: "runner_ask",
				sourceKind: "runner_upstream",
			});
			expect(JSON.parse(leadEnvelope.message.payload)).toMatchObject({
				session_ref: launchRequests[0]?.sessionRef,
				uid: asked.uid,
				body: "Which acceptance command should I run?",
			});
			await expect(
				sendHostRequest({
					socketPath,
					secret,
					action: "enqueue",
					payload: {
						sourceKind: "ask_response",
						sourceId: asked.uid,
						payload: JSON.stringify({
							v: 1,
							uid: asked.uid,
							body: "Run pnpm -r build.",
						}),
						toAgent: launchRequests[0]?.sessionRef,
						kind: "ask_response",
						retentionClass: "business",
					},
				}),
			).resolves.toMatchObject({ status: "enqueued" });
			const runnerResponse = (await sendHostRequest({
				socketPath,
				secret,
				action: "next_delivery",
				payload: { sessionRef: launchRequests[0]?.sessionRef },
			})) as DeliveryEnvelope;
			expect(runnerResponse.message.kind).toBe("ask_response");
			expect(JSON.parse(runnerResponse.message.payload)).toEqual({
				v: 1,
				uid: asked.uid,
				body: "Run pnpm -r build.",
			});
			for (const [agentId, response] of [
				["lead-runtime", leadEnvelope],
				[launchRequests[0]?.sessionRef, runnerResponse],
			] as const) {
				await expect(
					sendHostRequest({
						socketPath,
						secret,
						action: "submit_proposal",
						payload: {
							agentId,
							attemptUid: response.handle.attemptUid,
							messageUid: response.handle.messageUid,
							effects: [],
							authorization: response.authorization,
						},
					}),
				).resolves.toMatchObject({ status: "succeeded" });
			}
			const inspected = Kernel.open({ path: database.dbPath });
			expect(
				inspected.read(
					(tx) =>
						tx.get<{ state: string }>(
							"SELECT state FROM mailbox WHERE source_kind='dag_task_dispatch'",
						)?.state,
				),
			).toBe("applied");
			inspected.close();
		} finally {
			await host.close();
		}
	});
});
