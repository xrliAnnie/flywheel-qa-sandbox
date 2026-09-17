#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = realpathSync(
	resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);

function fail(reason) {
	process.stderr.write(`${JSON.stringify({ ok: false, reason })}\n`);
	process.exitCode = 1;
}

function digest(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function currentHead() {
	return execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repoRoot,
		encoding: "utf8",
	}).trim();
}

function option(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function assertSandboxManifest(manifest, manifestPath) {
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.mode, "derived_fixture");
	assert.equal(manifest.productionSnapshot.status, "unavailable");
	assert.equal(manifest.externalSandbox.status, "not_run");
	assert.deepEqual(manifest.allowlist.network, []);
	assert.deepEqual(manifest.allowlist.discordThreadIds, []);
	assert.deepEqual(manifest.allowlist.linearIssueIds, []);
	assert.deepEqual(
		manifest.cases.map((entry) => entry.incident),
		["2391", "2588", "2413", "2602"],
	);
	for (const entry of manifest.cases) {
		assert.equal(entry.sourceKind, "derived_fixture");
		assert.equal(entry.productionAcceptance, false);
		assert.ok(entry.provenance?.shape);
		assert.ok(entry.provenance?.sourceDecision);
	}
	const manifestRelative = relative(repoRoot, manifestPath);
	assert.ok(
		manifestRelative.startsWith(
			"engineering/doc/FLY-2616-proven-closeout/evidence/",
		),
	);
}

function observationsFor(shape) {
	const absent = (reason) => ({ state: "absent", reason });
	const notApplicable = (reason) => ({ state: "not_applicable", reason });
	if (shape === "session_row_missing") {
		return {
			stateSession: absent("session_row_missing"),
			commSession: absent("comm_row_missing"),
			window: absent("tmux_window_missing"),
			hostProcess: absent("process_absent"),
			daemon: absent("daemon_absent"),
			heartbeat: notApplicable("heartbeat_not_supported"),
			launch: absent("launch_settled"),
		};
	}
	if (shape === "never_started_engine") {
		return {
			stateSession: absent("session_row_never_created"),
			commSession: absent("comm_row_never_created"),
			window: notApplicable("engine_node"),
			hostProcess: notApplicable("engine_node"),
			daemon: notApplicable("engine_node"),
			heartbeat: notApplicable("engine_node"),
			launch: absent("dispatch_has_no_runner_launch"),
		};
	}
	if (shape === "dead_parked") {
		return {
			stateSession: { state: "present", reason: "terminal_row_present" },
			commSession: { state: "present", reason: "parked_row_present" },
			window: absent("tmux_window_missing"),
			hostProcess: absent("process_absent"),
			daemon: absent("daemon_absent"),
			heartbeat: { state: "stale", reason: "heartbeat_expired" },
			launch: absent("launch_settled"),
		};
	}
	return {
		stateSession: absent("session_row_missing"),
		commSession: absent("comm_row_missing"),
		window: absent("tmux_window_missing"),
		hostProcess: absent("process_absent"),
		daemon: absent("daemon_absent"),
		heartbeat: notApplicable("heartbeat_not_supported"),
		launch: absent("launch_settled"),
	};
}

async function collectShapeEvidence(collectCloseoutEvidence, entry, index) {
	const facts = observationsFor(entry.provenance.shape);
	const observedAt = Date.now() + index * 100;
	return collectCloseoutEvidence(
		{
			evidenceId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
			project: "flywheel",
			issueUuid: `derived-${entry.incident}`,
			runId: `derived-run-${entry.incident}`,
			executionId: `derived-exec-${entry.incident}`,
			activationId: null,
			operationId: `derived-land-${entry.incident}`,
			operationGeneration: 1,
			lifecycleRevision: null,
			attributionDigest: digest(entry.provenance),
			commIdentityRevision: null,
			windowIdentity: null,
			controllerGeneration: null,
			adapter:
				entry.provenance.shape === "never_started_engine"
					? "engine"
					: "unknown",
		},
		{
			...Object.fromEntries(
				Object.entries(facts).map(([name, fact]) => [name, async () => fact]),
			),
			now: () => new Date(observedAt),
			sourceTimeoutMs: 100,
			totalTimeoutMs: 1_000,
		},
	);
}

