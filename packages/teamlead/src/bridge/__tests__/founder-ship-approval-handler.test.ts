/**
 * FLY-799 Part A — founder ship-approval handler (RED first).
 *
 * The assembly the deliverer's ship branch calls: identity (canonical founder) →
 * A-2 narrow to EXACTLY ONE current ship gate (status awaiting_review &&
 * review_question_id === questionId) → TextSource (v1) → shared gate-write
 * helper. Returns { handled, retrySafe } for the resolved gate; null when it
 * cannot safely attribute (non-founder / not exactly one current gate / unclear)
 * so the deliverer falls back to WAKE-only.
 */

import { describe, expect, it, vi } from "vitest";
import { tryFounderShipApproval } from "../approval-signal/founder-ship-approval-handler.js";

const CTX = {
	issueId: "issue-uuid",
	projectName: "proj",
	threadId: "T-1",
	ownerUserId: "FOUNDER-1",
	graceMs: 0,
	commDbPath: "/x",
	leadId: "lead",
};
const HEAD = "a".repeat(40);

const session = (over = {}) => ({
	status: "awaiting_review",
	review_question_id: "Q-1",
	pr_head_sha: HEAD,
	pr_number: 799,
	issue_identifier: "FLY-799",
	...over,
});

const oneShipGate = [
	{
		questionId: "Q-1",
		checkpoint: "approve_to_ship",
		executionId: "E-1",
		createdAtMs: 1,
	},
];

function deps(over = {}) {
	return {
		canonicalFounderId: "FOUNDER-1",
		store: { getSession: vi.fn().mockReturnValue(session()) },
		db: {},
		evaluateTextImpl: vi.fn().mockResolvedValue({
			source: "text",
			kind: "approve",
			questionId: "Q-1",
			prHeadSha: HEAD,
			messageId: "MSG-1",
			authorUserId: "FOUNDER-1",
		}),
		writeGateResponseImpl: vi
			.fn()
			.mockResolvedValue({ written: true, retrySafe: true }),
		...over,
	};
}

const founderMsg = { id: "MSG-1", content: "ship it", authorId: "FOUNDER-1" };

describe("tryFounderShipApproval — approve path", () => {
	it("founder approval on the one current gate → writes approval, returns handled", async () => {
		const d = deps();
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toEqual({ handled: ["Q-1"], retrySafe: true });
		// wrote a structured approval for this gate
		const [writeArgs] = d.writeGateResponseImpl.mock.calls[0];
		expect(writeArgs.questionId).toBe("Q-1");
		expect(writeArgs.actor).toBe("FOUNDER-1");
		expect(JSON.parse(writeArgs.answer).approved).toBe(true);
	});
});

describe("tryFounderShipApproval — fail-closed (returns null → WAKE-only)", () => {
	it("non-founder author → null (never evaluates)", async () => {
		const d = deps();
		const r = await tryFounderShipApproval(
			{
				msg: { ...founderMsg, authorId: "SOMEONE" },
				shipGates: oneShipGate,
				ctx: CTX,
			},
			d,
		);
		expect(r).toBeNull();
		expect(d.evaluateTextImpl).not.toHaveBeenCalled();
	});

	it("A-2: more than one current ship gate → null (no write)", async () => {
		const d = deps({
			store: {
				getSession: vi
					.fn()
					.mockImplementation((e: string) =>
						session({ review_question_id: e === "E-1" ? "Q-1" : "Q-2" }),
					),
			},
		});
		const two = [
			{
				questionId: "Q-1",
				checkpoint: "approve_to_ship",
				executionId: "E-1",
				createdAtMs: 1,
			},
			{
				questionId: "Q-2",
				checkpoint: "approve_to_ship",
				executionId: "E-2",
				createdAtMs: 2,
			},
		];
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: two, ctx: CTX },
			d,
		);
		expect(r).toBeNull();
		expect(d.writeGateResponseImpl).not.toHaveBeenCalled();
	});

	it("gate not awaiting_review → not a current gate → null", async () => {
		const d = deps({
			store: {
				getSession: vi.fn().mockReturnValue(session({ status: "running" })),
			},
		});
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toBeNull();
	});

	it("review_question_id mismatch → not the current gate → null", async () => {
		const d = deps({
			store: {
				getSession: vi
					.fn()
					.mockReturnValue(session({ review_question_id: "Q-OTHER" })),
			},
		});
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toBeNull();
	});

	it("TextSource unclear → null (WAKE-only, no write)", async () => {
		const d = deps({
			evaluateTextImpl: vi.fn().mockResolvedValue({
				source: "text",
				kind: "unclear",
				questionId: "Q-1",
				prHeadSha: HEAD,
				messageId: "MSG-1",
				authorUserId: "FOUNDER-1",
			}),
		});
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toBeNull();
		expect(d.writeGateResponseImpl).not.toHaveBeenCalled();
	});
});

