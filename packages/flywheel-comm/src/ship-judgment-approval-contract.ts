import { createHash } from "node:crypto";

export const SHIP_JUDGMENT_APPROVAL_ACTOR =
	"bridge-ship-judgment-gate" as const;
export const SHIP_JUDGMENT_APPROVAL_DECISION_SOURCE =
	"three_point_auto" as const;
export const SHIP_JUDGMENT_APPROVAL_POLICY = "three-point-auto-v1" as const;
export const SHIP_JUDGMENT_POLICY = "ship-judgment-v1" as const;
export const SHIP_JUDGMENT_EVIDENCE_POLICY =
	"ship-judgment-evidence-v2" as const;
export const SHIP_JUDGMENT_APPROVAL_MAX_BYTES = 65_536;

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISSUE = /^[A-Z]+-[1-9][0-9]*$/;
const REPO_IDENTITY = /^(?:__main__|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/;
const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SNOWFLAKE = /^\d{17,20}$/;
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface ShipJudgmentApprovalTargetV1 {
	repo_identity: string;
	repo_slug: string;
	pr_number: number;
	head_sha: string;
}

export interface ShipJudgmentApprovalEnvelopeV1 {
	schema_version: 1;
	policy: typeof SHIP_JUDGMENT_APPROVAL_POLICY;
	judgment_policy: typeof SHIP_JUDGMENT_POLICY;
	project_name: "flywheel";
	run_id: string;
	issue_id: string;
	question_id: string;
	gate_node_id: string;
	attempt: number;
	source_execution_id: string;
	card: { message_id: string; thread_id: string; channel_id: string };
	primary: ShipJudgmentApprovalTargetV1;
	targets: ShipJudgmentApprovalTargetV1[];
	manifest: { revision: number; digest: string };
	judgment: {
		opinion_id: string;
		input_id: string;
		evaluation_id: string;
		semantic_digest: string;
		model_snapshot_digest: string;
		evidence_policy: typeof SHIP_JUDGMENT_EVIDENCE_POLICY;
		evidence_digest: string;
		mechanical_digest: string;
		mechanical_checked_at: string;
		presentation_digest: string;
		delivered_message_id: string;
	};
	control: {
		event_id: string;
		opening_event_id: string;
		flag_revision: number;
	};
	policy_provenance: { id: string; original_message_digest: string };
	decision_at: string;
	response: { approved: true };
	actor: typeof SHIP_JUDGMENT_APPROVAL_ACTOR;
	decision_source: typeof SHIP_JUDGMENT_APPROVAL_DECISION_SOURCE;
}

function fail(reason: string): never {
	throw new Error(`ship_judgment_approval_invalid:${reason}`);
}

function objectValue(value: unknown, reason: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return fail(reason);
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	reason: string,
): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		fail(reason);
	}
}

function boundedString(value: unknown, reason: string, max = 200): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Buffer.byteLength(value, "utf8") > max
	) {
		return fail(reason);
	}
	return value;
}

function positiveInteger(value: unknown, reason: string): number {
	if (!Number.isSafeInteger(value) || Number(value) <= 0) return fail(reason);
	return Number(value);
}

function nonnegativeInteger(value: unknown, reason: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) return fail(reason);
	return Number(value);
}

function timestamp(value: unknown, reason: string): string {
	if (typeof value !== "string" || !ISO_MILLIS.test(value)) return fail(reason);
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		return fail(reason);
	}
	return value;
}

function digest(value: unknown, reason: string): string {
	return typeof value === "string" && SHA256.test(value) ? value : fail(reason);
}

function parseTarget(
	value: unknown,
	reason: string,
): ShipJudgmentApprovalTargetV1 {
	const target = objectValue(value, reason);
	exactKeys(
		target,
		["repo_identity", "repo_slug", "pr_number", "head_sha"],
		`${reason}_keys`,
	);
	if (
		typeof target.repo_identity !== "string" ||
		!REPO_IDENTITY.test(target.repo_identity) ||
		typeof target.repo_slug !== "string" ||
		!REPO_SLUG.test(target.repo_slug) ||
		typeof target.head_sha !== "string" ||
		!SHA40.test(target.head_sha)
	) {
		fail(reason);
	}
	positiveInteger(target.pr_number, `${reason}_pr_number`);
	return value as ShipJudgmentApprovalTargetV1;
}

function targetKey(target: ShipJudgmentApprovalTargetV1): string {
	return JSON.stringify([
		target.repo_identity,
		target.repo_slug,
		target.pr_number,
		target.head_sha,
	]);
}

