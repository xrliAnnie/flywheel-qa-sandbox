import { createHash, randomBytes } from "node:crypto";

/**
 * FLY-1135 PR-1 — the workflow claims vocabulary (plan §2.1/§2.2).
 *
 * These are the CLOSED enums of the edge contract: a gate resolves structured
 * claims from the ledger, never free-form strings. Anything outside these
 * vocabularies is rejected at the API boundary (fail-closed), never coerced.
 */

/** Closed predicate enum (plan §2.1 `predicate`). */
export const WORKFLOW_CLAIM_PREDICATES = [
	"qa_passed",
	"qa_failed",
	"codex_approved",
	"design_review_approved",
	"founder_approved",
	"qa_exempt",
] as const;
export type WorkflowClaimPredicate = (typeof WORKFLOW_CLAIM_PREDICATES)[number];

/** Who signs a claim (plan §2.1 `issuer_kind`). */
export const WORKFLOW_CLAIM_ISSUER_KINDS = [
	"runner_node",
	"bridge_policy",
	"founder_challenge",
] as const;
export type WorkflowClaimIssuerKind =
	(typeof WORKFLOW_CLAIM_ISSUER_KINDS)[number];

/** What a claim binds to (plan §2.1 `subject_kind`). */
export const WORKFLOW_CLAIM_SUBJECT_KINDS = [
	"git_head",
	"snapshot_digest",
] as const;
export type WorkflowClaimSubjectKind =
	(typeof WORKFLOW_CLAIM_SUBJECT_KINDS)[number];

/**
 * Decision families (plan §2.2 `allowed_predicate_family` = the claim's
 * `decision_kind`). A one-shot capability is scoped to ONE family; the
 * predicate submitted must belong to it — a QA ticket can say pass OR fail,
 * never "approved".
 */
export const WORKFLOW_DECISION_FAMILIES = {
	qa_verdict: ["qa_passed", "qa_failed"],
	review_verdict: ["codex_approved", "design_review_approved"],
	founder_decision: ["founder_approved"],
	qa_policy: ["qa_exempt"],
} as const satisfies Record<string, readonly WorkflowClaimPredicate[]>;
export type WorkflowDecisionFamily = keyof typeof WORKFLOW_DECISION_FAMILIES;

/** Families a runner-node capability may be issued for. */
export const RUNNER_CAPABILITY_FAMILIES: readonly WorkflowDecisionFamily[] = [
	"qa_verdict",
	"review_verdict",
];

/**
 * System-claim allowlist (plan §2.1): qa_exempt is a Bridge POLICY claim,
 * founder_approved comes only through the server-owned founder challenge.
 * Runner predicates are structurally unreachable through the system path.
 */
export const SYSTEM_CLAIM_ALLOWLIST: Record<
	Exclude<WorkflowClaimIssuerKind, "runner_node">,
	readonly WorkflowClaimPredicate[]
> = {
	bridge_policy: ["qa_exempt"],
	founder_challenge: ["founder_approved"],
};

/**
 * Review-class predicates (plan §2.1): the claim judges ANOTHER node's
 * product, so it must name the producer and the reviewer's vendor must differ
 * from the producer's (the cross-vendor invariant, E6 second gate).
 */
export const REVIEW_CLASS_PREDICATES: ReadonlySet<WorkflowClaimPredicate> =
	new Set([
		"qa_passed",
		"qa_failed",
		"codex_approved",
		"design_review_approved",
	]);

/** Predicates that OPEN a gate. Everything else refuses (fail-closed). */
export const PASSING_PREDICATES: ReadonlySet<WorkflowClaimPredicate> = new Set([
	"qa_passed",
	"codex_approved",
	"design_review_approved",
	"founder_approved",
	"qa_exempt",
]);

/** Stable stringify (sorted object keys) so digests are canonical. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * Canonical submission digest (plan §2.1 `submission_digest`) — the ONLY
 * deterministic comparison key for consumed-capability idempotent replay.
 */
export function canonicalSubmissionDigest(payload: unknown): string {
	return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** Mint a decision-capability token. Plaintext lives ONLY in Bridge memory. */
export function generateCapabilityToken(): string {
	return randomBytes(32).toString("hex");
}

/** The stored form — the DB never sees the plaintext (plan §2.2). */
export function hashCapabilityToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

// ── Rollout flags (plan §3.2) ────────────────────────────────────────────────
// THREE independent DEFAULT-OFF switches: write path, read path, emergency
// legacy fallback. Enrollment is a per-run typed marker — never inferred from
// these flags or from table contents.

const WORKFLOW_CLAIMS_WRITE_KEY = "FLYWHEEL_WORKFLOW_CLAIMS_WRITE";
const WORKFLOW_CLAIMS_READ_KEY = "FLYWHEEL_WORKFLOW_CLAIMS_READ";
const WORKFLOW_FORCE_LEGACY_KEY = "FLYWHEEL_WORKFLOW_FORCE_LEGACY";

type EnvLike = Record<string, string | undefined>;

/** Dual-write producers may write the claims ledger. Default OFF. */
export function isWorkflowClaimsWriteEnabled(env: EnvLike): boolean {
	return env[WORKFLOW_CLAIMS_WRITE_KEY] === "1";
}

/** Enrolled runs may READ gates from the claims ledger. Default OFF. */
export function isWorkflowClaimsReadEnabled(env: EnvLike): boolean {
	return env[WORKFLOW_CLAIMS_READ_KEY] === "1";
}

/** Emergency rollback: force the legacy path even for enrolled runs. */
export function isWorkflowLegacyForced(env: EnvLike): boolean {
	return env[WORKFLOW_FORCE_LEGACY_KEY] === "1";
}
