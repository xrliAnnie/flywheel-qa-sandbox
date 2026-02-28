import { describe, expect, it } from "vitest";
import { FlywheelRunnerRegistry } from "../src/FlywheelRunnerRegistry.js";
import type {
	FlywheelRunRequest,
	FlywheelRunResult,
	IFlywheelRunner,
} from "../src/flywheel-runner-types.js";

/** Minimal stub runner for testing */
function stubRunner(name: string): IFlywheelRunner {
	return {
		name,
		async run(_request: FlywheelRunRequest): Promise<FlywheelRunResult> {
			return { success: true, costUsd: 0, sessionId: "stub" };
		},
	};
}

describe("FlywheelRunnerRegistry", () => {
	it("single runner registered → get returns it", () => {
		const registry = new FlywheelRunnerRegistry();
		const claude = stubRunner("claude");
		registry.register(claude);

		expect(registry.get("claude")).toBe(claude);
	});

	it("single runner → getDefault returns it", () => {
		const registry = new FlywheelRunnerRegistry();
		const claude = stubRunner("claude");
		registry.register(claude);

		expect(registry.getDefault()).toBe(claude);
	});

	it("unknown runner name → throws descriptive error", () => {
		const registry = new FlywheelRunnerRegistry();
		registry.register(stubRunner("claude"));

		expect(() => registry.get("gemini")).toThrow(
			'Runner "gemini" is not registered. Available: claude',
		);
	});

	it("getDefault with no runners → throws", () => {
		const registry = new FlywheelRunnerRegistry();

		expect(() => registry.getDefault()).toThrow("No runners registered");
	});

	it("first registered runner becomes default", () => {
		const registry = new FlywheelRunnerRegistry();
		const claude = stubRunner("claude");
		const codex = stubRunner("codex");

		registry.register(claude);
		registry.register(codex);

		expect(registry.getDefault()).toBe(claude);
	});

	it("setDefault overrides the default", () => {
		const registry = new FlywheelRunnerRegistry();
		const claude = stubRunner("claude");
		const codex = stubRunner("codex");

		registry.register(claude);
		registry.register(codex);
		registry.setDefault("codex");

		expect(registry.getDefault()).toBe(codex);
	});

	it("setDefault with unknown name → throws", () => {
		const registry = new FlywheelRunnerRegistry();
		registry.register(stubRunner("claude"));

		expect(() => registry.setDefault("gemini")).toThrow(
			'Cannot set default: runner "gemini" is not registered',
		);
	});

	it("availableNames returns registered runner names", () => {
		const registry = new FlywheelRunnerRegistry();
		registry.register(stubRunner("claude"));
		registry.register(stubRunner("codex"));

		expect(registry.availableNames()).toEqual(["claude", "codex"]);
	});
});