export function compareShipJudgmentApprovalTargets(
	left: ShipJudgmentApprovalTargetV1,
	right: ShipJudgmentApprovalTargetV1,
): number {
	const leftKey = targetKey(left);
	const rightKey = targetKey(right);
	return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function shipJudgmentApprovalTargetDigest(
	targets: readonly ShipJudgmentApprovalTargetV1[],
	manifestRevision: number,
): string {
	return createHash("sha256")
		.update(JSON.stringify({ manifest_revision: manifestRevision, targets }))
		.digest("hex");
}

export function shipJudgmentApprovalSourceEventId(questionId: string): string {
	return `ship-judgment-auto:${boundedString(questionId, "question_id")}`;
}

export function shipJudgmentApprovalVerdictId(questionId: string): string {
	return `fgv:${createHash("sha256")
		.update(shipJudgmentApprovalSourceEventId(questionId))
		.digest("hex")}`;
}

export function parseShipJudgmentApprovalEnvelope(
	value: unknown,
): ShipJudgmentApprovalEnvelopeV1 {
	const envelope = objectValue(value, "object");
	exactKeys(
		envelope,
		[
			"schema_version",
			"policy",
			"judgment_policy",
			"project_name",
			"run_id",
			"issue_id",
			"question_id",
			"gate_node_id",
			"attempt",
			"source_execution_id",
			"card",
			"primary",
			"targets",
			"manifest",
			"judgment",
			"control",
			"policy_provenance",
			"decision_at",
			"response",
			"actor",
			"decision_source",
		],
		"keys",
	);
	if (
		Buffer.byteLength(JSON.stringify(value), "utf8") >
		SHIP_JUDGMENT_APPROVAL_MAX_BYTES
	) {
		fail("too_large");
	}
	if (
		envelope.schema_version !== 1 ||
		envelope.policy !== SHIP_JUDGMENT_APPROVAL_POLICY ||
		envelope.judgment_policy !== SHIP_JUDGMENT_POLICY ||
		envelope.project_name !== "flywheel"
	) {
		fail("policy");
	}
	boundedString(envelope.run_id, "run_id");
	if (typeof envelope.issue_id !== "string" || !ISSUE.test(envelope.issue_id)) {
		fail("issue_id");
	}
	boundedString(envelope.question_id, "question_id");
	boundedString(envelope.gate_node_id, "gate_node_id", 64);
	positiveInteger(envelope.attempt, "attempt");
	boundedString(envelope.source_execution_id, "source_execution_id");

	const card = objectValue(envelope.card, "card");
	exactKeys(card, ["message_id", "thread_id", "channel_id"], "card_keys");
	for (const key of ["message_id", "thread_id", "channel_id"] as const) {
		if (typeof card[key] !== "string" || !SNOWFLAKE.test(card[key])) {
			fail(`card_${key}`);
		}
	}

	const primary = parseTarget(envelope.primary, "primary");
	if (
		!Array.isArray(envelope.targets) ||
		envelope.targets.length === 0 ||
		envelope.targets.length > 200
	) {
		fail("targets");
	}
	const targets = envelope.targets.map((target, index) =>
		parseTarget(target, `target_${index}`),
	);
	const keys = targets.map(targetKey);
	if (
		new Set(keys).size !== keys.length ||
		targets.some(
			(target, index) =>
				index > 0 &&
				compareShipJudgmentApprovalTargets(targets[index - 1]!, target) >= 0,
		) ||
		!keys.includes(targetKey(primary))
	) {
		fail("target_set");
	}

	const manifest = objectValue(envelope.manifest, "manifest");
	exactKeys(manifest, ["revision", "digest"], "manifest_keys");
	nonnegativeInteger(manifest.revision, "manifest_revision");
	digest(manifest.digest, "manifest_digest");

	const judgment = objectValue(envelope.judgment, "judgment");
	exactKeys(
		judgment,
		[
			"opinion_id",
			"input_id",
			"evaluation_id",
			"semantic_digest",
			"model_snapshot_digest",
			"evidence_policy",
			"evidence_digest",
			"mechanical_digest",
			"mechanical_checked_at",
			"presentation_digest",
			"delivered_message_id",
		],
		"judgment_keys",
	);
	for (const key of ["opinion_id", "input_id", "evaluation_id"] as const) {
		boundedString(judgment[key], `judgment_${key}`);
	}
	for (const key of [
		"semantic_digest",
		"model_snapshot_digest",
		"evidence_digest",
		"mechanical_digest",
		"presentation_digest",
	] as const) {
		digest(judgment[key], `judgment_${key}`);
	}
	if (judgment.evidence_policy !== SHIP_JUDGMENT_EVIDENCE_POLICY) {
		fail("evidence_policy");
	}
	timestamp(judgment.mechanical_checked_at, "mechanical_checked_at");
	if (
		typeof judgment.delivered_message_id !== "string" ||
		!SNOWFLAKE.test(judgment.delivered_message_id)
	) {
		fail("delivered_message_id");
	}

	const control = objectValue(envelope.control, "control");
	exactKeys(
		control,
		["event_id", "opening_event_id", "flag_revision"],
		"control_keys",
	);
	if (
		typeof control.event_id !== "string" ||
		!UUID_V4.test(control.event_id) ||
		typeof control.opening_event_id !== "string" ||
		!UUID_V4.test(control.opening_event_id)
	) {
		fail("control_id");
	}
	positiveInteger(control.flag_revision, "flag_revision");

	const provenance = objectValue(
		envelope.policy_provenance,
		"policy_provenance",
	);
	exactKeys(
		provenance,
		["id", "original_message_digest"],
		"policy_provenance_keys",
	);
	if (typeof provenance.id !== "string" || !UUID_V4.test(provenance.id)) {
		fail("policy_provenance_id");
	}
	digest(provenance.original_message_digest, "policy_message_digest");
	timestamp(envelope.decision_at, "decision_at");

	const response = objectValue(envelope.response, "response");
	exactKeys(response, ["approved"], "response_keys");
	if (
		response.approved !== true ||
		envelope.actor !== SHIP_JUDGMENT_APPROVAL_ACTOR ||
		envelope.decision_source !== SHIP_JUDGMENT_APPROVAL_DECISION_SOURCE
	) {
		fail("source_identity");
	}
	return value as ShipJudgmentApprovalEnvelopeV1;
}
