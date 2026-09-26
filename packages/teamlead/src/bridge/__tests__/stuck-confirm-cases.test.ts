/**
 * FLY-1234 (T5-2): the 2026-07-13 production false-positive corpus as a
 * regression harness, plus the Lead handoff addendum (post-audit-window
 * cases), plus the annotation end-to-end render (both Lead runtimes).
 *
 * Acceptance (issue wording): the 5 audited formations reproduce → 0 false
 * positives; genuinely-stuck formations (dead pin / static + judge c_stuck)
 * still emit. Frames here are REAL pane shapes (spinner rows / codex driver
 * tails / test-runner output), not decision-table tautologies — the report
 * handed to the judge is asserted to carry the actual fixture evidence.
 */

import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../StateStore.js";
import { CommDBLeadRuntime } from "../commdb-lead-runtime.js";
import type { SuspiciousReport } from "../detection-suspicious.js";
import { scanErrorSignatures } from "../error-signatures.js";
import { formatSessionStuck, type HookPayload } from "../hook-payload.js";
import type { LeadEventEnvelope } from "../lead-runtime.js";
import { MailboxLeadRuntime } from "../mailbox-lead-runtime.js";
import {
	CONFIRM_NOTES,
	confirmStuckCandidate,
	type JudgeDecision,
	type StuckConfirmDeps,
} from "../stuck-pane-confirm.js";

function session(id: string): Session {
	return {
		execution_id: id,
		issue_id: "FLY-1224",
		issue_identifier: "FLY-1224",
		project_name: "flywheel",
		status: "running",
		last_activity_at: "2026-07-13 17:40:00",
	} as Session;
}

const gapAwareSleep = (ms: number) =>
	ms >= 90_000 ? new Promise<void>(() => {}) : Promise.resolve();

function runCase(opts: {
	execId: string;
	frames: [string, string];
	judge?: JudgeDecision;
	liveness?: "alive" | "dead_pin";
	onJudgeReport?: (r: SuspiciousReport, kinds: string[]) => void;
}) {
	let frameIdx = 0;
	const deps: StuckConfirmDeps = {
		probeLiveness: async () => opts.liveness ?? "alive",
		captureFrame: async () => ({
			text: opts.frames[Math.min(frameIdx++, 1)]!,
			capturedAtMs: frameIdx,
		}),
		frameGapMs: 15_000,
		deadlineMs: 90_000,
		sleep: gapAwareSleep,
		scanErrorSignatures,
		routeToJudge: async (r, ctx) => {
			opts.onJudgeReport?.(r, ctx.errorSignatureKinds);
			return opts.judge ?? { outcome: "delivered", decision: "unavailable" };
		},
	};
	return confirmStuckCandidate(session(opts.execId), deps);
}

// ── The five audited 2026-07-13 formations ──────────────────────────────────

