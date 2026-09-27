import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BlueprintContext } from "flywheel-edge-worker/dist/Blueprint.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	legacyGenericSeed,
	legacyWorkflowSeeds,
	pinLegacyWorkflowSeedAgents,
} from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import { StateStore } from "../../StateStore.js";
import { workflowSeedContentHash } from "../../workflow-template.js";

import type { StartRequest } from "../retry-dispatcher.js";
import { type ProjectRuntime, RunDispatcher } from "../run-dispatcher.js";
import { createProgressResumeComputer } from "../run-infra.js";
import { RunnerAdmissionController } from "../runner-admission.js";
import { WorkflowEngineDispatcher } from "../workflow-engine-dispatcher.js";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};
const dirs: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function fixture(kind: "design" | "generic" = "design") {
	const dir = mkdtempSync(join(tmpdir(), "fly2920-resume-"));
	dirs.push(dir);
	const repo = join(dir, "fixture");
	mkdirSync(repo);
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: repo,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	git("init", "-q");
	git("config", "user.email", "fixture@example.test");
	git("config", "user.name", "Fixture");
	writeFileSync(join(repo, "baseline"), "remote baseline");
	git("add", ".");
	git("commit", "-qm", "baseline");
	const branch = `${basename(repo)}-FLY-2920`;
	git("checkout", "-qb", branch);
	execFileSync("git", ["init", "--bare", "-q", join(dir, "remote.git")]);
	git("remote", "add", "origin", join(dir, "remote.git"));
	git("push", "-q", "origin", branch);
	const path = "engineering/doc/FLY-2920-fixture/progress.md";
	mkdirSync(join(repo, "engineering/doc/FLY-2920-fixture"), {
		recursive: true,
	});
	const ledger =
		'---\nissue: FLY-2920\nphase: implement\nphaseCursor: "4/7"\nchunks: []\npointers: {}\n---\nrecognizable local-only cursor\n';
	writeFileSync(join(repo, path), ledger);
	git("add", ".");
	git("commit", "-qm", "local-only progress");
	git("config", `branch.${branch}.description`, "preserve founder description");
	const tip = git("rev-parse", "HEAD");
	const dbPath = join(dir, "state.db");
	const store = await StateStore.create(dbPath);
	stores.push(store);
	const original = pinLegacyWorkflowSeedAgents(
		kind === "generic"
			? legacyGenericSeed()
			: legacyWorkflowSeeds().find((s) => s.templateId === "tpl_eng_heavy")!,
	);
	const manifest = JSON.parse(
		JSON.stringify(original.manifest).replaceAll(
			'"implement"',
			'"writer-custom"',
		),
	);
	if (kind === "design") {
		const customWriter = manifest.nodes.find(
			(n: { id: string }) => n.id === "writer-custom",
		);
		customWriter.type = "implement";
		customWriter.role = "implement";
	}
	const seed = { ...original, manifest };
	seed.contentHash = workflowSeedContentHash(seed);
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		runId: "run",
		issueId: "FLY-2920",
		projectName: "fixture",
		taskCategory: "code",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		entryKind: kind === "design" ? "pipeline_dag_v1" : "workflow_v2",
		actor: "lead",
		canonicalRoot: ROOT,
		env: ON,
		startReservation: {
			idempotencyKey: "start",
			selectionDigest: "selection",
			nodeId: kind === "generic" ? "execute" : "design",
			attempt: 1,
			executionId: kind === "generic" ? "current" : "design-predecessor",
			createdAt: new Date().toISOString(),
		},
	});
	if (kind === "design") {
		store.upsertWorkflowRunNode({
			runId: "run",
			nodeId: "design",
			attempt: 1,
			executionId: "design-predecessor",
			state: "running",
		});
		store.upsertSession({
			execution_id: "design-predecessor",
			issue_id: "FLY-2920",
			project_name: "fixture",
			status: "design_done",
			session_role: "design",
			issue_identifier: "FLY-2920",
		});
		store.commitWorkflowTransitionTx({
			nodeReuseEnabled: false,
			runId: "run",
			nodeId: "design",
			attempt: 1,
			executionId: "design-predecessor",
			outcome: "design_done",
			successorExecutionId: "current",
			now: new Date().toISOString(),
		});
	}

	store.upsertSession({
		execution_id: "stopped-prior",
		last_activity_at: "2020-01-01T00:00:00.000Z",
		issue_id: "FLY-2920",
		issue_identifier: "FLY-2920",
		project_name: "fixture",
		session_role: "implement",
		chat_thread_role: "implement",
		status: "terminated",
		session_stage: "design",
		branch,
		plan_path: "engineering/doc/FLY-2920-fixture/plan.md",
	});
	vi.stubEnv("FLYWHEEL_COMM_DIR", join(dir, "comm"));
	return { dir, repo, dbPath, store, git, branch, tip, path, ledger };
}
function runtime(
	repo: string,
	capture: BlueprintContext[],
	store: StateStore,
): ProjectRuntime {
	return {
		projectRoot: repo,
		tmuxSessionName: "fixture",
		agentDispatcher: {
			dispatchByName: vi.fn(),
		} as unknown as ProjectRuntime["agentDispatcher"],
		blueprint: {
			run: async (_n: unknown, _r: unknown, ctx: BlueprintContext) => {
				capture.push(ctx);
				ctx.prepareWorkflowIssueDelivery?.({
					sourceKind: "authoritative",
					body: "preserve founder description",
					updatedAt: new Date().toISOString(),
					anchorCommit:
						ctx.startPoint ??
						execFileSync("git", ["rev-parse", "HEAD"], {
							cwd: repo,
							encoding: "utf8",
						}).trim(),
				});
				if (ctx.commitWorkflowLaunch)
					expect(ctx.commitWorkflowLaunch()).toMatchObject({ ok: true });
				store.upsertSession({
					execution_id: ctx.executionId,
					last_activity_at: new Date().toISOString(),
					issue_id: "FLY-2920",
					project_name: "fixture",
					issue_identifier: "FLY-2920",
					status: "running",
					session_role: ctx.sessionRole,
					chat_thread_role: ctx.sessionRole,
					session_stage: "design",
					branch: "fixture-FLY-2920",
					plan_path: "engineering/doc/FLY-2920-fixture/plan.md",
				});
				return { success: true, sessionId: "fixture" };
			},
		} as unknown as ProjectRuntime["blueprint"],
	};
}
function wiring(f: Awaited<ReturnType<typeof fixture>>, store = f.store) {
	const capture: BlueprintContext[] = [];
	const requests: StartRequest[] = [];
	const runtimes = new Map([["fixture", runtime(f.repo, capture, store)]]);
	const resume = createProgressResumeComputer(
		store,
		runtimes,
		new Map([["fixture", "engineering"]]),
	);
	const dispatcher = new RunDispatcher(
		runtimes,
		[],
		RunnerAdmissionController.alwaysAdmit(),
		undefined,
		undefined,
		resume,
	);
	const start = dispatcher.start.bind(dispatcher);
	vi.spyOn(dispatcher, "start").mockImplementation(async (request) => {
		request = { ...request, leadId: "fixture-lead" };
		requests.push(request);
		return start(request);
	});
	const engine = new WorkflowEngineDispatcher({
		store,
		startDispatcher: dispatcher,
		stateRoot: join(f.dir, "engine"),
		env: ON,
		probeLaunchLiveness: async () => "dead",
		now: () => new Date(),
		log: console.log,
		resolvePredecessorHead: async () => f.tip,
	});
	return { capture, requests, resume, dispatcher, engine };
}

