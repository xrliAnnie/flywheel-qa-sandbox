/**
 * FLY-2921 C7 (FLY-2202 / FLY-2472) from the real event route.
 *
 * A rework target (implement#2, wake-delivered) completes through
 * `POST /events session_completed`. The Bridge resolves the head from the
 * bound worktree, computes the product delta against the rework base with a
 * real `git diff`, and the StateStore either refuses (409, retryable,
 * nothing advanced, one audit) or accepts. Real temporary git repositories
 * throughout; the timeout case uses a fake `git` on PATH that stalls `diff`.
 */
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { legacyWorkflowSeeds } from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { commDbPathForProject } from "../commdb-path.js";
import { initializeFlagStore } from "../flag-store-runtime.js";
import { createBridgeApp } from "../plugin.js";
import {
	classifyReworkProductDelta,
	reworkDeltaTimeoutMs,
} from "../rework-completion-evidence.js";
import type { BridgeConfig } from "../types.js";

const PROJECT = "geoforge3d";
const ISSUE = "FLY-2921";
const RUN = "run-fly2921";
const ENABLED = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

const testProjects: ProjectEntry[] = [
	{
		projectName: PROJECT,
		projectRoot: "/tmp/geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
		],
	},
];

function makeConfig(): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
	};
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function commitAll(cwd: string, message: string): string {
	git(cwd, "add", "-A");
	git(
		cwd,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		message,
	);
	return git(cwd, "rev-parse", "HEAD");
}

/** A real worktree with one base commit (`src/app.ts` + a progress ledger). */
function createWorktree(options: { origin?: boolean } = {}): {
	path: string;
	baseHead: string;
} {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "fly2921-route-")));
	roots.push(path);
	git(path, "init", "-q");
	if (options.origin ?? true) {
		git(path, "remote", "add", "origin", "https://github.com/example/app.git");
	}
	mkdirSync(join(path, "src"));
	mkdirSync(join(path, "engineering", "doc", "FLY-2921-slice"), {
		recursive: true,
	});
	writeFileSync(join(path, "src", "app.ts"), "export const v = 1;\n");
	writeFileSync(
		join(path, "engineering", "doc", "FLY-2921-slice", "progress.md"),
		"# progress\n\n- 0/9\n",
	);
	const baseHead = commitAll(path, "base");
	return { path, baseHead };
}

/**
 * tpl_eng_heavy run at implement#2 as a wake-delivered rework target whose
 * base is `judgedHead` (what QA judged), bound to `worktree`.
 */
