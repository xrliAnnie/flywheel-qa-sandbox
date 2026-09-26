import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import * as Controller from "../execution-process-controller.js";

let store: StateStore;
let root: string;
let options: any;
const ctx = {
	executionId: "exec-1",
	issueId: "FLY-2919",
	cwd: "/work",
	prompt: "task",
} as AdapterExecutionContext;
const identity = {
	pid: 200,
	pgid: 200,
	startIdentity: "worker-start",
	hostBootId: "boot-1",
};
beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "fly2919-tmux-owner-"));
	store = await StateStore.create(join(root, "fixture.db"));
	store.upsertSession({
		execution_id: ctx.executionId,
		issue_id: ctx.issueId,
		project_name: "fixture",
		status: "running",
	});
	options = {
		now: () => 1000,
		nonce: () => "nonce-1",
		ownerToken: () => "owner-1",
		readController: async () => ({
			pid: 100,
			pgid: 100,
			startIdentity: "controller-start",
			hostBootId: "boot-1",
			executable: "/bin/node",
			cwd: "/bridge",
		}),
		resolveCwd: async () => "/work",
		resolveLaunchExecutable: vi.fn(async (binary: string) => ({
			launchPath: `/tools/${binary}`,
			executable: binary === "kimi" ? "/bin/node" : `/bin/${binary}`,
			launchEnvPath: "/tools:/bin",
		})),
		bindSpawn: vi.fn(async () => null),
		sample: async () => ({
			sampledAtMs: 1000,
			hostBootId: "boot-1",
			processes: [],
			worker: null,
			writersComplete: true,
			viewers: [],
		}),
		sleep: async () => {},
	};
});
afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});
function factory() {
	const make = (Controller as any).createTmuxProcessLaunchDeps;
	expect(make).toBeTypeOf("function");
	return make(store, options);
}
function candidate(lease: any, adapter = "claude-tmux", binary = "claude") {
	return {
		version: 1,
		executionId: ctx.executionId,
		generation: lease.generation,
		ownerToken: lease.ownerToken,
		nonce: lease.nonce,
		adapter,
		binaryName: `/tools/${binary}`,
		nativeSessionId: adapter === "claude-tmux" ? "native-session" : null,
		cwd: "/work",
		...identity,
		shellExecutable: "/bin/sh",
	};
}
describe("FLY-2919 production Tmux owner factory", () => {
	it.each([
		["claude-tmux", "claude"],
		["kimi-tmux", "kimi"],
		["antigravity-tmux", "agy"],
	])(
		"admits and drains %s by trusted registered OS identity",
		async (adapter, binary) => {
			const nativeSessionId =
				adapter === "claude-tmux" ? "native-session" : null;
			const lease = await factory().createLaunch(ctx, {
				adapter,
				binaryName: binary,
				nativeSessionId,
			});
			expect(lease.launchPath).toBe(`/tools/${binary}`);
			expect(lease.launchEnvPath).toBe("/tools:/bin");
			expect(lease.authorizeSpawn()).toBe(false);
			await lease.prepareSpawn();
			expect(lease.authorizeSpawn()).toBe(true);
			const executable = binary === "kimi" ? "/bin/node" : `/bin/${binary}`;
			options.bindSpawn.mockResolvedValue({
				version: 1,
				...identity,
				adapter,
				nativeSessionId,
				executable,
				cwd: "/work",
				nonce: "nonce-1",
				writers: [],
			});
			await lease.acceptSpawn(candidate(lease, adapter, binary));
			expect(options.bindSpawn.mock.calls[0][0]).toMatchObject({
				adapter,
				executable,
				nativeSessionId,
				expectedLeader: {
					pid: 200,
					startIdentity: "worker-start",
					hostBootId: "boot-1",
				},
			});
			expect(
				store.executionProcessOwners.getBinding(ctx.executionId),
			).toMatchObject({ adapter, executable, nativeSessionId });
			await lease.finish();
			expect(
				store.executionProcessOwners.get(ctx.executionId)
					?.owner_drained_receipt,
			).toEqual(expect.any(String));
		},
	);
	it.each([
		["executionId", "foreign"],
		["generation", 2],
		["ownerToken", "foreign"],
		["nonce", "foreign"],
		["adapter", "kimi-tmux"],
		["binaryName", "/bin/foreign"],
		["nativeSessionId", "foreign"],
		["cwd", "/foreign"],
		["pid", 201],
	])(
		"refuses an untrusted candidate's %s mismatch before sampling",
		async (key, value) => {
			const lease = await factory().createLaunch(ctx, {
				adapter: "claude-tmux",
				binaryName: "claude",
				nativeSessionId: "native-session",
			});
			await lease.prepareSpawn();
			await expect(
				lease.acceptSpawn({ ...candidate(lease), [key]: value }),
			).rejects.toThrow();
			expect(options.bindSpawn).not.toHaveBeenCalled();
			expect(store.executionProcessOwners.get(ctx.executionId)).toMatchObject({
				spawn_inflight: 1,
				pending_pgid: null,
				binding_digest: null,
			});
		},
	);
	it("refuses unresolved executable before claiming a controller", async () => {
		options.resolveLaunchExecutable.mockRejectedValue(new Error("missing"));
		await expect(
			factory().createLaunch(ctx, {
				adapter: "kimi-tmux",
				binaryName: "kimi",
				nativeSessionId: null,
			}),
		).rejects.toThrow("missing");
		expect(store.executionProcessOwners.get(ctx.executionId)).toBeUndefined();
	});
});
