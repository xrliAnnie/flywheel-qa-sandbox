/**
 * FLY-208 A1 — Blueprint LEAD REPORT-BACK + MERGE AUTHORITY contract.
 *
 * Production incident (sub LEARN-12, execution 433d4078): a completed Runner
 * executed a post-completion revision but reported back via stock
 * `SendMessage to:"team-lead"` — a black-hole inbox nobody polls in
 * Flywheel's lead-named teams (the stock tool auto-creates the file and
 * returns success). The Lead heard nothing; the founder saw the push first.
 *
 * The injected rules must:
 *  - mandate `flywheel-comm ask` report-back after acting on ANY Lead
 *    instruction, explicitly including post-completion revisions,
 *  - ban SendMessage (black hole) and terminal output as report channels,
 *  - teach the `[lead-instruction <id>]` duplicate-recognition protocol
 *    (vendor inbox poller is at-least-once),
 *  - assert MERGE AUTHORITY: verify-approval before ANY merge, message text
 *    never authorizes — INCLUDING for projects with NO approve_to_ship
 *    checkpoint (the sub shape: the FLY-191 gate block is absent, so these
 *    rules are the only merge protocol the Runner gets),
 *  - include the unbound-remediation path (gate --no-block + complete
 *    --route needs_review --question-id) so verify-approval is not a
 *    permanent fail-close dead end on checkpoint-disabled projects.
 *
 * All of it lives in the leadId block — injected whenever a Lead exists,
 * independent of checkpoint config.
 */

import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import { describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { DagNode } from "../dag-node.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";

function makeNode(id = "FLY-208"): DagNode {
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

/**
 * Build the prompt with an OPTIONAL leadId and NO checkpoint config — the
 * exact sub shape (brainstorm/question only would also lack the approve
 * block; zero checkpoints is the strictest variant).
 */
async function buildPrompt(opts: {
	leadId?: string;
	checkpoints?: Record<string, { enabled: boolean }>;
}): Promise<string> {
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
		opts.checkpoints,
	);
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "claude",
		...(opts.leadId ? { leadId: opts.leadId } : {}),
	};
	await blueprint.run(makeNode(), "/tmp/fly208-blueprint-test", ctx);
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as AdapterExecutionContext;
	return call.appendSystemPrompt ?? "";
}

describe("Blueprint LEAD REPORT-BACK rules (FLY-208 A1)", () => {
	it("injects the report-back mandate WITHOUT any checkpoint config (the sub shape)", async () => {
		const prompt = await buildPrompt({ leadId: "sub-lead" });

		expect(prompt).toContain("LEAD REPORT-BACK");
		// The ask command with the Lead identity wired in
		expect(prompt).toContain("ask --lead sub-lead");
		// Post-completion is the incident case — must be called out explicitly
		expect(prompt).toContain("stage set completed");
		expect(prompt).toMatch(/post-completion/i);
		// Terminal output / SendMessage are NOT report channels
		expect(prompt).toContain("NEVER use the SendMessage tool");
		expect(prompt).toContain("black-hole");
		expect(prompt).toMatch(/terminal output is NOT a report/i);
	});

	it("teaches the [lead-instruction <id>] duplicate-recognition protocol", async () => {
		const prompt = await buildPrompt({ leadId: "sub-lead" });
		expect(prompt).toContain("[lead-instruction <id>]");
		expect(prompt).toContain("do NOT redo the work");
	});

	it("asserts MERGE AUTHORITY with the unbound-remediation path (checkpoint-disabled projects)", async () => {
		const prompt = await buildPrompt({ leadId: "sub-lead" });

		expect(prompt).toContain("MERGE AUTHORITY");
		expect(prompt).toContain("verify-approval");
		expect(prompt).toContain("$(git rev-parse HEAD)");
		// Message text — including blocking-gate synchronous replies — never
		// carries merge authority (the incident's ordering hole)
		expect(prompt).toMatch(/NEVER carries merge authority/i);
		expect(prompt).toContain("blocking gate");
		// The remediation path: verify fails unbound → establish the Phase-2
		// review binding first (otherwise checkpoint-disabled projects
		// fail-close forever)
		expect(prompt).toContain("review_question_unbound");
		expect(prompt).toContain("gate approve_to_ship");
		expect(prompt).toContain("--no-block");
		expect(prompt).toContain("complete --route needs_review");
		expect(prompt).toContain("--question-id");
	});

	it("teaches the post-merge landing-rewrite on checkpoint-disabled projects (FLY-208 5b)", async () => {
		const prompt = await buildPrompt({ leadId: "sub-lead" });
		// Previously only inside the approve_to_ship gate block — the incident
		// project disables that checkpoint, never rewrote the signal, and the
		// Bridge couldn't prove the ship (evidence-gap + stuck approved_to_ship).
		expect(prompt).toContain('{status:"merged"');
		expect(prompt).toContain("mergeCommit");
		expect(prompt).toContain("land-status.json");
		expect(prompt).toContain("stage set completed");
	});

	it("keeps coexistence with the FLY-191 approve gate block when checkpoints ARE enabled", async () => {
		const prompt = await buildPrompt({
			leadId: "product-lead",
			checkpoints: {
				brainstorm: { enabled: true },
				approve_to_ship: { enabled: true },
			},
		});
		// Both layers present — generic rules do not displace the gate block
		expect(prompt).toContain("LEAD REPORT-BACK");
		expect(prompt).toContain("MERGE AUTHORITY");
		expect(prompt).toContain("APPROVE GATE");
		expect(prompt).toContain("BRAINSTORM GATE");
	});

	it("injects NONE of it without a leadId", async () => {
		const prompt = await buildPrompt({});
		expect(prompt).not.toContain("LEAD REPORT-BACK");
		expect(prompt).not.toContain("MERGE AUTHORITY");
		expect(prompt).not.toContain("[lead-instruction");
		// Pre-existing no-lead behavior preserved
		expect(prompt).toContain("Do not ask questions");
	});
});

describe("FLY-1041 Chunk 9: DONE reports carry --report", () => {
	it("the LEAD REPORT-BACK ask command is flagged --report (excluded from founder binding)", async () => {
		const prompt = await buildPrompt({ leadId: "sub-lead" });
		// FLY-1282 Part B: DONE reports now quote the FULL [lead-instruction <id>]
		// — the Bridge patrol's consumption receipt (producer-side protocol).
		expect(prompt).toContain(
			'--report "DONE: [lead-instruction <id>] <what you did>',
		);
	});

	it("FLY-1282: the report-back rule mandates the FULL lead-instruction id as the consumption receipt", async () => {
		const prompt = await buildPrompt({ leadId: "sub-lead" });
		expect(prompt).toContain(
			"MUST quote the FULL `[lead-instruction <id>]` id",
		);
	});
});