function seedReworkTarget(
	store: StateStore,
	input: { worktree: string; judgedHead: string | null },
): { requestId: string; activationId: string } {
	const seed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	);
	if (!seed) throw new Error("tpl_eng_heavy seed missing");
	store.importWorkflowTemplateSeed(seed);
	store.bindWorkflowCategory({
		project: PROJECT,
		taskCategory: "code",
		templateId: seed.templateId,
		updatedBy: "lead",
	});
	store.materializeWorkflowRun({
		runId: RUN,
		issueId: ISSUE,
		projectName: PROJECT,
		taskCategory: "code",
		claimsReadEnrolled: true,
		actor: "lead",
		env: ENABLED,
		startReservation: {
			idempotencyKey: "start-fly2921",
			selectionDigest: "selection-fly2921",
			nodeId: "design",
			attempt: 1,
			executionId: "design-exec",
			createdAt: "2026-07-23T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: RUN,
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-exec",
	});
	const advance = (input: {
		nodeId: string;
		attempt: number;
		executionId: string;
		outcome: string;
		successorExecutionId?: string;
		subjectDigest?: string;
	}) =>
		store.commitWorkflowTransitionTx({
			nodeReuseEnabled: false,
			runId: RUN,
			...input,
			now: "2026-07-23T00:10:00.000Z",
		});
	advance({
		nodeId: "design",
		attempt: 1,
		executionId: "design-exec",
		outcome: "design_done",
		successorExecutionId: "implement-exec",
	});
	advance({
		nodeId: "implement",
		attempt: 1,
		executionId: "implement-exec",
		outcome: "implement_done",
		successorExecutionId: "qa-exec",
	});
	const failed = advance({
		nodeId: "qa",
		attempt: 1,
		executionId: "qa-exec",
		outcome: "qa_fail",
		...(input.judgedHead ? { subjectDigest: input.judgedHead } : {}),
	});
	if (!failed.ok || !failed.reworkRequestId) {
		throw new Error("rework request not returned");
	}
	const requestId = failed.reworkRequestId;
	const activationId = `activation:${requestId}`;
	const claim = store.claimWorkflowReworkDelivery({
		requestId,
		ownerId: "coordinator",
		now: "2026-07-23T00:11:00.000Z",
		leaseExpiresAt: "2026-07-23T00:11:30.000Z",
	});
	if (!claim.ok) throw new Error(claim.reason);
	const admitted = store.admitGeneralizedWorkflowExecution({
		runId: RUN,
		nodeId: "implement",
		executionId: "implement-exec",
		attempt: 2,
		activationId,
		activationMode: "wake",
		reworkRequestId: requestId,
		expiresAt: "2026-07-23T02:00:00.000Z",
		absoluteDeadlineAt: "2026-07-24T00:00:00.000Z",
		now: "2026-07-23T00:11:01.000Z",
		env: ENABLED,
	});
	if (!admitted.ok) throw new Error(admitted.reason);
	store.upsertSession({
		execution_id: "implement-exec",
		issue_id: ISSUE,
		project_name: PROJECT,
		status: "running",
		workflow_node_id: "implement",
		worktree_path: input.worktree,
	});
	store.bindWorktreeOnce(
		"implement-exec",
		{ path: input.worktree, branch: "feature", generation: "fly2921" },
		{ issueId: ISSUE, projectName: PROJECT },
	);
	const turn = store.recordWorkflowActivationTurn({
		activationId,
		issueId: ISSUE,
		executionId: "implement-exec",
		epoch: 4,
		sourceEventId: `rework-turn:${requestId}`,
		grantedAt: "2026-07-23T00:11:30.000Z",
	});
	if (!turn.ok) throw new Error(turn.reason);
	for (const [from, to] of [
		["pending", "turn_granted"],
		["turn_granted", "awaiting_receipt"],
	] as const) {
		const advanced = store.advanceWorkflowReworkDelivery({
			requestId,
			ownerId: "coordinator",
			generation: claim.generation,
			from,
			to,
			now: "2026-07-23T00:12:00.000Z",
			...(to === "awaiting_receipt" ? { releaseOwner: true } : {}),
		});
		if (!advanced.ok) throw new Error(advanced.reason);
	}
	const acked = store.recordWorkflowReworkWakeReceipt({
		activationId,
		executionId: "implement-exec",
		epoch: 4,
		ackedAt: "2026-07-23T00:12:01.000Z",
		alertIdentity: {
			leadId: "product-lead",
			projectName: PROJECT,
			leadResolution: "resolved",
		},
	});
	if (!acked.ok) throw new Error(acked.reason);
	return { requestId, activationId };
}