describe("tryFounderShipApproval — reject path", () => {
	it("TextSource reject → writes feedback (not approval), returns handled", async () => {
		const d = deps({
			evaluateTextImpl: vi.fn().mockResolvedValue({
				source: "text",
				kind: "reject",
				questionId: "Q-1",
				prHeadSha: HEAD,
				messageId: "MSG-1",
				authorUserId: "FOUNDER-1",
			}),
		});
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toMatchObject({ handled: ["Q-1"] });
		const [writeArgs] = d.writeGateResponseImpl.mock.calls[0];
		expect(JSON.parse(writeArgs.answer).approved).not.toBe(true);
	});
});

describe("tryFounderShipApproval — image approval (default-off fast-follow)", () => {
	const imgAttachments = [
		{
			id: "A-1",
			filename: "ok.png",
			contentType: "image/png",
			byteSize: 1234,
			sha256: "deadbeef",
		},
	];
	const imageMsg = {
		id: "MSG-1",
		content: "",
		authorId: "FOUNDER-1",
		imageAttachments: imgAttachments,
	};

	it("flag on + evaluator + attachments: image approve is authoritative (skips text)", async () => {
		const evaluateImageImpl = vi.fn().mockResolvedValue({
			source: "image",
			kind: "approve",
			questionId: "Q-1",
			prHeadSha: HEAD,
			messageId: "MSG-1",
			authorUserId: "FOUNDER-1",
			evidenceAttachmentIds: ["A-1"],
			imageHashes: ["deadbeef"],
		});
		const d = deps({ imageApproval: true, evaluateImageImpl });
		const r = await tryFounderShipApproval(
			{ msg: imageMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toEqual({ handled: ["Q-1"], retrySafe: true });
		expect(evaluateImageImpl).toHaveBeenCalledOnce();
		expect(d.evaluateTextImpl).not.toHaveBeenCalled();
		expect(
			JSON.parse(d.writeGateResponseImpl.mock.calls[0][0].answer).approved,
		).toBe(true);
	});

	it("image unclear → falls through to the text path", async () => {
		const evaluateImageImpl = vi
			.fn()
			.mockResolvedValue({ source: "image", kind: "unclear" });
		const d = deps({ imageApproval: true, evaluateImageImpl });
		await tryFounderShipApproval(
			{ msg: imageMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(evaluateImageImpl).toHaveBeenCalledOnce();
		expect(d.evaluateTextImpl).toHaveBeenCalledOnce(); // fell through
	});

	it("flag off (default) → image evaluator never runs even with attachments", async () => {
		const evaluateImageImpl = vi.fn();
		const d = deps({ imageApproval: false, evaluateImageImpl });
		await tryFounderShipApproval(
			{ msg: imageMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(evaluateImageImpl).not.toHaveBeenCalled();
		expect(d.evaluateTextImpl).toHaveBeenCalledOnce();
	});
});
