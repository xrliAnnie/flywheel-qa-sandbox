/**
 * FLY-579 P0-G3 — Blueprint QA-mode prompt contract.
 *
 * An Auto-QA runner (qaContext present) does INDEPENDENT verification of an
 * already-implemented + code-reviewed change. Its prompt MUST:
 *  - drop the implement/branch/push/PR contract,
 *  - drop the brainstorm gate and the approve_to_ship / ship contract,
 *  - tell it the pinned reviewed commit + that the worktree is read-only,
 *  - and route its verdict through `qa-result` then `complete --route no_code`.
 * A normal (non-QA) runner is byte-compatible — it still gets the implement
 * steps + brainstorm + approve gate.
 */

import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { describe, expect, it, vi } from "vitest";
import type { BlueprintContext, QaContext, ShellRunner } from "../Blueprint.js";
import { Blueprint, buildQaModeSystemPromptLines } from "../Blueprint.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";

function makeNode(id = "FLY-579"): DagNode {
	return { id, blockedBy: [] };
}

function makeHydrator() {
	return new PreHydrator(async (id) => ({
		title: `Issue ${id} title`,
		description: `Description for ${id}`,
		labels: [],
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

async function buildPrompt(
	ctxOverrides: Partial<BlueprintContext> = {},
): Promise<string> {
	const adapter = makeMockAdapter();
	const blueprint = new Blueprint(
		makeHydrator(),
		makeMockGitChecker(),
		() => adapter,
		makeMockShell(),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			brainstorm: { enabled: true },
			approve_to_ship: { enabled: true },
		},
	);
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "claude",
		leadId: "product-lead",
		...ctxOverrides,
	};
	await blueprint.run(makeNode(), "/tmp/fly579-blueprint-test", ctx);
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as AdapterExecutionContext;
	return call.appendSystemPrompt ?? "";
}

const QA_CTX: QaContext = {
	parentExecutionId: "parent-exec-abc",
	prHeadSha: "deadbeefcafe1234",
	prNumber: 4242,
	branch: "flywheel-FLY-579",
};

describe("Blueprint QA-mode prompt (FLY-579 P0-G3)", () => {
	it("QA runner: independent-verification skeleton + structured verdict", async () => {
		const prompt = await buildPrompt({ sessionRole: "qa", qaContext: QA_CTX });

		expect(prompt).toContain("INDEPENDENT QA Runner");
		expect(prompt).toContain("qa-developer-separation");
		// pinned reviewed commit + read-only worktree
		expect(prompt).toContain("deadbeefcafe1234");
		expect(prompt).toContain("read-only");
		expect(prompt).toContain("PR #4242");
		// structured verdict gate
		expect(prompt).toContain("qa-result");
		expect(prompt).toContain("--target-exec parent-exec-abc");
		expect(prompt).toContain("complete --route no_code");
		// real-machine E2E discipline
		expect(prompt).toContain("Claude-in-Chrome");
	});

	it("QA runner: NO implement / branch / push / PR contract", async () => {
		const prompt = await buildPrompt({ sessionRole: "qa", qaContext: QA_CTX });

		expect(prompt).not.toContain("Create a feature branch");
		expect(prompt).not.toContain("Push the branch and create a GitHub PR");
		expect(prompt).not.toContain(
			"Implement the requested changes following TDD",
		);
	});

	it("QA runner: NO brainstorm gate and NO approve/ship gate", async () => {
		const prompt = await buildPrompt({ sessionRole: "qa", qaContext: QA_CTX });

		// Target the checkpoint-block text. (The phrase "gate approve_to_ship"
		// also appears in the always-on LEAD REPORT-BACK / MERGE AUTHORITY block,
		// which is a vacuous safety rule for a QA runner that never merges — same
		// overlap the FLY-191 approve-gate test documents.)
		expect(prompt).not.toContain("BRAINSTORM GATE");
		expect(prompt).not.toContain("APPROVE GATE (MANDATORY");
		expect(prompt).not.toContain("On VERIFIED approval, SHIP the PR");
		expect(prompt).not.toContain("END YOUR TURN and wait");
	});

	it("regression: a normal (non-QA) runner is byte-compatible", async () => {
		const prompt = await buildPrompt(); // no qaContext

		// implement contract intact
		expect(prompt).toContain("Create a feature branch, commit your changes.");
		expect(prompt).toContain("Push the branch and create a GitHub PR.");
		// gates intact
		expect(prompt).toContain("BRAINSTORM GATE");
		expect(prompt).toContain("APPROVE GATE (MANDATORY");
		// and it is NOT a QA prompt
		expect(prompt).not.toContain("INDEPENDENT QA Runner");
		expect(prompt).not.toContain("qa-result");
	});
});

describe("buildQaModeSystemPromptLines (unit)", () => {
	it("contains the verdict gate and omits the implement/ship contract", () => {
		const lines = buildQaModeSystemPromptLines(
			QA_CTX,
			"FLY-579",
			"/path/to/flywheel-comm/dist/index.js",
			"qa-exec-1",
		);
		const text = lines.join("\n");

		expect(text).toContain("INDEPENDENT QA Runner");
		expect(text).toContain(
			"qa-result --exec-id qa-exec-1 --target-exec parent-exec-abc",
		);
		expect(text).toContain("complete --route no_code");
		expect(text).toContain("deadbeefcafe1234");

		expect(text).not.toContain("Create a feature branch");
		expect(text).not.toContain("APPROVE GATE");
		expect(text).not.toContain("BRAINSTORM GATE");
	});

	it("omits the optional PR/branch notes when not provided", () => {
		const lines = buildQaModeSystemPromptLines(
			{ parentExecutionId: "p", prHeadSha: "sha123" },
			"FLY-1",
			"/cli.js",
			"e1",
		);
		const text = lines.join("\n");
		expect(text).not.toContain("PR #");
		expect(text).not.toContain("on branch");
		expect(text).toContain("sha123");
	});
});
