/**
 * FLY-123: AdapterRegistry factory registration tests.
 *
 * Codex design review R1 #6: factory registration must preserve the
 * per-execution-fresh instance semantics of the `makeAdapter` closure it
 * replaces — concurrent executions must not share instance state.
 */
import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../AdapterRegistry.js";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	AdapterHealthCheck,
	IAdapter,
} from "../adapter-types.js";

class FakeAdapter implements IAdapter {
	readonly supportsStreaming = false;
	/** instance-level mutable state — the thing factories protect */
	mutated = false;
	constructor(readonly type: string = "fake") {}
	async checkEnvironment(): Promise<AdapterHealthCheck> {
		return { healthy: true, message: "ok" };
	}
	async execute(
		_ctx: AdapterExecutionContext,
	): Promise<AdapterExecutionResult> {
		this.mutated = true;
		return { success: true, sessionId: "s" };
	}
}

describe("AdapterRegistry — instance registration (existing behavior)", () => {
	it("registerAs + get returns the same singleton", () => {
		const registry = new AdapterRegistry();
		const adapter = new FakeAdapter("claude-tmux");
		registry.registerAs("claude-tmux", adapter);
		expect(registry.get("claude-tmux")).toBe(adapter);
		expect(registry.get("claude-tmux")).toBe(registry.get("claude-tmux"));
	});

	it("get throws on unregistered name with available list", () => {
		const registry = new AdapterRegistry();
		registry.registerAs("claude-tmux", new FakeAdapter());
		expect(() => registry.get("nope")).toThrow(/not registered/);
		expect(() => registry.get("nope")).toThrow(/claude-tmux/);
	});
});

describe("AdapterRegistry — registerFactory (FLY-123)", () => {
	it("get() invokes the factory per call — fresh instance each time", () => {
		const registry = new AdapterRegistry();
		let constructed = 0;
		registry.registerFactory("claude-tmux", () => {
			constructed++;
			return new FakeAdapter("claude-tmux");
		});
		const a = registry.get("claude-tmux");
		const b = registry.get("claude-tmux");
		expect(a).not.toBe(b);
		expect(constructed).toBe(2);
	});

	it("two concurrent executions do not share instance state", async () => {
		const registry = new AdapterRegistry();
		registry.registerFactory("codex-tmux", () => new FakeAdapter("codex-tmux"));
		const a = registry.get("codex-tmux") as FakeAdapter;
		const b = registry.get("codex-tmux") as FakeAdapter;
		await a.execute({} as AdapterExecutionContext);
		expect(a.mutated).toBe(true);
		expect(b.mutated).toBe(false); // b untouched — no shared state
	});

	it("first factory registration becomes the default", () => {
		const registry = new AdapterRegistry();
		registry.registerFactory(
			"claude-tmux",
			() => new FakeAdapter("claude-tmux"),
		);
		registry.registerFactory("codex-tmux", () => new FakeAdapter("codex-tmux"));
		expect(registry.getDefault().type).toBe("claude-tmux");
	});

	it("setDefault accepts factory-registered names", () => {
		const registry = new AdapterRegistry();
		registry.registerFactory(
			"claude-tmux",
			() => new FakeAdapter("claude-tmux"),
		);
		registry.registerFactory("codex-tmux", () => new FakeAdapter("codex-tmux"));
		registry.setDefault("codex-tmux");
		expect(registry.getDefault().type).toBe("codex-tmux");
	});

	it("availableNames lists instances and factories without duplicates", () => {
		const registry = new AdapterRegistry();
		registry.registerAs("legacy", new FakeAdapter("legacy"));
		registry.registerFactory("codex-tmux", () => new FakeAdapter("codex-tmux"));
		expect(registry.availableNames().sort()).toEqual(["codex-tmux", "legacy"]);
	});

	it("factory takes precedence over instance under the same name", () => {
		const registry = new AdapterRegistry();
		const singleton = new FakeAdapter("dup");
		registry.registerAs("dup", singleton);
		registry.registerFactory("dup", () => new FakeAdapter("dup"));
		expect(registry.get("dup")).not.toBe(singleton);
	});
});