async function finalizeCommShape(CommDB, dbPath, incident) {
	const db = new CommDB(dbPath);
	const executionId = `derived-exec-${incident}`;
	const observedMs = Date.now();
	try {
		if (incident === "2413") {
			db.registerSession(
				executionId,
				"runner-derived:@2413",
				"flywheel",
				"derived-2413",
				"flywheel-eng-lead",
			);
			db.updateSessionStatus(executionId, "completed");
			db.upsertDeclaredState(
				executionId,
				"parked",
				"derived phase handoff",
				observedMs,
				null,
			);
		} else if (incident === "2391") {
			db.insertQuestion(executionId, "flywheel-eng-lead", "derived orphan");
		} else {
			return { applicable: false };
		}
		const identity = db.getSessionCloseoutIdentity(executionId);
		const input = {
			reservationId: `derived-reservation-${incident}`,
			evidenceId: `derived-evidence-${incident}`,
			expectedIdentityRevision: identity.revision,
			observedAt: new Date(observedMs).toISOString(),
			expiresAt: new Date(observedMs + 30_000).toISOString(),
			now: new Date(observedMs + 1_000).toISOString(),
		};
		const first = db.finalizeProvenGoneSession(executionId, input);
		assert.equal(first.finalized, true);
		assert.equal(db.getSession(executionId), undefined);
		if (incident === "2413") {
			assert.equal(
				db.getEffectiveDeclaredState(executionId, observedMs + 2_000),
				null,
			);
		}
		const replay = db.finalizeProvenGoneSession(executionId, input);
		assert.equal(replay.finalized, true);
		assert.equal(replay.idempotentReplay, true);
		return {
			applicable: true,
			deletedSessionCount: first.result.deletedSessionCount,
			retiredQuestionCount: first.result.retiredQuestionCount,
			idempotentReplay: replay.idempotentReplay,
		};
	} finally {
		db.close();
	}
}

async function absentWorktreeProof(
	makeWorktreeCleanup,
	store,
	operation,
	claim,
	root,
) {
	const projectRoot = join(root, "flywheel");
	mkdirSync(projectRoot, { recursive: true });
	const canonicalRoot = realpathSync(projectRoot);
	const canonicalParent = realpathSync(root);
	const absentPath = join(canonicalParent, "flywheel-FLY-2602");
	const parent = await lstat(canonicalParent);
	const cleanup = makeWorktreeCleanup({
		store,
		worktreeManager: {
			expectedWorktree: () => {
				throw new Error("unexpected expectedWorktree");
			},
			parseWorktreeKeyFromPath: () => undefined,
			getRegisteredWorktree: () => undefined,
			removeCleanWorktreeByPath: async () => {
				throw new Error("absent worktree must not be removed");
			},
			readWorktreeGeneration: async () => undefined,
		},
		resolveProjectRoot: () => canonicalRoot,
		isWorktreeClean: async () => {
			throw new Error("absent worktree must not run git status");
		},
		autoclean: true,
	});
	const attestation = await cleanup({
		issueId: "derived-2602",
		projectName: "flywheel",
		tmuxClosed: true,
		tmuxErrors: [],
		operationContext: {
			operationAudit: {
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				runId: null,
				sourceExecutionId: "derived-exec-2602",
			},
			target: {
				kind: "bound_worktree",
				path: absentPath,
				branch: "flywheel-FLY-2602",
				generation: "derived-generation-2602",
				projectRoot: canonicalRoot,
				parentIdentity: {
					path: canonicalParent,
					dev: Number(parent.dev),
					ino: Number(parent.ino),
				},
				sourceExecutionIds: ["derived-exec-2602"],
				sourceRunId: null,
				sourceReceipt: "derived-fixture:2602",
			},
		},
	});
	assert.equal(attestation.cleanupState, "absent", JSON.stringify(attestation));
	assert.equal(attestation.removed, false);
	assert.equal(attestation.absentEvidence.path, absentPath);
	return attestation;
}

