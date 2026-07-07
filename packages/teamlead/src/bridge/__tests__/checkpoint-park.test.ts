/**
 * FLY-927 (Task 3.1): park-tuple derivation matrix (checkpoint × status ×
 * autoQa × evidence) + the truthful wording template (FLY-912 regression).
 */
import { describe, expect, it } from "vitest";
import { deriveParkTuple, formatParkAlert } from "../checkpoint-park.js";

const NOW = Date.UTC(2026, 6, 7, 12, 0);

function input(over: Record<string, unknown> = {}) {
	return {
		session: {
			issue_id: "issue-uuid",
			issue_identifier: "FLY-912",
			status: "awaiting_review",
			session_stage: "approve",
			stage_updated_at: "2026-07-07 08:00:00",
			awaiting_review_entered_at: "2026-07-07 08:10:00",
			...(over.session as object),
		},
		pendingGates: (over.pendingGates as never[]) ?? [],
		autoQaActive: (over.autoQaActive as boolean) ?? false,
		notifiedEvidence: (over.notifiedEvidence as boolean) ?? false,
		ownerLeadId: "flywheel-eng-lead",
		nowMs: NOW,
	};
}

describe("deriveParkTuple", () => {
	it("approve_to_ship gate → party=founder, waiting from the gate", () => {
		const t = deriveParkTuple(
			input({
				pendingGates: [
					{ checkpoint: "approve_to_ship", createdAtMs: NOW - 3_600_000 },
				],
			}),
		);
		expect(t).toMatchObject({
			party: "founder",
			stage: "approve",
			waitingSinceMs: NOW - 3_600_000,
			nextStep: "等你 ship FLY-912(待你拍板)",
		});
	});

	it("awaiting_review WITHOUT a gate row still parks on the founder (entry stamp)", () => {
		const t = deriveParkTuple(input());
		expect(t?.party).toBe("founder");
		expect(t?.waitingSinceMs).toBe(Date.parse("2026-07-07T08:10:00Z"));
	});

	it("brainstorm gate → founder with the brainstorm next step", () => {
		const t = deriveParkTuple(
			input({
				session: { status: "running" },
				pendingGates: [{ checkpoint: "brainstorm", createdAtMs: NOW - 1000 }],
			}),
		);
		expect(t?.party).toBe("founder");
		expect(t?.nextStep).toContain("brainstorm");
	});

	it("question gate → party=lead", () => {
		const t = deriveParkTuple(
			input({
				session: { status: "running" },
				pendingGates: [{ checkpoint: "question", createdAtMs: NOW - 1000 }],
			}),
		);
		expect(t?.party).toBe("lead");
	});

	it("auto-QA active → party=ci", () => {
		const t = deriveParkTuple(
			input({ session: { status: "running" }, autoQaActive: true }),
		);
		expect(t?.party).toBe("ci");
	});

	it("running with a reported stage, no gates → party=runner (derive only)", () => {
		const t = deriveParkTuple(
			input({ session: { status: "running", session_stage: "implement" } }),
		);
		expect(t?.party).toBe("runner");
	});

	it("running WITHOUT a stage report → null (nothing truthful to say)", () => {
		const t = deriveParkTuple(
			input({ session: { status: "running", session_stage: null } }),
		);
		expect(t).toBeNull();
	});

	it("evidence flag rides through", () => {
		expect(
			deriveParkTuple(input({ notifiedEvidence: true }))?.notifiedEvidence,
		).toBe(true);
	});
});

describe("formatParkAlert (FLY-912 truthful wording)", () => {
	it("approve park says 待你拍板 and NEVER says code review", () => {
		const t = deriveParkTuple(
			input({
				pendingGates: [
					{
						checkpoint: "approve_to_ship",
						createdAtMs: NOW - 3 * 3_600_000,
					},
				],
			}),
		)!;
		const line = formatParkAlert(t, NOW);
		expect(line).toBe(
			"[FLY-912] [Runner] 停在approve已3h,球在founder(待你拍板),owner=flywheel-eng-lead,下一步=等你 ship FLY-912(待你拍板)",
		);
		expect(line.toLowerCase()).not.toContain("code review");
	});

	it("missing stage renders (stage未上报) — never a guessed name", () => {
		const t = deriveParkTuple(
			input({
				session: { session_stage: null },
				pendingGates: [
					{ checkpoint: "approve_to_ship", createdAtMs: NOW - 3_600_000 },
				],
			}),
		)!;
		expect(formatParkAlert(t, NOW)).toContain("停在(stage未上报)");
	});
});
