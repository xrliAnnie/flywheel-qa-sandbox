/**
 * FLY-869 — the SINGLE ship-eligibility predicate, shared by the CLI
 * (`verify-approval` command / MERGE AUTHORITY) and the Bridge completion +
 * finalization surfaces. There is exactly ONE authority for "may this session
 * reach completed/Done", so the CLI and the Bridge can never diverge (design
 * R1/R2 HIGH-2).
 *
 * Composed of TWO independently-gated sub-checks (design R2 HIGH-3 — the B and
 * A kill-switches must be independent):
 *
 *   - B (merge approval): reuses `verifyApproval` VERBATIM (durable bound
 *     approve_to_ship question + structured `{approved:true}` + status +
 *     pr_head match + FLY-827 Codex gate). Kill-switch `FLYWHEEL_MERGE_APPROVAL_GATE=0`
 *     bypasses ONLY this check — QA stays enforced.
 *   - A (QA): `evaluateQaShipGate` — reads the immutable `qa_required` snapshot
 *     persisted at auto-qa-policy eval time and checks a passing `auto_qa_record`
 *     for the head. Kill-switch `FLYWHEEL_QA_DONE_GATE=0` bypasses ONLY this
 *     check — merge approval stays enforced.
 *
 * Both kill-switches use the same BIDIRECTIONALLY-LIVE `~/.flywheel/.env`
 * resolution as the FLY-827 Codex gate (a re-arm by deleting the `.env` line
 * turns the gate back ON even for a runner that inherited `=0`).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { readEnvValueFromContent } from "flywheel-config";
import {
	resolveStateDbPath,
	type VerifyApprovalArgs,
	verifyApproval,
} from "./commands/verify-approval.js";

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

const MERGE_APPROVAL_GATE_KEY = "FLYWHEEL_MERGE_APPROVAL_GATE";
const QA_DONE_GATE_KEY = "FLYWHEEL_QA_DONE_GATE";

/**
 * Resolve a DEFAULT-ON gate flag with the FLY-827 live-`.env` semantics:
 *   1. explicit test override (`argsEnv` HAS the key) wins,
 *   2. readable `~/.flywheel/.env` is authoritative INCLUDING key-absent (=ON),
 *   3. `.env` unreadable → inherited `processEnv` (legacy fallback).
 * `=0` = OFF; anything else (incl. absent) = ON.
 */
function resolveDefaultOnGate(
	key: string,
	args: {
		argsEnv?: NodeJS.ProcessEnv;
		processEnv: NodeJS.ProcessEnv;
		dotenvPath?: string;
	},
): boolean {
	if (args.argsEnv && key in args.argsEnv) {
		return args.argsEnv[key] !== "0";
	}
	const path = args.dotenvPath ?? join(homedir(), ".flywheel", ".env");
	try {
		const content = readFileSync(path, "utf-8");
		return readEnvValueFromContent(content, key) !== "0";
	} catch {
		return args.processEnv[key] !== "0";
	}
}

export type QaShipReason =
	| "qa_ok"
	| "qa_gate_off"
	| "qa_not_required"
	| "qa_not_passed"
	| "qa_claim_ok"
	| "qa_claim_missing_failclosed"
	| "qa_claim_gate_unenrolled_failclosed"
	| "head_authority_unavailable_failclosed"
	| "head_authority_mismatch_failclosed"
	| "qa_snapshot_missing_exempt"
	| "qa_snapshot_missing_failclosed"
	| "invalid_pr_head_format"
	| "state_db_unreadable"
	| "session_not_found";

export interface QaShipGateArgs {
	execId: string;
	/** Full 40-hex PR head sha. */
	prHead: string;
	/** StateStore (teamlead.db) path override. */
	stateDbPath?: string;
	env?: NodeJS.ProcessEnv;
	/** Test-only override for the `~/.flywheel/.env` live-read path. */
	qaDotenvPath?: string;
}

export interface QaShipGateResult {
	passed: boolean;
	reason: QaShipReason;
	/** The persisted qa_required snapshot (0/1/undefined). */
	qaRequired?: number;
}

interface QaSessionRow {
	qa_required?: number | null;
	decision_route?: string | null;
	pr_number?: number | null;
	session_role?: string | null;
	chat_thread_role?: string | null;
}

/**
 * Read-only mirror of StateStore's claims resolver for an explicitly admitted
 * QA execution. flywheel-comm cannot import the higher-level teamlead package,
 * so this exact SQL/selection contract is locked by cross-package tests.
 */
