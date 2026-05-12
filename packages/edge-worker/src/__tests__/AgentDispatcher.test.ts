import type { AgentConfig } from "flywheel-config";
import { describe, expect, it } from "vitest";
import type { AgentDispatchResult } from "../AgentDispatcher.js";
import {
	AgentDispatcher,
	InvalidAgentFilePathError,
	InvalidAgentNameError,
	parsedDept,
} from "../AgentDispatcher.js";

/** Synthetic Flywheel repo root for tests — value isn't read on disk, just non-empty. */
const TEST_FLYWHEEL_ROOT = "/test-flywheel-root";

// ─── Helpers ─────────────────────────────────────

/** v1.27.2 dept-grouped fixture mirroring the GeoForge3D layout. */
function makeAgents(): Record<string, AgentConfig> {
	return {
		backend: {
			agent_file: ".flywheel/agents/product/backend-executor.md",
			department: "product",
			match: { labels: ["backend", "api"] },
		},
		frontend: {
			agent_file: ".flywheel/agents/product/frontend-executor.md",
			department: "product",
			match: { labels: ["frontend", "ui", "design"] }, // multi-alias
		},
		operations: {
			agent_file: ".flywheel/agents/operations/operations-executor.md",
			department: "operations",
			match: { labels: ["operations", "ops"] },
		},
		general: {
			// top-level cross-dept catch-all (no department field; path has no subdir)
			agent_file: ".flywheel/agents/general-executor.md",
			match: { labels: ["chore", "tooling"] },
		},
	};
}

// ─── parsedDept helper ─────────────────────────────

describe("parsedDept", () => {
	it("returns null for top-level path (depth 0)", () => {
		expect(parsedDept(".flywheel/agents/general-executor.md")).toBeNull();
	});

	it("returns the dept name for dept-owned path (depth 1)", () => {
		expect(parsedDept(".flywheel/agents/product/backend-executor.md")).toBe(
			"product",
		);
	});

	it("throws on legacy .claude/agents/ paths", () => {
		expect(() => parsedDept(".claude/agents/backend-executor.md")).toThrow(
			InvalidAgentFilePathError,
		);
	});

	it("throws on nested subdirs (depth >= 2)", () => {
		expect(() =>
			parsedDept(".flywheel/agents/product/eng/backend-executor.md"),
		).toThrow(InvalidAgentFilePathError);
	});

	it("throws on bare prefix without filename", () => {
		expect(() => parsedDept(".flywheel/agents/")).toThrow(
			InvalidAgentFilePathError,
		);
	});
});

// ─── AgentDispatcher ─────────────────────────────

