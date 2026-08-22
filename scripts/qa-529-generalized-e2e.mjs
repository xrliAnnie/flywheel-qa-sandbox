#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	buildGateDeliveryOpenArgs,
	buildGateDeliveryRespondArgs,
	buildGeneralizedStartRequest,
	buildSlotCommEnv,
	classifyDurableLaunchDrain,
	generalizedEntryAuthorityIsReady,
	hasOwnedPrMarker,
	parseTmuxTargetIdentity,
	proveOwnedExecutionSet,
	reconcileOwnedExecutionSet,
	resolveOwnedPrEvidence,
	resolveVerifiedPrCleanupTarget,
	shouldTerminatePriorRun,
	terminateQaSessionForA3,
	tmuxObservationIsAlive,
	validateGeneralizedStartResponse,
	validateQaShipPreconditions,
	validateRoomInfo,
} from "./lib/qa-generalized-e2e-lib.mjs";

const A3_DIAGNOSIS_EXIT = 20;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 500;

function usage() {
	process.stderr.write(`Usage:
  scripts/qa-529-generalized-e2e.mjs <slot> --issue <FLY-N> [--real]

Exit 0: steps 1-9 completed
Exit ${A3_DIAGNOSIS_EXIT}: steps 1-7 completed; step 8 emitted the known F2 PR-authority diagnosis
Other non-zero: fail-closed setup, ownership, assertion, or infrastructure error
`);
}

function parseArgs(argv) {
	const args = { runnerMode: "stub", timeoutMs: DEFAULT_TIMEOUT_MS };
	let index = 0;
	if (/^\d+$/.test(argv[0] ?? "")) args.slot = Number(argv[index++]);
	for (; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--issue") args.issue = argv[++index];
		else if (value === "--real") args.runnerMode = "real";
		else if (value === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
		else if (value === "--help" || value === "-h") {
			usage();
			process.exit(0);
		} else throw new Error(`unknown argument: ${value}`);
	}
	if (!Number.isInteger(args.slot) || args.slot < 1) {
		throw new Error("slot must be a positive integer");
	}
	if (!/^[A-Z]+-\d+$/.test(args.issue ?? "")) {
		throw new Error("--issue must be a canonical identifier such as FLY-202");
	}
	if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 10_000) {
		throw new Error("--timeout-ms must be at least 10000");
	}
	return args;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp.${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}

function command(file, args, options = {}) {
	return execFileSync(file, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	}).trim();
}

