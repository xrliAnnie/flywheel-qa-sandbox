import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchOnce, type SpawnRequest } from "flywheel-v2-dag";
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
import { createOperationalDagPorts } from "../dag-ports.js";

const AGENT_CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const WINDOW = "drill-window";
const EPOCH = 9;
const HOST_EPOCH = "drill-host-epoch";
const ISSUE = "FLY-1545-drill";
const MERGED_SHA = "d".repeat(40);

/**
 * FLY-1545 ②: founder ship approval gate drill -- the plan §3.1 seven steps,
 * executed through REAL `flywheel-v2` CLI processes (the exact verbs the
 * founder runs) against a real live-authority kernel DB and a real git
 * worktree. GitHub is the only fake: a stateful fake-gh subprocess that
 * merges on the `:cool:` comment, so the whole
 * open -> negative -> approve -> replay -> drift -> red-to-green -> settle
 * lifecycle is exercised end to end and repeatably. The test-room rerun with
 * real GitHub is FLY-1539's inheritance; the production smoke of the
 * installed gate is post-merge evidence (plan §3.2).
 */
interface GhControl {
	head: string;
	mergeStateStatus: string;
	checks: { bucket: string; name: string; state: string }[];
	checksStatus: number;
	mergeOnCool: boolean;
	mergedSha: string;
	mergedMarkerPath: string;
	logPath: string;
}

