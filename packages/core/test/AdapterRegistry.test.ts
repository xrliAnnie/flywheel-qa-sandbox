import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../src/AdapterRegistry.js";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	AdapterHealthCheck,
	IAdapter,
} from "../src/adapter-types.js";

/** Minimal stub adapter for testing */
function stubAdapter(type: string): IAdapter {
	return {
		type,
		supportsStreaming: false,
		async checkEnvironment(): Promise<AdapterHealthCheck> {
			return { healthy: true, message: "ok" };
		},
		async execute(
			_ctx: AdapterExecutionContext,
		): Promise<AdapterExecutionResult> {
			return { success: true, sessionId: "stub" };
		},
	};
}

describe("AdapterRegistry", () => {
	it("single adapter registered → get returns it", () => {
		const registry = new AdapterRegistry();
		const claude = stubAdapter("claude");
		registry.register(claude);

		expect(registry.get("claude")).toBe(claude);
	});

	it("single adapter → getDefault returns it", () => {
		const registry = new AdapterRegistry();
		const claude = stubAdapter("claude");
		registry.register(claude);

		expect(registry.getDefault()).toBe(claude);
	});

	it("unknown adapter name → throws descriptive error", () => {
		const registry = new AdapterRegistry();
		registry.register(stubAdapter("claude"));

		expect(() => registry.get("gemini")).toThrow(
			'Adapter "gemini" is not registered. Available: claude',
		);
	});

	it("getDefault with no adapters → throws", () => {
		const registry = new AdapterRegistry();

		expect(() => registry.getDefault()).toThrow("No adapters registered");
	});

	it("first registered adapter becomes default", () => {
		const registry = new AdapterRegistry();
		const claude = stubAdapter("claude");
		const codex = stubAdapter("codex");

		registry.register(claude);
		registry.register(codex);

		expect(registry.getDefault()).toBe(claude);
	});

	it("setDefault overrides the default", () => {
		const registry = new AdapterRegistry();
		const claude = stubAdapter("claude");
		const codex = stubAdapter("codex");

		registry.register(claude);
		registry.register(codex);
		registry.setDefault("codex");

		expect(registry.getDefault()).toBe(codex);
	});

	it("setDefault with unknown name → throws", () => {
		const registry = new AdapterRegistry();
		registry.register(stubAdapter("claude"));

		expect(() => registry.setDefault("gemini")).toThrow(
			'Cannot set default: adapter "gemini" is not registered',
		);
	});

	it("availableNames returns registered adapter names", () => {
		const registry = new AdapterRegistry();
		registry.register(stubAdapter("claude"));
		registry.register(stubAdapter("codex"));

		expect(registry.availableNames()).toEqual(["claude", "codex"]);
	});

	it("registerAs allows custom alias", () => {
		const registry = new AdapterRegistry();
		const tmux = stubAdapter("claude-tmux");
		registry.registerAs("claude", tmux);

		expect(registry.get("claude")).toBe(tmux);
		expect(registry.getDefault()).toBe(tmux);
	});
});