async function runDerivedCase(modules, entry, index, root) {
	const evidence = await collectShapeEvidence(
		modules.collectCloseoutEvidence,
		entry,
		index,
	);
	assert.equal(evidence.verdict, "gone");
	const store = await modules.StateStore.create(":memory:");
	const notifications = [];
	let worktree;
	let linearDone = false;
	let threadArchived = false;
	try {
		const now = new Date(Date.now() + index * 1_000);
		const operation = store.ensureLandOperation({
			issueId: `derived-${entry.incident}`,
			projectName: "flywheel",
			prNumber: 20_000 + index,
			approvedHead: "a".repeat(40),
			now: now.toISOString(),
		});
		const mergeDriver = {
			inspectPr: async () => ({
				state: "MERGED",
				headSha: "a".repeat(40),
				mergeSha: "b".repeat(40),
			}),
			triggerCool: async () => {
				throw new Error("derived closeout must not trigger merge");
			},
			inspectTriggeredWorkflow: async () => {
				throw new Error("derived closeout must not inspect a ship workflow");
			},
		};
		const result = await modules.executeLandOperation(operation.operation_id, {
			store,
			mergeDriver,
			authorize: () => ({ ok: true }),
			ownerId: `derived-owner-${entry.incident}`,
			now: () => now,
			notify: async (_current, stage) => {
				notifications.push(stage);
				return { disposition: "posted" };
			},
			finalize: async (current) => {
				assert.ok(current.owner_id);
				if (entry.incident === "2602") {
					worktree = await absentWorktreeProof(
						modules.makeWorktreeCleanup,
						store,
						current,
						{
							ownerId: current.owner_id,
							generation: current.generation,
						},
						root,
					);
				}
				const disposition = store.recordLandLinearDoneDisposition({
					operationId: current.operation_id,
					ownerId: current.owner_id,
					generation: current.generation,
					disposition: "done",
					reason: "derived_sandbox_readback",
					executionId: `derived-exec-${entry.incident}`,
					now: now.toISOString(),
				});
				assert.equal(disposition.ok, true);
				linearDone = true;
				threadArchived = true;
				return { complete: true, outcome: "completed" };
			},
		});
		assert.equal(result.status, "completed", JSON.stringify(result));
		assert.equal(
			store.getLandOperation(operation.operation_id).state,
			"completed",
		);
		assert.equal(
			(
				await modules.executeLandOperation(operation.operation_id, {
					store,
					mergeDriver,
					ownerId: "replay-must-not-run",
				})
			).status,
			"completed",
		);
		assert.equal(
			notifications.filter((stage) => stage === "completed").length,
			1,
		);
		const comm = await finalizeCommShape(
			modules.CommDB,
			join(root, `comm-${entry.incident}.db`),
			entry.incident,
		);
		return {
			incident: entry.incident,
			sourceKind: entry.sourceKind,
			fixtureDigest: digest({ entry, evidence: evidence.observations }),
			verdict: evidence.verdict,
			negativeReasons: evidence.negativeReasons,
			landOperation: "completed",
			workflowRun: "completed_local_double",
			simulatedFinalization: {
				evidenceKind: "local_double",
				threadArchive: threadArchived ? "completed" : "failed",
				linearDisposition: linearDone ? "completed" : "failed",
			},
			completedNotificationCount: 1,
			comm,
			...(worktree
				? { worktree: { cleanupState: worktree.cleanupState, removed: false } }
				: {}),
		};
	} finally {
		store.close();
	}
}

