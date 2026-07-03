/**
 * FLY-799 Part A — ImageSource (RED first).
 *
 * Founder image confirmation → bound ApprovalSignal (multimodal Haiku verified
 * on subscription). Source-level logic: identity (canonical founder) → MIME/size
 * allowlist filter → injected multimodal classify → evidence binding (Codex R5):
 * an approve is honored ONLY when the classifier echoes evidenceMessageId ===
 * message id AND evidenceAttachmentIds ⊆ the founder's image attachments (non
 * empty). No valid image / classify failure / evidence mismatch → null or
 * unclear (fail-closed). Attachments are pre-downloaded + sha256'd by the caller.
 */

import { describe, expect, it, vi } from "vitest";
import { evaluateImageSource } from "../approval-signal/image-approval-source.js";
import type { GateBinding } from "../approval-signal/types.js";

const GATE: Omit<GateBinding, "targetMessageId"> = {
	questionId: "Q-1",
	executionId: "E-1",
	issueId: "I-1",
	issueIdentifier: "FLY-799",
	prHeadSha: "a".repeat(40),
	prNumber: 799,
	threadId: "T-1",
	canonicalFounderId: "FOUNDER-1",
};

const att = (over = {}) => ({
	id: "ATT-1",
	filename: "shot.png",
	contentType: "image/png",
	byteSize: 5000,
	sha256: "hash-1",
	...over,
});

const message = (over = {}) => ({
	id: "MSG-1",
	authorId: "FOUNDER-1",
	imageAttachments: [att()],
	...over,
});

describe("evaluateImageSource — approve (bound)", () => {
	it("founder image + classifier approve with matching evidence → approve", async () => {
		const classifyImpl = vi.fn().mockResolvedValue({
			kind: "approve",
			evidenceMessageId: "MSG-1",
			evidenceAttachmentIds: ["ATT-1"],
		});
		const sig = await evaluateImageSource(
			{ gate: GATE, message: message() },
			{ classifyImpl },
		);
		expect(sig).toMatchObject({
			source: "image",
			kind: "approve",
			messageId: "MSG-1",
			evidenceAttachmentIds: ["ATT-1"],
			imageHashes: ["hash-1"],
		});
	});
});

describe("evaluateImageSource — fail-closed", () => {
	it("non-founder author → null (never classifies)", async () => {
		const classifyImpl = vi.fn();
		const sig = await evaluateImageSource(
			{ gate: GATE, message: message({ authorId: "OTHER" }) },
			{ classifyImpl },
		);
		expect(sig).toBeNull();
		expect(classifyImpl).not.toHaveBeenCalled();
	});

	it("no image attachments → null (never classifies)", async () => {
		const classifyImpl = vi.fn();
		const sig = await evaluateImageSource(
			{ gate: GATE, message: message({ imageAttachments: [] }) },
			{ classifyImpl },
		);
		expect(sig).toBeNull();
		expect(classifyImpl).not.toHaveBeenCalled();
	});

	it("non-image MIME filtered out → null", async () => {
		const classifyImpl = vi.fn();
		const sig = await evaluateImageSource(
			{
				gate: GATE,
				message: message({
					imageAttachments: [att({ contentType: "application/pdf" })],
				}),
			},
			{ classifyImpl },
		);
		expect(sig).toBeNull();
		expect(classifyImpl).not.toHaveBeenCalled();
	});

	it("oversized image filtered out → null", async () => {
		const classifyImpl = vi.fn();
		const sig = await evaluateImageSource(
			{
				gate: GATE,
				message: message({
					imageAttachments: [att({ byteSize: 999_999_999 })],
				}),
			},
			{ classifyImpl, maxBytes: 10_000_000 },
		);
		expect(sig).toBeNull();
	});

	it("approve but evidence attachment NOT in the founder's attachments → unclear", async () => {
		const classifyImpl = vi.fn().mockResolvedValue({
			kind: "approve",
			evidenceMessageId: "MSG-1",
			evidenceAttachmentIds: ["ATT-OTHER"],
		});
		const sig = await evaluateImageSource(
			{ gate: GATE, message: message() },
			{ classifyImpl },
		);
		expect(sig?.kind).toBe("unclear");
	});

	it("approve but evidenceMessageId mismatch → unclear", async () => {
		const classifyImpl = vi.fn().mockResolvedValue({
			kind: "approve",
			evidenceMessageId: "MSG-OTHER",
			evidenceAttachmentIds: ["ATT-1"],
		});
		const sig = await evaluateImageSource(
			{ gate: GATE, message: message() },
			{ classifyImpl },
		);
		expect(sig?.kind).toBe("unclear");
	});

	it("classifier reject → reject; unclear → unclear", async () => {
		const rej = await evaluateImageSource(
			{ gate: GATE, message: message() },
			{ classifyImpl: vi.fn().mockResolvedValue({ kind: "reject" }) },
		);
		expect(rej?.kind).toBe("reject");
		const unc = await evaluateImageSource(
			{ gate: GATE, message: message() },
			{ classifyImpl: vi.fn().mockResolvedValue({ kind: "unclear" }) },
		);
		expect(unc?.kind).toBe("unclear");
	});
});
