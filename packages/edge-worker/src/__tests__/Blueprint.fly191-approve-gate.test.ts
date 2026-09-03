/**
 * FLY-191 Phase 2 — Blueprint approve_to_ship instruction contract.
 *
 * The injected gate instruction must teach the NON-BLOCKING flow:
 *  - `gate approve_to_ship ... --no-block` (park + idle, NOT a 48h freeze),
 *  - `complete --route needs_review` (awaiting_review label),
 *  - mandatory `verify-approval --pr-head $(git rev-parse HEAD)` before ship,
 *  - the wake message carries NO authority,
 *  - feedback → fix + re-request review (window resets),
 *  - and the OLD "This command BLOCKS until approval" language is GONE.
 * Other gates (brainstorm/question) stay blocking — untouched (§7).
 */

import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import { describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint, resolveStateDbPathForRunner } from "../Blueprint.js";
import type { DagNode } from "../dag-node.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";

function makeNode(id = "FLY-191"): DagNode {
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

async function buildPromptWithCheckpoints(
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
	await blueprint.run(makeNode(), "/tmp/fly191-blueprint-test", ctx);
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as AdapterExecutionContext;
	return call.appendSystemPrompt ?? "";
}

describe("Blueprint approve_to_ship instruction (FLY-191 Phase 2)", () => {
	it("teaches the non-blocking flow with mandatory verify-approval", async () => {
		const prompt = await buildPromptWithCheckpoints();

		// FLY-1314 material #8: gate creation is a hard CI authority boundary.
		// The generated runner contract must wait for required checks BEFORE it
		// invokes gate approve_to_ship, otherwise a normal pending CI run strands
		// the mandatory flow without a questionId.
		const approveSection = prompt.indexOf("APPROVE GATE (MANDATORY");
		const ciPrecondition = prompt.indexOf(
			"CI PRECONDITION (HARD)",
			approveSection,
		);
		const gateOpen = prompt.indexOf("gate approve_to_ship", approveSection);
		expect(ciPrecondition).toBeGreaterThanOrEqual(0);
		expect(prompt).toContain("gh pr checks <NUMBER>");
		expect(prompt).not.toContain("gh pr checks <NUMBER> --required");
		expect(prompt).not.toContain("gh pr checks <NUMBER> --watch");
		expect(prompt).toContain("Exit 8 means checks are still pending");
		expect(prompt).toContain("re-run the short probe on the next turn or wake");
		expect(prompt).toContain("do NOT open the approve gate");
		expect(ciPrecondition).toBeLessThan(gateOpen);
		expect(prompt).toContain(
			"repeat the CI PRECONDITION and APPROVE GATE steps a-b",
		);
		expect(prompt).toContain(
			"repeat the CI PRECONDITION and APPROVE GATE steps a-b (not steps a-b alone)",
		);

		// Non-blocking request + label + question binding
		expect(prompt).toContain("--no-block");
		expect(prompt).toContain("complete --route needs_review");
		expect(prompt).toContain("--question-id");
		expect(prompt).toContain("END YOUR TURN");

		// Ship authority = verify-approval, never the wake text
		expect(prompt).toContain("verify-approval");
		expect(prompt).toContain("$(git rev-parse HEAD)");
		expect(prompt).toContain("NO authority");
		expect(prompt).toContain('NEVER ship on a plain-text "approved"');

		// Feedback loop re-requests review
		expect(prompt).toContain("RE-REQUEST review");

		// Existing ship mechanics preserved
		expect(prompt).toContain(":cool:");
		expect(prompt).toContain("rewriting the landing signal");
	});

	it("removed the OLD blocking language from approve_to_ship — but kept it for brainstorm", async () => {
		const prompt = await buildPromptWithCheckpoints();

		// The approve gate must no longer freeze the runner
		expect(prompt).not.toContain("This command BLOCKS until approval");

		// Out of scope (§7): brainstorm gate still blocks
		expect(prompt).toContain("BRAINSTORM GATE");
		expect(prompt).toContain("This command BLOCKS until your Lead confirms");
	});

	// FLY-493: a no-transport (antigravity) Runner gets the pr_handoff finish
	// procedure INSTEAD of the wake-dependent approve gate.
	it("FLY-493: runnerTransportMode=none → pr_handoff finish, NOT the approve/wake gate", async () => {
		const prompt = await buildPromptWithCheckpoints({
			runnerTransportMode: "none",
		});

		// pr_handoff finish procedure
		expect(prompt).toContain("complete --route pr_handoff");
		expect(prompt).toContain("no-transport backend");
		expect(prompt).toContain('status:"ready_to_merge"');
		// FLY-827: the pr_handoff finish surfaces the Codex code-review status so the
		// founder isn't blind when shipping a no-transport PR by hand.
		expect(prompt).toContain("Codex code review is REQUIRED");
		expect(prompt).toContain(
			"the founder reviews Codex status and ships the PR",
		);

		// MUST NOT inject the approve-gate CHECKPOINT block (the "gate
		// approve_to_ship" / verify-approval phrases still appear in the
		// always-on LEAD REPORT-BACK block, so we target checkpoint-only text).
		expect(prompt).not.toContain("APPROVE GATE (MANDATORY");
		expect(prompt).not.toContain("END YOUR TURN and wait");
		expect(prompt).not.toContain("On VERIFIED approval, SHIP the PR");
	});

	it("FLY-493: claude (no runnerTransportMode) still gets the approve gate (regression)", async () => {
		const prompt = await buildPromptWithCheckpoints();
		expect(prompt).toContain("APPROVE GATE (MANDATORY");
		expect(prompt).toContain("On VERIFIED approval, SHIP the PR");
		expect(prompt).not.toContain("complete --route pr_handoff");
	});

	it("FLY-248: removed the timer self-merge fallback — Runner never self-merges, even after approval", async () => {
		const prompt = await buildPromptWithCheckpoints();

		// The 5-minute timeout self-merge fallback is GONE (the incident root cause):
		// after a verified approval the Runner used to force-merge if the deploy
		// workflow was slow. That direct `gh pr merge` path is the FLY-248 red line.
		expect(prompt).not.toContain(
			"If no deploy workflow merges within 5 minutes",
		);
		expect(prompt).not.toContain(
			"merge directly: `gh pr merge <NUMBER> --squash --delete-branch`",
		);

		// Replacement: the :cool: deploy workflow is the only merge path; a stalled
		// attempt reports to the Lead and preserves the approved checkpoint.
		expect(prompt).toContain("ONLY merge path");
		expect(prompt).toContain("a Runner must never self-merge");
		expect(prompt).toContain("NEVER run `complete --route blocked`");
		expect(prompt).toContain("SHIP-STALLED");
		expect(prompt).toContain("The session remains approved_to_ship");
	});
});

describe("resolveStateDbPathForRunner (FLY-191 — QA-caught wiring gap)", () => {
	it("propagates the Bridge's TEAMLEAD_DB_PATH so verify-approval reads the same StateStore", () => {
		expect(
			resolveStateDbPathForRunner({
				TEAMLEAD_DB_PATH: "/tmp/flywheel-test-slot-2/teamlead.db",
			} as NodeJS.ProcessEnv),
		).toBe("/tmp/flywheel-test-slot-2/teamlead.db");
	});

	it("explicit FLYWHEEL_STATE_DB_PATH wins over TEAMLEAD_DB_PATH", () => {
		expect(
			resolveStateDbPathForRunner({
				FLYWHEEL_STATE_DB_PATH: "/custom/state.db",
				TEAMLEAD_DB_PATH: "/tmp/other.db",
			} as NodeJS.ProcessEnv),
		).toBe("/custom/state.db");
	});

	it("unset → undefined (prod default-path behavior unchanged)", () => {
		expect(resolveStateDbPathForRunner({} as NodeJS.ProcessEnv)).toBe(
			undefined,
		);
	});

	it(":memory: (unit-test stores) is never propagated — no file to read", () => {
		expect(
			resolveStateDbPathForRunner({
				TEAMLEAD_DB_PATH: ":memory:",
			} as NodeJS.ProcessEnv),
		).toBe(undefined);
	});

	it("Blueprint passes stateDbPath into the adapter execution context", async () => {
		const prev = process.env.TEAMLEAD_DB_PATH;
		process.env.TEAMLEAD_DB_PATH = "/tmp/fly191-statedb-test/teamlead.db";
		try {
			const adapter = makeMockAdapter();
			const blueprint = new Blueprint(
				makeHydrator(),
				makeMockGitChecker(),
				() => adapter,
				makeMockShell(),
			);
			await blueprint.run(makeNode(), "/tmp/fly191-blueprint-test", {
				teamName: "eng",
				runnerName: "claude",
			});
			const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
				.calls[0]![0] as AdapterExecutionContext;
			expect(call.stateDbPath).toBe("/tmp/fly191-statedb-test/teamlead.db");
		} finally {
			if (prev === undefined) delete process.env.TEAMLEAD_DB_PATH;
			else process.env.TEAMLEAD_DB_PATH = prev;
		}
	});
});
