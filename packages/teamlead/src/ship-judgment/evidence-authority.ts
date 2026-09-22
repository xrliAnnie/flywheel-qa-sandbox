import type Database from "better-sqlite3";
import type {
	CodeReviewAtHead,
	DesignApproval,
	QaAuthority,
} from "./evidence-ledger.js";

function iso(value: string): string {
	return new Date(
		value.includes("T") ? value : `${value.replace(" ", "T")}Z`,
	).toISOString();
}
const validTime = (value: string) => Number.isFinite(Date.parse(value));
function issues(issueId: string, aliases: string[]): string[] {
	const values = [...new Set([issueId, ...aliases])];
	if (values.length > 200 || values.some((v) => !v || v.length > 200))
		throw new Error("invalid_evidence_issue_aliases");
	return values;
}
interface ReviewRow {
	request_id: string;
	execution_id: string;
	target_path: string | null;
	round: number;
	status: string;
	verdict: string | null;
	responded_at: string | null;
	created_at: string;
}

/** Read-only shared queries for online collection and a caller-owned offline snapshot. */
export class EvidenceAuthorityReader {
	private readonly hasDesignReviewApprovalProof: boolean;

	constructor(private readonly db: Database.Database) {
		this.hasDesignReviewApprovalProof = Boolean(
			db
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type='table' AND name='design_review_approval_proof' LIMIT 1",
				)
				.get(),
		);
	}

	aliases(runId: string): string[] {
		return (
			this.db
				.prepare(
					"SELECT issue_alias FROM workflow_run_issue_alias WHERE run_id=? ORDER BY issue_alias LIMIT 201",
				)
				.all(runId) as { issue_alias: string }[]
		).map((row) => row.issue_alias);
	}

	designApproval(
		issueId: string,
		aliases: string[],
		repoIdentity: string,
		asOf = new Date().toISOString(),
	): DesignApproval | undefined {
		if (!validTime(asOf)) return undefined;
		const names = issues(issueId, aliases);
		const row = this.db
			.prepare(`SELECT * FROM codex_review_job WHERE project_name='flywheel'
			AND review_type='design' AND target_repo_identity=? AND issue_id IN (${names.map(() => "?").join(",")})
			AND julianday(created_at)<=julianday(?) ORDER BY julianday(created_at) DESC,round DESC,request_id DESC LIMIT 1`)
			.get(repoIdentity, ...names, asOf) as ReviewRow | undefined;
		if (!row) return undefined;
		const answered =
			row.status === "done" &&
			row.responded_at &&
			validTime(row.responded_at) &&
			Date.parse(iso(row.responded_at)) <= Date.parse(asOf);
		const status =
			answered && row.verdict === "APPROVED" && row.target_path
				? "approved"
				: answered && row.verdict === "CHANGES_REQUESTED"
					? "changes_requested"
					: "superseded";
		const proof = this.hasDesignReviewApprovalProof
			? (this.db
					.prepare(`SELECT expected_blob_sha FROM design_review_approval_proof
			WHERE lane='coordinator' AND review_job_request_id=? AND execution_id=?
			AND repository_identity=? AND plan_path=? AND state='approved'
			AND julianday(approved_at)<=julianday(?) LIMIT 1`)
					.get(
						row.request_id,
						row.execution_id,
						repoIdentity,
						row.target_path,
						asOf,
					) as { expected_blob_sha: string } | undefined)
			: undefined;
		return {
			requestId: row.request_id,
			executionId: row.execution_id,
			path: row.target_path ?? "",
			round: row.round,
			status,
			respondedAt: iso(answered ? row.responded_at! : row.created_at),
			...(proof ? { expectedBlobSha: proof.expected_blob_sha } : {}),
		};
	}

	codeReviewAtHead(
		issueId: string,
		aliases: string[],
		repoIdentity: string,
		headSha: string,
		asOf = new Date().toISOString(),
	): CodeReviewAtHead | undefined {
		if (!validTime(asOf) || !/^[a-f0-9]{40}$/i.test(headSha)) return undefined;
		const names = issues(issueId, aliases);
		const row = this.db
			.prepare(`SELECT request_id,round,verdict,responded_at FROM codex_review_job
			WHERE project_name='flywheel' AND review_type='code' AND status='done' AND target_repo_identity=?
			AND lower(frozen_head_sha)=lower(?) AND issue_id IN (${names.map(() => "?").join(",")})
			AND julianday(responded_at)<=julianday(?) AND julianday(created_at)<=julianday(?)
			ORDER BY julianday(responded_at) DESC,round DESC,request_id DESC LIMIT 1`)
			.get(repoIdentity, headSha, ...names, asOf, asOf) as
			| Pick<ReviewRow, "request_id" | "round" | "verdict" | "responded_at">
			| undefined;
		return row?.responded_at
			? {
					requestId: row.request_id,
					round: row.round,
					verdict: row.verdict ?? "unknown",
					respondedAt: iso(row.responded_at),
				}
			: undefined;
	}

	qaAuthority(
		runId: string,
		repoIdentity: string,
		headSha: string,
		asOf: string,
	): QaAuthority {
		const absent: QaAuthority = {
			verdict: "undetermined",
			reason: "evidence_missing",
		};
		if (!validTime(asOf) || !/^[a-f0-9]{40}$/i.test(headSha)) return absent;
		// Claims bind a head. First prove that this head belongs to this run/repository.
		const target = this.db
			.prepare(`SELECT 1 FROM workflow_node_pr_binding b JOIN workflow_run r ON r.run_id=b.run_id
			WHERE b.run_id=? AND r.project_name='flywheel' AND b.target_repo_identity=? AND lower(b.head_sha)=lower(?)
			AND julianday(b.bound_at)<=julianday(?)
			UNION ALL SELECT 1 FROM workflow_declared_pr d JOIN workflow_run r ON r.run_id=d.run_id
			WHERE d.run_id=? AND r.project_name='flywheel' AND d.repo_identity=? AND lower(d.frozen_head_sha)=lower(?)
			AND julianday(d.declared_at)<=julianday(?) AND d.revision=(SELECT MAX(revision) FROM workflow_declared_pr WHERE run_id=d.run_id AND julianday(declared_at)<=julianday(?)) LIMIT 1`)
			.get(
				runId,
				repoIdentity,
				headSha,
				asOf,
				runId,
				repoIdentity,
				headSha,
				asOf,
				asOf,
			);
		if (!target) return absent;
		const node = this.db
			.prepare(`SELECT attempt,execution_id FROM workflow_run_node WHERE run_id=? AND node_id='qa'
			AND julianday(started_at)<=julianday(?) ORDER BY attempt DESC LIMIT 1`)
			.get(runId, asOf) as
			| { attempt: number; execution_id: string | null }
			| undefined;
		if (!node) return absent;
		const rows = this.db
			.prepare(`SELECT c.*,EXISTS(SELECT 1 FROM workflow_claim_revocation r WHERE r.claim_id=c.id
			AND julianday(r.revoked_at)<=julianday(?)) AS revoked FROM workflow_claims c
			WHERE c.workflow_run_id=? AND c.node_id='qa' AND c.decision_kind='qa_verdict' AND c.subject_kind='git_head'
			AND lower(c.subject_digest)=lower(?) AND julianday(c.issued_at)<=julianday(?) ORDER BY c.attempt DESC,c.server_seq DESC`)
			.all(asOf, runId, headSha, asOf) as {
			id: number;
			server_seq: number;
			attempt: number;
			issuer_kind: string;
			issuer_node_id: string;
			issuer_execution_id: string;
			predicate: string;
			issued_at: string;
			permanent: number;
			expires_at: string | null;
			revoked: number;
			evidence: string | null;
		}[];
		const candidate = rows[0];
		if (!candidate) return absent;
		let summary: string | undefined;
		try {
			const evidence = JSON.parse(candidate.evidence ?? "null");
			if (typeof evidence?.summary === "string") summary = evidence.summary;
		} catch {
			/* Missing report text does not invalidate a server claim. */
		}
		const result: QaAuthority = {
			...absent,
			claimId: String(candidate.id),
			serverSeq: candidate.server_seq,
			predicate: candidate.predicate,
			issuedAt: iso(candidate.issued_at),
			revoked: candidate.revoked === 1,
			...(summary ? { summary } : {}),
		};
		const reject = (reason: QaAuthority["reason"]): QaAuthority => ({
			...result,
			verdict: "fail",
			reason,
		});
		if (candidate.attempt !== node.attempt)
			return reject("qa_claim_stale_attempt");
		if (
			!node.execution_id ||
			candidate.issuer_execution_id !== node.execution_id ||
			candidate.issuer_kind !== "runner_node" ||
			candidate.issuer_node_id !== "qa"
		)
			return reject("qa_claim_wrong_issuer");
		if (
			rows.some(
				(row) =>
					row.attempt === candidate.attempt &&
					row.predicate !== candidate.predicate,
			)
		)
			return reject("qa_claim_inconsistent");
		if (candidate.revoked) return reject("qa_claim_revoked");
		if (
			candidate.permanent !== 1 &&
			(!candidate.expires_at ||
				!validTime(candidate.expires_at) ||
				Date.parse(iso(candidate.expires_at)) <= Date.parse(asOf))
		)
			return result;
		if (candidate.predicate === "qa_failed") return reject("qa_failed");
		if (candidate.predicate !== "qa_passed") return result;
		return { ...result, verdict: "pass", reason: "evidence_complete" };
	}
}