describe("AgentDispatcher", () => {
	// ─── Constructor ────────────────────────────

	it("throws when flywheelRepoRoot is empty", () => {
		expect(() => new AgentDispatcher({}, undefined, "")).toThrow(
			/flywheelRepoRoot is required/,
		);
	});

	// ─── Shipped-generic fallback ────────────────

	it("returns shipped-generic when agents map is empty", () => {
		const dispatcher = new AgentDispatcher({}, undefined, TEST_FLYWHEEL_ROOT);
		const result = dispatcher.dispatch({
			issueLabels: ["anything"],
			owningDept: undefined,
		});
		expect(result.agentName).toBe("generic");
		expect(result.matchMethod).toBe("shipped-generic");
		expect(result.agentFileRoot).toBe("flywheel");
		expect(result.agentConfig.agent_file).toBe("agents/generic-executor.md");
		expect(result.department).toBeUndefined();
	});

	it("returns shipped-generic when label matches nothing", () => {
		const dispatcher = new AgentDispatcher(
			makeAgents(),
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		const result = dispatcher.dispatch({
			issueLabels: ["nonexistent-label"],
			owningDept: undefined,
		});
		expect(result.matchMethod).toBe("shipped-generic");
		expect(result.agentFileRoot).toBe("flywheel");
	});

	// ─── Step 2a: own-dept scope ─────────────────

	it("matches dept-owned agent when owningDept set + label hits", () => {
		const dispatcher = new AgentDispatcher(
			makeAgents(),
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		const result = dispatcher.dispatch({
			issueLabels: ["backend"],
			owningDept: "product",
		});
		expect(result.agentName).toBe("backend");
		expect(result.matchMethod).toBe("label");
		expect(result.agentFileRoot).toBe("project");
		expect(result.department).toBe("product");
	});

	it("multi-alias label match (case-insensitive)", () => {
		const dispatcher = new AgentDispatcher(
			makeAgents(),
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		// frontend has match.labels: ["frontend", "ui", "design"]
		const result = dispatcher.dispatch({
			issueLabels: ["design"],
			owningDept: "product",
		});
		expect(result.agentName).toBe("frontend");
		expect(result.matchMethod).toBe("label");
	});

	it("normalized lowercase labels match mixed-case configured labels", () => {
		const agents: Record<string, AgentConfig> = {
			backend: {
				agent_file: ".flywheel/agents/product/backend-executor.md",
				department: "product",
				match: { labels: ["Backend", "API"] }, // mixed case in config
			},
		};
		const dispatcher = new AgentDispatcher(
			agents,
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		const result = dispatcher.dispatch({
			issueLabels: ["backend"], // caller already lowercased
			owningDept: "product",
		});
		expect(result.agentName).toBe("backend");
	});

	// ─── Step 2b: top-level catch-all ────────────

	it("falls through to top-level catch-all when own-dept has no match", () => {
		const dispatcher = new AgentDispatcher(
			makeAgents(),
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		// "chore" only matches general (top-level), not any product/ops agent
		const result = dispatcher.dispatch({
			issueLabels: ["chore"],
			owningDept: "product",
		});
		expect(result.agentName).toBe("general");
		expect(result.matchMethod).toBe("label");
		expect(result.department).toBeUndefined();
	});

	it("owningDept=undefined skips step 2a, matches top-level directly", () => {
		const dispatcher = new AgentDispatcher(
			makeAgents(),
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		const result = dispatcher.dispatch({
			issueLabels: ["chore"],
			owningDept: undefined,
		});
		expect(result.agentName).toBe("general");
	});

	it('owningDept="multiple" skips step 2a, goes to top-level', () => {
		const dispatcher = new AgentDispatcher(
			makeAgents(),
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		const result = dispatcher.dispatch({
			issueLabels: ["chore"],
			owningDept: "multiple",
		});
		expect(result.agentName).toBe("general");
	});

	// ─── default_agent fallback ──────────────────

	it("uses default_agent when no label match anywhere", () => {
		const dispatcher = new AgentDispatcher(
			makeAgents(),
			"backend",
			TEST_FLYWHEEL_ROOT,
		);
		const result = dispatcher.dispatch({
			issueLabels: ["unrelated"],
			owningDept: undefined,
		});
		expect(result.agentName).toBe("backend");
		expect(result.matchMethod).toBe("default");
		expect(result.department).toBe("product");
	});

	it("default_agent absent → falls to shipped-generic", () => {
		const dispatcher = new AgentDispatcher(
			makeAgents(),
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		const result = dispatcher.dispatch({
			issueLabels: ["unrelated"],
			owningDept: undefined,
		});
		expect(result.matchMethod).toBe("shipped-generic");
	});

	it("default_agent pointing at unknown name → falls to shipped-generic", () => {
		const dispatcher = new AgentDispatcher(
			makeAgents(),
			"ghost-agent",
			TEST_FLYWHEEL_ROOT,
		);
		const result = dispatcher.dispatch({
			issueLabels: [],
			owningDept: undefined,
		});
		expect(result.matchMethod).toBe("shipped-generic");
	});

	// ─── Backward compat (no dept hierarchy) ──────

	it("project with all flat agents (no dept subdirs) still dispatches", () => {
		// Every agent_file is .flywheel/agents/<file>.md (top-level)
		const flatAgents: Record<string, AgentConfig> = {
			alpha: {
				agent_file: ".flywheel/agents/alpha-executor.md",
				match: { labels: ["alpha"] },
			},
			beta: {
				agent_file: ".flywheel/agents/beta-executor.md",
				match: { labels: ["beta"] },
			},
		};
		const dispatcher = new AgentDispatcher(
			flatAgents,
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		// Even with owningDept set, step 2a finds nothing (no dept subdirs);
		// step 2b iterates top-level entries and matches.
		const result = dispatcher.dispatch({
			issueLabels: ["beta"],
			owningDept: "product",
		});
		expect(result.agentName).toBe("beta");
		expect(result.matchMethod).toBe("label");
		expect(result.department).toBeUndefined();
	});

	// ─── First-configured-agent wins on collision ─

	it("when multiple agents declare the same label, first-configured wins", () => {
		const agents: Record<string, AgentConfig> = {
			alpha: {
				agent_file: ".flywheel/agents/product/alpha-executor.md",
				department: "product",
				match: { labels: ["shared"] },
			},
			bravo: {
				agent_file: ".flywheel/agents/product/bravo-executor.md",
				department: "product",
				match: { labels: ["shared"] },
			},
		};
		const dispatcher = new AgentDispatcher(
			agents,
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		const result = dispatcher.dispatch({
			issueLabels: ["shared"],
			owningDept: "product",
		});
		expect(result.agentName).toBe("alpha");
	});

	// ─── dispatchByName (Lead override) ──────────

	it("dispatchByName picks a known agent", () => {
		const dispatcher = new AgentDispatcher(
			makeAgents(),
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		const result = dispatcher.dispatchByName("frontend");
		expect(result.agentName).toBe("frontend");
		expect(result.matchMethod).toBe("override");
		expect(result.agentFileRoot).toBe("project");
		expect(result.department).toBe("product");
	});

	it("dispatchByName('generic') returns shipped-generic", () => {
		const dispatcher = new AgentDispatcher(
			makeAgents(),
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		const result = dispatcher.dispatchByName("generic");
		expect(result.matchMethod).toBe("shipped-generic");
		expect(result.agentFileRoot).toBe("flywheel");
	});

	it("dispatchByName throws InvalidAgentNameError on unknown name", () => {
		const dispatcher = new AgentDispatcher(
			makeAgents(),
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		try {
			dispatcher.dispatchByName("does-not-exist");
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidAgentNameError);
			const e = err as InvalidAgentNameError;
			expect(e.providedName).toBe("does-not-exist");
			// available includes all configured names + "generic"
			expect(e.available).toContain("backend");
			expect(e.available).toContain("frontend");
			expect(e.available).toContain("operations");
			expect(e.available).toContain("general");
			expect(e.available).toContain("generic");
		}
	});

	// ─── AgentDispatchResult shape ────────────────

	it("returns correct AgentDispatchResult shape", () => {
		const agents = makeAgents();
		const dispatcher = new AgentDispatcher(
			agents,
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		const result = dispatcher.dispatch({
			issueLabels: ["api"],
			owningDept: "product",
		});
		expect(result).toEqual<AgentDispatchResult>({
			agentName: "backend",
			agentConfig: agents.backend!,
			matchMethod: "label",
			agentFileRoot: "project",
			department: "product",
		});
	});

	// ─── availableNames ───────────────────────────

	it("availableNames includes all configured + generic", () => {
		const dispatcher = new AgentDispatcher(
			makeAgents(),
			undefined,
			TEST_FLYWHEEL_ROOT,
		);
		const names = dispatcher.availableNames();
		expect(names).toEqual([
			"backend",
			"frontend",
			"operations",
			"general",
			"generic",
		]);
	});
});