function stableId(prefix, value) {
	return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function sleep(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(label, probe, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		try {
			last = await probe();
			if (last) return last;
		} catch (error) {
			last = error instanceof Error ? error.message : String(error);
		}
		await sleep(POLL_MS);
	}
	throw new Error(
		`${label} timed out after ${timeoutMs}ms; last=${JSON.stringify(last)}`,
	);
}

async function httpJson(url, options = {}) {
	const response = await fetch(url, options);
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { raw: text };
	}
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${url}: ${JSON.stringify(body)}`);
	}
	return { status: response.status, body };
}

function tableExists(db, table) {
	return Boolean(
		db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(table),
	);
}

function all(db, sql, ...params) {
	return db.prepare(sql).all(...params);
}

function one(db, sql, ...params) {
	return db.prepare(sql).get(...params);
}

function parseSnapshot(value) {
	if (typeof value === "string") return JSON.parse(value);
	return value;
}

function snapshotNode(snapshot, id) {
	const manifest = snapshot?.manifest ?? snapshot;
	return manifest?.nodes?.find((node) => node.id === id);
}

function snapshotGate(snapshot) {
	const manifest = snapshot?.manifest ?? snapshot;
	return manifest?.approval_gate ?? manifest?.approvalGate;
}

function executionRows(db, runId) {
	return all(
		db,
		`SELECT DISTINCT b.execution_id AS executionId, b.node_id AS nodeId,
		        b.attempt, a.role, s.status AS sessionStatus,
		        s.terminal_at AS terminalAt, s.tmux_session AS stateTmux,
		        s.worktree_binding_path AS worktreeBindingPath,
		        s.worktree_binding_branch AS worktreeBindingBranch,
		        s.worktree_binding_generation AS worktreeBindingGeneration,
		        s.pr_number AS prNumber, s.pr_head_sha AS prHeadSha
		   FROM workflow_execution_binding b
		   JOIN workflow_actor a ON a.execution_id = b.execution_id
		   LEFT JOIN sessions s ON s.execution_id = b.execution_id
		  WHERE b.run_id = ?
		  ORDER BY b.bound_at, b.execution_id`,
		runId,
	);
}

function observedRunExecutionIds(db, runId) {
	const bound = executionRows(db, runId).map((row) => row.executionId);
	const currentNodes = all(
		db,
		"SELECT execution_id AS executionId FROM workflow_run_node WHERE run_id = ? AND execution_id IS NOT NULL",
		runId,
	).map((row) => row.executionId);
	return [...new Set([...bound, ...currentNodes])];
}

function syncOwnedExecutions(db, runId, owner, ownerPath) {
	const observed = observedRunExecutionIds(db, runId);
	const reconciled = reconcileOwnedExecutionSet(
		owner.executionIds ?? [],
		observed,
	);
	if (JSON.stringify(owner.executionIds ?? []) !== JSON.stringify(reconciled)) {
		owner.executionIds = reconciled;
		writeJsonAtomic(ownerPath, owner);
	}
	return reconciled;
}

function requestExecutionExits(slotDir, runId, executionIds) {
	for (const executionId of executionIds) {
		writeJsonAtomic(join(slotDir, "stub-control", `${executionId}.exit.json`), {
			schemaVersion: 1,
			runId,
			executionId,
			requested: true,
			requestedAt: new Date().toISOString(),
		});
	}
}

function currentPark(db, executionId) {
	if (!tableExists(db, "workflow_engine_park_outbox")) return null;
	return one(
		db,
		`SELECT * FROM workflow_engine_park_outbox
		  WHERE execution_id = ? ORDER BY row_id DESC LIMIT 1`,
		executionId,
	);
}

function readCommTarget(commDb, executionId) {
	if (!commDb || !tableExists(commDb, "sessions")) return null;
	return one(
		commDb,
		"SELECT tmux_window AS tmuxWindow, status FROM sessions WHERE execution_id = ?",
		executionId,
	);
}

function processAlive(pid) {
	if (!Number.isInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function paneAlive(target, executionId) {
	const identity = parseTmuxTargetIdentity(target);
	if (!identity) return false;
	const env = { ...process.env };
	delete env.TMUX;
	delete env.TMUX_PANE;
	const result = spawnSync(
		"tmux",
		[
			"display-message",
			"-p",
			"-t",
			identity.target,
			"#{window_id}|#{pane_id}|#{pane_dead}|#{@flywheel_exec_id}",
		],
		{ encoding: "utf8", env },
	);
	if (result.status !== 0) return false;
	return tmuxObservationIsAlive(identity.target, result.stdout, executionId);
}

function probeExecution(slotDir, commDb, executionId) {
	const statePath = join(slotDir, "stub-state", `${executionId}.json`);
	const stub = existsSync(statePath) ? readJson(statePath) : null;
	const comm = readCommTarget(commDb, executionId);
	const pidAlive = processAlive(stub?.pid);
	const tmuxAlive = paneAlive(comm?.tmuxWindow, executionId);
	return {
		executionId,
		liveness: pidAlive || tmuxAlive ? "alive" : "dead",
		pid: stub?.pid ?? null,
		pidAlive,
		tmuxWindow: comm?.tmuxWindow ?? null,
		tmuxAlive,
		stub,
	};
}

function dangerousReworkRows(db, runId) {
	if (!tableExists(db, "workflow_rework_delivery")) return [];
	return all(
		db,
		`SELECT d.request_id, d.state, d.last_error
		   FROM workflow_rework_delivery d
		   JOIN workflow_rework_request r ON r.request_id = d.request_id
		  WHERE r.run_id = ? AND (
		        d.state IN ('held','needs_lead') OR
		        lower(COALESCE(d.last_error, '')) LIKE '%state_not_revivable%' OR
		        lower(COALESCE(d.last_error, '')) LIKE '%holder_activation_failed%')`,
		runId,
	);
}

function latestStub(slotDir, executionId) {
	const path = join(slotDir, "stub-state", `${executionId}.json`);
	return existsSync(path) ? readJson(path) : null;
}

function stepWriter(evidenceDir, runId) {
	return (step, title, payload) => {
		const evidence = {
			schemaVersion: 1,
			runId,
			step,
			title,
			observedAt: new Date().toISOString(),
			...payload,
		};
		writeJsonAtomic(join(evidenceDir, `step-${step}.json`), evidence);
		process.stdout.write(`[qa529] step ${step}: ${title}\n`);
		return evidence;
	};
}

function priorOwners(evidenceRoot, issue) {
	if (!existsSync(evidenceRoot)) return [];
	return readdirSync(evidenceRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(evidenceRoot, entry.name, "owner.json"))
		.filter(existsSync)
		.map((path) => ({
			path,
			owner: readJson(path),
			mtime: statSync(path).mtimeMs,
		}))
		.filter(({ owner }) => owner.schemaVersion === 1 && owner.issue === issue)
		.sort((left, right) => right.mtime - left.mtime);
}

async function terminateOwnedRun(room, token, runId) {
	const clientRequestId = stableId("qa529-terminate", runId);
	const request = {
		reason: "FLY-1775 replay convergence for marker-owned 529 drill",
		clientRequestId,
	};
	for (let replay = 0; replay < 2; replay += 1) {
		await httpJson(
			`${room.bridgeUrl}/api/runs/${encodeURIComponent(runId)}/terminate`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
			},
		);
	}
	return { clientRequestId, replayed: true };
}

function launchDrainSnapshot(db, commDb, slotDir, runId, executionIds) {
	const runStatus = one(
		db,
		"SELECT status FROM workflow_run WHERE run_id = ?",
		runId,
	)?.status;
	const placeholders = executionIds.map(() => "?").join(",");
	const lifecycleClaims =
		executionIds.length && tableExists(db, "lifecycle_launch_claims")
			? all(
					db,
					`SELECT * FROM lifecycle_launch_claims WHERE execution_id IN (${placeholders})`,
					...executionIds,
				)
			: [];
	const launchOwners =
		executionIds.length && tableExists(db, "workflow_launch_owner")
			? all(
					db,
					`SELECT * FROM workflow_launch_owner WHERE execution_id IN (${placeholders})`,
					...executionIds,
				)
			: [];
	const rows = executionRows(db, runId);
	const actors = rows.map((row) => {
		const live = probeExecution(slotDir, commDb, row.executionId);
		return {
			executionId: row.executionId,
			liveness: live.liveness,
			sessionStatus: row.sessionStatus,
			parkOpen: currentPark(db, row.executionId)?.event === "park_opened",
		};
	});
	return { runStatus, lifecycleClaims, launchOwners, actors };
}

async function githubRequest(repo, path, options = {}) {
	const token = command("gh", ["auth", "token"]);
	const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
		...options,
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"x-github-api-version": "2022-11-28",
			...(options.headers ?? {}),
		},
	});
	const text = await response.text();
	let body = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = { raw: text };
	}
	return { response, body };
}

async function cleanupOwnedPr(pr, runId, ownedExecutionIds) {
	if (!pr) return { skipped: "no_pr" };
	const current = await githubRequest(pr.repo, `/pulls/${pr.number}`);
	if (!current.response.ok)
		throw new Error(`cannot inspect prior PR #${pr.number}`);
	if (!hasOwnedPrMarker(current.body.body, runId, ownedExecutionIds)) {
		throw new Error(`prior PR #${pr.number} is not marker-owned by ${runId}`);
	}
	const target = resolveVerifiedPrCleanupTarget(pr, current.body);
	if (current.body.state === "open") {
		const closed = await githubRequest(pr.repo, `/pulls/${pr.number}`, {
			method: "PATCH",
			body: JSON.stringify({ state: "closed" }),
		});
		if (!closed.response.ok)
			throw new Error(`marker-owned close failed for PR #${pr.number}`);
	}
	const encoded = target.branch.split("/").map(encodeURIComponent).join("/");
	// The exact execution set and durable launch owners are drained before this
	// point. GitHub has no ref-delete CAS, so be honest: re-read the ref, refuse
	// any head drift, then perform one narrow unconditional sandbox deletion.
	const ref = await githubRequest(target.repo, `/git/ref/heads/${encoded}`);
	if (ref.response.status === 404)
		return { closed: true, branch: "already_absent" };
	if (!ref.response.ok || ref.body.object?.sha !== target.expectedHead) {
		throw new Error(
			`prior branch ${target.branch} head drifted; refusing deletion`,
		);
	}
	const deleted = await githubRequest(
		target.repo,
		`/git/refs/heads/${encoded}`,
		{
			method: "DELETE",
		},
	);
	if (!deleted.response.ok)
		throw new Error(`read-verified branch delete failed for ${target.branch}`);
	return { closed: true, branch: "deleted_after_read_verify" };
}