function resolveEnrolledQaClaim(
	db: Database.Database,
	execId: string,
	prHead: string,
	nowMs: number,
): QaShipGateResult {
	let binding: { run_id: string; node_id: string; attempt: number } | undefined;
	try {
		binding = db
			.prepare(
				`SELECT b.run_id, b.node_id, b.attempt
				   FROM workflow_execution_binding b
				   JOIN workflow_run_node n
				     ON n.run_id = b.run_id
				    AND n.node_id = b.node_id
				    AND n.attempt = b.attempt
				    AND n.execution_id = b.execution_id
				   JOIN workflow_run r
				     ON r.run_id = b.run_id
				  WHERE b.execution_id = ?
				    AND b.node_id = 'qa'
				    AND r.claims_read_enrolled = 1
				    AND b.attempt = (
				      SELECT MAX(latest.attempt)
				        FROM workflow_run_node latest
				       WHERE latest.run_id = b.run_id
				         AND latest.node_id = b.node_id
				    )`,
			)
			.get(execId) as typeof binding;
	} catch {
		// Missing pre-cutover tables/columns are an unenrolled durable QA, never a
		// reason to fall back to the stale qa_required exemption.
		return {
			passed: false,
			reason: "qa_claim_gate_unenrolled_failclosed",
		};
	}
	if (!binding) {
		return {
			passed: false,
			reason: "qa_claim_gate_unenrolled_failclosed",
		};
	}

	let rows: Array<{
		id: number;
		server_seq: number;
		predicate: string;
		expires_at: string | null;
		permanent: number;
		revoked: number;
	}>;
	try {
		rows = db
			.prepare(
				`SELECT c.id, c.server_seq, c.predicate, c.expires_at, c.permanent,
				        EXISTS (
				          SELECT 1 FROM workflow_claim_revocation x WHERE x.claim_id = c.id
				        ) AS revoked
				   FROM workflow_claims c
				  WHERE c.workflow_run_id = ?
				    AND c.node_id = ?
				    AND c.decision_kind = 'qa_verdict'
				    AND c.attempt = ?
				    AND c.issuer_execution_id = ?
				    AND c.subject_kind = 'git_head'
				    AND lower(c.subject_digest) = ?
				  ORDER BY c.server_seq DESC`,
			)
			.all(
				binding.run_id,
				binding.node_id,
				binding.attempt,
				execId,
				prHead,
			) as typeof rows;
	} catch {
		return { passed: false, reason: "qa_claim_missing_failclosed" };
	}
	const candidate = rows[0];
	if (!candidate) {
		return { passed: false, reason: "qa_claim_missing_failclosed" };
	}
	if (rows.some((row) => row.predicate !== candidate.predicate)) {
		return { passed: false, reason: "qa_claim_missing_failclosed" };
	}
	if (candidate.revoked === 1) {
		return { passed: false, reason: "qa_claim_missing_failclosed" };
	}
	if (
		candidate.permanent !== 1 &&
		(!candidate.expires_at ||
			!Number.isFinite(Date.parse(candidate.expires_at)) ||
			nowMs >= Date.parse(candidate.expires_at))
	) {
		return { passed: false, reason: "qa_claim_missing_failclosed" };
	}
	return candidate.predicate === "qa_passed"
		? { passed: true, reason: "qa_claim_ok" }
		: { passed: false, reason: "qa_claim_missing_failclosed" };
}

/** Routes that legitimately produce no mergeable PR → QA never applies. */
const NO_QA_ROUTES = new Set(["no_code", "pr_handoff"]);

/**
 * FLY-869 A-1: the QA ship gate. Reads the IMMUTABLE `qa_required` snapshot from
 * the session row (persisted Bridge-side at auto-qa-policy eval, where the trusted
 * signals live) and, when required, verifies a passing `auto_qa_record` for the head.
 *
 * `qa_required` snapshot semantics:
 *   - 1  → QA applies → require a passed record for this head, else `qa_not_passed`.
 *   - 0  → exempt (no-code / pure-docs / no-qa label / qa.auto:false) → pass.
 *   - NULL (never evaluated — the "该起没起" hole / pre-migration) → fail-closed for a
 *     real code PR (`qa_snapshot_missing_failclosed`); exempt for a no-code/no-PR route.
 */
