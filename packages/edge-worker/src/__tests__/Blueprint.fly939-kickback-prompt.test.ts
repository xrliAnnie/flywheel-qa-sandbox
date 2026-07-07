/**
 * FLY-939 (G-B) — Blueprint three-stage QA kickback prompt contract.
 *
 * When the QA phase is woken with FEEDBACK on its OWN approve_to_ship gate (a
 * founder "changes requested" after a PASS), it must NOT edit code — it kicks the
 * feedback back so the alive, parked implement phase does the fixing. Two prompt
 * changes enforce this under keep-alive:
 *   1. a "5-fb" kickback step in the three-stage QA role prompt;
 *   2. the generic APPROVE GATE step f is OVERRIDDEN for the QA phase (the generic
 *      "push your fixes" would have QA fix the code itself, and its turn self-check
 *      cannot stop it since a passed QA is the TURN holder — Codex design R1 #1).
 * Keep-alive OFF and single-session prompts keep the generic step f byte-for-byte.
 */

import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";

function makeNode(id = "FLY-939"): DagNode {
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
			commitMessages: ["feat: x"],
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
		{ brainstorm: { enabled: true }, approve_to_ship: { enabled: true } },
	);
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "claude",
		leadId: "flywheel-eng-lead",
		...ctxOverrides,
	};
	await blueprint.run(makeNode(), "/tmp/fly939-blueprint-test", ctx);
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as AdapterExecutionContext;
	return call.appendSystemPrompt ?? "";
}

describe("FLY-939 QA kickback prompt — keep-alive ON", () => {
	afterEach(() => {
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = undefined;
	});

	it("QA phase carries the kickback contract (do NOT edit code; kickback verdict)", async () => {
		const p = await buildPrompt({ sessionRole: "qa", shareParentBranch: true });
		expect(p).toContain("woken with FEEDBACK");
		expect(p).toContain("do NOT edit code yourself");
		expect(p).toContain("founder feedback kickback:");
		expect(p).toContain("WAIT for the RE-TEST wake");
	});

	it("the generic APPROVE GATE step f is OVERRIDDEN for the QA phase (kickback, not 'push your fixes')", async () => {
		const p = await buildPrompt({ sessionRole: "qa", shareParentBranch: true });
		// The QA phase's effective step f routes feedback to the kickback, and does
		// NOT tell it to push its own fixes.
		expect(p).toContain("for THIS role (three-stage QA) FEEDBACK = KICKBACK");
		expect(p).not.toContain(
			"address it, push your fixes, then RE-REQUEST review",
		);
	});
});

describe("FLY-939 byte-compat sentinels", () => {
	afterEach(() => {
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = undefined;
	});

	it("keep-alive OFF QA phase: no kickback step, generic step f preserved", async () => {
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = "0";
		const p = await buildPrompt({ sessionRole: "qa", shareParentBranch: true });
		expect(p).not.toContain("founder feedback kickback:");
		expect(p).not.toContain("FEEDBACK = KICKBACK");
		// The generic step f is intact.
		expect(p).toContain("address it, push your fixes, then RE-REQUEST review");
	});

	it("single-session runner: generic step f preserved, no kickback contract", async () => {
		const p = await buildPrompt({});
		expect(p).not.toContain("founder feedback kickback:");
		expect(p).not.toContain("FEEDBACK = KICKBACK");
		expect(p).toContain("address it, push your fixes, then RE-REQUEST review");
	});
});