async function convergePriorRun(context) {
	const { db, commDb, room, slotDir, evidenceRoot, issue, token, timeoutMs } =
		context;
	const active = one(
		db,
		`SELECT * FROM workflow_run WHERE project_name = ? AND issue_id = ?
		  AND status IN ('active','held') ORDER BY created_at DESC LIMIT 1`,
		room.projectName,
		issue,
	);
	const owners = priorOwners(evidenceRoot, issue).filter(
		({ owner }) => owner.projectName === room.projectName,
	);
	let prior;
	let previous = active;
	if (active) {
		prior = owners.find(({ owner }) => owner.runId === active.run_id);
	} else {
		for (const candidate of owners) {
			const row = one(
				db,
				`SELECT * FROM workflow_run
				  WHERE run_id = ? AND project_name = ? AND issue_id = ?`,
				candidate.owner.runId,
				room.projectName,
				issue,
			);
			if (row) {
				prior = candidate;
				previous = row;
				break;
			}
		}
	}
	if (active && !prior) {
		throw new Error(
			`active run ${active.run_id} has no local driver ownership evidence; refusing mutation`,
		);
	}
	if (!prior || !previous) return { kind: "clean" };
	const runId = previous.run_id;
	const terminate = shouldTerminatePriorRun(previous.status);
	let proven = syncOwnedExecutions(db, runId, prior.owner, prior.path);
	const fence = terminate
		? await terminateOwnedRun(room, token, runId)
		: { skipped: `already_${previous.status}` };
	proven = syncOwnedExecutions(db, runId, prior.owner, prior.path);
	requestExecutionExits(slotDir, runId, proven);
	const drained = await waitFor(
		`prior run ${runId} durable launch drain`,
		() => {
			proven = syncOwnedExecutions(db, runId, prior.owner, prior.path);
			requestExecutionExits(slotDir, runId, proven);
			const snapshot = launchDrainSnapshot(db, commDb, slotDir, runId, proven);
			const result = classifyDurableLaunchDrain(snapshot);
			return result.settled
				? { snapshot, result, executionIds: [...proven] }
				: false;
		},
		timeoutMs,
	);
	const stable = observedRunExecutionIds(db, runId);
	proveOwnedExecutionSet(drained.executionIds, stable);
	const ownedPr = resolveOwnedPrEvidence(
		prior.owner.pr,
		proven
			.map((executionId) => latestStub(slotDir, executionId))
			.filter(Boolean),
		runId,
		proven,
	);
	if (ownedPr) {
		prior.owner.pr = ownedPr;
		writeJsonAtomic(prior.path, prior.owner);
	}
	const cleanup = await cleanupOwnedPr(ownedPr, runId, proven);
	return { kind: "converged", runId, fence, drained, cleanup };
}

