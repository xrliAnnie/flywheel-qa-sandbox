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
import type { DagNode } from "flywheel-dag-resolver";
import { describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint, resolveStateDbPathForRunner } from "../Blueprint.js";
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

async function buildPromptWithCheckpoints(): Promise<string> {
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
	};
	await blueprint.run(makeNode(), "/tmp/fly191-blueprint-test", ctx);
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as AdapterExecutionContext;
	return call.appendSystemPrompt ?? "";
}

describe("Blueprint approve_to_ship instruction (FLY-191 Phase 2)", () => {
	it("teaches the non-blocking flow with mandatory verify-approval", async () => {
		const prompt = await buildPromptWithCheckpoints();

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
