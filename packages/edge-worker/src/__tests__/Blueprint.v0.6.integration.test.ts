import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Blueprint } from "../Blueprint.js";
import { PreHydrator } from "../PreHydrator.js";
import { AgentDispatcher } from "../AgentDispatcher.js";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import type { DagNode } from "flywheel-dag-resolver";
import type { AgentConfig } from "flywheel-config";
import type {
	IAdapter,
	AdapterExecutionContext,
	AdapterExecutionResult,
} from "flywheel-core";
import type { GitResultChecker } from "../GitResultChecker.js";

// ─── Helpers ─────────────────────────────────────

function makeNode(id = "GEO-42"): DagNode {
	return { id, blockedBy: [] };
}

function makeContext(overrides: Partial<BlueprintContext> = {}): BlueprintContext {
	return { teamName: "eng", runnerName: "claude", ...overrides };
}

function makeHydrator(labels: string[] = []) {
	return new PreHydrator(async (id) => ({
		title: `Issue ${id} title`,
		description: `Description for ${id}`,
		labels,
	}));
}

function makeMockGitChecker() {
	return {
		assertCleanTree: vi.fn(async () => {}),
		captureBaseline: vi.fn(async () => "abc123"),
		check: vi.fn(async () => ({
			hasNewCommits: true,
			commitCount: 1,
			filesChanged: 3,
			commitMessages: ["feat: implement feature"],
		})),
	} as unknown as GitResultChecker;
}

function makeMockShell(): ShellRunner {
	return { execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })) };
}

function makeMockAdapter(): IAdapter {
	return {
		type: "mock",
		supportsStreaming: false,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn(async (_ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
			success: true,
			sessionId: "sess-uuid",
			tmuxWindow: "flywheel:@42",
			durationMs: 5000,
		})),
	};
}

// ─── Tests ───────────────────────────────────────

