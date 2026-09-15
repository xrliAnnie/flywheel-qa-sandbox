import type Database from "better-sqlite3";
import { expect, it } from "vitest";
import { bindingFixture, HEAD } from "./binding-fixture.js";

const BEFORE = "2026-09-11T00:00:00.000Z",
	AT = "2026-09-14T20:00:00.000Z",
	AFTER = "2026-09-14T21:00:00.000Z";
function review(
	db: Database.Database,
	id: string,
	options: {
		type?: string;
		issue?: string;
		repo?: string;
		status?: string;
		verdict?: string;
		time?: string;
		head?: string;
	} = {},
) {
	db.prepare(`INSERT INTO codex_review_job(request_id,execution_id,issue_id,project_name,review_type,round,question_id,target_path,target_repo_identity,frozen_head_sha,status,verdict,created_at,responded_at)
		VALUES (?,? ,?,'flywheel',?,1,?,'engineering/doc/plan.md',?,?,?,?,?,?)`).run(
		id,
		`exec-${id}`,
		options.issue ?? "FLY-2399",
		options.type ?? "design",
		`question-${id}`,
		options.repo ?? "__main__",
		options.head ?? HEAD,
		options.status ?? "done",
		options.verdict ?? "APPROVED",
		options.time ?? BEFORE,
		options.status === "pending" ? null : (options.time ?? BEFORE),
	);
}
function qaNode(db: Database.Database, attempt = 1, at = BEFORE) {
	db.prepare(
		"INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at) VALUES ('r','qa',?,'completed',?,?)",
	).run(attempt, `qa-${attempt}`, at);
}
function claim(
	db: Database.Database,
	seq: number,
	options: {
		attempt?: number;
		issuer?: string;
		predicate?: string;
		issuedAt?: string;
		expiresAt?: string;
		head?: string;
	} = {},
) {
	db.prepare(`INSERT INTO workflow_claims(server_seq,issue_id,workflow_run_id,node_id,decision_kind,attempt,predicate,issuer_kind,issuer_execution_id,issuer_node_id,issuer_vendor,issuer_model,subject_kind,subject_digest,permanent,expires_at,submission_digest,client_request_id,evidence,authority_id,issued_at)
		VALUES (?,'FLY-2399','r','qa','qa_verdict',?,?,'runner_node',?,'qa','codex','fixture','git_head',?,?,?,?,?,'{"summary":"QA https://reports.vercel.app/r/report/"}','authority',?)`).run(
		seq,
		options.attempt ?? 1,
		options.predicate ?? "qa_passed",
		options.issuer ?? `qa-${options.attempt ?? 1}`,
		options.head ?? HEAD,
		options.expiresAt ? 0 : 1,
		options.expiresAt ?? null,
		`digest-${seq}`,
		`client-${seq}`,
		options.issuedAt ?? BEFORE,
	);
	return Number(
		(
			db
				.prepare("SELECT id FROM workflow_claims WHERE server_seq=?")
				.get(seq) as { id: number }
		).id,
	);
}

it("reads design approval across execution/issue aliases and binds manifest by execution, not request", async () => {
	const { store, db } = await bindingFixture();
	try {
		review(db, "approved", { issue: "issue-uuid" });
		expect(
			store.readShipJudgmentDesignApproval("FLY-2399", [], "__main__", AT),
		).toBeUndefined();
		const approval = store.readShipJudgmentDesignApproval(
			"FLY-2399",
			["issue-uuid"],
			"__main__",
			AT,
		);
		expect(approval).toMatchObject({
			requestId: "approved",
			status: "approved",
			path: "engineering/doc/plan.md",
		});
		expect(approval?.expectedBlobSha).toBeUndefined();
		db.prepare(`INSERT INTO design_review_manifest(execution_id,revision,request_id,project_name,source_event_id,expected_plan_path,expected_blob_sha,created_at)
			VALUES ('exec-approved',1,'distinct-manifest-request','flywheel','source','engineering/doc/plan.md',?,?)`).run(
			"b".repeat(40),
			BEFORE,
		);
		expect(
			store.readShipJudgmentDesignApproval(
				"FLY-2399",
				["issue-uuid"],
				"__main__",
				AT,
			)?.expectedBlobSha,
		).toBe("b".repeat(40));
		expect(
			store.readShipJudgmentDesignApproval(
				"FLY-2399",
				["issue-uuid"],
				"nested",
				AT,
			),
		).toBeUndefined();
	} finally {
		store.close();
	}
});

it("newer pending or negative design review supersedes approval, while future review does not leak into replay", async () => {
	const { store, db } = await bindingFixture();
	try {
		review(db, "first");
		review(db, "future", { time: AFTER, verdict: "CHANGES_REQUESTED" });
		expect(
			store.readShipJudgmentDesignApproval("FLY-2399", [], "__main__", AT)
				?.status,
		).toBe("approved");
		review(db, "pending", { time: "2026-09-14T19:00:00Z", status: "pending" });
		expect(
			store.readShipJudgmentDesignApproval("FLY-2399", [], "__main__", AT)
				?.status,
		).toBe("superseded");
		expect(
			store.readShipJudgmentDesignApproval("FLY-2399", [], "__main__", AFTER)
				?.status,
		).toBe("changes_requested");
	} finally {
		store.close();
	}
});

