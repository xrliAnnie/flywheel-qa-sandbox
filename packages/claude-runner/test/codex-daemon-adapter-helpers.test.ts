import { describe, expect, it } from "vitest";
import {
	buildDaemonSandboxWritableRoots,
	buildGoalObjective,
	classifyGoalOutcome,
} from "../src/codex-daemon-adapter-helpers.js";
import { GoalRunError } from "../src/codex-daemon-client.js";

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

describe("buildGoalObjective", () => {
	it("folds the system layer above the prompt with a divider", () => {
		expect(
			buildGoalObjective({ systemLayer: "SYS", prompt: "do the thing" }),
		).toBe("SYS\n\n---\n\ndo the thing");
	});
	it("returns the bare prompt when there is no system layer", () => {
		expect(buildGoalObjective({ prompt: "just this" })).toBe("just this");
	});
});

describe("classifyGoalOutcome", () => {
	const result = (status: string, succeeded: boolean) => ({
		result: {
			status: status as never,
			tokensUsed: 1,
			turns: 1,
			succeeded,
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