async function negativeControls(collectCloseoutEvidence) {
	const base = observationsFor("session_row_missing");
	async function verdict(overrides) {
		const facts = { ...base, ...overrides };
		const evidence = await collectCloseoutEvidence(
			{
				evidenceId: "99999999-9999-4999-8999-999999999999",
				project: "flywheel",
				issueUuid: "negative-control",
				runId: null,
				executionId: "negative-control",
				activationId: null,
				operationId: "negative-control",
				operationGeneration: 1,
				lifecycleRevision: null,
				attributionDigest: "c".repeat(64),
				commIdentityRevision: null,
				windowIdentity: null,
				controllerGeneration: null,
				adapter: "unknown",
			},
			Object.fromEntries(
				Object.entries(facts).map(([name, fact]) => [name, async () => fact]),
			),
		);
		return evidence.verdict;
	}
	const alive = await verdict({
		daemon: { state: "live", reason: "daemon_live" },
	});
	const unknown = await verdict({
		hostProcess: { state: "unknown", reason: "probe_timeout" },
	});
	assert.equal(alive, "alive");
	assert.equal(unknown, "unknown");
	return {
		alive: { verdict: alive, sideEffects: "not_exercised" },
		unknown: { verdict: unknown, sideEffects: "not_exercised" },
	};
}

async function childKillGate(StateStore, LandOwnerLivenessMonitor) {
	const store = await StateStore.create(":memory:");
	let child;
	let monitor;
	try {
		const operation = store.ensureLandOperation({
			issueId: "derived-owner-death",
			projectName: "flywheel",
			prNumber: 2616,
			approvedHead: "d".repeat(40),
			now: new Date().toISOString(),
		});
		child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: "ignore",
		});
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
		const identity = {
			ownerId: `land-engine:${child.pid}`,
			ownerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			ownerPid: child.pid,
			ownerProcessStart: "derived-child-incarnation",
			ownerHostBootId: "derived-host-boot",
		};
		const now = new Date();
		const staleClaim = store.claimLandOperation({
			operationId: operation.operation_id,
			...identity,
			now: now.toISOString(),
			leaseExpiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
		});
		assert.ok(staleClaim);
		monitor = new LandOwnerLivenessMonitor(store, {
			hostBootId: identity.ownerHostBootId,
			probeProcessTuple: (pid) => {
				try {
					process.kill(pid, 0);
					return "alive";
				} catch (error) {
					return error.code === "ESRCH" ? "dead" : "unknown";
				}
			},
		});
		monitor.start();
		const exited = new Promise((resolvePromise) =>
			child.once("exit", resolvePromise),
		);
		const killedAt = Date.now();
		child.kill("SIGKILL");
		await exited;
		while (
			store.getLandOperation(operation.operation_id).state === "running" &&
			Date.now() - killedAt < 10_000
		) {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
		}
		const reclaimedAt = Date.now();
		const successor = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "land-engine:successor",
			ownerInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			ownerPid: process.pid,
			ownerProcessStart: "derived-successor",
			ownerHostBootId: identity.ownerHostBootId,
			now: new Date().toISOString(),
			leaseExpiresAt: new Date(Date.now() + 20_000).toISOString(),
		});
		assert.ok(successor);
		assert.ok(reclaimedAt - killedAt <= 10_000);
		assert.deepEqual(
			store.recordLandOperationStep({
				operationId: operation.operation_id,
				ownerId: staleClaim.ownerId,
				generation: staleClaim.generation,
				step: "stale-child-effect",
				receipt: { forbidden: true },
				now: new Date().toISOString(),
			}),
			{ ok: false, reason: "stale_land_generation" },
		);
		return {
			elapsedMs: reclaimedAt - killedAt,
			thresholdMs: 10_000,
			successorClaimed: true,
			staleOwnerFenced: true,
		};
	} finally {
		monitor?.stop();
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
		store.close();
	}
}