describe("FLY-1234 audited case regression — 5/5 false positives → 0", () => {
	it("case 1 (00ddfc18, FLY-1224 design): static codex design-review wait + corroborated a_working → SUPPRESSED", async () => {
		const frame = [
			"$ codex exec --json -C /Users/…/flywheel-FLY-1224 -s read-only -",
			"[codex] design review R2 in progress…",
			"❯ ",
		].join("\n");
		let judged: SuspiciousReport | undefined;
		const result = await runCase({
			execId: "00ddfc18",
			frames: [frame, frame], // review wait: pane静止数分钟
			judge: { outcome: "suppressed", decision: "a_working" },
			onJudgeReport: (r) => {
				judged = r;
			},
		});
		expect(result.action).toBe("suppress");
		// The judge saw the REAL evidence window, not a synthetic placeholder.
		expect(judged?.frames?.[0]?.text).toContain("design review R2");
		expect(judged?.targetKey).toBe("00ddfc18");
	});

	it("case 2 (e8c0e865, FLY-1224 implement): xhigh long thinking — live spinner counter changes the raw frame → SUPPRESSED without a judge call", async () => {
		const judge = vi.fn();
		const result = await runCase({
			execId: "e8c0e865",
			frames: [
				"✻ Pondering… (esc to interrupt) Cooked for 312s\n❯ ",
				"✻ Pondering… (esc to interrupt) Cooked for 327s\n❯ ",
			],
			onJudgeReport: judge as never,
		});
		expect(result).toMatchObject({
			action: "suppress",
			reason: "frames_changing",
		});
		expect(judge).not.toHaveBeenCalled(); // zero judge cost for a live spinner
	});

	it("case 3 (097a5dcf, FLY-1185 qa): active bash calls — scrolling output → SUPPRESSED", async () => {
		const result = await runCase({
			execId: "097a5dcf",
			frames: [
				"$ grep -rn codex-gate packages/…\npackages/a.ts:12: …\n❯",
				"$ grep -rn codex-gate packages/…\npackages/a.ts:12: …\npackages/b.ts:99: …\n❯",
			],
		});
		expect(result).toMatchObject({
			action: "suppress",
			reason: "frames_changing",
		});
	});

	it("case 4 (cc21f3f5, FLY-1185 implement): static frame + live process + judge a_working → SUPPRESSED", async () => {
		const frame = "Reading design docs…\n❯ ";
		const result = await runCase({
			execId: "cc21f3f5",
			frames: [frame, frame],
			judge: { outcome: "suppressed", decision: "a_working" },
		});
		expect(result).toMatchObject({
			action: "suppress",
			reason: "judge_a_working",
		});
	});

	it("case 5 (2ed82858, FLY-1224 qa): test suite running — vitest progress moves the frame → SUPPRESSED", async () => {
		const result = await runCase({
			execId: "2ed82858",
			frames: [
				"RUN v3.2.4 …\n✓ restart-guard.test.ts (14 tests)\n… 3 passed",
				"RUN v3.2.4 …\n✓ restart-guard.test.ts (14 tests)\n✓ dist-e2e.test.ts (9 tests)\n… 4 passed",
			],
		});
		expect(result).toMatchObject({
			action: "suppress",
			reason: "frames_changing",
		});
	});
});

// ── Lead handoff addendum ① — post-audit-window formations ─────────────────

describe("FLY-1234 addendum cases (Lead handoff ①)", () => {
	it("(a) 1232-implement 23:51 form: runner auditing files, command stream scrolling while heartbeat silent → SUPPRESSED", async () => {
		const result = await runCase({
			execId: "exec-1232-impl",
			frames: [
				"$ rg 'audit' packages/…\npackages/x.ts:1\n$ cat packages/x.ts\n… 40 lines …\n❯",
				"$ rg 'audit' packages/…\npackages/x.ts:1\n$ cat packages/y.ts\n… 55 lines …\n❯",
			],
		});
		expect(result).toMatchObject({
			action: "suppress",
			reason: "frames_changing",
		});
	});

	it("(b) 1182 form: legitimately parked husk (work done, idle shell) — judge b_parked WITH mechanical corroboration → SUPPRESSED", async () => {
		const frame = [
			"flywheel-comm park --reason 'three-stage implement parked awaiting QA'",
			"Parked. Waiting for wake.",
			"❯ ",
		].join("\n");
		const result = await runCase({
			execId: "exec-1182-husk",
			frames: [frame, frame],
			judge: { outcome: "suppressed", decision: "b_parked" },
		});
		expect(result).toMatchObject({
			action: "suppress",
			reason: "judge_b_parked",
		});
	});

	it("(c) same-day pane-capture disproof form: looks static at a glance but the live region ticks → SUPPRESSED without judge", async () => {
		const judge = vi.fn();
		const result = await runCase({
			execId: "exec-earlier-disproof",
			frames: [
				"⏺ Bash(pnpm vitest run …)\n  ⎿ Running… (esc to interrupt) 41s\n❯",
				"⏺ Bash(pnpm vitest run …)\n  ⎿ Running… (esc to interrupt) 56s\n❯",
			],
			onJudgeReport: judge as never,
		});
		expect(result).toMatchObject({
			action: "suppress",
			reason: "frames_changing",
		});
		expect(judge).not.toHaveBeenCalled();
	});
});

// ── True stuck stays loud ───────────────────────────────────────────────────

