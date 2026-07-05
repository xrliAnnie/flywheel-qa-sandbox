/**
 * FLY-494 (Codex design R1 #2): registry seam test. The production registration
 * point is run-infra.ts (a large inline function not unit-testable in isolation),
 * so this reproduces the SAME AdapterRegistry wiring at minimum fidelity to prove
 * `kimi-tmux` resolves to a KimiTmuxAdapter while the default stays `claude-tmux`.
 * Asserts against the REAL AdapterRegistry contract (unknown name THROWS — it is
 * NOT a silent fallback; the default is reached only via getDefault()).
 */
import { AdapterRegistry } from "flywheel-core";
import { describe, expect, it } from "vitest";
import { KimiTmuxAdapter } from "../src/KimiTmuxAdapter.js";
import { TmuxAdapter } from "../src/TmuxAdapter.js";

function makeRegistry(): AdapterRegistry {
	const registry = new AdapterRegistry();
	// Mirror run-infra.ts: claude-tmux + kimi-tmux factories, default claude-tmux.
	registry.registerFactory("claude-tmux", () => new TmuxAdapter("flywheel"));
	registry.registerFactory("kimi-tmux", () => new KimiTmuxAdapter("flywheel"));
	registry.setDefault("claude-tmux");
	return registry;
}

describe("KimiTmuxAdapter registry wiring (FLY-494)", () => {
	it("resolves kimi-tmux → a fresh KimiTmuxAdapter instance with type 'kimi-tmux'", () => {
		const registry = makeRegistry();
		const adapter = registry.get("kimi-tmux");
		expect(adapter).toBeInstanceOf(KimiTmuxAdapter);
		expect(adapter.type).toBe("kimi-tmux");
		// Factory registration → a NEW instance per call (not a shared singleton).
		expect(registry.get("kimi-tmux")).not.toBe(adapter);
	});

	it("default stays claude-tmux (a plain TmuxAdapter, NOT KimiTmuxAdapter)", () => {
		const registry = makeRegistry();
		const def = registry.getDefault();
		expect(def.type).toBe("claude-tmux");
		expect(def).toBeInstanceOf(TmuxAdapter);
		expect(def).not.toBeInstanceOf(KimiTmuxAdapter);
	});

	it("unknown backend name THROWS (real AdapterRegistry contract — not a fallback)", () => {
		const registry = makeRegistry();
		expect(() => registry.get("nonexistent-tmux")).toThrow(/not registered/i);
	});
});
