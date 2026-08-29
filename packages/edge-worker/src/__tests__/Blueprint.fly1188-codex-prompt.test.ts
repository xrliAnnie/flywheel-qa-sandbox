/**
 * FLY-1188 M2 — codex-flavored prompt assembly (plan §4.2).
 *
 * A codex-tmux runner's Blueprint-generated system prompt must carry NO
 * Claude-only tooling references (banned tokens: "SendMessage",
 * "Claude-in-Chrome", "/compact", the Skill-tool onboard step) — each is
 * either dropped or replaced by a capability-honest codex equivalent. Role
 * files stay verbatim but get a fixed ENVIRONMENT TRANSLATION header. The
 * claude path stays byte-compatible (guarded here by a full-prompt snapshot
 * with the machine-dependent CLI path normalized).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint, buildQaModeSystemPromptLines } from "../Blueprint.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import type { WorktreeManager } from "../WorktreeManager.js";

const BANNED_IN_CODEX_PROMPT = [
	"SendMessage",
	"Claude-in-Chrome",
	"/compact",
	// Codex M2 review LOW-1: the codex adapter has no PostToolUse hook.
	"PostToolUse",
	// FLY-1188 M4 (Codex R2 HIGH): a resident /goal runner is never auto-resumed
	// on a gate — the codex gate branches poll `check`, they never promise resume.
	"resumed automatically",
];

function makeNode(id = "FLY-1188"): DagNode {
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
			filesChanged: 1,
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
				durationMs: 100,
			}),
		),
	};
}
function makeRealWorktree(): string {
	const p = join(
		tmpdir(),
		`fly1188-m2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(p, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: p });
	return p;
}
function makeWtManager(worktreePath: string) {
	return {
		expectedWorktree: vi.fn(() => ({
			path: worktreePath,
			branch: "flywheel-FLY-1188",
		})),
		isRegistered: vi.fn(async () => false),
		removeIfExists: vi.fn(async () => true),
		create: vi.fn(async () => ({
			projectName: "proj",
			issueId: "FLY-1188",
			worktreePath,
			branch: "flywheel-FLY-1188",
			mainRepoPath: "/tmp/fly1188-main",
		})),
	} as unknown as WorktreeManager;
}

const CHECKPOINTS = {
	brainstorm: { enabled: true },
	question: { enabled: true },
	approve_to_ship: { enabled: true },
};

const cleanups: string[] = [];
afterEach(() => {
	while (cleanups.length) {
		rmSync(cleanups.pop() as string, { recursive: true, force: true });
	}
});

async function buildPrompt(opts: {
	ctxOverrides?: Partial<BlueprintContext>;
	worktreePath?: string;
}): Promise<string> {
	const adapter = makeMockAdapter();
	const blueprint = new Blueprint(
		makeHydrator(),
		makeMockGitChecker(),
		() => adapter,
		makeMockShell(),
		opts.worktreePath ? makeWtManager(opts.worktreePath) : undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		CHECKPOINTS,
	);
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "runner",
		leadId: "flywheel-eng-lead",
		projectName: "proj",
		...opts.ctxOverrides,
	};
	await blueprint.run(makeNode(), "/tmp/fly1188-m2-project", ctx);
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]?.[0] as AdapterExecutionContext | undefined;
	return call?.appendSystemPrompt ?? "";
}

async function buildCodexPrompt(
	ctxOverrides: Partial<BlueprintContext> = {},
): Promise<string> {
	const wt = makeRealWorktree();
	cleanups.push(wt);
	return buildPrompt({
		worktreePath: wt,
		ctxOverrides: { runnerBackend: "codex-tmux", ...ctxOverrides },
	});
}

describe("FLY-1188 M2 — codex prompt has ZERO Claude-only tooling references", () => {
	it("baseline codex prompt: banned tokens absent, codex equivalents present", async () => {
		const prompt = await buildCodexPrompt();
		expect(prompt.length).toBeGreaterThan(0);
		for (const banned of BANNED_IN_CODEX_PROMPT) {
			expect(prompt).not.toContain(banned);
		}
		// onboard: manual same-shape, not the Skill tool
		expect(prompt).toContain("Onboard MANUALLY (you have no Skill tool)");
		expect(prompt).not.toContain("Attempt the `onboard` skill");
		// report channel honesty
		expect(prompt).toContain("NO teammate-messaging tool");
	});

	it("codex three-stage implement phase (keep-alive): park wording carries no banned tokens", async () => {
		const prompt = await buildCodexPrompt({
			sessionRole: "implement",
			shareParentBranch: true,
			startPoint: "abc123", // matches the mock gitChecker baseline (takeover guard)
		});
		expect(prompt).toContain("Three-stage keep-alive (implement phase)");
		for (const banned of BANNED_IN_CODEX_PROMPT) {
			expect(prompt).not.toContain(banned);
		}
		expect(prompt).toContain("park --exec-id");
		expect(prompt).toContain("phase controller stays alive");
		expect(prompt).toContain("[phase-wake <id>]");
		expect(prompt).toContain("message is context; TURN is authority");
		expect(prompt).toContain("do not repeat external or worktree side effects");
		expect(prompt).not.toContain(
			"make your final message a short status note and END YOUR TURN",
		);
	});

	it("codex three-stage design phase parks after its exact completion route", async () => {
		const prompt = await buildCodexPrompt({
			sessionRole: "design",
			shareParentBranch: true,
			startPoint: "abc123",
		});
		const complete = prompt.indexOf("complete --route phase_design_complete");
		const park = prompt.indexOf("park --exec-id", complete);
		expect(complete).toBeGreaterThanOrEqual(0);
		expect(park).toBeGreaterThan(complete);
		expect(prompt).toContain("phase controller stays alive");
		expect(prompt).toContain("[phase-wake <id>]");
		expect(prompt).not.toContain(
			"make your final message a short handoff note and END YOUR TURN",
		);
	});

	it("codex three-stage QA phase parks after verdict and supports same-session re-test", async () => {
		const prompt = await buildCodexPrompt({
			sessionRole: "qa",
			shareParentBranch: true,
			startPoint: "abc123",
		});
		expect(prompt).toContain("QA phase of a three-stage pipeline");
		for (const banned of BANNED_IN_CODEX_PROMPT) {
			expect(prompt).not.toContain(banned);
		}
		const failVerdict = prompt.indexOf("--status fail");
		const park = prompt.indexOf("park --exec-id", failVerdict);
		expect(failVerdict).toBeGreaterThanOrEqual(0);
		expect(park).toBeGreaterThan(failVerdict);
		expect(prompt).toContain("RE-TEST wake");
		expect(prompt).toContain("turn --exec-id");
		expect(prompt).toContain("[phase-wake <id>]");
		expect(prompt).toContain("message is context; TURN is authority");
		expect(prompt).toContain("5-fb.");
		expect(prompt).toContain("FEEDBACK = KICKBACK");
	});
});

describe("FLY-1188 M2 — auto-QA prompt lines (buildQaModeSystemPromptLines)", () => {
	const qaContext = {
		parentExecutionId: "parent-exec",
		prHeadSha: "deadbeef",
		prNumber: 42,
		branch: "feat/x",
	};

	it("codex variant: capability-honest, no banned tokens, coverage-gap reporting", () => {
		const lines = buildQaModeSystemPromptLines(
			qaContext,
			"FLY-1188",
			"/cli",
			"exec-1",
			true,
		).join("\n");
		for (const banned of BANNED_IN_CODEX_PROMPT) {
			expect(lines).not.toContain(banned);
		}
		expect(lines).toContain("NO browser automation");
		expect(lines).toContain("coverage gap");
		expect(lines).toContain("END YOUR TURN");
		// Codex M2 review R4 HIGH-1: no park/wake/same-session promises until
		// the adapter loop milestone lands.
		expect(lines).not.toContain("park");
		expect(lines).not.toContain("re-woken");
		expect(lines).not.toContain("SAME QA session");
	});

	it("claude variant (default param): byte-identical to pre-FLY-1188 wording", () => {
		const lines = buildQaModeSystemPromptLines(
			qaContext,
			"FLY-1188",
			"/cli",
			"exec-1",
		).join("\n");
		expect(lines).toContain(
			"Claude-in-Chrome for browser surfaces, NOT Playwright",
		);
		expect(lines).toContain("close all Claude-in-Chrome tabs");
		expect(lines).toContain("if your context is large, `/compact`");
		expect(lines).toContain(
			'Never use the stock SendMessage to:"team-lead" channel.',
		);
	});
});

describe("FLY-1188 M2 — role-file ENVIRONMENT TRANSLATION header (codex only)", () => {
	async function buildWithDispatcher(codex: boolean): Promise<string> {
		const adapter = makeMockAdapter();
		const dispatcher = {
			dispatch: vi.fn(() => ({
				agentConfig: {
					agent_file: "role.md",
					// keep the mock minimal — content injected via readAgentFile
				},
				agentFileRoot: "project",
			})),
			dispatchByName: vi.fn(),
		};
		const wt = makeRealWorktree();
		cleanups.push(wt);
		// place the role file inside the worktree (agentFileRoot "project" → cwd)
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			join(wt, "role.md"),
			"Use the Skill tool and SendMessage as usual.",
		);
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
			makeWtManager(wt),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			dispatcher as any,
			CHECKPOINTS,
		);
		const ctx: BlueprintContext = {
			teamName: "eng",
			runnerName: "runner",
			leadId: "flywheel-eng-lead",
			projectName: "proj",
			...(codex ? { runnerBackend: "codex-tmux" } : {}),
		};
		await blueprint.run(makeNode(), "/tmp/fly1188-m2-project", ctx);
		const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0] as AdapterExecutionContext | undefined;
		return call?.appendSystemPrompt ?? "";
	}

	it("codex: translation header precedes the verbatim role text", async () => {
		const prompt = await buildWithDispatcher(true);
		const headerIdx = prompt.indexOf(
			"## Environment Translation (codex runner)",
		);
		const roleIdx = prompt.indexOf("## Agent Role");
		expect(headerIdx).toBeGreaterThanOrEqual(0);
		expect(roleIdx).toBeGreaterThan(headerIdx);
		// role text stays VERBATIM (translation is a header, not a rewrite)
		expect(prompt).toContain("Use the Skill tool and SendMessage as usual.");
	});

	it("claude: no translation header (byte-compat)", async () => {
		const prompt = await buildWithDispatcher(false);
		expect(prompt).not.toContain("## Environment Translation");
		expect(prompt).toContain("## Agent Role");
	});
});

describe("FLY-1188 M2 — claude prompt byte-snapshot (drift guard)", () => {
	it("default claude ctx full prompt is unchanged", async () => {
		const prompt = await buildPrompt({});
		// normalize the machine-dependent CLI path, land-signal path, and the
		// per-run random executionId
		const normalized = prompt
			.replace(/node \/[^\s`]+flywheel-comm[^\s`]*/g, "node <COMM_CLI>")
			.replace(/\/[^\s`]*land-status\.json/g, "<LAND_STATUS>")
			.replace(
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
				"<EXEC_ID>",
			);
		expect(normalized).toMatchSnapshot();
	});
});

// ── FLY-1224 (T13 ①) — codex author code-review lane guidance ─────────────
// A codex author's FLY-827 code gate is request-driven (event-route skips the
// legacy trigger); without this prompt block NO review ever runs and the ship
// gate deadlocks. The block must carry the coordinator's FULL state machine:
// three terminal outcomes + the re-round loop + fail-closed failure handling.
describe("FLY-1224 — codex author CODE REVIEW GATE guidance (T13 ①)", () => {
	it("codex prompt carries the full code-review lane state machine", async () => {
		const prompt = await buildCodexPrompt();
		expect(prompt).toContain("CODE REVIEW GATE (codex author");
		// lane mechanics: gate → request-review → poll
		expect(prompt).toContain("gate review_code");
		expect(prompt).toContain("request-review --type code --question-id");
		expect(prompt).toContain("check <questionId>");
		// all THREE terminal outcomes (R5 #1: the real coordinator state machine)
		expect(prompt).toContain("APPROVED → the code gate is satisfied");
		expect(prompt).toContain("SKIPPED (governance-level codex-skip");
		expect(prompt).toContain(
			"CHANGES_REQUESTED → the answered question is CONSUMED",
		);
		// the re-round loop: a NEW gate + a NEW request per round
		expect(prompt).toContain("open a NEW `gate review_code --no-block`");
		// fail-closed failure handling — never a same-family substitute
		expect(prompt).toContain("FAIL-CLOSED: report it to your Lead");
		expect(prompt).toContain("never substitute a same-family review");
		// ordering: the code gate guidance precedes the approve gate
		expect(prompt.indexOf("CODE REVIEW GATE (codex author")).toBeLessThan(
			prompt.indexOf("APPROVE GATE (MANDATORY"),
		);
	});

	it("claude prompt does NOT carry the codex code-review lane (byte-compat guard)", async () => {
		const prompt = await buildPrompt({ ctxOverrides: {} });
		expect(prompt).not.toContain("CODE REVIEW GATE (codex author");
		expect(prompt).not.toContain("request-review --type code");
	});
});
