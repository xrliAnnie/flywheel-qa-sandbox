/**
 * FLY-1766 QA A6 + A7 (independent) — positive injection for the renamed
 * unreachable-runner reconcile, and the W-1 false-fresh negative test.
 */
import { describe, expect, it } from "vitest";
import { FounderReplyUnreachableReconcile } from "../founder-reply-unreachable.js";
import { LivenessCheckTracker } from "../liveness-manifest.js";

type Emitted = {
	eventType: string;
	eventId: string;
	title: string;
	body: string;
	severity: string;
	leadId: string;
};

function makeReconcile(env: Record<string, string | undefined> = {}) {
	const emitted: Emitted[] = [];
	let clock = 1_000;
	const r = new FounderReplyUnreachableReconcile({
		alertSink: {
			alert: async (a: Record<string, unknown>) => {
				emitted.push(a as unknown as Emitted);
			},
		},
		infraRoute: () => ({ leadId: "infra-lead", projectName: "flywheel" }),
		nowMs: () => clock,
		env,
	} as unknown as ConstructorParameters<
		typeof FounderReplyUnreachableReconcile
	>[0]);
	return { r, emitted, tick: (ms: number) => { clock += ms; } };
}

describe("FLY-1766 QA A6 — unreachable-runner reconcile: positive injection", () => {
	it("emits founder_reply_unreachable_runner for a live session with no CommDB row", async () => {
		const { r, emitted } = makeReconcile();
		r.beginUnreachableSweep();
		r.noteUnreachableRunner({
			executionId: "exec-qa-1766",
			issueId: "FLY-9999",
			projectName: "flywheel",
			questionId: "q-1766",
		});
		r.endUnreachableSweep();
		await r.tick();

		expect(emitted).toHaveLength(1);
		expect(emitted[0].eventType).toBe("founder_reply_unreachable_runner");
		expect(emitted[0].eventId).toContain("exec-qa-1766");
		expect(emitted[0].title).toContain("FLY-9999");
		expect(emitted[0].body).toContain("CommDB registration row is gone");
		expect(emitted[0].severity).toBe("warning");
	});

	it("latches per episode — a still-unreachable runner is not re-alerted", async () => {
		const { r, emitted } = makeReconcile();
		for (let i = 0; i < 5; i += 1) {
			r.beginUnreachableSweep();
			r.noteUnreachableRunner({
				executionId: "exec-qa-1766",
				issueId: "FLY-9999",
				projectName: "flywheel",
				questionId: "q-1766",
			});
			r.endUnreachableSweep();
			await r.tick();
		}
		expect(emitted).toHaveLength(1);
	});

	it("a cleared then re-detected condition is a NEW episode with a fresh eventId", async () => {
		const { r, emitted, tick } = makeReconcile();
		r.beginUnreachableSweep();
		r.noteUnreachableRunner({
			executionId: "exec-qa-1766",
			issueId: "FLY-9999",
			projectName: "flywheel",
			questionId: "q-1766",
		});
		r.endUnreachableSweep();
		await r.tick();

		// Condition clears (re-registered / gate resolved): sweep sees nothing.
		r.beginUnreachableSweep();
		r.endUnreachableSweep();
		await r.tick();
		expect(emitted).toHaveLength(1);

		// Re-detected later → must alert again, with a different eventId.
		tick(60_000);
		r.beginUnreachableSweep();
		r.noteUnreachableRunner({
			executionId: "exec-qa-1766",
			issueId: "FLY-9999",
			projectName: "flywheel",
			questionId: "q-1766",
		});
		r.endUnreachableSweep();
		await r.tick();
		expect(emitted).toHaveLength(2);
		expect(emitted[1].eventId).not.toBe(emitted[0].eventId);
	});

	it("stays silent when the reconcile is switched off (proves the alert is caused by it)", async () => {
		const { r, emitted } = makeReconcile({
			FLYWHEEL_FOUNDER_REPLY_UNREACHABLE: "0",
		});
		r.beginUnreachableSweep();
		r.noteUnreachableRunner({
			executionId: "exec-qa-1766",
			issueId: "FLY-9999",
			projectName: "flywheel",
			questionId: "q-1766",
		});
		r.endUnreachableSweep();
		await r.tick();
		expect(emitted).toHaveLength(0);
	});
});

describe("FLY-1766 QA A7 — W-1 must never report a false fresh", () => {
	const CADENCE = 300_000;

	it("an owner that started but never completed stays in_flight forever, never fresh", () => {
		let now = 0;
		const t = new LivenessCheckTracker({ cadenceMs: CADENCE, now: () => now });
		t.started(); // hung owner: no completed()
		for (const elapsed of [1_000, CADENCE, CADENCE * 5, CADENCE * 100]) {
			now = elapsed;
			const s = t.snapshot({ wired: true, effectiveEnabled: true });
			expect(s.freshness).toBe("in_flight");
			expect(s.in_flight_age_ms).toBe(elapsed);
			expect(s.last_check_completed_at).toBeNull();
		}
	});

	it("a LATER generation completing cannot clear the still-hung owner", () => {
		let now = 0;
		const t = new LivenessCheckTracker({ cadenceMs: CADENCE, now: () => now });
		const hung = t.started();
		now = CADENCE * 3;
		const later = t.started();
		t.completed(later); // the concurrent pass finishes...
		now = CADENCE * 4;
		const s = t.snapshot({ wired: true, effectiveEnabled: true });
		// ...but the ORIGINAL owner is still hung, so the row must not read fresh.
		expect(s.freshness).toBe("in_flight");
		expect(s.in_flight_age_ms).toBe(CADENCE * 4);
		expect(hung).not.toBe(later);
	});

	it("a skipped tick (no started/completed at all) decays fresh → stale, not fresh forever", () => {
		let now = 0;
		const t = new LivenessCheckTracker({ cadenceMs: CADENCE, now: () => now });
		t.completed(t.started());
		now = CADENCE; // within 2x cadence
		expect(t.snapshot({ wired: true, effectiveEnabled: true }).freshness).toBe(
			"fresh",
		);
		now = CADENCE * 2 + 1; // beyond 2x cadence with no new pass
		expect(t.snapshot({ wired: true, effectiveEnabled: true }).freshness).toBe(
			"stale",
		);
	});

	it("completing an unknown/stale generation is a no-op (cannot forge freshness)", () => {
		let now = 0;
		const t = new LivenessCheckTracker({ cadenceMs: CADENCE, now: () => now });
		t.completed(999); // never started
		now = CADENCE * 10;
		const s = t.snapshot({ wired: true, effectiveEnabled: true });
		expect(s.freshness).toBe("not_started");
		expect(s.last_check_completed_at).toBeNull();
	});
});
