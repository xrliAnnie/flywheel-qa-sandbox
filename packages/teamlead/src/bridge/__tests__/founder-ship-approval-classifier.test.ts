/**
 * FLY-799 Part A-3 — FounderShipApprovalClassifier (RED first).
 *
 * Tier-3: only reached for genuinely ambiguous free text (Tier-2 exact allowlist
 * missed and it wasn't a ✅). Builds a strict prompt, calls the subscription
 * runner (injected here), and maps the model's verdict to a ClassifierVerdict —
 * with the Codex R1 #1 binding: an "approve" is honored ONLY when the model's
 * echoed `evidence_message_id` exactly equals `expectedMessageId`. Any runner
 * failure, wrong shape, or evidence mismatch → `unclear` (fail-closed →
 * WAKE-only, no approval).
 */

import { describe, expect, it, vi } from "vitest";
import { classifyFounderShipApproval } from "../approval-signal/founder-ship-approval-classifier.js";
import type { RunnerResult } from "../approval-signal/subscription-claude-classifier-runner.js";

const INPUT = {
	expectedMessageId: "MSG-1",
	messageContent: "yeah go for it I guess it's fine now",
	questionId: "Q-1",
	executionId: "EXEC-1",
	issueId: "issue-uuid",
	issueIdentifier: "FLY-799",
	prHeadSha: "a".repeat(40),
};

const runnerFor = (verdict: unknown): (() => Promise<RunnerResult>) =>
	vi.fn().mockResolvedValue({ ok: true, verdict });

describe("classifyFounderShipApproval — mapping", () => {
	it("approve WITH matching evidence_message_id → approve", async () => {
		const res = await classifyFounderShipApproval(INPUT, {
			runnerImpl: runnerFor({
				decision: "approve",
				evidence_message_id: "MSG-1",
			}),
		});
		expect(res).toEqual({ kind: "approve", evidenceMessageId: "MSG-1" });
	});

	it("approve but MISMATCHED evidence_message_id → unclear (fail-closed)", async () => {
		const res = await classifyFounderShipApproval(INPUT, {
			runnerImpl: runnerFor({
				decision: "approve",
				evidence_message_id: "MSG-OTHER",
			}),
		});
		expect(res.kind).toBe("unclear");
	});

	it("approve but missing evidence_message_id → unclear", async () => {
		const res = await classifyFounderShipApproval(INPUT, {
			runnerImpl: runnerFor({ decision: "approve" }),
		});
		expect(res.kind).toBe("unclear");
	});

	it("reject → reject", async () => {
		const res = await classifyFounderShipApproval(INPUT, {
			runnerImpl: runnerFor({
				decision: "reject",
				evidence_message_id: "MSG-1",
			}),
		});
		expect(res.kind).toBe("reject");
	});

	it("unclear → unclear", async () => {
		const res = await classifyFounderShipApproval(INPUT, {
			runnerImpl: runnerFor({
				decision: "unclear",
				evidence_message_id: "MSG-1",
			}),
		});
		expect(res.kind).toBe("unclear");
	});
});

describe("classifyFounderShipApproval — fail-closed", () => {
	it("runner ok:false → unclear", async () => {
		const res = await classifyFounderShipApproval(INPUT, {
			runnerImpl: vi
				.fn()
				.mockResolvedValue({ ok: false, reason: "exec_failed" }),
		});
		expect(res.kind).toBe("unclear");
	});

	it("unknown decision value → unclear", async () => {
		const res = await classifyFounderShipApproval(INPUT, {
			runnerImpl: runnerFor({
				decision: "ship-it-yolo",
				evidence_message_id: "MSG-1",
			}),
		});
		expect(res.kind).toBe("unclear");
	});

	it("verdict not an object → unclear", async () => {
		const res = await classifyFounderShipApproval(INPUT, {
			runnerImpl: runnerFor("approve"),
		});
		expect(res.kind).toBe("unclear");
	});
});

describe("classifyFounderShipApproval — prompt binding", () => {
	it("prompt carries the expected message id, issue identifier, and message text", async () => {
		const runnerImpl = vi.fn().mockResolvedValue({
			ok: true,
			verdict: { decision: "unclear", evidence_message_id: "MSG-1" },
		});
		await classifyFounderShipApproval(INPUT, { runnerImpl });
		const [prompt] = runnerImpl.mock.calls[0] as [string, unknown];
		expect(prompt).toContain("MSG-1");
		expect(prompt).toContain("FLY-799");
		expect(prompt).toContain(INPUT.messageContent);
	});
});

describe("classifyFounderShipApproval — failure attribution (FLY-1041 Chunk 4)", () => {
	it("runner ok:false → unclear WITH runnerFailed + the runner's reason (no longer folded away)", async () => {
		const res = await classifyFounderShipApproval(INPUT, {
			runnerImpl: async () => ({ ok: false, reason: "cli_missing" }),
		});
		expect(res).toMatchObject({
			kind: "unclear",
			runnerFailed: true,
			reason: "cli_missing",
		});
	});

	it("runner throw → unclear WITH runnerFailed", async () => {
		const res = await classifyFounderShipApproval(INPUT, {
			runnerImpl: async () => {
				throw new Error("boom");
			},
		});
		expect(res).toMatchObject({ kind: "unclear", runnerFailed: true });
	});

	it("evidence mismatch → unclear with a distinguishing reason (NOT runnerFailed)", async () => {
		const res = await classifyFounderShipApproval(INPUT, {
			runnerImpl: async () => ({
				ok: true,
				verdict: { decision: "approve", evidence_message_id: "WRONG" },
			}),
		});
		expect(res.kind).toBe("unclear");
		expect((res as { runnerFailed?: boolean }).runnerFailed).toBeUndefined();
		expect((res as { reason?: string }).reason).toBe(
			"evidence_message_id_mismatch",
		);
	});
});
