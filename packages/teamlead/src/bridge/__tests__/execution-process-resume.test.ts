import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../../workflow-run-snapshot.js";
import {
	createExecutionProcessOwnerFactory,
	createTmuxProcessLaunchDeps,
	type ExecutionProcessControllerOptions,
} from "../execution-process-controller.js";

let store: StateStore;
let root: string;
let ctx: AdapterExecutionContext;
let options: ExecutionProcessControllerOptions;
const activation = "activation:exec:run:execute:1";
beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "fly2919-resume-"));
	vi.stubEnv("FLYWHEEL_COMPLETE_MARKER_DIR", join(root, "markers"));
	mkdirSync(join(root, "markers"));
	store = await StateStore.create(join(root, "fixture.db"));
	store.upsertSession({
		execution_id: "exec",
		issue_id: "FLY-2919",
		project_name: "fixture",
		status: "running",
	});
	ctx = {
		executionId: "exec",
		issueId: "FLY-2919",
		cwd: "/work",
		prompt: "resume",
		processLifecycle: { mode: "resume", generation: 1 },
	};
	options = {
		now: () => 1000,
		nonce: () => "nonce",
		sleep: async () => {},
		readController: async () => ({
			pid: 100,
			pgid: 100,
			startIdentity: "controller",
			hostBootId: "boot",
			executable: "/bin/node",
			cwd: "/bridge",
		}),
		resolveCwd: async () => "/work",
		resolveExecutable: async () => "/bin/worker",
		bindSpawn: async () => ({
			version: 1,
			adapter: "codex-tmux",
			pid: 200,
			pgid: 200,
			startIdentity: "worker",
			hostBootId: "boot",
			executable: "/bin/worker",
			cwd: "/work",
			nonce: "nonce",
			nativeSessionId: null,
			writers: [],
		}),
		sample: async () => ({
			sampledAtMs: 1000,
			hostBootId: "boot",
			processes: [],
			worker: null,
			daemon: "absent",
			writersComplete: true,
			viewers: [],
		}),
	};
});
afterEach(() => {
	store.close();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});
function enroll() {
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Execute safely.\n");
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: "fixture", revision: 1 },
		canonicalRoot: root,
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "execute",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					agent_file: "agents/generic.md",
				},
				{ id: "founder_gate", type: "gate" },
			],
			edges: [
				{
					id: "done",
					from: "execute",
					to: "founder_gate",
					condition: "node_done",
				},
			],
			loops: [],
			terminal_gate: { node: "founder_gate", predicate: "founder_approved" },
			ship_claims: ["founder_approved"],
		},
	});
	store.createWorkflowRun({
		runId: "run",
		issueId: "FLY-2919",
		projectName: "fixture",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: false,
	});
	expect(
		store.admitWorkflowExecution({
			runId: "run",
			nodeId: "execute",
			executionId: "exec",
			attempt: 1,
			family: "review_verdict",
			now: "2026-09-26T00:00:00.000Z",
			expiresAt: "2026-09-26T01:00:00.000Z",
			absoluteDeadlineAt: "2026-09-27T00:00:00.000Z",
		}).ok,
	).toBe(true);
	expect(store.resolveCurrentWorkflowActivation("exec")).toMatchObject({
		kind: "current",
		binding: { activation_id: activation },
	});
}
const acquire = () =>
	createExecutionProcessOwnerFactory(store, options)(ctx, "owner");
