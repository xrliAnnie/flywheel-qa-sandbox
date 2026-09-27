import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createExecutionBodyObserver } from "../execution-body-liveness.js";
import { createLegacyProcessBindingPreparer } from "../legacy-process-binding.js";

let store: StateStore;
let root: string;
let clock: number;
let enabled: boolean;
const sessionId = "11111111-2222-3333-4444-555555555555";
const binding = {
	version: 1 as const,
	adapter: "claude-tmux" as const,
	pid: 42,
	pgid: 42,
	startIdentity: "start",
	hostBootId: "boot",
	executable: "/bin/claude",
	cwd: "/work",
	nonce: null,
	legacyExecutionId: "exec-1",
	nativeSessionId: sessionId,
	writers: [],
};
const discover = vi.fn();
beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "fly2919-legacy-"));
	clock = 1000;
	enabled = true;
	store = await StateStore.create(":memory:");
	store.upsertSession({
		execution_id: "exec-1",
		issue_id: "FLY-2919",
		project_name: "fixture",
		adapter_type: "claude-tmux",
		status: "running",
		worktree_path: "/work",
	});
	mkdirSync(join(root, "exec-1"));
	writeFileSync(
		join(root, "exec-1", "session.json"),
		JSON.stringify({
			schemaVersion: 1,
			executionId: "exec-1",
			vendor: "claude",
			sessionId,
			cwd: "/work",
		}),
	);
	discover.mockReset().mockResolvedValue(binding);
});
afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});
function prepare() {
	return createLegacyProcessBindingPreparer(store, {
		stateRoot: root,
		isEnabled: () => enabled,
		now: () => clock,
		resolveCwd: async (p) => p,
		resolveExecutable: async () => "/bin/claude",
		discover,
	});
}
describe("FLY-2919 live legacy binding migration", () => {
	it("accepts OS-verified identity once and reuses the existing owner inventory", async () => {
		const run = prepare();
		await run("exec-1");
		await run("exec-1");
		expect(store.executionProcessOwners.getBinding("exec-1")).toEqual(binding);
		expect(discover).toHaveBeenCalledOnce();
		expect(store.executionProcessOwners.listObservationCandidates()).toContain(
			"exec-1",
		);
	});
	it("coalesces discovery and waits for cancelled OS work to drain", async () => {
		let release!: (value: typeof binding) => void;
		discover.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const run = prepare();
		const cancel = new AbortController();
		const first = run("exec-1");
		const second = run("exec-1", { signal: cancel.signal });
		await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
		let settled = false;
		void second.then(() => {
			settled = true;
		});
		cancel.abort();
		await Promise.resolve();
		expect(settled).toBe(false);
		release(binding);
		await Promise.all([first, second]);
		expect(store.executionProcessOwners.get("exec-1")).toBeUndefined();
	});
	it("retries a contended short mutation lease without repeating OS discovery", async () => {
		const lease = vi
			.spyOn(store, "claimExecutionMutationLease")
			.mockReturnValueOnce({ ok: false, reason: "lease_held" } as never);
		await prepare()("exec-1");
		expect(lease).toHaveBeenCalledTimes(2);
		expect(discover).toHaveBeenCalledOnce();
		expect(store.executionProcessOwners.getBinding("exec-1")).toEqual(binding);
	});
	it("the common observer keeps adopted workers alive and waits for detached writers before death", async () => {
		await prepare()("exec-1");
		let workerAlive = true;
		let detached = false;
		const observer = createExecutionBodyObserver(store, {
			isEnabled: () => enabled,
			isRecoveryActive: () => false,
			now: () => clock,
			sample: async () => ({
				sampledAtMs: clock,
				hostBootId: "boot",
				processes: [
					...(workerAlive
						? [
								{
									pid: 42,
									ppid: 1,
									pgid: 42,
									startIdentity: "start",
									state: "running" as const,
								},
							]
						: []),
					...(detached
						? [
								{
									pid: 88,
									ppid: 1,
									pgid: 88,
									startIdentity: "child",
									state: "running" as const,
								},
							]
						: []),
				],
				worker: workerAlive
					? { executable: "/bin/claude", cwd: "/work" }
					: null,
				writersComplete: true,
				discoveredWriters: detached
					? [{ pid: 88, startIdentity: "child", hostBootId: "boot" }]
					: [],
				viewers: [],
			}),
		});
		expect((await observer.observe("exec-1"))?.verdict).toBe("alive");
		workerAlive = false;
		detached = true;
		expect((await observer.observe("exec-1"))?.verdict).toBe("unknown");
		detached = false;
		const dead = await observer.observe("exec-1");
		expect(dead?.verdict).toBe("dead");
		expect(observer.isCurrent(dead!)).toBe(true);
	});
	it.each([
		"no_match",
		"disabled_before",
		"disabled_after",
		"lifecycle_changed",
		"expired",
		"cancelled",
		"manifest_changed",
		"activation_changed",
		"generation_changed",
	])("refuses unsafe adoption: %s", async (mode) => {
		const cancel = new AbortController();
		if (mode === "disabled_before") enabled = false;
		discover.mockImplementation(async () => {
			if (mode === "disabled_after") enabled = false;
			if (mode === "lifecycle_changed") store.forceStatus("exec-1", "failed");
			if (mode === "activation_changed")
				vi.spyOn(store, "resolveCurrentWorkflowActivation").mockReturnValue({
					kind: "ambiguous",
					activationIds: ["changed"],
				});
			if (mode === "generation_changed")
				vi.spyOn(store, "getWorkflowExecutionProcessBody").mockReturnValue({
					generation: 2,
				} as never);
			if (mode === "expired") clock += 5001;
			if (mode === "cancelled") cancel.abort();
			if (mode === "manifest_changed")
				writeFileSync(join(root, "exec-1", "session.json"), "{}");
			return mode === "no_match" ? null : binding;
		});
		await prepare()("exec-1", { signal: cancel.signal });
		expect(store.executionProcessOwners.get("exec-1")).toBeUndefined();
		if (mode === "disabled_before") expect(discover).not.toHaveBeenCalled();
	});
	it.each(["symlink", "oversize", "wrong_execution", "wrong_cwd"])(
		"refuses an untrusted manifest: %s",
		async (mode) => {
			const file = join(root, "exec-1", "session.json");
			if (mode === "symlink") {
				const other = join(root, "other.json");
				writeFileSync(other, "{}");
				rmSync(file);
				symlinkSync(other, file);
			}
			if (mode === "oversize") writeFileSync(file, "x".repeat(65537));
			if (mode === "wrong_execution" || mode === "wrong_cwd")
				writeFileSync(
					file,
					JSON.stringify({
						schemaVersion: 1,
						executionId: mode === "wrong_execution" ? "foreign" : "exec-1",
						vendor: "claude",
						sessionId,
						cwd: mode === "wrong_cwd" ? "/foreign" : "/work",
					}),
				);
			await prepare()("exec-1");
			expect(store.executionProcessOwners.get("exec-1")).toBeUndefined();
			expect(discover).not.toHaveBeenCalled();
		},
	);
	it("records unresolved legacy identities durably without recording death", async () => {
		discover.mockResolvedValue(null);
		const run = prepare();
		await run("exec-1");
		await run("exec-1");
		const events = store
			.getEventsByExecution("exec-1")
			.filter((e) => e.event_type === "runner_process_binding");
		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toMatchObject({ status: "unknown" });
		expect(store.getSession("exec-1")?.status).toBe("running");
	});
});