describe("FLY-2920 persisted workflow boot resume", () => {
	it("uses current custom node phase, preserving stopped prior local-only tip, ledger and description", async () => {
		const f = await fixture();
		const w = wiring(f);
		expect(await w.engine.reconcile()).toEqual({ started: 2, held: 0 });
		await w.dispatcher.drain();
		expect(w.capture).toHaveLength(1);
		expect(w.capture[0]?.progressResume).toMatchObject({
			priorExecutionId: "stopped-prior",
			effectiveStage: "implement",
			progressPath: f.path,
		});
		expect(w.capture[0]?.startPoint).toBe(f.tip);
		expect(w.requests[0]?.generalizedExecution).toMatchObject({
			engineOwned: true,
			nodeId: "writer-custom",
			executionId: "current",
			attempt: 1,
		});
		expect(f.git("show", `${f.tip}:${f.path}`)).toBe(f.ledger.trim());
		expect(f.git("rev-parse", "HEAD")).toBe(f.tip);
		expect(f.git("config", `branch.${f.branch}.description`)).toBe(
			"preserve founder description",
		);
	});
	it("replaces a previously bound dead execution after database reopen without losing its local cursor", async () => {
		const f = await fixture();
		const initial = wiring(f);
		expect(await initial.engine.reconcile()).toEqual({ started: 2, held: 0 });
		await initial.dispatcher.drain();
		const old = initial.requests[0]!.generalizedExecution!;
		f.store.upsertSession({
			execution_id: "current",
			issue_id: "FLY-2920",
			project_name: "fixture",
			status: "failed",
			workflow_node_id: "writer-custom",
		});
		f.store.close();
		stores.splice(stores.indexOf(f.store), 1);
		const reopened = await StateStore.create(f.dbPath);
		stores.push(reopened);
		const w = wiring(f, reopened);
		const recovery = new WorkflowEngineDispatcher({
			store: reopened,
			startDispatcher: w.dispatcher,
			stateRoot: join(f.dir, "recovery"),
			env: ON,
			now: () => new Date(Date.now() + 6 * 60 * 60 * 1000),
			probeLaunchLiveness: async () => "dead",
			resolvePredecessorHead: async () => f.tip,
			resolveLeadId: () => "fixture-lead",
			log: console.log,
		});
		expect(await recovery.reconcile()).toEqual({ started: 1, held: 0 });
		await w.dispatcher.drain();
		expect(w.requests).toHaveLength(1);
		expect(w.capture).toHaveLength(1);
		const replacement = w.requests[0]!.generalizedExecution!;
		expect(replacement.executionId).not.toBe(old.executionId);
		expect(replacement.activationId).not.toBe(old.activationId);
		expect(
			reopened.getWorkflowActivation(replacement.activationId!),
		).toMatchObject({
			execution_id: replacement.executionId,
			node_id: "writer-custom",
			attempt: 1,
			mode: "spawn",
		});
		expect(
			reopened
				.listWorkflowSideEffects("run")
				.filter((row) => row.node_id === "writer-custom"),
		).toHaveLength(2);
		expect(w.capture[0]?.progressResume).toMatchObject({
			priorExecutionId: "current",
			effectiveStage: "implement",
			progressPath: f.path,
		});
		expect(w.capture[0]?.startPoint).toBe(f.tip);
		expect(await recovery.reconcile()).toEqual({ started: 0, held: 0 });
		expect(w.requests).toHaveLength(1);
		expect(f.git("rev-parse", "HEAD")).toBe(f.tip);
		expect(f.git("show", `${f.tip}:${f.path}`)).toBe(f.ledger.trim());
		expect(f.git("config", `branch.${f.branch}.description`)).toBe(
			"preserve founder description",
		);
	});
	it("keeps a valid generic first start as role main without importing legacy phase authority", async () => {
		const f = await fixture("generic");
		const w = wiring(f);
		expect(await w.engine.reconcile()).toEqual({ started: 1, held: 0 });
		await w.dispatcher.drain();
		expect(w.requests[0]?.sessionRole).toBe("main");
		expect(w.capture[0]?.progressResume).toBeUndefined();
	});

	it("valid QA skips ledger only after validating its persisted binding; stale attempts and completed nodes refuse", async () => {
		const f = await fixture();
		const admission = f.store.admitWorkflowExecution({
			runId: "run",
			nodeId: "qa",
			executionId: "qa-current",
			attempt: 1,
			family: "qa_verdict",
			now: "2026-09-26T00:00:00.000Z",
			expiresAt: "2026-09-26T01:00:00.000Z",
			absoluteDeadlineAt: "2026-09-26T02:00:00.000Z",
		});
		expect(admission.ok).toBe(true);
		const binding = f.store.getWorkflowActivationForAttempt({
			runId: "run",
			nodeId: "qa",
			executionId: "qa-current",
			attempt: 1,
		})!;
		const identity = {
			engineOwned: true,
			executionId: "qa-current",
			activationId: binding.activation_id,
			runId: "run",
			nodeId: "qa",
			attempt: 1,
		};
		const w = wiring(f);
		await expect(
			w.resume("FLY-2920", "qa", "fixture", identity),
		).resolves.toBeNull();
		f.store.upsertWorkflowRunNode({
			runId: "run",
			nodeId: "qa",
			attempt: 1,
			executionId: "qa-current",
			state: "done",
		});
		await expect(
			w.resume("FLY-2920", "qa", "fixture", identity),
		).rejects.toThrow("workflow_resume_authority_refused");
		f.store.upsertWorkflowRunNode({
			runId: "run",
			nodeId: "qa",
			attempt: 1,
			executionId: "qa-current",
			state: "admitted",
		});
		await expect(
			w.resume("FLY-2920", "qa", "fixture", identity),
		).resolves.toBeNull();
		f.store.upsertWorkflowRunNode({
			runId: "run",
			nodeId: "qa",
			attempt: 2,
			executionId: "new-qa",
			state: "pending",
		});
		await expect(
			w.resume("FLY-2920", "qa", "fixture", identity),
		).rejects.toThrow("workflow_resume_authority_refused");
	});

	it("rechecks engine authority after no-ledger continuity Git awaits", async () => {
		const f = await fixture();
		const admission = f.store.admitWorkflowExecution({
			runId: "run",
			nodeId: "qa",
			executionId: "qa-current",
			attempt: 1,
			family: "qa_verdict",
			now: "2026-09-26T00:00:00.000Z",
			expiresAt: "2026-09-26T01:00:00.000Z",
			absoluteDeadlineAt: "2026-09-26T02:00:00.000Z",
		});
		expect(admission.ok).toBe(true);
		const binding = f.store.getWorkflowActivationForAttempt({
			runId: "run",
			nodeId: "qa",
			executionId: "qa-current",
			attempt: 1,
		})!;
		const capture: BlueprintContext[] = [];
		const runtimes = new Map([["fixture", runtime(f.repo, capture, f.store)]]);
		const resume = createProgressResumeComputer(
			f.store,
			runtimes,
			new Map([["fixture", "engineering"]]),
		);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			resume,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			async () => {
				const run = f.store.getWorkflowRun("run")!;
				vi.spyOn(f.store, "getWorkflowRun").mockReturnValue({
					...run,
					status: "terminated",
				});
				return { kind: "missing" };
			},
		);
		await expect(
			dispatcher.start({
				issueId: "FLY-2920",
				projectName: "fixture",
				sessionRole: "qa",
				generalizedExecution: {
					engineOwned: true,
					executionId: "qa-current",
					activationId: binding.activation_id,
					runId: "run",
					nodeId: "qa",
					attempt: 1,
					dispatch: { vendor: "claude", model: "claude-fable-5" },
					capabilities: {},
					agentContent: "fixture",
					snapshotDigest: "fixture",
					gateCarrierEpoch: 0,
					idempotencyKey: "fixture",
				},
			}),
		).rejects.toThrow("workflow_resume_authority_refused");
		expect(capture).toHaveLength(0);
	});

	it("validates wrong activation, attempt, missing node, corrupt snapshot and unknown storage before QA/no-ledger fallback", async () => {
		const f = await fixture();
		const w = wiring(f);
		await w.engine.reconcile();
		await w.dispatcher.drain();
		const identity = w.requests[0]!.generalizedExecution!;
		for (const bad of [
			{ ...identity, activationId: "missing" },
			{ ...identity, attempt: 99 },
			{ ...identity, nodeId: "missing" },
		]) {
			await expect(
				w.resume("FLY-2920", "implement", "fixture", bad),
			).rejects.toThrow("workflow_resume_authority_refused");
			await expect(w.resume("FLY-2920", "qa", "fixture", bad)).rejects.toThrow(
				"workflow_resume_authority_refused",
			);
		}
		vi.spyOn(f.store, "getWorkflowRun").mockImplementationOnce(() => {
			throw new Error("unreadable");
		});
		await expect(
			w.resume("FLY-2920", "implement", "fixture", identity),
		).rejects.toThrow("workflow_resume_authority_refused");
		const run = f.store.getWorkflowRun("run")!;
		vi.spyOn(f.store, "getWorkflowRun").mockReturnValue({
			...run,
			snapshot: "broken",
		});
		await expect(
			w.resume("FLY-2920", "implement", "fixture", identity),
		).rejects.toThrow("workflow_resume_authority_refused");
	});
	it("rechecks terminal authority after asynchronous Git and refuses pinned requests before launch", async () => {
		const f = await fixture();
		const w = wiring(f);
		await w.engine.reconcile();
		await w.dispatcher.drain();
		const identity = w.requests[0]!.generalizedExecution!;
		const resume = createProgressResumeComputer(
			f.store,
			new Map([["fixture", { projectRoot: f.repo }]]),
			new Map([["fixture", "engineering"]]),
			undefined,
			async (_root, args) => {
				const run = f.store.getWorkflowRun("run")!;
				vi.spyOn(f.store, "getWorkflowRun").mockReturnValue({
					...run,
					status: "terminated",
				});
				return f.git(...args);
			},
		);
		await expect(
			resume("FLY-2920", "implement", "fixture", identity),
		).rejects.toThrow("workflow_resume_authority_refused");
		await expect(
			w.dispatcher.start({ ...w.requests[0]!, startPoint: f.tip }),
		).rejects.toThrow("workflow_resume_authority_refused");
		expect(w.capture).toHaveLength(1);
	});
	it("a persisted terminal run stays stopped across repeated boot and manual resume preserves its own authority", async () => {
		const f = await fixture();
		const initial = wiring(f);
		expect(await initial.engine.reconcile()).toEqual({ started: 2, held: 0 });
		await initial.dispatcher.drain();
		const activation = initial.requests[0]!.generalizedExecution!;
		f.store.upsertSession({
			execution_id: "current",
			issue_id: "FLY-2920",
			project_name: "fixture",
			status: "terminated",
		});
		const result = f.store.terminateWorkflowRunByOperator({
			runId: "run",
			reason: "fixture founder stop",
			clientRequestId: "stop",
			principal: "founder",
			evidence: [
				{
					executionId: "current",
					sessionStatus: "terminated",
					lifecycleRevision:
						f.store.getSession("current")?.lifecycle_revision ?? null,
					liveness: "dead",
					observedAt: new Date().toISOString(),
				},
			],
			now: new Date().toISOString(),
		});
		expect(result.ok).toBe(true);
		f.store.close();
		stores.splice(stores.indexOf(f.store), 1);
		const reopened = await StateStore.create(f.dbPath);
		stores.push(reopened);
		for (let boot = 0; boot < 2; boot++) {
			const w = wiring(f, reopened);
			expect(await w.engine.reconcile()).toEqual({ started: 0, held: 0 });
			expect(w.requests).toHaveLength(0);
			expect(w.capture).toHaveLength(0);
		}
		expect(
			reopened.getWorkflowActivation(activation.activationId!),
		).toMatchObject({ execution_id: "current", node_id: "writer-custom" });
		const manual = wiring(f, reopened);
		const resultManual = await manual.resume(
			"FLY-2920",
			"implement",
			"fixture",
		);
		expect(resultManual?.startPoint).toBe(f.tip);
		expect(resultManual?.effectiveStage).toBeUndefined();
		await manual.dispatcher.start({
			issueId: "FLY-2920",
			projectName: "fixture",
			sessionRole: "implement",
			leadId: "fixture-lead",
		});
		await manual.dispatcher.drain();
		expect(manual.capture).toHaveLength(1);
		expect(manual.capture[0]?.startPoint).toBe(f.tip);
		expect(reopened.getWorkflowRun("run")?.status).toBe("terminated");
		expect(f.git("rev-parse", "HEAD")).toBe(f.tip);
		expect(f.git("show", `${f.tip}:${f.path}`)).toBe(f.ledger.trim());
		expect(f.git("config", `branch.${f.branch}.description`)).toBe(
			"preserve founder description",
		);
	});
});
