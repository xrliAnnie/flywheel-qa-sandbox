import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StateStore } from "../../StateStore.js";
import { type ProjectRuntime, RunDispatcher } from "../run-dispatcher.js";
import {
	createRunInfraDispatcher,
	isMissingProjectConfigError,
	resolveWorkflowTmuxWindowAuthority,
} from "../run-infra.js";

describe("project config ENOENT classification", () => {
	it("allows fallback only when config.yaml itself is absent", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2121-run-infra-config-"));
		try {
			const configPath = join(root, "config.yaml");
			const enoent = Object.assign(new Error("registry missing"), {
				code: "ENOENT",
			});
			expect(isMissingProjectConfigError(enoent, configPath)).toBe(true);

			writeFileSync(configPath, "project: fixture\n");
			expect(isMissingProjectConfigError(enoent, configPath)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

class NoRegistrationRunDispatcher extends RunDispatcher {
	protected override preRegisterCommDb(): void {}
}

function releasedLaunchStore(): StateStore {
	return {
		getSession: () => ({
			session_params: JSON.stringify({
				pane_loss_generation: {
					socket_path: "/tmp/flywheel.sock",
					server_start_time: "123",
					window_id: "@7",
					execution_id: "exec-1",
					launch_generation: 2,
					launch_fingerprint: "fingerprint-2",
				},
			}),
		}),
		getWorkflowLaunchOwner: () => ({ released_generation: 2 }),
	} as unknown as StateStore;
}

describe("resolveWorkflowTmuxWindowAuthority", () => {
	it("prunes a released same-execution window only when its full persisted identity matches", () => {
		const store = releasedLaunchStore();
		expect(
			resolveWorkflowTmuxWindowAuthority(store, "exec-1", {
				windowId: "@7",
				windowName: "design",
				executionId: "exec-1",
				launchGeneration: 2,
				launchFingerprint: "fingerprint-2",
			}),
		).toBe("prune");
	});

	it.each([
		["wrong window id", { windowId: "@8" }],
		["wrong generation", { launchGeneration: 1 }],
		["wrong fingerprint", { launchFingerprint: "stale" }],
		["missing fingerprint", { launchFingerprint: undefined }],
	])("keeps a released same-execution window with %s", (_label, override) => {
		const store = releasedLaunchStore();
		expect(
			resolveWorkflowTmuxWindowAuthority(store, "exec-1", {
				windowId: "@7",
				windowName: "design",
				executionId: "exec-1",
				launchGeneration: 2,
				launchFingerprint: "fingerprint-2",
				...override,
			}),
		).toBe("keep");
	});
});

describe("createRunInfraDispatcher inflight lifecycle wiring", () => {
	function setup(statuses: Map<string, string>) {
		const store = {
			getSession: (executionId: string) => {
				const status = statuses.get(executionId);
				return status ? { status } : undefined;
			},
			getSkillFrameworkStamp: () => undefined,
		} as unknown as StateStore;
		const blueprint = {
			run: vi.fn(() => new Promise(() => {})),
		};
		const runtime: ProjectRuntime = {
			blueprint: blueprint as unknown as ProjectRuntime["blueprint"],
			projectRoot: "/tmp/fly1775",
			tmuxSessionName: "runner-fly1775",
		};
		const dispatcher = createRunInfraDispatcher({
			store,
			projectRuntimes: new Map([["flywheel", runtime]]),
			cleanupHandles: [],
			dispatcherClass: NoRegistrationRunDispatcher,
		});
		return { dispatcher, blueprint };
	}

	it("uses the StateStore irreversible-terminal predicate to release a stale lane", async () => {
		const statuses = new Map<string, string>();
		const { dispatcher, blueprint } = setup(statuses);
		const first = await dispatcher.start({
			issueId: "FLY-1775",
			projectName: "flywheel",
			sessionRole: "implement",
		});
		statuses.set(first.executionId, "completed");

		await expect(
			dispatcher.start({
				issueId: "FLY-1775",
				projectName: "flywheel",
				sessionRole: "implement",
			}),
		).resolves.toMatchObject({ issueId: "FLY-1775" });
		expect(blueprint.run).toHaveBeenCalledTimes(2);
	});

	it("does not release a lane for the resumable awaiting_review status", async () => {
		const statuses = new Map<string, string>();
		const { dispatcher, blueprint } = setup(statuses);
		const first = await dispatcher.start({
			issueId: "FLY-1775",
			projectName: "flywheel",
			sessionRole: "implement",
		});
		statuses.set(first.executionId, "awaiting_review");

		await expect(
			dispatcher.start({
				issueId: "FLY-1775",
				projectName: "flywheel",
				sessionRole: "implement",
			}),
		).rejects.toThrow("already in progress");
		expect(blueprint.run).toHaveBeenCalledOnce();
	});
});
