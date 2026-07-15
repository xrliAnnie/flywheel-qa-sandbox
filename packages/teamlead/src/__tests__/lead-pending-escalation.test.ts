import { describe, expect, it } from "vitest";
import {
	computeStuckKey,
	decideLeadNudge,
	type LeadNudgePolicy,
	type LeadNudgeRow,
} from "../bridge/lead-pending-escalation.js";

/**
 * FLY-637-ext: pure exponential-backoff policy for the lead-pending escalation.
 * Runner blocked on a `question` gate the Lead hasn't answered → nudge the Lead
 * on exponential backoff → after K rounds page Annie once. Thresholds (Annie):
 * grace 20min, ×2, cap 2h, PAGE_ANNIE_ROUNDS=3 (0 = never page).
 */

const MIN = 60_000;
const policy = (over: Partial<LeadNudgePolicy> = {}): LeadNudgePolicy => ({
	graceMs: 20 * MIN,
	backoffFactor: 2,
	capMs: 120 * MIN,
	pageAnnieRounds: 3,
	...over,
});

const SK = "stuck-key-A";

describe("decideLeadNudge (FLY-637-ext)", () => {
	it("waits until the gate has been pending >= grace before the first nudge", () => {
		const createdAt = 0;
		// 19 min in — not yet
		expect(
			decideLeadNudge(undefined, SK, createdAt, 19 * MIN, policy()).kind,
		).toBe("wait");
		// 20 min in — first nudge
		const r = decideLeadNudge(undefined, SK, createdAt, 20 * MIN, policy());
		expect(r.kind).toBe("nudge");
		if (r.kind === "nudge") {
			expect(r.nudgeCount).toBe(1);
			expect(r.nextRow.nudge_count).toBe(1);
			// next interval = base × 2^1 = 40min
			expect(r.nextRow.next_eligible_at_ms).toBe(20 * MIN + 40 * MIN);
			expect(r.nextRow.paged_annie).toBe(false);
		}
	});

	it("exponential backoff between nudges, capped", () => {
		const row1: LeadNudgeRow = {
			stuck_key: SK,
			nudge_count: 1,
			last_nudge_at_ms: 20 * MIN,
			next_eligible_at_ms: 60 * MIN, // eligible at 60
			paged_annie: false,
		};
		// not eligible at 59
		expect(decideLeadNudge(row1, SK, 0, 59 * MIN, policy()).kind).toBe("wait");
		// eligible at 60 → nudge #2, next interval = base×2^2 = 80min
		const r2 = decideLeadNudge(row1, SK, 0, 60 * MIN, policy());
		expect(r2.kind).toBe("nudge");
		if (r2.kind === "nudge") {
			expect(r2.nudgeCount).toBe(2);
			expect(r2.nextRow.next_eligible_at_ms).toBe(60 * MIN + 80 * MIN);
		}
		// nudge #3 → next interval = base×2^3 = 160 → capped at 120
		const row2: LeadNudgeRow = {
			...row1,
			nudge_count: 2,
			last_nudge_at_ms: 60 * MIN,
			next_eligible_at_ms: 140 * MIN,
		};
		const r3 = decideLeadNudge(row2, SK, 0, 140 * MIN, policy());
		expect(r3.kind).toBe("nudge");
		if (r3.kind === "nudge") {
			expect(r3.nudgeCount).toBe(3);
			expect(r3.nextRow.next_eligible_at_ms).toBe(140 * MIN + 120 * MIN); // capped
		}
	});

	it("after K=3 nudges, the next eligible escalation pages Annie ONCE", () => {
		const row3: LeadNudgeRow = {
			stuck_key: SK,
			nudge_count: 3,
			last_nudge_at_ms: 140 * MIN,
			next_eligible_at_ms: 260 * MIN,
			paged_annie: false,
		};
		const r = decideLeadNudge(row3, SK, 0, 260 * MIN, policy());
		expect(r.kind).toBe("page_annie");
		if (r.kind === "page_annie") expect(r.nextRow.paged_annie).toBe(true);

		// once paged, a later eligible tick does NOT page again — keeps nudging the Lead
		const rowPaged: LeadNudgeRow = {
			stuck_key: SK,
			nudge_count: 4,
			last_nudge_at_ms: 260 * MIN,
			next_eligible_at_ms: 380 * MIN,
			paged_annie: true,
		};
		const r2 = decideLeadNudge(rowPaged, SK, 0, 380 * MIN, policy());
		expect(r2.kind).toBe("nudge");
		if (r2.kind === "nudge") expect(r2.nextRow.paged_annie).toBe(true);
	});

	it("PAGE_ANNIE_ROUNDS=0 → never pages Annie, only keeps nudging the Lead", () => {
		const row3: LeadNudgeRow = {
			stuck_key: SK,
			nudge_count: 3,
			last_nudge_at_ms: 140 * MIN,
			next_eligible_at_ms: 260 * MIN,
			paged_annie: false,
		};
		const r = decideLeadNudge(
			row3,
			SK,
			0,
			260 * MIN,
			policy({ pageAnnieRounds: 0 }),
		);
		expect(r.kind).toBe("nudge");
		if (r.kind === "nudge") expect(r.nextRow.paged_annie).toBe(false);
	});

	it("a changed stuck_key (stage advanced = progress) resets the backoff", () => {
		const row2: LeadNudgeRow = {
			stuck_key: SK,
			nudge_count: 2,
			last_nudge_at_ms: 60 * MIN,
			next_eligible_at_ms: 140 * MIN,
			paged_annie: false,
		};
		// new stuck key → reset row with a FRESH grace from now (205min), NOT from
		// the old question age (Codex code R1 #2 — would otherwise nudge immediately).
		const r = decideLeadNudge(
			row2,
			"stuck-key-B",
			200 * MIN,
			205 * MIN,
			policy(),
		);
		expect(r.kind).toBe("reset");
		if (r.kind === "reset") {
			expect(r.nextRow.nudge_count).toBe(0);
			expect(r.nextRow.paged_annie).toBe(false);
			expect(r.nextRow.stuck_key).toBe("stuck-key-B");
			expect(r.nextRow.next_eligible_at_ms).toBe(205 * MIN + 20 * MIN);
		}
		// the reset row then honors that fresh grace: not eligible at 224, nudge at 225
		const resetRow: LeadNudgeRow = {
			stuck_key: "stuck-key-B",
			nudge_count: 0,
			last_nudge_at_ms: 205 * MIN,
			next_eligible_at_ms: 225 * MIN,
			paged_annie: false,
		};
		expect(
			decideLeadNudge(resetRow, "stuck-key-B", 200 * MIN, 224 * MIN, policy())
				.kind,
		).toBe("wait");
		expect(
			decideLeadNudge(resetRow, "stuck-key-B", 200 * MIN, 225 * MIN, policy())
				.kind,
		).toBe("nudge");
	});

	it("a not-yet-paged round at/after K+1 keeps trying to page (>= not ===)", () => {
		// count=4 (== pageAnnieRounds+1) but a prior page was NOT accepted (paged
		// still false) → the next eligible escalation re-attempts the page.
		const row: LeadNudgeRow = {
			stuck_key: SK,
			nudge_count: 4,
			last_nudge_at_ms: 260 * MIN,
			next_eligible_at_ms: 380 * MIN,
			paged_annie: false,
		};
		expect(decideLeadNudge(row, SK, 0, 380 * MIN, policy()).kind).toBe(
			"page_annie",
		);
	});

	it("computeStuckKey is deterministic and changes with stage", () => {
		const a = computeStuckKey("q1", "implement");
		const b = computeStuckKey("q1", "implement");
		const c = computeStuckKey("q1", "test");
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});
});