function makeDrillRig() {
	const dir = mkdtempSync(join(tmpdir(), "flywheel-v2-ship-drill-"));
	chmodSync(dir, 0o700);
	const dbPath = join(dir, "flywheel-v2.db");
	const markerPath = join(dir, "migration-complete.json");
	const authorityPath = join(dir, "authority.json");
	const armedPath = join(dir, "armed.json");
	const lockRoot = join(dir, "locks");
	const controlPath = join(dir, "gh-control.json");
	const ghPath = join(dir, "gh");
	const repoPath = join(dir, "repo");

	// A REAL git worktree: admission/completion read heads from it.
	mkdirSync(repoPath);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
	execFileSync("git", ["init", "--initial-branch=main", repoPath], {
		encoding: "utf8",
	});
	git("config", "user.email", "drill@flywheel.dev");
	git("config", "user.name", "Flywheel Drill");
	writeFileSync(join(repoPath, "README.md"), "drill\n");
	git("add", "README.md");
	git("commit", "-m", "drill: base");
	// Admission requires the worktree head to sit ON the merge anchor -- work
	// enters the ledger only through authenticated completions, so the drill
	// admits at the anchor and runs a non-writer node.
	git("checkout", "-b", "feature");
	const head = git("rev-parse", "HEAD");

	// Stateful fake gh: `pr comment :cool:` flips the PR to MERGED, exactly
	// like ship-on-comment.yml does after its own CI rerun.
	writeFileSync(
		ghPath,
		`#!/usr/bin/env node
const { readFileSync, writeFileSync, existsSync, appendFileSync } = require("node:fs");
const control = JSON.parse(readFileSync(process.env.DRILL_GH_CONTROL, "utf8"));
const args = process.argv.slice(2);
appendFileSync(control.logPath, JSON.stringify(args) + "\\n");
const merged = existsSync(control.mergedMarkerPath);
const sub = args.slice(0, 2).join(" ");
if (sub === "pr view") {
	process.stdout.write(JSON.stringify(merged
		? { headRefOid: control.head, state: "MERGED",
			mergeCommit: { oid: control.mergedSha }, mergeStateStatus: "UNKNOWN" }
		: { headRefOid: control.head, state: "OPEN",
			mergeCommit: null, mergeStateStatus: control.mergeStateStatus }));
	process.exit(0);
}
if (sub === "pr checks") {
	process.stdout.write(JSON.stringify(control.checks));
	process.exit(control.checksStatus);
}
if (sub === "pr comment") {
	const body = args[args.indexOf("--body") + 1];
	if (control.mergeOnCool && body === ":cool:") {
		writeFileSync(control.mergedMarkerPath, "merged");
	}
	process.exit(0);
}
process.stderr.write("fake gh: unsupported " + sub);
process.exit(1);
`,
	);
	chmodSync(ghPath, 0o755);
	const control: GhControl = {
		head,
		mergeStateStatus: "CLEAN",
		checks: [{ bucket: "pass", name: "ci", state: "COMPLETED" }],
		checksStatus: 0,
		mergeOnCool: false,
		mergedSha: MERGED_SHA,
		mergedMarkerPath: join(dir, "merged.marker"),
		logPath: join(dir, "gh.log"),
	};
	const writeControl = (patch: Partial<GhControl>) => {
		Object.assign(control, patch);
		writeFileSync(controlPath, JSON.stringify(control));
	};
	writeControl({});
	process.env.DRILL_GH_CONTROL = controlPath;

	// Live-authority DB bring-up (same lifecycle the production cutover used).
	seedPreCutoverAuthority({
		authorityPath,
		armedPath,
		windowId: WINDOW,
		epoch: EPOCH,
		nowIso: "2026-07-30T00:00:00.000Z",
	});
	armCutoverAuthority({
		authorityPath,
		armedPath,
		windowId: WINDOW,
		epoch: EPOCH,
		nowIso: "2026-07-30T00:01:00.000Z",
	});
	migrateDatabase({ path: dbPath });
	const kernel = Kernel.open({ path: dbPath });
	initializeEngineDb(kernel);
	kernel.write("drill.cutover-meta", (tx) => {
		for (const [key, value] of [
			["cutover_window_id", WINDOW],
			["cutover_epoch", String(EPOCH)],
		] as const) {
			tx.run(
				`INSERT INTO meta(key,value,updated_at)
				 VALUES (@key,@value,@now)
				 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
				{ key, value, now: "2026-07-30T00:00:00.000Z" },
			);
		}
	});
	provisionAgentRecipient(kernel, "drill-lead", "lead");
	provisionAgentRecipient(kernel, "drill-ship-agent", "lead");
	kernel.close();
	chmodSync(dbPath, 0o600);
	publishMigrationCompleteMarker({
		dbPath,
		markerPath,
		authorityPath,
		armedPath,
		expectedWindowId: WINDOW,
		expectedEpoch: EPOCH,
		nowIso: "2026-07-30T00:02:00.000Z",
	});
	const liveKernel = Kernel.open({ path: dbPath });
	liveKernel.write("drill.publish-live", (tx) => {
		advanceDatabaseAuthorityStateTx(tx, {
			expected: "cutover",
			next: "live",
			nowIso: "2026-07-30T00:02:01.000Z",
		});
	});
	liveKernel.close();
	publishLiveCutoverAuthority({
		authorityPath,
		armedPath,
		windowId: WINDOW,
		epoch: EPOCH,
		nowIso: "2026-07-30T00:02:02.000Z",
	});

	const contractArgs = [
		"--db",
		dbPath,
		"--marker",
		markerPath,
		"--authority",
		authorityPath,
		"--armed",
		armedPath,
		"--window",
		WINDOW,
		"--epoch",
		String(EPOCH),
		"--host-epoch",
		HOST_EPOCH,
		"--lock-root",
		lockRoot,
		"--gh-bin",
		ghPath,
	];
	let requestCount = 0;
	return {
		dir,
		head,
		repoPath,
		control,
		writeControl,
		ghLog: () =>
			existsSync(control.logPath)
				? readFileSync(control.logPath, "utf8").trim().split("\n")
				: [],
		/** Runs the REAL CLI; returns parsed stdout JSON. */
		cli(verb: string, request?: unknown): unknown {
			const args = [AGENT_CLI, verb, ...contractArgs];
			if (request !== undefined) {
				requestCount += 1;
				const requestPath = join(dir, `request-${requestCount}.json`);
				writeFileSync(requestPath, JSON.stringify(request));
				args.push("--request-file", requestPath);
			}
			return JSON.parse(
				execFileSync(process.execPath, args, { encoding: "utf8" }),
			);
		},
		/** Runs the REAL CLI expecting a refusal; returns exit code + stderr. */
		cliRefused(verb: string, request: unknown): { code: number; err: string } {
			try {
				this.cli(verb, request);
				throw new Error(`expected ${verb} to be refused`);
			} catch (error) {
				const failure = error as { status?: number; stderr?: unknown };
				if (typeof failure.status !== "number") throw error;
				return { code: failure.status, err: String(failure.stderr ?? "") };
			}
		},
		read<T>(fn: (tx: Parameters<Parameters<Kernel["read"]>[0]>[0]) => T): T {
			const readKernel = Kernel.open({ path: dbPath });
			try {
				return readKernel.read(fn);
			} finally {
				readKernel.close();
			}
		},
		async dispatchInProcess(): Promise<SpawnRequest> {
			const dispatchKernel = Kernel.open({ path: dbPath });
			try {
				const ports = createOperationalDagPorts({
					ghBin: ghPath,
					hostEpoch: HOST_EPOCH,
					lockRoot,
				});
				const result = await dispatchOnce(dispatchKernel, {
					...ports,
					spawn: {
						async spawn(request) {
							return {
								v: 1,
								hostEpoch: HOST_EPOCH,
								sessionId: request.sessionRef,
								pid: 20_001,
								pidStart: `drill-start:${request.sessionRef}`,
							};
						},
					},
					process: {
						async probe() {
							return {
								state: "absent" as const,
								confirmedAt: new Date().toISOString(),
							};
						},
					},
				});
				const spawned = result.dispatched[0];
				if (!spawned) {
					throw new Error(
						`dispatch produced nothing: ${JSON.stringify(result)}`,
					);
				}
				return spawned;
			} finally {
				dispatchKernel.close();
			}
		},
		gateRow() {
			return this.read((tx) =>
				tx.get<{
					state: string;
					attempts: number;
					capabilityId: string | null;
					settledSha: string | null;
				}>(
					`SELECT json_extract(value,'$.data.state') AS state,
					        json_extract(value,'$.data.retry.attempt_count') AS attempts,
					        json_extract(value,'$.data.capability_id') AS capabilityId,
					        json_extract(value,'$.data.settled.merged_sha') AS settledSha
					   FROM meta WHERE key='ship_gate:${ISSUE}'`,
				),
			);
		},
		capabilityConsumed(capabilityId: string) {
			return this.read(
				(tx) =>
					tx.get<{ consumed: string | null }>(
						"SELECT consumed_at AS consumed FROM capabilities WHERE id=@id",
						{ id: capabilityId },
					)?.consumed ?? null,
			);
		},
		cleanup() {
			delete process.env.DRILL_GH_CONTROL;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("FLY-1545 ② founder ship approval gate drill (real CLI, plan §3.1)", () => {
	const rigs: ReturnType<typeof makeDrillRig>[] = [];
	afterEach(() => {
		for (const rig of rigs.splice(0)) rig.cleanup();
	});

	it("walks the seven-step drill end to end", async () => {
		const rig = makeDrillRig();
		rigs.push(rig);

		// -- Step 1: admit a one-node DAG, run it to all-members-done; the gate
		// opens by itself (maybeRefreshShipGateTx on the completion path).
		expect(
			rig.cli("admit", {
				admissionUid: "drill-admission",
				projectId: "project-drill",
				issueId: ISSUE,
				notifyAgentId: "drill-lead",
				shipWorktreeId: "wt-drill",
				worktrees: [
					{
						worktreeId: "wt-drill",
						repoIdentity: rig.repoPath,
						worktreePath: rig.repoPath,
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
							family: "family-drill",
							vendor: "vendor",
							model: "model",
							effort: "high",
						},
					},
				],
				edges: [],
			}),
		).toMatchObject({ status: "admitted", issueId: ISSUE });
		const attempt = await rig.dispatchInProcess();
		expect(
			rig.cli("complete", {
				taskId: attempt.taskId,
				attemptId: attempt.attemptId,
				activationId: attempt.activationId,
				agent: attempt.agent,
				completionUid: "drill-completion",
			}),
		).toMatchObject({ status: "completed" });
		expect(rig.gateRow()).toMatchObject({ state: "open", attempts: 0 });
		expect(
			rig.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM events WHERE kind='gate_opened'",
					)?.count,
			),
		).toBe(1);

		// -- Step 2 (negative, before any approval): a ship request with a
		// fabricated capability is refused; the gate does not move.
		const unapproved = rig.cliRefused("ship", {
			issueId: ISSUE,
			capabilityId: "00000000-0000-0000-0000-000000000000",
			actor: {
				kind: "lead",
				agentId: "drill-ship-agent",
				instanceId: "drill-session",
				generation: 0,
			},
		});
		expect(unapproved.code).toBe(1);
		expect(unapproved.err).toContain("ship authority is incomplete");
		expect(rig.gateRow()).toMatchObject({ state: "open", attempts: 0 });

		// -- Step 3: founder approves with a real approvalRef; capability mints,
		// ship_authorized reaches the actor's mailbox, pr_ready hits the thread
		// lifecycle.
		const approval = rig.cli("approve-ship", {
			issueId: ISSUE,
			approvalRef: "drill-approval-1",
			observedTip: rig.head,
			shipTarget: { repo: rig.repoPath, pr: 31 },
			actorConfig: {
				defaultActionAgentId: "drill-ship-agent",
				configDigest: "drill-config",
			},
		}) as { capabilityId: string };
		expect(approval.capabilityId).toEqual(expect.any(String));
		expect(rig.gateRow()).toMatchObject({
			state: "approved",
			capabilityId: approval.capabilityId,
		});
		expect(rig.capabilityConsumed(approval.capabilityId)).toBeNull();
		expect(
			rig.read((tx) => ({
				approvedEvents: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='gate_approved'",
				)?.count,
				authorizedMail: tx.get<{ count: number }>(
					`SELECT count(*) AS count FROM mailbox
					  WHERE kind='ship_authorized' AND to_agent='drill-ship-agent'`,
				)?.count,
				prReadyMail: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE kind='pr_ready'",
				)?.count,
			})),
			// Lifecycle rows are COPIED to two mailboxes by design (FLY-1544
			// founder ruling): the issue lead and the Discord messenger.
		).toEqual({ approvedEvents: 1, authorizedMail: 1, prReadyMail: 2 });

		// -- Step 4 (negative): the same approvalRef replayed onto a different
		// target is a conflict, not a second authority.
		const replay = rig.cliRefused("approve-ship", {
			issueId: ISSUE,
			approvalRef: "drill-approval-1",
			observedTip: rig.head,
			shipTarget: { repo: rig.repoPath, pr: 32 },
			actorConfig: {
				defaultActionAgentId: "drill-ship-agent",
				configDigest: "drill-config",
			},
		});
		expect(replay.err).toContain("ship approval replay conflicts");

		// -- Step 5 (negative): the PR head drifts away from the approved tip;
		// ship refuses and consumes nothing. Recovery is force-pushing the
		// approved head back (here: restoring the fake world).
		const actor = {
			kind: "lead",
			agentId: "drill-ship-agent",
			instanceId: "drill-session",
			generation: 0,
		};
		rig.writeControl({ head: "b".repeat(40) });
		const drifted = rig.cliRefused("ship", {
			issueId: ISSUE,
			capabilityId: approval.capabilityId,
			actor,
		});
		expect(drifted.err).toContain("world head drifted");
		expect(rig.capabilityConsumed(approval.capabilityId)).toBeNull();
		expect(rig.gateRow()).toMatchObject({ state: "approved", attempts: 0 });
		rig.writeControl({ head: rig.head });

		// -- Step 6: CI red refuses with zero consumption; the checks rerun
		// green on the SAME head; the SAME capability then ships -- zero
		// re-approval. The fake PR merges on the `:cool:` comment.
		rig.writeControl({
			checks: [{ bucket: "fail", name: "ci", state: "COMPLETED" }],
		});
		const red = rig.cliRefused("ship", {
			issueId: ISSUE,
			capabilityId: approval.capabilityId,
			actor,
		});
		expect(red.err).toContain("ci is not green");
		expect(rig.capabilityConsumed(approval.capabilityId)).toBeNull();
		expect(rig.gateRow()).toMatchObject({ state: "approved", attempts: 0 });
		rig.writeControl({
			checks: [{ bucket: "pass", name: "ci", state: "COMPLETED" }],
			mergeOnCool: true,
		});
		expect(
			rig.cli("ship", {
				issueId: ISSUE,
				capabilityId: approval.capabilityId,
				actor,
			}),
		).toMatchObject({ status: "succeeded", mergedSha: MERGED_SHA });
		expect(
			rig.read((tx) => ({
				shipCompleted: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='ship_completed'",
				)?.count,
				mergedMail: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE kind='issue_merged'",
				)?.count,
			})),
		).toEqual({ shipCompleted: 1, mergedMail: 2 });
		expect(rig.gateRow()).toMatchObject({ settledSha: MERGED_SHA });
		expect(
			rig.ghLog().filter((line) => line.includes('"comment"')),
		).toHaveLength(1);

		// -- Step 7 (negative): a settled gate cannot ship again. With the CI
		// wait installed the refusal now fires at the observation layer (a
		// merged PR reports mergeStateStatus=UNKNOWN, fail-closed red) before
		// the ledger's own "already successful" guard; nothing is written.
		const resettle = rig.cliRefused("ship", {
			issueId: ISSUE,
			capabilityId: approval.capabilityId,
			actor,
		});
		expect(resettle.err).toContain("ci is not green");
		expect(rig.gateRow()).toMatchObject({ settledSha: MERGED_SHA });
		expect(
			rig.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM actions WHERE kind='github_merge'",
					)?.count,
			),
		).toBe(1);
	}, 60_000);
});
