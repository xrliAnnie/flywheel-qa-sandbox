import { payloadObjectKey } from "flywheel-release-contract";
import type { CustomerAttemptResult, CustomerReleasePermit } from "./types.js";

/** Reconciliation deliberately does not require the old beta or release pointer to remain active. */
export function validateAttemptResult(
	result: CustomerAttemptResult,
	permit: CustomerReleasePermit,
): void {
	const fields = [
		"attemptId",
		"decisionId",
		"nonce",
		"baseEtag",
		"kind",
		"reason",
		"manifest",
		"manifestEtag",
	];
	if (
		!result ||
		Object.keys(result).some((key) => !fields.includes(key)) ||
		result.attemptId !== permit.attemptId ||
		result.decisionId !== permit.decisionId ||
		result.nonce !== permit.nonce ||
		result.baseEtag !== permit.baseEtag
	)
		throw new Error("release result identity invalid");
	if (result.kind === "unknown") {
		if (result.reason || result.manifest || result.manifestEtag)
			throw new Error("unknown result invalid");
		return;
	}
	if (result.kind === "no_write") {
		if (
			!["guard_rejected", "cas_conflict"].includes(result.reason ?? "") ||
			result.manifest ||
			result.manifestEtag
		)
			throw new Error("no-write evidence invalid");
		return;
	}
	if (
		!["published", "fenced"].includes(result.kind) ||
		result.reason ||
		typeof result.manifestEtag !== "string" ||
		!/^[\x21-\x7e]{1,128}$/.test(result.manifestEtag) ||
		result.manifestEtag === permit.baseEtag
	)
		throw new Error("terminal evidence invalid");
	const manifest = result.manifest as {
		releaseOps?: Record<string, Record<string, unknown>>;
		versions?: Record<string, Record<string, unknown>>;
	} | null;
	const binding = permit.fullBinding;
	const op = manifest?.releaseOps?.[binding.releaseId];
	if (
		!op ||
		op.kind !== "release" ||
		op.state !== (result.kind === "published" ? "committed" : "abandoned") ||
		op.ver !== binding.releaseVersion ||
		op.sourceCommit !== binding.sourceCommit ||
		op.sha256 !== binding.releasePayloadSha256 ||
		op.betaVersion !== binding.betaVersion ||
		op.objectKey !==
			payloadObjectKey(binding.releaseVersion, binding.releasePayloadSha256)
	)
		throw new Error("terminal artifact mismatch");
	if (result.kind === "published") {
		const entry = manifest?.versions?.[binding.releaseVersion];
		if (
			!entry ||
			entry.channel !== "release" ||
			entry.sourceCommit !== binding.sourceCommit ||
			entry.sha256 !== binding.releasePayloadSha256
		)
			throw new Error("published artifact mismatch");
	}
}
