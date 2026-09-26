import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AutoContinueArmer } from "../bridge/autocontinue-armer.js";
import { isAutocontinueArmed } from "../bridge/autocontinue-state.js";
import type { Session, StateStore } from "../StateStore.js";

const IDLE_INPUT_BOX = [
	"⏺ done with this turn.",
	"────────────────────────────────────────────────────────",
	"❯ ",
	"────────────────────────────────────────────────────────",
	"  Opus 4.8 (1M context)/xhigh | ctx 6% ░░░░░░░░░░",
].join("\n");
const ACTIVE_TURN = "✻ Pondering… (26s · ↓ 582 tokens)";

function sess(over: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-A",
		status: "running",
		adapter_type: "claude-tmux",
		session_role: "main",
		project_name: "flywheel",
		issue_id: "FLY-1",
		issue_identifier: "FLY-1",
		...over,
	} as unknown as Session;
}

interface Harness {
	armer: AutoContinueArmer;
	sends: Array<{ window: string; text: string }>;
	events: Array<{ event_type: string; payload: unknown }>;
	root: string;
	env: NodeJS.ProcessEnv;
	setSessions: (s: Session[]) => void;
	setCapture: (output: string) => void;
	setNow: (ms: number) => void;
}

function harness(
	opts: {
		enabled?: boolean;
		sendOk?: boolean;
		pendingGate?: boolean;
		nowMs?: number;
		armWindowMs?: number;
	} = {},
): Harness {
	const root = mkdtempSync(join(tmpdir(), "fly818-armer-"));
	const env = {
		FLYWHEEL_RUNNER_STATE_ROOT: root,
		...(opts.enabled === false ? {} : { FLYWHEEL_RUNNER_AUTOCONTINUE: "1" }),
	} as NodeJS.ProcessEnv;
	let sessions: Session[] = [sess()];
	let captureOutput = IDLE_INPUT_BOX;
	let nowMs = opts.nowMs ?? 0;
	const sends: Array<{ window: string; text: string }> = [];
	const events: Array<{ event_type: string; payload: unknown }> = [];
	const armer = new AutoContinueArmer({
		pollIntervalMs: 1000,
		projects: [],
		store: {
			getActiveSessions: () => sessions,
			insertEvent: (e: { event_type: string; payload?: unknown }) => {
				events.push({ event_type: e.event_type, payload: e.payload });
				return true;
			},
		} as unknown as StateStore,
		captureSessionFn: vi.fn(async () => ({
			output: captureOutput,
			tmux_target: "runner-flywheel:@1",
			lines: 100,
			captured_at: "now",
		})),
		getTmuxTarget: () => ({ tmuxWindow: "runner-flywheel:@1" }) as never,
		sendKeys: vi.fn(async (window: string, text: string) => {
			sends.push({ window, text });
			return { sent: opts.sendOk !== false };
		}),
		hasPendingGate: () => opts.pendingGate === true,
		now: () => nowMs,
		env,
		armWindowMs: opts.armWindowMs,
	});
	return {
		armer,
		sends,
		events,
		root,
		env,
		setSessions: (s) => {
			sessions = s;
		},
		setCapture: (o) => {
			captureOutput = o;
		},
		setNow: (ms) => {
			nowMs = ms;
		},
	};
}

describe("AutoContinueArmer (FLY-818) — lifecycle-bound arming worker", () => {
	it("does NOTHING when the feature flag is off (byte-compat default)", async () => {
		const h = harness({ enabled: false });
		await h.armer.pollOnce();
		expect(h.sends).toHaveLength(0);
		expect(isAutocontinueArmed("exec-A", h.env)).toBe(false);
	});

	it("arms a claude runner ONCE when the idle input box is visible, then never again", async () => {
		const h = harness();
		await h.armer.pollOnce();
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0].text).toContain("/loop");
		expect(h.sends[0].text).toContain("autocontinue-goal.md");
		expect(isAutocontinueArmed("exec-A", h.env)).toBe(true);
		expect(h.events.some((e) => e.event_type === "autocontinue_arm")).toBe(
			true,
		);

		// A second poll must NOT re-arm (durable idempotence).
		await h.armer.pollOnce();
		expect(h.sends).toHaveLength(1);
	});

	it("does NOT arm a non-Claude backend (codex/agy/kimi)", async () => {
		for (const adapter_type of ["codex", "antigravity-tmux", "kimi-tmux"]) {
			const h = harness();
			h.setSessions([sess({ adapter_type })]);
			await h.armer.pollOnce();
			expect(h.sends).toHaveLength(0);
		}
	});

	it("waits (no send) while the runner is mid-turn (no idle input box)", async () => {
		const h = harness();
		h.setCapture(ACTIVE_TURN);
		await h.armer.pollOnce();
		expect(h.sends).toHaveLength(0);
		expect(isAutocontinueArmed("exec-A", h.env)).toBe(false);
	});

	it("does NOT arm a runner parked at a blocking gate/question", async () => {
		const h = harness({ pendingGate: true });
		await h.armer.pollOnce();
		expect(h.sends).toHaveLength(0);
	});

	it("keeps waiting through a long turn, only fail-closes when the arm window is exceeded", async () => {
		const h = harness({ nowMs: 0, armWindowMs: 5_000 });
		h.setCapture(ACTIVE_TURN);
		// First poll seeds the observe window (elapsed 0) → wait, not fail-closed.
		await h.armer.pollOnce();
		expect(h.sends).toHaveLength(0);
		expect(isAutocontinueArmed("exec-A", h.env)).toBe(false);
		// Time advances past the window, still mid-turn → fail-closed (resolved).
		h.setNow(10_000);
		await h.armer.pollOnce();
		expect(h.sends).toHaveLength(0);
		// resolved durably → won't re-observe forever.
		expect(isAutocontinueArmed("exec-A", h.env)).toBe(true);
		expect(
			h.events.some(
				(e) => (e.payload as { result?: string })?.result === "fail-closed",
			),
		).toBe(true);
	});

	it("at-most-once: a tmux send failure still COMMITS the armed marker and is NEVER re-sent (no double-arm)", async () => {
		// Codex code review R1 #1: the marker is committed BEFORE the send, so a
		// send failure (or a crash around it) degrades this runner to plain but can
		// never re-send `/loop` on a later poll.
		const h = harness({ sendOk: false });
		await h.armer.pollOnce();
		expect(h.sends).toHaveLength(1); // attempted once
		expect(isAutocontinueArmed("exec-A", h.env)).toBe(true); // committed (degraded, not retried)
		// A second poll (e.g. after a Bridge restart re-drives the observe) must NOT
		// send `/loop` a second time.
		await h.armer.pollOnce();
		expect(h.sends).toHaveLength(1);
	});
});