describe("FLY-2919 resumed owner activation authority", () => {
	it("classifies the exact resumed activation when execution-wide lookup is ambiguous", async () => {
		enroll();
		store.upsertSession({
			execution_id: "exec",
			issue_id: "FLY-2919",
			project_name: "fixture",
			status: "running",
			adapter_type: "claude-tmux",
		});
		store.ensureFlagValueRows({ env: {}, now: 1000 });
		const bind = options.bindSpawn!;
		const deps = createTmuxProcessLaunchDeps(store, {
			...options,
			ownerToken: () => "owner",
			resolveLaunchExecutable: async () => ({
				launchPath: "/bin/worker",
				executable: "/bin/worker",
				launchEnvPath: "/bin",
			}),
			bindSpawn: async (...args) => ({
				...(await bind(...args))!,
				adapter: "claude-tmux",
				nativeSessionId: "native",
			}),
		});
		const lease = await deps.createLaunch(ctx, {
			adapter: "claude-tmux",
			binaryName: "claude",
			nativeSessionId: "native",
		});
		await lease.prepareSpawn();
		await lease.acceptSpawn({
			version: 1,
			executionId: "exec",
			generation: 1,
			ownerToken: "owner",
			nonce: "nonce",
			adapter: "claude-tmux",
			binaryName: "/bin/worker",
			nativeSessionId: "native",
			cwd: "/work",
			pid: 200,
			pgid: 200,
			startIdentity: "worker",
			hostBootId: "boot",
			shellExecutable: "/bin/sh",
		});
		const dead = await lease.observeBody!();
		expect(dead?.verdict).toBe("dead");
		vi.spyOn(store, "getGeneralizedWorkflowNodeForExecution").mockReturnValue(
			undefined,
		);
		expect(await lease.classifyBodyExit!(dead!)).toBe("abnormal_process_exit");
		vi.spyOn(store, "getWorkflowNodeCompletion").mockReturnValue({
			execution_id: "exec",
			activation_id: activation,
		} as never);
		expect(await lease.classifyBodyExit!(dead!)).toBe("completed");
	});

	it.each(["codex-tmux", "claude-tmux"] as const)(
		"derives a missing resume activation from the current durable binding (%s)",
		async (adapter) => {
			enroll();
			options.adapter = adapter;
			const lease = await acquire();
			expect(store.executionProcessOwners.get("exec")).toMatchObject({
				activation_id: activation,
				owner_token: "owner",
			});
			await lease.prepareSpawn();
			expect(lease.authorizeSpawn()).toBe(true);
		},
	);
	it.each(["none", "ambiguous"] as const)(
		"refuses resume with %s authority before claiming an owner",
		async (kind) => {
			if (kind === "ambiguous") {
				enroll();
				vi.spyOn(store, "resolveCurrentWorkflowActivation").mockReturnValue({
					kind,
					activationIds: [activation, "other"],
				});
			}
			await expect(acquire()).rejects.toThrow(
				"process_resume_activation_unavailable",
			);
			expect(store.executionProcessOwners.get("exec")).toBeUndefined();
		},
	);
	it("does not replace an explicitly stale resume activation with the current one", async () => {
		enroll();
		ctx.workflowActivationId = "stale";
		await expect(acquire()).rejects.toThrow(
			"process_resume_activation_changed",
		);
		expect(store.executionProcessOwners.get("exec")).toBeUndefined();
	});
	it("rechecks current activation across a temporary owner-claim lease retry", async () => {
		enroll();
		ctx.workflowActivationId = activation;
		const owners = store.executionProcessOwners;
		vi.spyOn(store, "executionProcessOwners", "get").mockReturnValue(owners);
		vi.spyOn(owners, "claim").mockReturnValueOnce({
			ok: false,
			reason: "lease_held",
		});
		options.sleep = async () => {
			vi.spyOn(store, "resolveCurrentWorkflowActivation").mockReturnValue({
				kind: "ambiguous",
				activationIds: [],
			});
		};
		await expect(acquire()).rejects.toThrow(
			"process_resume_activation_changed",
		);
		expect(owners.get("exec")).toBeUndefined();
	});
	it("refuses the native spawn permit after a new activation supersedes the resume", async () => {
		enroll();
		ctx.workflowActivationId = activation;
		const lease = await acquire();
		await lease.prepareSpawn();
		vi.spyOn(store, "resolveCurrentWorkflowActivation").mockReturnValue({
			kind: "ambiguous",
			activationIds: [],
		});
		expect(lease.authorizeSpawn()).toBe(false);
	});
	it("records a newborn for cleanup but rejects admission when activation changes during binding", async () => {
		enroll();
		ctx.workflowActivationId = activation;
		const bind = options.bindSpawn!;
		options.bindSpawn = async (...args) => {
			const value = await bind(...args);
			vi.spyOn(store, "resolveCurrentWorkflowActivation").mockReturnValue({
				kind: "ambiguous",
				activationIds: [],
			});
			return value;
		};
		const lease = await acquire();
		await lease.prepareSpawn();
		await expect(lease.acceptSpawn(200)).rejects.toThrow(
			"process_resume_activation_changed",
		);
		expect(
			store.executionProcessOwners.get("exec")?.binding_digest,
		).toBeTruthy();
		expect(lease.authorizeSpawn()).toBe(false);
		await lease.finish();
		expect(
			store.executionProcessOwners.get("exec")?.owner_drained_receipt,
		).toBeTruthy();
	});
	it("can drain an accepted resume after the logical activation finishes", async () => {
		enroll();
		ctx.workflowActivationId = activation;
		const lease = await acquire();
		await lease.prepareSpawn();
		await lease.acceptSpawn(200);
		vi.spyOn(store, "resolveCurrentWorkflowActivation").mockReturnValue({
			kind: "ambiguous",
			activationIds: [],
		});
		await lease.finish();
		expect(
			store.executionProcessOwners.get("exec")?.owner_drained_receipt,
		).toBeTruthy();
	});
});
