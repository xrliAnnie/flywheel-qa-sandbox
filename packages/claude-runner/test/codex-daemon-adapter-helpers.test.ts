import { describe, expect, it } from "vitest";
import {
	buildDaemonSandboxWritableRoots,
	buildGoalKickText,
	buildGoalObjective,
	classifyGoalOutcome,
	enforceObjectiveLimit,
} from "../src/codex-daemon-adapter-helpers.js";
import {
	GOAL_OBJECTIVE_MAX_CHARS,
	GoalRunError,
} from "../src/codex-daemon-client.js";

// ── FLY-1188 M4d — pure adapter helpers for daemon-mode execute() ──────────

describe("buildDaemonSandboxWritableRoots", () => {
	it("unions the flywheel roots + worktree + git metadata, deduped", () => {
		const roots = buildDaemonSandboxWritableRoots({
			flywheelRoot: "/home/x/.flywheel",
			gateMarkerDir: "/home/x/.flywheel/gate-markers",
			commDbDir: "/home/x/.flywheel/comm",
			sandboxCwd: "/work/tree",
			gitWritableDirs: ["/main/.git", "/main/.git/worktrees/tree"],
		});
		expect(roots).toEqual([
			"/home/x/.flywheel",
			"/home/x/.flywheel/gate-markers",
			"/home/x/.flywheel/comm",
			"/work/tree",
			"/main/.git",
			"/main/.git/worktrees/tree",
		]);
	});

	it("omits commDbDir when absent and dedupes an overlapping git-dir (main checkout)", () => {
		const roots = buildDaemonSandboxWritableRoots({
			flywheelRoot: "/fw",
			gateMarkerDir: "/fw/gm",
			sandboxCwd: "/repo",
			gitWritableDirs: ["/repo/.git", "/repo/.git"], // git-dir === common-dir
		});
		expect(roots).toEqual(["/fw", "/fw/gm", "/repo", "/repo/.git"]);
	});
});

// ── FLY-1236 — objective/kick split ────────────────────────────────────────

describe("buildGoalKickText (FLY-1236: full body → kick turn)", () => {
	it("folds the system layer above the prompt with the exact divider", () => {
		// Exact equality locks byte-compat with the pre-FLY-1236 objective body
		// (only the CHANNEL moved, not the content).
		expect(
			buildGoalKickText({ systemLayer: "SYS", prompt: "do the thing" }),
		).toBe("SYS\n\n---\n\ndo the thing");
	});
	it("returns the bare prompt when there is no system layer", () => {
		expect(buildGoalKickText({ prompt: "just this" })).toBe("just this");
	});
	it("carries BOTH the appendSystemPrompt (e.g. FLY-795 resume directive) and the task prompt", () => {
		// The no-persistence guarantee: a new execution reconstructs the kick from
		// ctx, and buildGoalKickText merges the system layer (which carries the
		// FLY-795 resumeModeInstructions) with the ordinary phase prompt.
		const kick = buildGoalKickText({
			systemLayer: "RESUME: continue from progress.md",
			prompt: "PHASE PROMPT: implement step 2",
		});
		expect(kick).toContain("RESUME: continue from progress.md");
		expect(kick).toContain("PHASE PROMPT: implement step 2");
	});
});

describe("buildGoalObjective (FLY-1236: bounded phase-neutral north-star)", () => {
	it("prefers the label as the task head", () => {
		const obj = buildGoalObjective({
			issueId: "FLY-1225",
			label: "FLY-1225-fix the goal cap",
		});
		expect(obj).toContain("[FLY-1225-fix the goal cap]");
	});
	it("falls back to issueId when no label", () => {
		expect(buildGoalObjective({ issueId: "FLY-1225" })).toContain("[FLY-1225]");
	});
	it("falls back to a generic head when neither is present", () => {
		expect(buildGoalObjective({})).toContain("[the assigned runner task]");
	});
	it("is PHASE-NEUTRAL — no imperative implement/PR phrasing (Codex R2 #3)", () => {
		// Ban the imperative PHRASES, not the bare tokens (a label may legitimately
		// contain "implement" or "PR"): the durable /goal must not tell a Design or
		// QA phase to implement or open a PR.
		const obj = buildGoalObjective({ issueId: "FLY-1225" });
		expect(obj.toLowerCase()).not.toContain("implement the change");
		expect(obj.toLowerCase()).not.toContain("open a pr");
		expect(obj.toLowerCase()).not.toContain("open a pull request");
	});
	it("stays well under the goal char cap", () => {
		expect(
			buildGoalObjective({
				issueId: "FLY-1225",
				label: "FLY-1225-a normal title",
			}).length,
		).toBeLessThan(GOAL_OBJECTIVE_MAX_CHARS);
	});
});