describe("Blueprint v0.6 — Agent Dispatch Integration", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-v06-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("injects agent + domain content into system prompt (additive)", async () => {
		// Create agent and domain files
		const agentDir = path.join(tmpDir, ".claude", "agents");
		const domainDir = path.join(tmpDir, ".claude", "domains");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(domainDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "backend.md"),
			"You are the backend engineer. Focus on API and database work.",
		);
		fs.writeFileSync(
			path.join(domainDir, "backend.md"),
			"Domain: backend services, PostgreSQL, REST APIs.",
		);

		const agents: Record<string, AgentConfig> = {
			backend: {
				agent_file: ".claude/agents/backend.md",
				domain_file: ".claude/domains/backend.md",
				match: { labels: ["backend"], keywords: ["api"] },
			},
		};
		const dispatcher = new AgentDispatcher(agents, undefined);

		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(["backend"]),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
			undefined, undefined, undefined, undefined, undefined, undefined,
			dispatcher,
		);

		await blueprint.run(makeNode(), tmpDir, makeContext());

		const runCall = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AdapterExecutionContext;
		const sysPrompt = runCall.appendSystemPrompt!;

		// Agent content prepended
		expect(sysPrompt).toContain("## Agent Role");
		expect(sysPrompt).toContain("backend engineer");
		expect(sysPrompt).toContain("## Domain Config");
		expect(sysPrompt).toContain("PostgreSQL");

		// Baseline always retained
		expect(sysPrompt).toContain("## Baseline Rules");
		expect(sysPrompt).toContain("Read the codebase");
		expect(sysPrompt).toContain("TDD");
		expect(sysPrompt).toContain("stop and wait");
	});

	it("agent without domain_file — only agent content injected", async () => {
		const agentDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "frontend.md"),
			"You are the frontend engineer.",
		);

		const agents: Record<string, AgentConfig> = {
			frontend: {
				agent_file: ".claude/agents/frontend.md",
				match: { labels: ["frontend"], keywords: ["ui"] },
			},
		};
		const dispatcher = new AgentDispatcher(agents, undefined);

		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(["frontend"]),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
			undefined, undefined, undefined, undefined, undefined, undefined,
			dispatcher,
		);

		await blueprint.run(makeNode(), tmpDir, makeContext());

		const runCall = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AdapterExecutionContext;
		const sysPrompt = runCall.appendSystemPrompt!;

		expect(sysPrompt).toContain("## Agent Role");
		expect(sysPrompt).toContain("frontend engineer");
		expect(sysPrompt).not.toContain("## Domain Config");
		// Baseline still present
		expect(sysPrompt).toContain("## Baseline Rules");
	});

	it("agent_file missing — fallback to generic prompt", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const agents: Record<string, AgentConfig> = {
			backend: {
				agent_file: ".claude/agents/nonexistent.md",
				match: { labels: ["backend"], keywords: ["api"] },
			},
		};
		const dispatcher = new AgentDispatcher(agents, undefined);

		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(["backend"]),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
			undefined, undefined, undefined, undefined, undefined, undefined,
			dispatcher,
		);

		await blueprint.run(makeNode(), tmpDir, makeContext());

		const runCall = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AdapterExecutionContext;
		const sysPrompt = runCall.appendSystemPrompt!;

		// Falls back to generic — no agent section
		expect(sysPrompt).not.toContain("## Agent Role");
		expect(sysPrompt).toContain("Read the codebase");

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Agent file not found"),
		);
		warnSpy.mockRestore();
	});

	it("no agent dispatch — generic prompt unchanged (regression)", async () => {
		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
		);

		await blueprint.run(makeNode(), tmpDir, makeContext());

		const runCall = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AdapterExecutionContext;
		const sysPrompt = runCall.appendSystemPrompt!;

		expect(sysPrompt).not.toContain("## Agent Role");
		expect(sysPrompt).not.toContain("## Baseline Rules");
		expect(sysPrompt).toContain("Read the codebase");
	});

	it("rejects path traversal in agent_file", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const agents: Record<string, AgentConfig> = {
			evil: {
				agent_file: "../../etc/passwd",
				match: { labels: ["evil"], keywords: [] },
			},
		};
		const dispatcher = new AgentDispatcher(agents, undefined);

		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(["evil"]),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
			undefined, undefined, undefined, undefined, undefined, undefined,
			dispatcher,
		);

		await blueprint.run(makeNode(), tmpDir, makeContext());

		const runCall = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AdapterExecutionContext;
		const sysPrompt = runCall.appendSystemPrompt!;

		// Path traversal rejected — generic prompt
		expect(sysPrompt).not.toContain("## Agent Role");
		expect(sysPrompt).toContain("Read the codebase");

		warnSpy.mockRestore();
	});

	it("symlink outside repo is rejected", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		// Create a file outside the repo
		const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
		fs.writeFileSync(path.join(outsideDir, "evil.md"), "HACKED");

		// Create symlink inside repo pointing outside
		const agentDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.symlinkSync(
			path.join(outsideDir, "evil.md"),
			path.join(agentDir, "backend.md"),
		);

		const agents: Record<string, AgentConfig> = {
			backend: {
				agent_file: ".claude/agents/backend.md",
				match: { labels: ["backend"], keywords: [] },
			},
		};
		const dispatcher = new AgentDispatcher(agents, undefined);

		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(["backend"]),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
			undefined, undefined, undefined, undefined, undefined, undefined,
			dispatcher,
		);

		await blueprint.run(makeNode(), tmpDir, makeContext());

		const runCall = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AdapterExecutionContext;
		const sysPrompt = runCall.appendSystemPrompt!;

		// Symlink outside repo rejected — generic prompt
		expect(sysPrompt).not.toContain("## Agent Role");
		expect(sysPrompt).not.toContain("HACKED");

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("symlinks outside repo"),
		);
		warnSpy.mockRestore();
		fs.rmSync(outsideDir, { recursive: true, force: true });
	});

	it("agent content is truncated at 40KB", async () => {
		const agentDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentDir, { recursive: true });
		// Write a 50KB file
		fs.writeFileSync(
			path.join(agentDir, "large.md"),
			"X".repeat(50_000),
		);

		const agents: Record<string, AgentConfig> = {
			large: {
				agent_file: ".claude/agents/large.md",
				match: { labels: ["large"], keywords: [] },
			},
		};
		const dispatcher = new AgentDispatcher(agents, undefined);

		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(["large"]),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
			undefined, undefined, undefined, undefined, undefined, undefined,
			dispatcher,
		);

		await blueprint.run(makeNode(), tmpDir, makeContext());

		const runCall = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AdapterExecutionContext;
		const sysPrompt = runCall.appendSystemPrompt!;

		// Agent content present but truncated
		expect(sysPrompt).toContain("## Agent Role");
		// The agent content section should be ~40KB, not 50KB
		const agentSection = sysPrompt.split("## Baseline Rules")[0]!;
		expect(agentSection.length).toBeLessThan(41_000);
	});
});