describe("FLY-2921 C7 from the real event route", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let stateRoot: string;
	let originalPath: string | undefined;
	let originalTimeout: string | undefined;

	beforeEach(async () => {
		stateRoot = mkdtempSync(join(tmpdir(), "fly2921-route-state-"));
		roots.push(stateRoot);
		process.env.FLYWHEEL_COMM_DIR = join(stateRoot, "comm");
		const commPath = commDbPathForProject(PROJECT);
		mkdirSync(dirname(commPath), { recursive: true });
		new CommDB(commPath).close();
		store = await StateStore.create(join(stateRoot, "teamlead.db"));
		const flagStore = initializeFlagStore(store, {});
		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ flagStore },
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		originalPath = process.env.PATH;
		originalTimeout = process.env.FLYWHEEL_REWORK_DELTA_TIMEOUT_MS;
	});

	afterEach(async () => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalTimeout === undefined) {
			delete process.env.FLYWHEEL_REWORK_DELTA_TIMEOUT_MS;
		} else process.env.FLYWHEEL_REWORK_DELTA_TIMEOUT_MS = originalTimeout;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	function complete(
		activationId: string,
		eventId = "complete-implement-2",
	): Promise<Response> {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify({
				event_id: eventId,
				execution_id: "implement-exec",
				issue_id: ISSUE,
				project_name: PROJECT,
				event_type: "session_completed",
				source: "flywheel-comm",
				payload: {
					decision: { route: "needs_review" },
					workflowActivation: {
						activationId,
						runId: RUN,
						nodeId: "implement",
						attempt: 2,
						turnEpoch: 4,
					},
				},
			}),
		});
	}

	function eventsOfKind(kind: string) {
		return store
			.listWorkflowRunEvents(RUN)
			.filter((event) => event.kind === kind);
	}

	function ledgers(requestId: string): string {
		return JSON.stringify({
			delivery: store.getWorkflowReworkDelivery(requestId),
			path: store.getWorkflowReworkVerificationPath(requestId),
			node: store.getWorkflowRunNode(RUN, "implement", 2),
			run: store.getWorkflowRun(RUN)?.current_node_id,
			completion: store.getWorkflowNodeCompletion(RUN, "implement", 2) ?? null,
		});
	}

	async function expectRefused(
		response: Response,
		transitionReason: string,
		requestId: string,
	) {
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: "workflow_completion_rejected",
			reason: "transition_refused",
			retryable: true,
			detail: { transitionReason, requestId },
		});
		expect(
			store.getWorkflowNodeCompletion(RUN, "implement", 2),
		).toBeUndefined();
		expect(store.getWorkflowReworkDelivery(requestId)?.state).toBe(
			"wake_delivered",
		);
		expect(store.getWorkflowRunNode(RUN, "implement", 2)?.state).toBe(
			"running",
		);
		expect(store.getWorkflowRun(RUN)).toMatchObject({
			status: "active",
			current_node_id: "implement",
		});
		const audits = eventsOfKind("rework_completion_refused");
		expect(audits).toHaveLength(1);
		expect(audits[0]!.payload).toMatchObject({ transitionReason, requestId });
		expect(eventsOfKind("completion_transition_refused")).toEqual([]);
	}

	async function expectAccepted(response: Response, requestId: string) {
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			generalized: true,
		});
		expect(store.getWorkflowNodeCompletion(RUN, "implement", 2)).toMatchObject({
			execution_id: "implement-exec",
		});
		expect(store.getWorkflowReworkDelivery(requestId)?.state).toBe("completed");
		expect(store.getWorkflowRun(RUN)?.current_node_id).toBe("qa");
		expect(eventsOfKind("rework_completion_refused")).toEqual([]);
	}

	it("refuses a zero-commit completion (head == base) and leaves nothing behind", async () => {
		const worktree = createWorktree();
		const { requestId, activationId } = seedReworkTarget(store, {
			worktree: worktree.path,
			judgedHead: worktree.baseHead,
		});
		const before = ledgers(requestId);
		await expectRefused(
			await complete(activationId),
			"rework_head_unchanged",
			requestId,
		);
		expect(ledgers(requestId)).toBe(before);
		// The runner retries the same bytes: same refusal, still one audit.
		await expectRefused(
			await complete(activationId, "complete-implement-2-again"),
			"rework_head_unchanged",
			requestId,
		);
		expect(ledgers(requestId)).toBe(before);
	});

	it("refuses a completion whose only new commit touches the progress ledger", async () => {
		const worktree = createWorktree();
		const { requestId, activationId } = seedReworkTarget(store, {
			worktree: worktree.path,
			judgedHead: worktree.baseHead,
		});
		writeFileSync(
			join(
				worktree.path,
				"engineering",
				"doc",
				"FLY-2921-slice",
				"progress.md",
			),
			"# progress\n\n- 1/9\n",
		);
		const ledgerHead = commitAll(worktree.path, "chore(progress): 1/9");
		expect(ledgerHead).not.toBe(worktree.baseHead);
		const response = await complete(activationId);
		await expectRefused(response, "rework_no_product_change", requestId);
		expect(eventsOfKind("rework_completion_refused")[0]!.payload).toMatchObject(
			{ head: ledgerHead, baseRevision: worktree.baseHead },
		);
	});

	it("accepts a real product change", async () => {
		const worktree = createWorktree();
		const { requestId, activationId } = seedReworkTarget(store, {
			worktree: worktree.path,
			judgedHead: worktree.baseHead,
		});
		writeFileSync(
			join(worktree.path, "src", "app.ts"),
			"export const v = 2;\n",
		);
		commitAll(worktree.path, "fix: real change");
		await expectAccepted(await complete(activationId), requestId);
		expect(eventsOfKind("rework_delta_unverified")).toEqual([]);
	});

	it("sees the one product file behind 200 progress ledgers", async () => {
		const worktree = createWorktree();
		const { requestId, activationId } = seedReworkTarget(store, {
			worktree: worktree.path,
			judgedHead: worktree.baseHead,
		});
		for (let index = 0; index < 200; index += 1) {
			const dir = join(worktree.path, "engineering", "doc", `FLY-${index}-x`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "progress.md"), `# ${index}\n`);
		}
		// Sorts after every `engineering/...` path in the diff output.
		writeFileSync(
			join(worktree.path, "src", "zzz.ts"),
			"export const z = 1;\n",
		);
		commitAll(worktree.path, "200 ledgers + 1 product file");
		await expectAccepted(await complete(activationId), requestId);
		expect(eventsOfKind("rework_delta_unverified")).toEqual([]);
	});

	it("accepts a product change whose path carries escape characters", async () => {
		const worktree = createWorktree();
		const { requestId, activationId } = seedReworkTarget(store, {
			worktree: worktree.path,
			judgedHead: worktree.baseHead,
		});
		const weird = 'src/quo"te\\back\tslash 中文 \u0001ctl.ts';
		writeFileSync(join(worktree.path, weird), "export const w = 1;\n");
		commitAll(worktree.path, "escape characters");
		await expectAccepted(await complete(activationId), requestId);
		expect(eventsOfKind("rework_delta_unverified")).toEqual([]);
	});

	it("allows a new head whose base object is missing and audits rework_delta_unverified", async () => {
		const worktree = createWorktree();
		const missingBase = "1234567890abcdef1234567890abcdef12345678";
		const { requestId, activationId } = seedReworkTarget(store, {
			worktree: worktree.path,
			judgedHead: missingBase,
		});
		writeFileSync(
			join(worktree.path, "src", "app.ts"),
			"export const v = 3;\n",
		);
		const newHead = commitAll(worktree.path, "fix after lost base");
		await expectAccepted(await complete(activationId), requestId);
		const audits = eventsOfKind("rework_delta_unverified");
		expect(audits).toHaveLength(1);
		expect(audits[0]!.payload).toMatchObject({
			requestId,
			baseRevision: missingBase,
			head: newHead,
		});
	});

	it("allows a new head when the diff times out and audits rework_delta_unverified", async () => {
		const worktree = createWorktree();
		const { requestId, activationId } = seedReworkTarget(store, {
			worktree: worktree.path,
			judgedHead: worktree.baseHead,
		});
		writeFileSync(
			join(worktree.path, "src", "app.ts"),
			"export const v = 4;\n",
		);
		const newHead = commitAll(worktree.path, "fix under a stalled diff");
		// A `git` shim first on PATH: `diff` stalls (exec'd so the timeout's
		// SIGTERM lands on the sleeper and the stdout pipe closes at once),
		// everything else delegates to the real git.
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const shimDir = mkdtempSync(join(tmpdir(), "fly2921-git-shim-"));
		roots.push(shimDir);
		writeFileSync(
			join(shimDir, "git"),
			`#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "diff" ]; then exec sleep 30; fi\ndone\nexec "${realGit}" "$@"\n`,
		);
		chmodSync(join(shimDir, "git"), 0o755);
		process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
		process.env.FLYWHEEL_REWORK_DELTA_TIMEOUT_MS = "300";
		expect(reworkDeltaTimeoutMs()).toBe(300);
		const started = Date.now();
		await expectAccepted(await complete(activationId), requestId);
		expect(Date.now() - started).toBeLessThan(10_000);
		const audits = eventsOfKind("rework_delta_unverified");
		expect(audits).toHaveLength(1);
		expect(audits[0]!.payload).toMatchObject({
			requestId,
			baseRevision: worktree.baseHead,
			head: newHead,
		});
	});

	it("allows a historical 'unavailable' base and audits rework_head_check_skipped", async () => {
		const worktree = createWorktree();
		const { requestId, activationId } = seedReworkTarget(store, {
			worktree: worktree.path,
			judgedHead: null,
		});
		expect(store.getWorkflowReworkRequest(requestId)?.base_revision).toBe(
			"unavailable",
		);
		await expectAccepted(await complete(activationId), requestId);
		const audits = eventsOfKind("rework_head_check_skipped");
		expect(audits).toHaveLength(1);
		expect(audits[0]!.payload).toMatchObject({
			requestId,
			baseRevision: "unavailable",
			head: worktree.baseHead,
		});
	});

	it("refuses when the server cannot resolve the head (rework_head_unavailable)", async () => {
		// No origin remote: repository authority resolution fails, so the
		// Bridge captures no head at all for this completion.
		const worktree = createWorktree({ origin: false });
		const { requestId, activationId } = seedReworkTarget(store, {
			worktree: worktree.path,
			judgedHead: worktree.baseHead,
		});
		writeFileSync(
			join(worktree.path, "src", "app.ts"),
			"export const v = 5;\n",
		);
		commitAll(worktree.path, "unresolvable head");
		const before = ledgers(requestId);
		await expectRefused(
			await complete(activationId),
			"rework_head_unavailable",
			requestId,
		);
		expect(ledgers(requestId)).toBe(before);
		expect(eventsOfKind("rework_completion_refused")[0]!.payload).toMatchObject(
			{ head: "unresolved" },
		);
	});
});