it("code verdict binds exact head, repo, aliases and decision-time cutoff", async () => {
	const { store, db } = await bindingFixture();
	try {
		review(db, "code", {
			type: "code",
			issue: "issue-uuid",
			head: HEAD.toUpperCase(),
		});
		review(db, "future", {
			type: "code",
			time: AFTER,
			verdict: "CHANGES_REQUESTED",
		});
		expect(
			store.readShipJudgmentCodeReviewAtHead(
				"FLY-2399",
				["issue-uuid"],
				"__main__",
				HEAD,
				AT,
			)?.requestId,
		).toBe("code");
		expect(
			store.readShipJudgmentCodeReviewAtHead(
				"FLY-2399",
				["issue-uuid"],
				"nested",
				HEAD,
				AT,
			),
		).toBeUndefined();
		expect(
			store.readShipJudgmentCodeReviewAtHead(
				"FLY-2399",
				[],
				"__main__",
				HEAD,
				AT,
			),
		).toBeUndefined();
		expect(
			store.readShipJudgmentCodeReviewAtHead(
				"FLY-2399",
				["issue-uuid"],
				"__main__",
				"b".repeat(40),
				AT,
			),
		).toBeUndefined();
		expect(
			store.readShipJudgmentCodeReviewAtHead(
				"FLY-2399",
				["issue-uuid"],
				"__main__",
				HEAD,
				AFTER,
			)?.verdict,
		).toBe("CHANGES_REQUESTED");
	} finally {
		store.close();
	}
});

it("resolves permanent QA only at the correct repo, exact head, issuer, attempt and as-of", async () => {
	const { store, db } = await bindingFixture();
	try {
		qaNode(db);
		const id = claim(db, 1148, { head: HEAD.toUpperCase() });
		expect(
			store.readShipJudgmentQaAuthority("r", "__main__", HEAD, AT),
		).toMatchObject({
			verdict: "pass",
			claimId: String(id),
			serverSeq: 1148,
			predicate: "qa_passed",
			issuedAt: BEFORE,
			revoked: false,
		});
		expect(
			store.readShipJudgmentQaAuthority("r", "nested", HEAD, AT).verdict,
		).toBe("undetermined");
		expect(
			store.readShipJudgmentQaAuthority("r", "__main__", "b".repeat(40), AT)
				.verdict,
		).toBe("undetermined");
		qaNode(db, 2, AFTER);
		claim(db, 1149, { attempt: 2, issuedAt: AFTER, predicate: "qa_failed" });
		expect(
			store.readShipJudgmentQaAuthority("r", "__main__", HEAD, AT).verdict,
		).toBe("pass");
		expect(
			store.readShipJudgmentQaAuthority("r", "__main__", HEAD, AFTER),
		).toMatchObject({
			verdict: "fail",
			reason: "qa_failed",
			serverSeq: 1149,
			issuedAt: AFTER,
		});
	} finally {
		store.close();
	}
});

it.each([
	"stale_attempt",
	"wrong_issuer",
	"revoked",
	"inconsistent",
	"expired",
] as const)(
	"fails closed for QA %s and retains candidate metadata",
	async (kind) => {
		const { store, db } = await bindingFixture();
		try {
			qaNode(db);
			const id = claim(db, 1, {
				...(kind === "wrong_issuer" ? { issuer: "other" } : {}),
				...(kind === "expired" ? { expiresAt: BEFORE } : {}),
			});
			if (kind === "stale_attempt") qaNode(db, 2);
			if (kind === "revoked")
				db.prepare(
					"INSERT INTO workflow_claim_revocation(claim_id,reason,actor,revoked_at) VALUES (?,'withdrawn','qa',?)",
				).run(id, BEFORE);
			if (kind === "inconsistent") claim(db, 2, { predicate: "qa_failed" });
			const result = store.readShipJudgmentQaAuthority(
				"r",
				"__main__",
				HEAD,
				AT,
			);
			expect(result.verdict).toBe(kind === "expired" ? "undetermined" : "fail");
			expect(result.reason).toBe(
				kind === "expired" ? "evidence_missing" : `qa_claim_${kind}`,
			);
			expect(result.claimId).toBeTruthy();
			expect(result.issuedAt).toBe(BEFORE);
		} finally {
			store.close();
		}
	},
);

it("excludes both post-decision permanent QA claims and post-decision revocations", async () => {
	const { store, db } = await bindingFixture();
	try {
		qaNode(db);
		claim(db, 2, { issuedAt: AFTER });
		expect(
			store.readShipJudgmentQaAuthority("r", "__main__", HEAD, AT).verdict,
		).toBe("undetermined");
		const id = claim(db, 1);
		db.prepare(
			"INSERT INTO workflow_claim_revocation(claim_id,reason,actor,revoked_at) VALUES (?,'withdrawn','qa',?)",
		).run(id, AFTER);
		expect(
			store.readShipJudgmentQaAuthority("r", "__main__", HEAD, AT).verdict,
		).toBe("pass");
	} finally {
		store.close();
	}
});
