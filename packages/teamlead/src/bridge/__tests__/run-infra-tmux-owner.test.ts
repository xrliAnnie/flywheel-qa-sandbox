import { AdapterRegistry } from "flywheel-core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("flywheel-claude-runner", async (original) => ({
	...(await original<object>()),
	TmuxAdapter: vi.fn().mockImplementation(() => ({ type: "claude-tmux" })),
	KimiTmuxAdapter: vi.fn().mockImplementation(() => ({ type: "kimi-tmux" })),
	AntigravityTmuxAdapter: vi
		.fn()
		.mockImplementation(() => ({ type: "antigravity-tmux" })),
}));

import {
	AntigravityTmuxAdapter,
	KimiTmuxAdapter,
	TmuxAdapter,
} from "flywheel-claude-runner";
import * as Infra from "../run-infra.js";

afterEach(() => vi.clearAllMocks());
describe("production Tmux process admission wiring", () => {
	it("injects the shared owner factory into every fresh registered carrier", () => {
		const registry = new AdapterRegistry();
		const processLaunchDeps = { createLaunch: vi.fn() };
		const register = (Infra as any).registerTmuxRunAdapterFactories;
		expect(register).toBeTypeOf("function");
		register(registry, {
			sessionName: "runner",
			sessionTimeoutMs: 1000,
			processLaunchDeps,
		});
		for (const type of ["claude-tmux", "kimi-tmux", "antigravity-tmux"]) {
			const first = registry.get(type),
				second = registry.get(type);
			expect(first.type).toBe(type);
			expect(second).not.toBe(first);
		}
		expect(vi.mocked(TmuxAdapter).mock.calls.map((args) => args[8])).toEqual([
			processLaunchDeps,
			processLaunchDeps,
		]);
		expect(
			vi.mocked(KimiTmuxAdapter).mock.calls.map((args) => args[5]),
		).toEqual([processLaunchDeps, processLaunchDeps]);
		expect(
			vi.mocked(AntigravityTmuxAdapter).mock.calls.map((args) => args[5]),
		).toEqual([processLaunchDeps, processLaunchDeps]);
	});
});