async function archiveFailureControl(StateStore, executeLandOperation) {
	const store = await StateStore.create(":memory:");
	try {
		const operation = store.ensureLandOperation({
			issueId: "derived-2244",
			projectName: "flywheel",
			prNumber: 2244,
			approvedHead: "e".repeat(40),
			now: new Date().toISOString(),
		});
		let nowMs = Date.now();
		let attempts = 0;
		const deps = {
			store,
			mergeDriver: {
				inspectPr: async () => ({
					state: "MERGED",
					headSha: "e".repeat(40),
					mergeSha: "f".repeat(40),
				}),
				triggerCool: async () => {
					throw new Error("archive control must not merge");
				},
				inspectTriggeredWorkflow: async () => ({ state: "pending" }),
			},
			authorize: () => ({ ok: true }),
			ownerId: "derived-archive-owner",
			now: () => new Date(nowMs),
			finalize: async (current) => {
				attempts += 1;
				if (attempts === 1) {
					return {
						complete: false,
						outcome: "partial",
						reason: "land_postconditions_incomplete:thread_archive",
					};
				}
				store.recordLandLinearDoneDisposition({
					operationId: current.operation_id,
					ownerId: current.owner_id,
					generation: current.generation,
					disposition: "done",
					reason: "archive_recovered",
					executionId: "derived-exec-2244",
					now: new Date(nowMs).toISOString(),
				});
				return { complete: true, outcome: "completed" };
			},
		};
		assert.equal(
			(await executeLandOperation(operation.operation_id, deps)).status,
			"partial",
		);
		nowMs += 61_000;
		assert.equal(
			(await executeLandOperation(operation.operation_id, deps)).status,
			"completed",
		);
		return {
			first: "partial",
			replay: "completed",
			finalizeAttempts: attempts,
		};
	} finally {
		store.close();
	}
}

async function main() {
	if (!process.argv.includes("--sandbox-only")) {
		throw new Error("sandbox_only_required");
	}
	const rawManifest = option("--manifest");
	if (!rawManifest) throw new Error("manifest_required");
	const manifestPath = realpathSync(resolve(repoRoot, rawManifest));
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	assertSandboxManifest(manifest, manifestPath);
	globalThis.fetch = async () => {
		throw new Error("network_disabled_by_fly2616_replay");
	};
	const dist = (path) => pathToFileURL(join(repoRoot, path)).href;
	const [
		stateModule,
		evidenceModule,
		landModule,
		ownerModule,
		worktreeModule,
		commModule,
	] = await Promise.all([
		import(dist("packages/teamlead/dist/StateStore.js")),
		import(
			dist("packages/teamlead/dist/bridge/execution-closeout-evidence.js")
		),
		import(dist("packages/teamlead/dist/bridge/land-executor.js")),
		import(dist("packages/teamlead/dist/bridge/land-owner-liveness.js")),
		import(dist("packages/teamlead/dist/bridge/worktree-cleanup.js")),
		import(dist("packages/flywheel-comm/dist/db.js")),
	]);
	const modules = {
		StateStore: stateModule.StateStore,
		collectCloseoutEvidence: evidenceModule.collectCloseoutEvidence,
		executeLandOperation: landModule.executeLandOperation,
		LandOwnerLivenessMonitor: ownerModule.LandOwnerLivenessMonitor,
		makeWorktreeCleanup: worktreeModule.makeWorktreeCleanup,
		CommDB: commModule.CommDB,
	};
	for (const [name, value] of Object.entries(modules)) {
		if (!value) throw new Error(`dist_export_missing:${name}`);
	}
	const root = mkdtempSync(join(tmpdir(), "fly2616-closeout-replay-"));
	try {
		const cases = [];
		for (const [index, entry] of manifest.cases.entries()) {
			cases.push(await runDerivedCase(modules, entry, index, root));
		}
		const controls = await negativeControls(modules.collectCloseoutEvidence);
		const lease = await childKillGate(
			modules.StateStore,
			modules.LandOwnerLivenessMonitor,
		);
		const archiveFailure = await archiveFailureControl(
			modules.StateStore,
			modules.executeLandOperation,
		);
		process.stdout.write(
			`${JSON.stringify({
				ok: true,
				head: currentHead(),
				manifest: relative(repoRoot, manifestPath),
				manifestDigest: digest(manifest),
				mode: manifest.mode,
				networkCalls: 0,
				cases,
				controls,
				lease,
				archiveFailure,
				productionAcceptance: false,
				productionAcceptanceReason: manifest.productionSnapshot.reason,
				externalSandboxAcceptance: false,
				externalSandboxAcceptanceReason: manifest.externalSandbox.reason,
				externalSandboxReadback: {
					status: "not_run",
					threadArchived: null,
					linearStateType: null,
					archiveCalls: null,
					linearCalls: null,
				},
			})}\n`,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

main().catch((error) =>
	fail(error instanceof Error ? error.stack : String(error)),
);