function parseQuestionId(output) {
	try {
		const parsed = JSON.parse(output);
		if (typeof parsed.questionId === "string") return parsed.questionId;
	} catch {
		// CLI may print a human prefix before the JSON payload.
	}
	const match = output.match(/(?:questionId["':=\s]+)([0-9a-f-]{20,})/i);
	if (!match) throw new Error(`cannot parse gate questionId: ${output}`);
	return match[1];
}

function runComm(
	commCli,
	commDbPath,
	flywheelProjectsFile,
	leadIdentity,
	args,
	env = {},
) {
	const result = spawnSync(
		process.execPath,
		[commCli, ...args, "--db", commDbPath],
		{
			encoding: "utf8",
			env: buildSlotCommEnv(
				process.env,
				commDbPath,
				flywheelProjectsFile,
				leadIdentity,
				env,
			),
		},
	);
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	if (result.status !== 0)
		throw new Error(`flywheel-comm ${args[0]} failed: ${output}`);
	return output;
}

function openGateDeliveryProbe(context, qaExecutionId, implementExecutionId) {
	const checkpoint = "question";
	const openArgs = buildGateDeliveryOpenArgs({
		leadId: context.room.agentId,
		qaExecutionId,
		implementExecutionId,
	});
	const message = openArgs.at(-1);
	const output = runComm(
		context.commCli,
		context.commDbPath,
		context.room.flywheelProjectsFile,
		context.leadIdentity,
		openArgs,
	);
	const questionId = parseQuestionId(output);
	const question = one(
		context.commDb,
		`SELECT id, from_agent AS fromAgent, to_agent AS toAgent, checkpoint,
		        resolved_at AS resolvedAt
		   FROM mailbox_message_projection WHERE id = ?`,
		questionId,
	);
	if (
		!question ||
		question.fromAgent !== qaExecutionId ||
		question.checkpoint !== checkpoint ||
		question.resolvedAt
	) {
		throw new Error(
			`gate delivery probe attribution mismatch: ${JSON.stringify(question)}`,
		);
	}
	if (question.fromAgent === implementExecutionId) {
		throw new Error(
			"ship_parked implement actor incorrectly owns gate delivery probe",
		);
	}
	runComm(
		context.commCli,
		context.commDbPath,
		context.room.flywheelProjectsFile,
		context.leadIdentity,
		buildGateDeliveryRespondArgs({
			questionId,
			leadId: context.room.agentId,
			qaExecutionId,
		}),
	);
	return { questionId, question, message, checkpoint };
}

function remotePrFromStub(stub) {
	const completion = stub?.lastCompletion;
	if (!completion?.prNumber || !completion.repo) return null;
	const rows = JSON.parse(
		command("gh", [
			"pr",
			"view",
			String(completion.prNumber),
			"--repo",
			completion.repo,
			"--json",
			"number,state,isDraft,headRefOid,url,headRefName",
		]),
	);
	return rows;
}

async function runDrill(context) {
	const {
		room,
		token,
		issue,
		db,
		commDb,
		slotDir,
		evidenceRoot,
		timeoutMs,
		config,
	} = context;
	const convergence = await convergePriorRun(context);
	process.stdout.write(`[qa529] replay pre-action: ${convergence.kind}\n`);
	let pretrustedWorktree;
	if (context.runnerMode === "real") {
		pretrustedWorktree = command("bash", [
			resolve(room.flywheelRepo, "scripts/lib/runner-workspace-trust.sh"),
			"pretrust-dual",
			`${room.hostRepo}-${issue}`,
		]);
	}

	const idempotencyKey = `qa529-${issue.toLowerCase()}-${Date.now()}`;
	const request = buildGeneralizedStartRequest({
		issueId: issue,
		projectName: room.projectName,
		leadId: room.agentId,
		idempotencyKey,
	});
	const started = await httpJson(`${room.bridgeUrl}/api/runs/start`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(request),
	});
	const start = validateGeneralizedStartResponse(started.body);
	const runId = start.workflowRunId;
	const evidenceDir = join(
		evidenceRoot,
		`${runId}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
	);
	mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
	const ownerPath = join(evidenceDir, "owner.json");
	const owner = {
		schemaVersion: 1,
		issue,
		projectName: room.projectName,
		runId,
		executionIds: [start.executionId],
		createdAt: new Date().toISOString(),
	};
	writeJsonAtomic(ownerPath, owner);
	const writeStep = stepWriter(evidenceDir, runId);
	if (pretrustedWorktree) {
		const session = await waitFor(
			"pretrusted worktree binding",
			() => {
				const row = one(
					db,
					"SELECT execution_id, worktree_path FROM sessions WHERE execution_id = ?",
					start.executionId,
				);
				return row?.worktree_path ? row : false;
			},
			timeoutMs,
		);
		const actualWorktree = realpathSync(session.worktree_path);
		if (actualWorktree !== pretrustedWorktree) {
			writeStep(0, "pretrusted worktree binding mismatch", {
				expected: pretrustedWorktree,
				actual: actualWorktree,
				executionId: start.executionId,
			});
			throw new Error(
				`pretrusted worktree mismatch: expected ${pretrustedWorktree}, got ${actualWorktree}`,
			);
		}
		writeStep(0, "pretrusted worktree binding verified", {
			expected: pretrustedWorktree,
			actual: actualWorktree,
			executionId: start.executionId,
		});
	}

	const run = await waitFor(
		"step 1 generalized run authority",
		() => {
			const row = one(db, "SELECT * FROM workflow_run WHERE run_id = ?", runId);
			if (!row) return false;
			const snapshot = parseSnapshot(row.snapshot);
			const gate = snapshotGate(snapshot);
			if (!generalizedEntryAuthorityIsReady(row, gate)) return false;
			return { row, gate, implementNode: snapshotNode(snapshot, "implement") };
		},
		timeoutMs,
	);
	writeStep(1, "generalized run authority is durable", run);

	const design = await waitFor(
		"step 2 design completion",
		() => {
			const node = one(
				db,
				"SELECT * FROM workflow_run_node WHERE run_id = ? AND node_id = 'design' ORDER BY attempt DESC LIMIT 1",
				runId,
			);
			if (node?.state !== "done" || !node.execution_id) return false;
			const session = one(
				db,
				"SELECT * FROM sessions WHERE execution_id = ?",
				node.execution_id,
			);
			if (session?.status !== "completed" || !session.terminal_at) return false;
			return { node, session };
		},
		timeoutMs,
	);
	owner.executionIds = [
		...new Set([...owner.executionIds, design.node.execution_id]),
	];
	writeJsonAtomic(ownerPath, owner);
	writeStep(2, "design completed without ship parking", design);

	const implement1 = await waitFor(
		"step 3 implement dispatch",
		() => {
			const node = one(
				db,
				"SELECT * FROM workflow_run_node WHERE run_id = ? AND node_id = 'implement' AND attempt = 1",
				runId,
			);
			if (!node?.execution_id) return false;
			const snapshot = parseSnapshot(run.row.snapshot);
			const manifestNode = snapshotNode(snapshot, "implement");
			const createsPr = manifestNode?.type
				? config.getNodeTypeRegistryEntry(manifestNode.type)?.capabilities
						?.creates_pr
				: false;
			if (manifestNode?.type !== "implement" || createsPr !== true)
				return false;
			return { node, manifestNode };
		},
		timeoutMs,
	);
	let implementExecutionId = implement1.node.execution_id;
	syncOwnedExecutions(db, runId, owner, ownerPath);
	writeStep(3, "implement node dispatched with PR capability", implement1);

	const parked1 = await waitFor(
		"step 4 implement ship park",
		() => {
			const node = one(
				db,
				"SELECT * FROM workflow_run_node WHERE run_id = ? AND node_id = 'implement' AND attempt = 1",
				runId,
			);
			if (!node?.execution_id) return false;
			syncOwnedExecutions(db, runId, owner, ownerPath);
			const currentExecutionId = node.execution_id;
			const session = one(
				db,
				"SELECT * FROM sessions WHERE execution_id = ?",
				currentExecutionId,
			);
			const park = currentPark(db, currentExecutionId);
			const liveness = probeExecution(slotDir, commDb, currentExecutionId);
			if (
				session?.status !== "ship_parked" ||
				session.terminal_at != null ||
				park?.event !== "park_opened" ||
				park.reason !== "rework_reachable_wait" ||
				liveness.liveness !== "alive"
			)
				return false;
			const pr = resolveOwnedPrEvidence(
				null,
				liveness.stub ? [liveness.stub] : [],
				runId,
				owner.executionIds,
			);
			return pr ? { node, session, park, liveness, pr } : false;
		},
		timeoutMs,
	);
	implementExecutionId = parked1.node.execution_id;
	const attempt1ExecutionId = implementExecutionId;
	owner.pr = parked1.pr;
	writeJsonAtomic(ownerPath, owner);
	writeStep(4, "implement is alive in rework-reachable ship_parked", parked1);

	const qa1Ready = await waitFor(
		"QA attempt 1 release boundary",
		() => {
			const row = one(
				db,
				"SELECT * FROM workflow_run_node WHERE run_id = ? AND node_id = 'qa' AND attempt = 1",
				runId,
			);
			if (!row?.execution_id) return false;
			syncOwnedExecutions(db, runId, owner, ownerPath);
			const stub = latestStub(slotDir, row.execution_id);
			return stub?.qaFailReady ? { row, stub } : false;
		},
		timeoutMs,
	);
	syncOwnedExecutions(db, runId, owner, ownerPath);
	const deliveryProbe1 = openGateDeliveryProbe(
		context,
		qa1Ready.row.execution_id,
		implementExecutionId,
	);
	writeStep(
		5,
		"question gate delivery works while parked implement owns no gate",
		{
			implementStatus: parked1.session.status,
			probe: deliveryProbe1,
		},
	);
	writeJsonAtomic(
		join(
			slotDir,
			"stub-control",
			`${qa1Ready.row.execution_id}.fail-release.json`,
		),
		{
			schemaVersion: 1,
			runId,
			executionId: qa1Ready.row.execution_id,
			attempt: 1,
			expectedHead: "0".repeat(40),
			releasedAt: new Date().toISOString(),
		},
	);

	const rework = await waitFor(
		"step 6 QA fail rework wake",
		() => {
			const delivery = one(
				db,
				`SELECT d.*, r.authority, r.source_attempt AS sourceAttempt
				   FROM workflow_rework_delivery d
				   JOIN workflow_rework_request r ON r.request_id = d.request_id
				  WHERE r.run_id = ? AND r.authority = 'qa'
				  ORDER BY r.requested_at DESC LIMIT 1`,
				runId,
			);
			const currentRun = one(
				db,
				"SELECT status FROM workflow_run WHERE run_id = ?",
				runId,
			);
			const dangerous = dangerousReworkRows(db, runId);
			syncOwnedExecutions(db, runId, owner, ownerPath);
			if (
				delivery?.state !== "wake_delivered" ||
				currentRun?.status !== "active" ||
				dangerous.length
			) {
				return false;
			}
			return { delivery, currentRun, dangerous };
		},
		timeoutMs,
	);
	writeStep(
		6,
		"QA FAIL reached wake_delivered without held/needs_lead",
		rework,
	);

	const implement2 = await waitFor(
		"step 7 current implement actor attempt 2",
		() => {
			const node = one(
				db,
				"SELECT * FROM workflow_run_node WHERE run_id = ? AND node_id = 'implement' AND attempt = 2",
				runId,
			);
			if (!node?.execution_id || node.state !== "done") return false;
			syncOwnedExecutions(db, runId, owner, ownerPath);
			const currentExecutionId = node.execution_id;
			const session = one(
				db,
				"SELECT * FROM sessions WHERE execution_id = ?",
				currentExecutionId,
			);
			const park = currentPark(db, currentExecutionId);
			const stub = latestStub(slotDir, currentExecutionId);
			const attempt1Head = parked1.pr.expectedHead;
			const attempt2Head = stub?.lastCompletion?.head;
			if (
				session?.status !== "ship_parked" ||
				park?.event !== "park_opened" ||
				stub?.lastCompletion?.attempt !== 2 ||
				!attempt1Head ||
				!attempt2Head ||
				attempt1Head === attempt2Head
			)
				return false;
			return {
				node,
				session,
				park,
				stub,
				actorOutcome:
					currentExecutionId === attempt1ExecutionId
						? "original_body_resumed"
						: "replacement_execution_completed",
				resumedOriginalBody: currentExecutionId === attempt1ExecutionId,
				attempt1Head,
				attempt2Head,
			};
		},
		timeoutMs,
	);
	implementExecutionId = implement2.node.execution_id;
	owner.pr = {
		executionId: implementExecutionId,
		number: implement2.stub.lastCompletion.prNumber,
		repo: implement2.stub.lastCompletion.repo,
		branch: implement2.stub.lastCompletion.branch,
		expectedHead: implement2.stub.lastCompletion.head,
	};
	writeJsonAtomic(ownerPath, owner);
	writeStep(
		7,
		"current implement execution completed attempt 2 and advanced head",
		implement2,
	);
	process.stdout.write(
		`[qa529] step 7 actor outcome: ${implement2.actorOutcome}\n`,
	);

	const qa2 = await waitFor(
		"QA attempt 2 preflight boundary",
		() => {
			const node = one(
				db,
				"SELECT * FROM workflow_run_node WHERE run_id = ? AND node_id = 'qa' AND attempt = 2",
				runId,
			);
			if (!node?.execution_id) return false;
			syncOwnedExecutions(db, runId, owner, ownerPath);
			const stub = latestStub(slotDir, node.execution_id);
			return stub?.qaReady ? { node, stub } : false;
		},
		timeoutMs,
	);
	syncOwnedExecutions(db, runId, owner, ownerPath);
	const qaSession = one(
		db,
		"SELECT * FROM sessions WHERE execution_id = ?",
		qa2.node.execution_id,
	);
	const producer = one(
		db,
		"SELECT * FROM sessions WHERE execution_id = ?",
		implementExecutionId,
	);
	const gateBinding = one(
		db,
		"SELECT * FROM workflow_node_pr_binding WHERE run_id = ? AND node_id = 'implement' AND attempt = 2",
		runId,
	);
	const remotePr = remotePrFromStub(implement2.stub);
	const preflightInput = {
		qaWorktreeBinding:
			qaSession?.worktree_binding_path && qaSession?.worktree_binding_generation
				? {
						path: qaSession.worktree_binding_path,
						branch: qaSession.worktree_binding_branch,
						generation: qaSession.worktree_binding_generation,
					}
				: null,
		producerPrNumber: producer?.pr_number ?? null,
		producerPrHead: producer?.pr_head_sha ?? null,
		gateEntryBinding: gateBinding,
		remotePr,
		expectedHead: qa2.stub.qaReady.expectedHead,
	};
	const preflight = validateQaShipPreconditions(preflightInput);
	if (!preflight.ok) {
		const qaExecutionId = qa2.node.execution_id;
		const diagnosis = {
			status: "diagnosed_not_released",
			preflight,
			observed: preflightInput,
		};
		writeStep(
			8,
			"A3 diagnosis: QA PASS authority is incomplete; release withheld",
			{
				...diagnosis,
				closeout: { status: "pending" },
			},
		);
		let closeout;
		try {
			closeout = await terminateQaSessionForA3({
				executionId: qaExecutionId,
				leadId: room.agentId,
				bridgeUrl: room.bridgeUrl,
				token,
				runId,
				timeoutMs,
				readSession: () =>
					one(
						db,
						"SELECT * FROM sessions WHERE execution_id = ?",
						qaExecutionId,
					),
				requestExecutionExit: () =>
					requestExecutionExits(slotDir, runId, [qaExecutionId]),
				probeExecution: () => probeExecution(slotDir, commDb, qaExecutionId),
				waitFor,
			});
		} catch (error) {
			writeStep(
				8,
				"A3 diagnosis: QA PASS authority is incomplete; release withheld",
				{
					...diagnosis,
					closeout: { status: "failed", error: String(error) },
				},
			);
			throw error;
		}
		writeStep(
			8,
			"A3 diagnosis: QA PASS authority is incomplete; release withheld",
			{ ...diagnosis, closeout },
		);
		process.stdout.write(
			`[qa529] A3 diagnosis emitted (${preflight.failures.join(", ")}); steps 1-7 are complete; QA PASS was not sent.\n`,
		);
		return A3_DIAGNOSIS_EXIT;
	}

	writeJsonAtomic(
		join(slotDir, "stub-control", `${qa2.node.execution_id}.release.json`),
		{
			schemaVersion: 1,
			...qa2.stub.qaReady,
			releasedAt: new Date().toISOString(),
		},
	);
	await waitFor(
		"QA PASS submission",
		() => latestStub(slotDir, qa2.node.execution_id)?.qaPassResult ?? false,
		timeoutMs,
	);
	const holder = await waitFor(
		"founder approval gate materialization",
		() =>
			one(
				db,
				`SELECT * FROM workflow_gate_holder
			  WHERE run_id = ? AND state IN ('awaiting_review','approved')
			  ORDER BY attempt DESC LIMIT 1`,
				runId,
			),
		timeoutMs,
	);
	if (holder.source_execution_id === implementExecutionId) {
		throw new Error(
			"parked implement execution became the workflow gate holder",
		);
	}
	if (holder.state !== "approved") {
		runComm(
			context.commCli,
			context.commDbPath,
			room.flywheelProjectsFile,
			context.leadIdentity,
			[
				"respond",
				holder.question_id,
				"approve",
				"--lead",
				room.agentId,
				"--expect-owner",
				holder.source_execution_id,
				"--expect-checkpoint",
				"approve_to_ship",
				"--bridge-url",
				room.bridgeUrl,
			],
			{ TEAMLEAD_API_TOKEN: token, BRIDGE_URL: room.bridgeUrl },
		);
	}
	const landed = await waitFor(
		"step 8 land completion",
		() => {
			const currentRun = one(
				db,
				"SELECT * FROM workflow_run WHERE run_id = ?",
				runId,
			);
			if (!currentRun || currentRun.status === "active") return false;
			return {
				currentRun,
				holder: one(
					db,
					"SELECT * FROM workflow_gate_holder WHERE question_id = ?",
					holder.question_id,
				),
			};
		},
		timeoutMs,
	);
	writeStep(8, "QA PASS reached founder approval and land", landed);

	const settled = await waitFor(
		"step 9 park settlement and actor collection",
		() => {
			const session = one(
				db,
				"SELECT * FROM sessions WHERE execution_id = ?",
				implementExecutionId,
			);
			const park = currentPark(db, implementExecutionId);
			const liveness = probeExecution(slotDir, commDb, implementExecutionId);
			if (
				session?.status !== "completed" ||
				!session.terminal_at ||
				park?.event !== "park_cleared" ||
				liveness.liveness !== "dead"
			)
				return false;
			return { session, park, liveness };
		},
		timeoutMs,
	);
	writeStep(
		9,
		"park cleared, terminal timestamp written, actor collected",
		settled,
	);
	return 0;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const slotDir = `/tmp/flywheel-test-slot-${args.slot}`;
	const roomPath = join(slotDir, "room-info.json");
	if (!existsSync(roomPath))
		throw new Error(`generalized room not found: ${roomPath}`);
	const room = validateRoomInfo(readJson(roomPath), args.runnerMode);
	const token = readFileSync(room.apiTokenPath, "utf8").trim();
	if (!token) throw new Error(`empty master token: ${room.apiTokenPath}`);
	if ((statSync(room.apiTokenPath).mode & 0o077) !== 0) {
		throw new Error(`master token must be mode 0600: ${room.apiTokenPath}`);
	}
	const checkoutHead = command("git", [
		"-C",
		room.flywheelRepo,
		"rev-parse",
		"HEAD",
	]);
	if (checkoutHead !== room.buildSha) {
		throw new Error(
			`room checkout drifted: expected ${room.buildSha}, got ${checkoutHead}`,
		);
	}
	const requireFromTeamlead = createRequire(
		resolve(room.flywheelRepo, "packages/teamlead/package.json"),
	);
	const config = await import(
		pathToFileURL(resolve(room.flywheelRepo, "packages/config/dist/index.js"))
			.href
	);
	const Database = requireFromTeamlead("better-sqlite3");
	const db = new Database(room.dbPath, {
		readonly: true,
		fileMustExist: true,
		timeout: 5_000,
	});
	db.pragma("busy_timeout = 5000");
	const commDbPath = join(
		homedir(),
		".flywheel",
		"comm",
		room.projectName,
		"comm.db",
	);
	if (!existsSync(commDbPath))
		throw new Error(`slot CommDB not found: ${commDbPath}`);
	const commDb = new Database(commDbPath, {
		readonly: true,
		fileMustExist: true,
		timeout: 5_000,
	});
	commDb.pragma("busy_timeout = 5000");
	const commCli = resolve(
		room.flywheelRepo,
		"packages/flywheel-comm/dist/index.js",
	);
	if (!existsSync(commCli))
		throw new Error(`flywheel-comm build missing: ${commCli}`);
	const leadIdentity = JSON.parse(
		command(process.execPath, [
			commCli,
			"lead-identity",
			"resolve",
			"--projects-file",
			room.flywheelProjectsFile,
			"--project",
			room.projectName,
			"--lead",
			room.agentId,
			"--format",
			"json",
		]),
	);
	try {
		const code = await runDrill({
			...args,
			room,
			token,
			db,
			commDb,
			commDbPath,
			commCli,
			leadIdentity,
			config,
			slotDir,
			evidenceRoot: join(slotDir, "e2e-evidence"),
		});
		process.exitCode = code;
	} finally {
		commDb.close();
		db.close();
	}
}

main().catch((error) => {
	process.stderr.write(
		`[qa529] ${error instanceof Error ? error.stack : String(error)}\n`,
	);
	process.exitCode = 1;
});