describe("classifyReworkProductDelta", () => {
	it("excludes the ledger at the pathspec layer and reports the first qualifying path", async () => {
		const worktree = createWorktree();
		writeFileSync(
			join(
				worktree.path,
				"engineering",
				"doc",
				"FLY-2921-slice",
				"progress.md",
			),
			"# progress\n\n- 2/9\n",
		);
		const ledgerOnly = commitAll(worktree.path, "ledger only");
		expect(
			await classifyReworkProductDelta({
				repoPath: worktree.path,
				baseRevision: worktree.baseHead,
				head: ledgerOnly,
			}),
		).toBe("ledger_only");
		writeFileSync(
			join(worktree.path, "src", "app.ts"),
			"export const v = 9;\n",
		);
		const product = commitAll(worktree.path, "product");
		expect(
			await classifyReworkProductDelta({
				repoPath: worktree.path,
				baseRevision: worktree.baseHead,
				head: product,
			}),
		).toBe("product_change");
		// A truncated output budget still counts one complete NUL-terminated
		// path; zero complete entries under the budget is unverified.
		expect(
			await classifyReworkProductDelta({
				repoPath: worktree.path,
				baseRevision: worktree.baseHead,
				head: product,
				maxBufferBytes: 1,
			}),
		).toBe("unverified");
		expect(
			await classifyReworkProductDelta({
				repoPath: worktree.path,
				baseRevision: "0".repeat(40),
				head: product,
			}),
		).toBe("unverified");
		expect(
			await classifyReworkProductDelta({
				repoPath: worktree.path,
				baseRevision: "not-a-sha",
				head: product,
			}),
		).toBe("unverified");
	});
});
