import type { AgentConfig } from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import type { AgentDispatchResult, ClassifyFn } from "../AgentDispatcher.js";
import { AgentDispatcher } from "../AgentDispatcher.js";
import type { HydratedContext } from "../PreHydrator.js";

// ─── Helpers ─────────────────────────────────────

function makeAgents(): Record<string, AgentConfig> {
	return {
		backend: {
			agent_file: ".claude/agents/backend.md",
			domain_file: ".claude/domains/backend.md",
			match: {
				labels: ["backend", "api"],
				keywords: ["database", "server", "migration"],
			},
		},
		frontend: {
			agent_file: ".claude/agents/frontend.md",
			match: {
				labels: ["frontend", "ui"],
				keywords: ["react", "css", "component"],
			},
		},
		devops: {
			agent_file: ".claude/agents/devops.md",
			match: {
				labels: ["devops"],
				keywords: ["ci", "deploy", "docker"],
			},
		},
	};
}

function makeHydrated(
	overrides: Partial<HydratedContext> = {},
): HydratedContext {
	return {
		issueId: "GEO-42",
		issueTitle: "Add user API endpoint",
		issueDescription: "Create REST endpoint for user management",
		labels: [],
		projectId: "proj-1",
		issueIdentifier: "GEO-42",
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────

describe("AgentDispatcher", () => {
	// ─── Empty config ────────────────────────────────

	it("returns null when agents config is empty", async () => {
		const dispatcher = new AgentDispatcher({}, undefined);
		const result = await dispatcher.dispatch(makeHydrated());
		expect(result).toBeNull();
	});

	// ─── Label matching ──────────────────────────────

	it("matches by exact label", async () => {
		const dispatcher = new AgentDispatcher(makeAgents(), undefined);
		const result = await dispatcher.dispatch(
			makeHydrated({ labels: ["backend"] }),
		);
		expect(result).not.toBeNull();
		expect(result!.agentName).toBe("backend");
		expect(result!.matchMethod).toBe("label");
	});

	it("matches label case-insensitively", async () => {
		const dispatcher = new AgentDispatcher(makeAgents(), undefined);
		const result = await dispatcher.dispatch(
			makeHydrated({ labels: ["BACKEND"] }),
		);
		expect(result).not.toBeNull();
		expect(result!.agentName).toBe("backend");
		expect(result!.matchMethod).toBe("label");
	});

	it("matches when issue has multiple labels", async () => {
		const dispatcher = new AgentDispatcher(makeAgents(), undefined);
		const result = await dispatcher.dispatch(
			makeHydrated({ labels: ["bug", "frontend", "P0"] }),
		);
		expect(result).not.toBeNull();
		expect(result!.agentName).toBe("frontend");
	});

	it("returns first matching agent when multiple agents match labels", async () => {
		const agents = makeAgents();
		// Add "shared" label to both backend and frontend
		agents.backend.match.labels.push("shared");
		agents.frontend.match.labels.push("shared");
		const dispatcher = new AgentDispatcher(agents, undefined);
		const result = await dispatcher.dispatch(
			makeHydrated({ labels: ["shared"] }),
		);
		expect(result).not.toBeNull();
		// First match wins (object iteration order = insertion order)
		expect(result!.agentName).toBe("backend");
	});

	// ─── Haiku classification ────────────────────────

	it("falls back to classifyFn when no label match", async () => {
		const classifyFn: ClassifyFn = vi.fn(async () => "frontend");
		const dispatcher = new AgentDispatcher(makeAgents(), undefined, classifyFn);
		const result = await dispatcher.dispatch(makeHydrated({ labels: [] }));
		expect(result).not.toBeNull();
		expect(result!.agentName).toBe("frontend");
		expect(result!.matchMethod).toBe("haiku");
		expect(classifyFn).toHaveBeenCalled();
	});

	it("validates classifyFn output against agent name allowlist", async () => {
		const classifyFn: ClassifyFn = vi.fn(async () => "hacker-agent");
		const dispatcher = new AgentDispatcher(makeAgents(), "backend", classifyFn);
		const result = await dispatcher.dispatch(makeHydrated({ labels: [] }));
		// Invalid name → fallback to default_agent
		expect(result).not.toBeNull();
		expect(result!.agentName).toBe("backend");
		expect(result!.matchMethod).toBe("fallback");
	});

	it("handles classifyFn returning null", async () => {
		const classifyFn: ClassifyFn = vi.fn(async () => null);
		const dispatcher = new AgentDispatcher(makeAgents(), "devops", classifyFn);
		const result = await dispatcher.dispatch(makeHydrated({ labels: [] }));
		expect(result).not.toBeNull();
		expect(result!.agentName).toBe("devops");
		expect(result!.matchMethod).toBe("fallback");
	});

	it("handles classifyFn throwing error → fallback", async () => {
		const classifyFn: ClassifyFn = vi.fn(async () => {
			throw new Error("API rate limit");
		});
		const dispatcher = new AgentDispatcher(makeAgents(), "backend", classifyFn);
		const result = await dispatcher.dispatch(makeHydrated({ labels: [] }));
		expect(result).not.toBeNull();
		expect(result!.agentName).toBe("backend");
		expect(result!.matchMethod).toBe("fallback");
	});

	// ─── classifyFn not provided ─────────────────────

	it("skips classification when classifyFn is undefined", async () => {
		const dispatcher = new AgentDispatcher(makeAgents(), "backend");
		const result = await dispatcher.dispatch(
			makeHydrated({ labels: ["unrelated"] }),
		);
		expect(result).not.toBeNull();
		expect(result!.agentName).toBe("backend");
		expect(result!.matchMethod).toBe("fallback");
	});

	// ─── Default agent fallback ──────────────────────

	it("uses default_agent when no label or haiku match", async () => {
		const dispatcher = new AgentDispatcher(makeAgents(), "devops");
		const result = await dispatcher.dispatch(makeHydrated({ labels: [] }));
		expect(result).not.toBeNull();
		expect(result!.agentName).toBe("devops");
		expect(result!.agentConfig.agent_file).toBe(".claude/agents/devops.md");
		expect(result!.matchMethod).toBe("fallback");
	});

	// ─── No match at all ─────────────────────────────

	it("returns null when no match and no default_agent", async () => {
		const dispatcher = new AgentDispatcher(makeAgents(), undefined);
		const result = await dispatcher.dispatch(
			makeHydrated({ labels: ["unrelated"] }),
		);
		expect(result).toBeNull();
	});

	// ─── classifyFn receives correct arguments ───────

	it("passes correct args to classifyFn", async () => {
		const classifyFn: ClassifyFn = vi.fn(async () => "backend");
		const agents = makeAgents();
		const dispatcher = new AgentDispatcher(agents, undefined, classifyFn);

		await dispatcher.dispatch(
			makeHydrated({
				issueTitle: "Fix DB migration",
				issueDescription: "The database migration is broken",
			}),
		);

		expect(classifyFn).toHaveBeenCalledWith(
			"Fix DB migration",
			"The database migration is broken",
			["backend", "frontend", "devops"],
			{
				backend: ["database", "server", "migration"],
				frontend: ["react", "css", "component"],
				devops: ["ci", "deploy", "docker"],
			},
		);
	});

	// ─── AgentDispatchResult shape ────────────────────────

	it("returns correct AgentDispatchResult shape", async () => {
		const dispatcher = new AgentDispatcher(makeAgents(), undefined);
		const result = await dispatcher.dispatch(makeHydrated({ labels: ["api"] }));
		expect(result).toEqual<AgentDispatchResult>({
			agentName: "backend",
			agentConfig: makeAgents().backend,
			matchMethod: "label",
		});
	});
});