describe("enforceObjectiveLimit (FLY-1236: fail-loud degrade, never truncate the body)", () => {
	it("passes an in-limit objective through unchanged, not degraded", () => {
		const obj = buildGoalObjective({ issueId: "FLY-1225" });
		expect(enforceObjectiveLimit(obj, "FLY-1225")).toEqual({
			objective: obj,
			degraded: false,
		});
	});
	it("passes an objective of exactly the max length through (boundary)", () => {
		const exactly = "x".repeat(GOAL_OBJECTIVE_MAX_CHARS);
		const out = enforceObjectiveLimit(exactly, "FLY-1225");
		expect(out.degraded).toBe(false);
		expect(out.objective).toBe(exactly);
	});
	it("degrades at max+1 to a bounded pointer <= the cap (boundary)", () => {
		const over = "x".repeat(GOAL_OBJECTIVE_MAX_CHARS + 1);
		const out = enforceObjectiveLimit(over, "FLY-1225");
		expect(out.degraded).toBe(true);
		expect(out.objective.length).toBeLessThanOrEqual(GOAL_OBJECTIVE_MAX_CHARS);
		expect(out.objective).toContain("FLY-1225");
	});
	it("code-point-safely caps a pathological issueId in the fallback (no surrogate split)", () => {
		// A giant label pushes the built objective over the cap; the fallback caps
		// the (untrusted) issueId by CODE POINTS so it never splits an astral pair.
		const overObjective = "y".repeat(GOAL_OBJECTIVE_MAX_CHARS + 500);
		const pathologicalId = "😀".repeat(200); // 200 astral code points, 400 UTF-16 units
		const out = enforceObjectiveLimit(overObjective, pathologicalId);
		expect(out.degraded).toBe(true);
		expect(out.objective.length).toBeLessThanOrEqual(GOAL_OBJECTIVE_MAX_CHARS);
		// no lone surrogate: re-encoding round-trips cleanly
		expect(
			Array.from(out.objective).every((c) => c.codePointAt(0)! <= 0x10ffff),
		).toBe(true);
	});
});

describe("classifyGoalOutcome", () => {
	const result = (
		status: string,
		succeeded: boolean,
		lastTurnError?: {
			turnId: string;
			message: string;
			code?: string;
		},
	) => ({
		result: {
			status: status as never,
			tokensUsed: 1,
			turns: 1,
			succeeded,
			...(lastTurnError ? { lastTurnError } : {}),
		},
	});

	it("complete + succeeded → success", () => {
		expect(
			classifyGoalOutcome({ outcome: result("complete", true) }),
		).toMatchObject({ success: true, timedOut: false });
	});

	it("every non-complete terminal → non-success with a reason", () => {
		for (const s of ["blocked", "usageLimited", "budgetLimited", "paused"]) {
			const c = classifyGoalOutcome({ outcome: result(s, false) });
			expect(c.success).toBe(false);
			expect(c.timedOut).toBe(false);
			expect(c.failureReason).toContain(s);
		}
	});

	it("maps an owned unauthorized turn to a sanitized environment failure", () => {
		const classification = classifyGoalOutcome({
			outcome: result("blocked", false, {
				turnId: "turn-1",
				message: "refresh\n@everyone <@123> ```\u0000revoked",
				code: "unauthorized",
			}),
		});

		expect(classification).toMatchObject({
			failureClass: "environment",
			failureCode: "codex:unauthorized",
		});
		expect(classification.failureReason).toContain("last turn error:");
		expect(classification.failureReason).toContain("[unauthorized]");
		expect(classification.failureReason).not.toContain("\n");
		expect(classification.failureReason).not.toContain("\r");
		expect(classification.failureReason).not.toContain("\u0000");
		expect(classification.failureReason).not.toContain("@everyone");
		expect(classification.failureReason).not.toContain("<@123>");
		expect(classification.failureReason).not.toContain("```");
	});

	it("bounds error text by Unicode code point and does not classify unknown codes", () => {
		const classification = classifyGoalOutcome({
			outcome: result("blocked", false, {
				turnId: "turn-1",
				message: "😀".repeat(600),
				code: "future_code",
			}),
		});

		expect(classification.failureClass).toBeUndefined();
		expect(classification.failureCode).toBeUndefined();
		const rendered =
			classification.failureReason!.split("last turn error: ")[1]!;
		expect(Array.from(rendered.split(" [future_code]")[0]!)).toHaveLength(500);
		expect(rendered).toContain("[future_code]");
	});

	it("complete but NOT succeeded → non-success (defensive)", () => {
		expect(
			classifyGoalOutcome({ outcome: result("complete", false) }).success,
		).toBe(false);
	});

	it("GoalRunError timeout → timedOut, other kinds → plain failure", () => {
		expect(
			classifyGoalOutcome({
				caughtError: new GoalRunError("deadline", "timeout"),
			}),
		).toMatchObject({ success: false, timedOut: true });
		expect(
			classifyGoalOutcome({
				caughtError: new GoalRunError("dead socket", "transport_closed"),
			}),
		).toMatchObject({ success: false, timedOut: false });
	});

	it("a caught non-GoalRunError → failure with its message; precedence over outcome", () => {
		const c = classifyGoalOutcome({
			caughtError: new Error("boom"),
			outcome: result("complete", true), // ignored — the run threw
		});
		expect(c.success).toBe(false);
		expect(c.failureReason).toContain("boom");
	});

	it("no outcome and no error → non-success", () => {
		expect(classifyGoalOutcome({}).success).toBe(false);
		expect(classifyGoalOutcome({ outcome: null }).success).toBe(false);
	});

	it("carries lastMessage through as resultText on a successful complete", () => {
		expect(
			classifyGoalOutcome({
				outcome: result("complete", true),
				lastMessage: "PR opened",
			}).resultText,
		).toBe("PR opened");
	});
});
