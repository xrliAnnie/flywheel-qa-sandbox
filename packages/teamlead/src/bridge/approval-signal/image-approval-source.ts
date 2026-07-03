/**
 * FLY-799 Part A — ImageSource.
 *
 * Founder image confirmation → bound ApprovalSignal. Multimodal Haiku on
 * subscription is verified (`claude -p '@image'`, 2026-07-02). Pipeline:
 * identity (canonical founder) → MIME/size allowlist filter → injected
 * multimodal classify → evidence binding (Codex R5): an approve is honored ONLY
 * when the classifier grounds on this exact message (evidenceMessageId ===
 * message.id) AND on the founder's own image (evidenceAttachmentIds a non-empty
 * subset of the accepted attachment ids). Non-founder / no valid image / classify
 * failure / evidence mismatch → null or unclear (fail-closed → WAKE-only).
 *
 * Attachments arrive already downloaded + sha256'd by the caller (the deliverer's
 * fetch step, with the same MIME/size guards); this source re-applies them
 * defensively and never trusts a raw URL.
 */

import type { ApprovalSignal, GateBinding } from "./types.js";

export interface ImageAttachment {
	id: string;
	filename: string;
	contentType: string;
	byteSize: number;
	sha256: string;
}

export interface ImageSourceArgs {
	gate: Omit<GateBinding, "targetMessageId">;
	message: {
		id: string;
		authorId: string;
		imageAttachments: ImageAttachment[];
	};
}

export interface ImageClassifyResult {
	kind: "approve" | "reject" | "unclear";
	evidenceMessageId?: string;
	evidenceAttachmentIds?: string[];
}

export type ImageClassifyImpl = (input: {
	expectedMessageId: string;
	expectedAttachmentIds: string[];
	attachments: ImageAttachment[];
	gate: Omit<GateBinding, "targetMessageId">;
}) => Promise<ImageClassifyResult>;

export interface ImageSourceDeps {
	classifyImpl: ImageClassifyImpl;
	mimeAllowlist?: readonly string[];
	maxBytes?: number;
}

const DEFAULT_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const DEFAULT_MAX_BYTES = 10_000_000; // 10 MB

export async function evaluateImageSource(
	args: ImageSourceArgs,
	deps: ImageSourceDeps,
): Promise<ApprovalSignal | null> {
	const { gate, message } = args;

	// Identity: only the canonical founder's own message can be an approval.
	if (message.authorId !== gate.canonicalFounderId) return null;

	const mime = deps.mimeAllowlist ?? DEFAULT_MIME;
	const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
	const valid = message.imageAttachments.filter(
		(a) => mime.includes(a.contentType) && a.byteSize <= maxBytes,
	);
	if (valid.length === 0) return null; // no acceptable image → no signal

	const validIds = valid.map((a) => a.id);
	const result = await deps.classifyImpl({
		expectedMessageId: message.id,
		expectedAttachmentIds: validIds,
		attachments: valid,
		gate,
	});

	const base = {
		source: "image" as const,
		questionId: gate.questionId,
		prHeadSha: gate.prHeadSha,
		messageId: message.id,
		authorUserId: message.authorId,
		evidenceAttachmentIds: validIds,
		imageHashes: valid.map((a) => a.sha256),
	};

	if (result.kind === "approve") {
		// Binding: grounded on THIS message AND on a non-empty subset of the
		// founder's own accepted attachments.
		const ev = result.evidenceAttachmentIds ?? [];
		const evidenceOk =
			result.evidenceMessageId === message.id &&
			ev.length > 0 &&
			ev.every((id) => validIds.includes(id));
		if (!evidenceOk) return { ...base, kind: "unclear" };
		const hashes = valid.filter((a) => ev.includes(a.id)).map((a) => a.sha256);
		return {
			...base,
			kind: "approve",
			evidenceAttachmentIds: ev,
			imageHashes: hashes,
		};
	}
	if (result.kind === "reject") return { ...base, kind: "reject" };
	return { ...base, kind: "unclear" };
}
