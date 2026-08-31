import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "flywheel-config";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDispatcher } from "../AgentDispatcher.js";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import {
	resolvedTestAgent,
	testAgentFallbacks,
} from "./agent-dispatch-fixtures.js";

// ─── Helpers ─────────────────────────────────────

function makeNode(id = "GEO-42"): DagNode {
	return { id, blockedBy: [] };
}

function makeContext(
	overrides: Partial<BlueprintContext> = {},
): BlueprintContext {
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
		execute: vi.fn(
			async (
				_ctx: AdapterExecutionContext,
			): Promise<AdapterExecutionResult> => ({
				success: true,
				sessionId: "sess-uuid",
				tmuxWindow: "flywheel:@42",
				durationMs: 5000,
			}),
		),
	};
}

/**
 * FLY-137 v1.27.2: build a Blueprint wired with the v1.27.2 contract.
 * `flywheelRepoRoot` defaults to a sentinel tmpdir; tests that need it (shipped-generic)
 * write the sentinel file there.
 */
function makeBlueprint(opts: {
	dispatcher?: AgentDispatcher;
	flywheelRepoRoot?: string;
	labels?: string[];
}) {
	return {
		adapter: makeMockAdapter(),
		build(adapter: IAdapter) {
			return new Blueprint(
				makeHydrator(opts.labels ?? []),
				makeMockGitChecker(),
				() => adapter,
				makeMockShell(),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				opts.dispatcher,
				undefined, // checkpointConfig
				opts.flywheelRepoRoot, // FLY-137 v1.27.2
			);
		},
	};
}

const FAKE_REPO_ROOT = "/tmp/flywheel-v06-test-repo-root";

// ─── Tests ───────────────────────────────────────

