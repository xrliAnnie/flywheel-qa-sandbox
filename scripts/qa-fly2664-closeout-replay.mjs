#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = realpathSync(
	resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);

function fail(reason) {
	process.stderr.write(`${JSON.stringify({ ok: false, reason })}\n`);
	process.exitCode = 1;
}

function git(cwd, args) {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_AUTHOR_DATE: "2026-09-17T20:00:00Z",
			GIT_COMMITTER_DATE: "2026-09-17T20:00:00Z",
		},
	}).trim();
}

function digest(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function main() {
	if (!process.argv.includes("--sandbox-only"))
		throw new Error("sandbox_only_required");
	globalThis.fetch = async () => {
		throw new Error("network_disabled_by_fly2664_replay");
	};
	const dist = (path) => pathToFileURL(join(repoRoot, path)).href;
	const [
		stateModule,
		landModule,
		contextModule,
		finalizationModule,
		cleanupModule,
		branchModule,
		edgeModule,
		configModule,
	] = await Promise.all([
		import(dist("packages/teamlead/dist/StateStore.js")),
		import(dist("packages/teamlead/dist/bridge/land-executor.js")),
		import(dist("packages/teamlead/dist/bridge/land-finalization-context.js")),
		import(dist("packages/teamlead/dist/bridge/post-ship-finalization.js")),
		import(dist("packages/teamlead/dist/bridge/worktree-cleanup.js")),
		import(dist("packages/teamlead/dist/bridge/branch-cleanup.js")),
		import(dist("packages/edge-worker/dist/index.js")),
		import(dist("packages/config/dist/index.js")),
	]);
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2664-closeout-replay-")),
	);
	const projectRoot = join(root, "flywheel");
	const worktreePath = join(root, "flywheel-FLY-2601");
	const branch = "docs/FLY-2601-founder-page-copy-block-placement";
	const generation = "generation-2601";
	const store = await stateModule.StateStore.create(":memory:");
	try {
		mkdirSync(projectRoot);
		git(projectRoot, ["init", "-b", "main"]);
		git(projectRoot, ["config", "user.name", "Flywheel Replay"]);
		git(projectRoot, ["config", "user.email", "flywheel@example.invalid"]);
		writeFileSync(join(projectRoot, "README.md"), "base\n");
		git(projectRoot, ["add", "."]);
		git(projectRoot, ["commit", "-m", "base"]);
		git(projectRoot, ["worktree", "add", "-b", branch, worktreePath, "main"]);
		writeFileSync(join(worktreePath, "copy.md"), "merged copy\n");
		git(worktreePath, ["add", "."]);
		git(worktreePath, ["commit", "-m", "FLY-2601 copy"]);
		const prHead = git(worktreePath, ["rev-parse", "HEAD"]);
		git(projectRoot, ["merge", "--ff-only", branch]);
		const mergeSha = git(projectRoot, ["rev-parse", "HEAD"]);
		const marker = git(worktreePath, [
			"rev-parse",
			"--path-format=absolute",
			"--git-path",
			"flywheel.generation",
		]);
		writeFileSync(marker, `${generation}\n`);
		const parent = statSync(root);
		const target = {
			kind: "bound_worktree",
			path: worktreePath,
			branch: "flywheel-FLY-2601",
			generation,
			projectRoot,
			parentIdentity: {
				path: root,
				dev: Number(parent.dev),
				ino: Number(parent.ino),
			},
			sourceExecutionIds: ["implement-2601"],
			sourceRunId: null,
			sourceReceipt: "derived-fixture:binding=flywheel-FLY-2601",
		};
		const snapshot = {
			version: 1,
			project: "flywheel",
			issueUuid: "FLY-2601",
			runId: null,
			targets: [target],
		};
		const snapshotJson = configModule.canonicalJsonString(snapshot);
		// The closeout audit uses the process clock, so the replay lease must start
		// at replay time rather than at the fixture's fixed Git commit timestamp.
		const now = new Date();
		const operation = store.ensureLandOperation({
			issueId: "FLY-2601",
			projectName: "flywheel",
			prNumber: 1232,
			approvedHead: prHead,
			now: now.toISOString(),
			verifiedTargets: {
				json: snapshotJson,
				digest: configModule.canonicalSubmissionDigest(snapshot),
				version: 1,
				attributionDigest: configModule.canonicalSubmissionDigest([
					"implement-2601",
				]),
				observedAt: "2026-09-17T20:00:00.000Z",
			},
		});
		const manager = new edgeModule.WorktreeManager();
		const cleanup = cleanupModule.makeWorktreeCleanup({
			store,
			worktreeManager: manager,
			resolveProjectRoot: () => projectRoot,
			isWorktreeClean: cleanupModule.gitWorktreeClean,
			autoclean: true,
			withRepoLock: async (_repo, fn) => fn(),
			protectedBranchesForProject: () => ["main", "master"],
			isOperationAuthorityCurrent: (identity) => {
				const current = store.getLandOperation(identity.operationId);
				return Boolean(
					current?.state === "running" &&
						current.owner_id === identity.ownerId &&
						current.generation === identity.generation,
				);
			},
		});
		let remoteMutationAttempts = 0;
		const remoteCleanup = branchModule.makeShipRemoteBranchCleanup({
			store,
			resolveProjectRoot: () => projectRoot,
			getMergedPrHeads: async () => {
				remoteMutationAttempts += 1;
				throw new Error("merged proof must remain local-only");
			},
			exec: async () => {
				remoteMutationAttempts += 1;
				throw new Error("remote git mutation must not run");
			},
		});
		const result = await landModule.executeLandOperation(
			operation.operation_id,
			{
				store,
				ownerId: "fly2664-replay",
				now: () => now,
				authorize: () => ({ ok: true }),
				mergeDriver: {
					inspectPr: async () => ({
						state: "MERGED",
						headSha: prHead,
						mergeSha,
						baseRefName: "main",
						repoIdentity: "owner/flywheel",
					}),
					triggerCool: async () => {
						throw new Error("already merged fixture must not trigger merge");
					},
					inspectTriggeredWorkflow: async () => ({ state: "pending" }),
				},
				finalize: async (current) => {
					const prepared = contextModule.prepareLandFinalization(
						store,
						current,
						{},
						{
							projectName: "flywheel",
							projectRoot,
							projectRepo: "owner/flywheel",
						},
					);
					assert.equal(prepared.ok, true, JSON.stringify(prepared));
					assert.ok(prepared.opts.mergedWorktreeProof);
					const settled = await finalizationModule.settleLandOperationWorktrees(
						prepared.opts,
						{
							store,
							removeCleanWorktree: cleanup,
							remoteBranchCleanup: remoteCleanup,
						},
						true,
					);
					assert.equal(settled.complete, true, JSON.stringify(settled));
					const disposition = store.recordLandLinearDoneDisposition({
						operationId: current.operation_id,
						ownerId: current.owner_id,
						generation: current.generation,
						disposition: "done",
						reason: "fly2664_sandbox_replay",
						executionId: "implement-2601",
						now: now.toISOString(),
					});
					assert.equal(disposition.ok, true);
					return { complete: true, outcome: "completed" };
				},
			},
		);
		assert.equal(result.status, "completed", JSON.stringify(result));
		assert.equal(existsSync(worktreePath), false);
		assert.doesNotMatch(
			git(projectRoot, ["worktree", "list", "--porcelain"]),
			new RegExp(worktreePath),
		);
		assert.equal(
			spawnSync("git", [
				"-C",
				projectRoot,
				"show-ref",
				"--quiet",
				"--verify",
				`refs/heads/${branch}`,
			]).status,
			1,
		);
		assert.equal(remoteMutationAttempts, 0);
		assert.equal(
			store.getLandOperation(operation.operation_id).state,
			"completed",
		);
		process.stdout.write(
			`${JSON.stringify({
				ok: true,
				mode: "derived_fixture",
				issueShape: "FLY-2601",
				pr: 1232,
				fixtureDigest: digest({
					issue: "FLY-2601",
					pr: 1232,
					bindingBranch: target.branch,
					registeredBranch: branch,
					prHead,
					mergeSha,
					generation,
				}),
				registeredBranch: branch,
				bindingBranch: target.branch,
				prHead,
				mergeSha,
				landFinalization: "completed",
				directoryExists: false,
				registrationExists: false,
				branchExists: false,
				remoteMutationAttempts,
				networkCalls: 0,
				productionAcceptance: false,
			})}\n`,
		);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
}

main().catch((error) =>
	fail(error instanceof Error ? error.stack : String(error)),
);