export function evaluateQaShipGate(args: QaShipGateArgs): QaShipGateResult {
	const env = args.env ?? process.env;
	const gateOn = resolveDefaultOnGate(QA_DONE_GATE_KEY, {
		argsEnv: args.env,
		processEnv: env,
		dotenvPath: args.qaDotenvPath,
	});
	if (!gateOn) return { passed: true, reason: "qa_gate_off" };
	const prHead = args.prHead.trim().toLowerCase();
	if (!FULL_SHA_RE.test(prHead)) {
		return { passed: false, reason: "invalid_pr_head_format" };
	}

	const statePath = resolveStateDbPath(args.stateDbPath, env);
	if (!existsSync(statePath)) {
		return { passed: false, reason: "state_db_unreadable" };
	}
	let row: QaSessionRow | undefined;
	let qaPassedForHead = false;
	try {
		const db = new Database(statePath, { readonly: true, fileMustExist: true });
		try {
			row = db
				.prepare(
					"SELECT qa_required, decision_route, pr_number, session_role, chat_thread_role FROM sessions WHERE execution_id = ?",
				)
				.get(args.execId) as typeof row;
			if (!row) return { passed: false, reason: "session_not_found" };
			const durableQa =
				row.session_role === "qa" && row.chat_thread_role === "qa";
			if (durableQa) {
				return resolveEnrolledQaClaim(db, args.execId, prHead, Date.now());
			}
			// A missing column (pre-migration DB) or missing table must fail-closed,
			// never crash the authoritative gate.
			try {
				const qaRow = db
					.prepare(
						"SELECT 1 AS ok FROM auto_qa_record WHERE parent_execution_id = ? AND lower(target_pr_head_sha) = ? AND status = 'passed'",
					)
					.get(args.execId, prHead) as { ok?: number } | undefined;
				qaPassedForHead = qaRow?.ok === 1;
			} catch {
				qaPassedForHead = false;
			}
		} finally {
			db.close();
		}
	} catch {
		return { passed: false, reason: "state_db_unreadable" };
	}
	if (!row) return { passed: false, reason: "session_not_found" };

	const qaRequired =
		row.qa_required == null ? undefined : Number(row.qa_required);

	// Exempt snapshot → pass.
	if (qaRequired === 0) {
		return { passed: true, reason: "qa_not_required", qaRequired: 0 };
	}
	// Required snapshot → need a passing record for the head.
	if (qaRequired === 1) {
		return qaPassedForHead
			? { passed: true, reason: "qa_ok", qaRequired: 1 }
			: { passed: false, reason: "qa_not_passed", qaRequired: 1 };
	}
	// NULL snapshot (never evaluated). Exempt only for a route that produces no
	// mergeable PR; a real code PR is fail-closed (the ship gate blocks until the
	// A-3 orphan sweep spawns QA).
	const route = row.decision_route ?? undefined;
	if ((route && NO_QA_ROUTES.has(route)) || row.pr_number == null) {
		return { passed: true, reason: "qa_snapshot_missing_exempt" };
	}
	return { passed: false, reason: "qa_snapshot_missing_failclosed" };
}

export interface ShipEligibilityArgs {
	execId: string;
	/** Full 40-hex PR head sha. */
	prHead: string;
	/** CommDB path (for verifyApproval's bound-question read). */
	commDbPath: string;
	/** StateStore (teamlead.db) path override. */
	stateDbPath?: string;
	env?: NodeJS.ProcessEnv;
	/** Test-only `.env` overrides for the Codex / QA live gates. */
	codexDotenvPath?: string;
	qaDotenvPath?: string;
	/** Test seam; production verifyApproval probes GitHub directly. */
	ciProbe?: VerifyApprovalArgs["ciProbe"];
}

export interface ShipEligibilityDecision {
	/** Both sub-gates satisfied → the session may reach completed/Done. */
	eligible: boolean;
	/** B side: merge approval satisfied (or its kill-switch is off). */
	mergeApprovalOk: boolean;
	/** A side: QA satisfied (or its kill-switch is off). */
	qaOk: boolean;
	/** verifyApproval's reason (approved | why-not | merge_gate_off). */
	mergeReason: string;
	/** evaluateQaShipGate's reason. */
	qaReason: QaShipReason;
}

/**
 * FLY-869: the single ship-eligibility decision. Call this BEFORE any status
 * mutation in the completion/finalization surfaces (design R2 HIGH-1 — never
 * re-run verifyApproval after the row leaves `approved_to_ship`), and thread the
 * returned decision into finalization.
 */
export function evaluateShipEligibility(
	args: ShipEligibilityArgs,
): ShipEligibilityDecision {
	const env = args.env ?? process.env;

	// B side — merge approval (independently kill-switchable).
	const mergeGateOn = resolveDefaultOnGate(MERGE_APPROVAL_GATE_KEY, {
		argsEnv: args.env,
		processEnv: env,
		// Reuse the Codex dotenv override for the shared `.env` file in tests.
		dotenvPath: args.codexDotenvPath,
	});
	let mergeApprovalOk: boolean;
	let mergeReason: string;
	if (!mergeGateOn) {
		mergeApprovalOk = true;
		mergeReason = "merge_gate_off";
	} else {
		const approval = verifyApproval({
			execId: args.execId,
			prHead: args.prHead,
			dbPath: args.commDbPath,
			stateDbPath: args.stateDbPath,
			// Production must NOT inject env (design R2 HIGH-2): only tests pass it.
			env: args.env,
			codexDotenvPath: args.codexDotenvPath,
			ciProbe: args.ciProbe,
		});
		mergeApprovalOk = approval.approved;
		mergeReason = approval.reason;
	}

	// A side — QA gate (independently kill-switchable).
	const qa = evaluateQaShipGate({
		execId: args.execId,
		prHead: args.prHead,
		stateDbPath: args.stateDbPath,
		env: args.env,
		qaDotenvPath: args.qaDotenvPath,
	});

	return {
		eligible: mergeApprovalOk && qa.passed,
		mergeApprovalOk,
		qaOk: qa.passed,
		mergeReason,
		qaReason: qa.reason,
	};
}