describe("Blueprint v0.6 — Agent Dispatch Integration (FLY-137 v1.27.2 dept-aware)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-v06-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("injects agent + domain content into system prompt (additive)", async () => {
		// FLY-137 v1.27.2: dept-grouped paths under .flywheel/agents/<dept>/
		const agentDir = path.join(tmpDir, ".flywheel", "agents", "product");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "backend-executor.md"),
			"You are the backend engineer. Focus on API and database work.",
		);
		const domainDir = path.join(tmpDir, ".claude", "domains");
		fs.mkdirSync(domainDir, { recursive: true });
		fs.writeFileSync(
			path.join(domainDir, "backend.md"),
			"Domain: backend services, PostgreSQL, REST APIs.",
		);

		const agents: Record<string, AgentConfig> = {
			backend: resolvedTestAgent({
				nodeName: "backend",
				labels: ["backend"],
				departments: ["product"],
				projectRoot: tmpDir,
				relativeFile: "product/backend-executor.md",
				domainFile: ".claude/domains/backend.md",
			}),
		};
		const dispatcher = new AgentDispatcher(
			agents,
			undefined,
			testAgentFallbacks(FAKE_REPO_ROOT),
		);

		const factory = makeBlueprint({
			dispatcher,
			flywheelRepoRoot: FAKE_REPO_ROOT,
			labels: ["backend"],
		});
		const blueprint = factory.build(factory.adapter);

		await blueprint.run(
			makeNode(),
			tmpDir,
			makeContext({
				issueLabels: ["backend"],
				owningDept: "product",
			}),
		);

		const runCall = (factory.adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		const sysPrompt = runCall.appendSystemPrompt!;

		expect(sysPrompt).toContain("## Agent Role");
		expect(sysPrompt).toContain("backend engineer");
		expect(sysPrompt).toContain("## Domain Config");
		expect(sysPrompt).toContain("PostgreSQL");
		expect(sysPrompt).toContain("## Baseline Rules");
		expect(sysPrompt).toContain("Read the codebase");
		expect(sysPrompt).toContain("TDD");
	});

	it("agent without domain_file — only agent content injected", async () => {
		const agentDir = path.join(tmpDir, ".flywheel", "agents", "product");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "frontend-executor.md"),
			"You are the frontend engineer.",
		);

		const agents: Record<string, AgentConfig> = {
			frontend: resolvedTestAgent({
				nodeName: "frontend",
				labels: ["frontend"],
				departments: ["product"],
				projectRoot: tmpDir,
				relativeFile: "product/frontend-executor.md",
			}),
		};
		const dispatcher = new AgentDispatcher(
			agents,
			undefined,
			testAgentFallbacks(FAKE_REPO_ROOT),
		);

		const factory = makeBlueprint({
			dispatcher,
			flywheelRepoRoot: FAKE_REPO_ROOT,
			labels: ["frontend"],
		});
		const blueprint = factory.build(factory.adapter);

		await blueprint.run(
			makeNode(),
			tmpDir,
			makeContext({
				issueLabels: ["frontend"],
				owningDept: "product",
			}),
		);

		const runCall = (factory.adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		const sysPrompt = runCall.appendSystemPrompt!;

		expect(sysPrompt).toContain("## Agent Role");
		expect(sysPrompt).toContain("frontend engineer");
		expect(sysPrompt).not.toContain("## Domain Config");
		expect(sysPrompt).toContain("## Baseline Rules");
	});

	it("FLY-137 v1.27.2 (Codex Track A #1): zero-config project → shipped-generic loads from Flywheel repo root", async () => {
		// Set up a SEPARATE fake Flywheel repo root with the shipped generic-executor.md
		const fakeRepoRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "fake-flywheel-repo-"),
		);
		try {
			const shippedAgentsDir = path.join(
				fakeRepoRoot,
				".flywheel",
				"agents",
				"nodes",
			);
			fs.mkdirSync(shippedAgentsDir, { recursive: true });
			fs.writeFileSync(
				path.join(shippedAgentsDir, "general.md"),
				"SHIPPED GENERIC CONTENT — vendor-neutral catch-all fallback.",
			);

			// Empty agents map → dispatcher returns shipped-generic
			const dispatcher = new AgentDispatcher(
				{},
				undefined,
				testAgentFallbacks(fakeRepoRoot),
			);

			const factory = makeBlueprint({
				dispatcher,
				flywheelRepoRoot: fakeRepoRoot,
				labels: ["anything"],
			});
			const blueprint = factory.build(factory.adapter);

			await blueprint.run(
				makeNode(),
				tmpDir,
				makeContext({
					issueLabels: ["anything"],
					owningDept: undefined,
				}),
			);

			const runCall = (factory.adapter.execute as ReturnType<typeof vi.fn>).mock
				.calls[0]![0] as AdapterExecutionContext;
			const sysPrompt = runCall.appendSystemPrompt!;

			// Registered generic content MUST be injected from its resolved root.
			expect(sysPrompt).toContain("## Agent Role");
			expect(sysPrompt).toContain("SHIPPED GENERIC CONTENT");
			expect(sysPrompt).toContain("## Baseline Rules");
		} finally {
			fs.rmSync(fakeRepoRoot, { recursive: true, force: true });
		}
	});

	it("resolved agent file missing — fallback to generic prompt", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const agents: Record<string, AgentConfig> = {
			backend: resolvedTestAgent({
				nodeName: "backend",
				labels: ["backend"],
				departments: ["product"],
				projectRoot: tmpDir,
				relativeFile: "product/nonexistent-executor.md",
			}),
		};
		const dispatcher = new AgentDispatcher(
			agents,
			undefined,
			testAgentFallbacks(FAKE_REPO_ROOT),
		);

		const factory = makeBlueprint({
			dispatcher,
			flywheelRepoRoot: FAKE_REPO_ROOT,
			labels: ["backend"],
		});
		const blueprint = factory.build(factory.adapter);

		await blueprint.run(
			makeNode(),
			tmpDir,
			makeContext({
				issueLabels: ["backend"],
				owningDept: "product",
			}),
		);

		const runCall = (factory.adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		const sysPrompt = runCall.appendSystemPrompt!;

		expect(sysPrompt).not.toContain("## Agent Role");
		expect(sysPrompt).toContain("Read the codebase");
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Agent file not found"),
		);
		warnSpy.mockRestore();
	});

	it("no agent dispatcher — generic prompt unchanged (regression, no dispatcher = no agent block)", async () => {
		const factory = makeBlueprint({ flywheelRepoRoot: FAKE_REPO_ROOT });
		const blueprint = factory.build(factory.adapter);

		await blueprint.run(makeNode(), tmpDir, makeContext());

		const runCall = (factory.adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		const sysPrompt = runCall.appendSystemPrompt!;

		expect(sysPrompt).not.toContain("## Agent Role");
		expect(sysPrompt).toContain("Read the codebase");
	});

	it("symlink outside repo is rejected (project-side .flywheel/agents/<dept>/<file> path)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		// Create a file outside the repo
		const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
		fs.writeFileSync(path.join(outsideDir, "evil.md"), "HACKED");

		// Create symlink inside project's .flywheel/agents/product/ pointing outside
		const agentDir = path.join(tmpDir, ".flywheel", "agents", "product");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.symlinkSync(
			path.join(outsideDir, "evil.md"),
			path.join(agentDir, "backend-executor.md"),
		);

		const agents: Record<string, AgentConfig> = {
			backend: resolvedTestAgent({
				nodeName: "backend",
				labels: ["backend"],
				departments: ["product"],
				projectRoot: tmpDir,
				relativeFile: "product/backend-executor.md",
			}),
		};
		const dispatcher = new AgentDispatcher(
			agents,
			undefined,
			testAgentFallbacks(FAKE_REPO_ROOT),
		);

		const factory = makeBlueprint({
			dispatcher,
			flywheelRepoRoot: FAKE_REPO_ROOT,
			labels: ["backend"],
		});
		const blueprint = factory.build(factory.adapter);

		await blueprint.run(
			makeNode(),
			tmpDir,
			makeContext({
				issueLabels: ["backend"],
				owningDept: "product",
			}),
		);

		const runCall = (factory.adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		const sysPrompt = runCall.appendSystemPrompt!;

		expect(sysPrompt).not.toContain("## Agent Role");
		expect(sysPrompt).not.toContain("HACKED");
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("symlinks outside repo"),
		);
		warnSpy.mockRestore();
		fs.rmSync(outsideDir, { recursive: true, force: true });
	});

	it("agent content is truncated at 40KB", async () => {
		const agentDir = path.join(tmpDir, ".flywheel", "agents", "product");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "large-executor.md"),
			"X".repeat(50_000),
		);

		const agents: Record<string, AgentConfig> = {
			large: resolvedTestAgent({
				nodeName: "large",
				labels: ["large"],
				departments: ["product"],
				projectRoot: tmpDir,
				relativeFile: "product/large-executor.md",
			}),
		};
		const dispatcher = new AgentDispatcher(
			agents,
			undefined,
			testAgentFallbacks(FAKE_REPO_ROOT),
		);

		const factory = makeBlueprint({
			dispatcher,
			flywheelRepoRoot: FAKE_REPO_ROOT,
			labels: ["large"],
		});
		const blueprint = factory.build(factory.adapter);

		await blueprint.run(
			makeNode(),
			tmpDir,
			makeContext({
				issueLabels: ["large"],
				owningDept: "product",
			}),
		);

		const runCall = (factory.adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		const sysPrompt = runCall.appendSystemPrompt!;

		expect(sysPrompt).toContain("## Agent Role");
		const agentSection = sysPrompt.split("## Baseline Rules")[0]!;
		expect(agentSection.length).toBeLessThan(41_000);
	});
});
