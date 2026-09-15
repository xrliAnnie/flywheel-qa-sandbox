import { createHash } from "node:crypto";
import {
	classifyRecordUrl,
	type RecordUrlClassificationOptions,
	type StrengthTwoReportRegistry,
} from "../bridge/strength-two-probes.js";
import type { StrengthTwoEvidenceRecordRow } from "../StateStore.js";
import type { QaSourceBody } from "./collect.js";
import type { QaAuthority } from "./evidence-ledger.js";
import { selectQaReportReference } from "./qa-report-reference.js";

/** Only a single report on the configured host can supply semantic QA bytes. */
export function readClaimQaSource(
	target: { runId: string; repoIdentity: string; headSha: string },
	claim: QaAuthority | undefined,
	registry: Pick<StrengthTwoReportRegistry, "readReportHtml">,
	hosting: RecordUrlClassificationOptions,
): (QaSourceBody & { reportToken: string }) | null {
	if (
		!claim?.claimId ||
		!claim.summary ||
		claim.summary.length > 65_536 ||
		!["evidence_complete", "qa_failed"].includes(claim.reason) ||
		claim.revoked
	)
		return null;
	const reference = selectQaReportReference(claim.summary);
	if (!reference) return null;
	const location = classifyRecordUrl(reference.url, hosting);
	if (location.kind !== "hosted_report") return null;
	const reportToken = location.token;
	try {
		const body = registry.readReportHtml(reportToken);
		if (!body.trim() || Buffer.byteLength(body) > 262_144) return null;
		return {
			...target,
			body,
			format: "html",
			revision: JSON.stringify({ claim: claim.claimId, report: reportToken }),
			digest: createHash("sha256").update(body).digest("hex"),
			withdrawn: false,
			reportToken,
		};
	} catch {
		return null;
	}
}

export type QaEvidenceRow = Pick<
	StrengthTwoEvidenceRecordRow,
	| "record_id"
	| "recorded_at"
	| "run_id"
	| "target_repo_identity"
	| "head_sha"
	| "record_url"
	| "record_url_kind"
	| "record_status"
	| "record_digest"
	| "record_bytes"
>;

/** Read retained, verified bytes, not a URL supplied by a model. This is not a liveness probe. */
export function readHostedQaSource(
	target: { runId: string; repoIdentity: string; headSha: string },
	rows: readonly QaEvidenceRow[],
	registry: Pick<StrengthTwoReportRegistry, "readReportHtml">,
	hosting: RecordUrlClassificationOptions,
): QaSourceBody | null {
	const row = rows
		.filter(
			(row) =>
				row.run_id === target.runId &&
				row.target_repo_identity === target.repoIdentity &&
				row.head_sha === target.headSha,
		)
		.sort(
			(a, b) =>
				b.recorded_at.localeCompare(a.recorded_at) ||
				b.record_id.localeCompare(a.record_id),
		)[0];
	// A later invalidated record must not expose an earlier successful report.
	if (
		!row ||
		row.record_status !== "satisfied" ||
		row.record_url_kind !== "hosted_report" ||
		!row.record_digest ||
		!Number.isSafeInteger(row.record_bytes) ||
		row.record_bytes! <= 0 ||
		row.record_bytes! > 262_144
	)
		return null;
	const location = classifyRecordUrl(row.record_url, hosting);
	if (location.kind !== "hosted_report") return null;
	try {
		const body = registry.readReportHtml(location.token);
		const digest = createHash("sha256").update(body).digest("hex");
		if (
			Buffer.byteLength(body) !== row.record_bytes ||
			digest !== row.record_digest
		)
			return null;
		return {
			body,
			format: "html",
			revision: row.record_id,
			...target,
			digest,
			withdrawn: false,
		};
	} catch {
		return null;
	}
}
