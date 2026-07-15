import { describe, expect, it } from "vitest";
import {
	type ArmingDecisionInput,
	DEFAULT_ARM_WINDOW_MS,
	decideArmingAction,
} from "../bridge/autocontinue-arming.js";

// A pane capture that satisfies detectInputBoxPresent: a box-border rule line
// plus a `❯` prompt line in the last 10 non-empty lines (matches the real
// Claude Code TUI + the FLY-818 spike capture).
const IDLE_INPUT_BOX = [
	"⏺ done with this turn.",
	"────────────────────────────────────────────────────────",
	"❯ ",
	"────────────────────────────────────────────────────────",
	"  Opus 4.8 (1M context)/xhigh | ctx 6% ░░░░░░░░░░",
	"  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

// A pane mid-active-turn: a working spinner, NO idle prompt box.
const ACTIVE_TURN = [
	"⏺ Bash(pnpm test)",
	"  ⎿ running tests…",
	"✻ Pondering… (26s · ↓ 582 tokens)",
].join("\n");

function base(over: Partial<ArmingDecisionInput> = {}): ArmingDecisionInput {
	return {
		alreadyArmed: false,
		status: "running",
		capture: { ok: true, output: ACTIVE_TURN },
		hasPendingGate: false,
		elapsedMs: 0,
		...over,
	};
}

describe("decideArmingAction (FLY-818) — lifecycle-bound arming", () => {
	it("arms (send) when the idle input box is visible on a running runner", () => {
		expect(
			decideArmingAction(
				base({ capture: { ok: true, output: IDLE_INPUT_BOX } }),
			),
		).toBe("send");
	});

	it("never re-arms once armed (idempotent — Bridge restart/retry safe)", () => {
		// Even with a visible input box, an already-armed session is skip-armed.
		expect(
			decideArmingAction(
				base({
					alreadyArmed: true,
					capture: { ok: true, output: IDLE_INPUT_BOX },
				}),
			),
		).toBe("skip-armed");
	});

	it("skips a terminal session (status not running)", () => {
		for (const status of [
			"completed",
			"failed",
			"awaiting_review",
			"blocked",
		]) {
			expect(
				decideArmingAction(
					base({ status, capture: { ok: true, output: IDLE_INPUT_BOX } }),
				),
			).toBe("skip-terminal");
		}
	});

	it("skips when the pane is dead (terminal even if status lags)", () => {
		expect(
			decideArmingAction(
				base({ paneDead: true, capture: { ok: true, output: IDLE_INPUT_BOX } }),
			),
		).toBe("skip-terminal");
	});

	it("does NOT arm when a blocking gate/question is pending (gate priority over input box)", () => {
		// A runner parked at a blocking gate shows an input box too — must not be armed.
		expect(
			decideArmingAction(
				base({
					hasPendingGate: true,
					capture: { ok: true, output: IDLE_INPUT_BOX },
				}),
			),
		).toBe("skip-gate");
	});

	it("waits while a capture error hides the input box (until the window)", () => {
		expect(
			decideArmingAction(base({ capture: { ok: false }, elapsedMs: 1000 })),
		).toBe("wait");
	});

	it("fail-closes when the arm window is exceeded without an input box", () => {
		expect(
			decideArmingAction(
				base({
					capture: { ok: true, output: ACTIVE_TURN },
					elapsedMs: DEFAULT_ARM_WINDOW_MS,
				}),
			),
		).toBe("fail-closed");
	});

	// ── The FLY-818 命门 test: a long first turn must NOT fail-closed early,
	// and MUST arm exactly once when it finally goes idle. This is the exact
	// failure mode Codex R2#1 blocked on: a short spawn-relative timeout would
	// give up on the long-first-turn runner that most needs auto-continue.
	it("命门: long first turn keeps waiting, then arms EXACTLY once when it goes idle", () => {
		const window = DEFAULT_ARM_WINDOW_MS;
		// 30 min into a long onboard/implement first turn — well past any short
		// probe interval, but far below the lifecycle-bound window. Still active.
		const midLongTurn = base({
			capture: { ok: true, output: ACTIVE_TURN },
			elapsedMs: 30 * 60_000,
			armWindowMs: window,
		});
		expect(decideArmingAction(midLongTurn)).toBe("wait");

		// The long first turn finally ends → idle input box appears (still within
		// the window). We arm now.
		const turnEnded = base({
			capture: { ok: true, output: IDLE_INPUT_BOX },
			elapsedMs: 45 * 60_000,
			armWindowMs: window,
		});
		expect(decideArmingAction(turnEnded)).toBe("send");

		// After the caller marks it armed, a subsequent tick never sends again.
		const afterArm = { ...turnEnded, alreadyArmed: true };
		expect(decideArmingAction(afterArm)).toBe("skip-armed");
	});
});