describe("FLY-1234 true-stuck formations still emit", () => {
	it("dead pin (remain-on-exit corpse) → EMIT immediately, zero frames burned", async () => {
		const result = await runCase({
			execId: "exec-corpse",
			frames: ["", ""],
			liveness: "dead_pin",
		});
		expect(result).toMatchObject({ action: "emit", reason: "dead_pin" });
	});

	it("static frames + judge c_stuck → EMIT with the c_stuck annotation", async () => {
		const frame = "⎿ API Error: something\n❯ ";
		const result = await runCase({
			execId: "exec-frozen",
			frames: [frame, frame],
			judge: { outcome: "delivered", decision: "c_stuck" },
		});
		expect(result).toMatchObject({
			action: "emit",
			reason: "frames_static_judge_c_stuck",
		});
		expect(result.confirmNote).toBe(CONFIRM_NOTES.frames_static_judge_c_stuck);
	});

	it("rolling error loop (same normalized signature, churning text) → EMIT, judge cannot downgrade", async () => {
		const result = await runCase({
			execId: "exec-error-loop",
			frames: [
				"API Error: Stream idle timeout - partial response received (attempt 3)\nretrying…",
				"API Error: Stream idle timeout - partial response received (attempt 4)\nretrying…",
			],
			judge: { outcome: "suppressed", decision: "a_working" }, // hostile downgrade
		});
		expect(result).toMatchObject({
			action: "emit",
			reason: "repeated_error_signature",
		});
	});
});

// ── Annotation end-to-end render (R1 #5 leg 3/3) ────────────────────────────

function envelope(event: HookPayload, seq = 3): LeadEventEnvelope {
	return {
		seq,
		event,
		sessionKey: event.execution_id,
		leadId: "flywheel-eng-lead",
		timestamp: "2026-07-13T22:01:35.000Z",
	};
}

function stuckEvent(over: Partial<HookPayload> = {}): HookPayload {
	return {
		event_type: "session_stuck",
		execution_id: "2ed82858",
		issue_id: "FLY-1224",
		issue_identifier: "FLY-1224",
		issue_title: "watchdog stuck",
		project_name: "flywheel",
		status: "running",
		minutes_since_activity: 21,
		session_role: "main",
		filter_priority: "high",
		notification_context: "…",
		...over,
	};
}

function renderVia(proto: unknown, env: LeadEventEnvelope): string {
	// The session_stuck branch returns before touching `this` — prototype-call
	// renders without a real CommDB / transport (stuck-escalation-render.test
	// precedent).
	return (
		proto as { formatEnvelope: (e: LeadEventEnvelope) => string }
	).formatEnvelope.call({}, env);
}

describe("session_stuck annotation rendering (both runtimes, parity by construction)", () => {
	it("confirm_note renders on a labeled Confirm-Note line in BOTH runtimes", () => {
		const env = envelope(
			stuckEvent({ confirm_note: CONFIRM_NOTES.confirm_budget_exhausted }),
		);
		for (const proto of [
			CommDBLeadRuntime.prototype,
			MailboxLeadRuntime.prototype,
		]) {
			const text = renderVia(proto, env);
			expect(text).toContain(
				`Confirm-Note: ${CONFIRM_NOTES.confirm_budget_exhausted}`,
			);
			expect(text).toBe(formatSessionStuck(env)); // shared renderer, no drift
		}
	});

	it("byte-compat: WITHOUT confirm_note the rendered text is exactly the legacy generic output", () => {
		const env = envelope(stuckEvent());
		const legacyGeneric = [
			`[Event #${env.seq}] session_stuck`,
			"ID: 2ed82858 | Issue: FLY-1224",
			"Title: watchdog stuck",
			"Status: running",
			"Priority: high",
			"Context: …",
			`Timestamp: ${env.timestamp} | Session Key: ${env.sessionKey}`,
		].join("\n");
		expect(formatSessionStuck(env)).toBe(legacyGeneric);
		expect(renderVia(CommDBLeadRuntime.prototype, env)).toBe(legacyGeneric);
		expect(renderVia(MailboxLeadRuntime.prototype, env)).toBe(legacyGeneric);
	});
});
