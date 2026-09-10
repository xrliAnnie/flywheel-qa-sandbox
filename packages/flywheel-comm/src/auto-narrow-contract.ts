import { createHash } from "node:crypto";

export const AUTO_NARROW_FLAG_NAME = "auto_merge_narrow_gate" as const;
export const AUTO_NARROW_MODES = ["off", "dry_run", "auto"] as const;
export type AutoNarrowMode = (typeof AUTO_NARROW_MODES)[number];
export const AUTO_NARROW_CONTROL_MODES = ["dry_run", "auto"] as const;
export type AutoNarrowControlMode = (typeof AUTO_NARROW_CONTROL_MODES)[number];
export const AUTO_NARROW_ACTOR = "bridge-auto-narrow-gate" as const;
export const AUTO_NARROW_DECISION_SOURCE = "auto_narrow_gate" as const;
export const AUTO_NARROW_POLICY_VERSION = 1 as const;
export const AUTO_NARROW_SOURCE_MAX_BYTES = 24_576;
export const AUTO_NARROW_OPINION_WINDOW = 200;
export const AUTO_NARROW_PRECISION_TARGET = 0.98;
export const AUTO_NARROW_PRECISION_MINIMUM = 5;

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const ISSUE = /^[A-Z]+-[1-9][0-9]*$/;
const REPO_IDENTITY = /^(?:__main__|[a-z0-9._-]+\/[a-z0-9._-]+)$/;
const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SNOWFLAKE = /^\d{17,20}$/;
const SHADOW_KEYS = [
	"verdict_id",
	"run_id",
	"question_id",
	"gate_execution_id",
	"repo_identity",
	"pr_number",
	"head_sha",
	"observed_at",
	"machine_class",
	"machine_reason",
	"machine_file_count",
	"machine_candidate_count",
	"machine_declared_projected_count",
	"machine_primary_snapshot_age_ms",
	"machine_declared_max_snapshot_age_ms",
	"machine_basis_json",
	"s2_ran_status",
	"s2_ran_reason",
	"s2_record_status",
	"s2_record_reason",
	"s2_verdict",
	"s2_basis_record_id",
	"s2_row_count",
	"s2_other_head_row_count",
	"shadow_version",
] as const;

export interface AutoNarrowSourceEnvelopeV1 {
	schema_version: 1;
	policy_version: 1;
	run_id: string;
	issue_id: string;
	question_id: string;
	gate_node_id: string;
	attempt: number;
	source_execution_id: string;
	repo_identity: string;
	repo_slug: string;
	pr_number: number;
	head_sha: string;
	response: { approved: true };
	actor: typeof AUTO_NARROW_ACTOR;
	decision_source: typeof AUTO_NARROW_DECISION_SOURCE;
	control: {
		event_id: string;
		opening_event_id: string;
		flag_revision: number;
		opening_at: string;
		founder_message_id: string;
	};
	declaration: { declaration_id: string; declaration_seq: number };
	strength_two: { basis_record_id: string };
	observation: Record<(typeof SHADOW_KEYS)[number], unknown>;
	decision_at: string;
}

export function autoNarrowSourceEventId(questionId: string): string {
	return `auto-narrow:${questionId}`;
}

export function autoNarrowVerdictId(questionId: string): string {
	return `fgv:${createHash("sha256")
		.update(autoNarrowSourceEventId(questionId))
		.digest("hex")}`;
}

function fail(reason: string): never {
	throw new Error(`auto_narrow_source_invalid:${reason}`);
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

function boundedString(value: unknown, reason: string, maxBytes = 256): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Buffer.byteLength(value, "utf8") > maxBytes
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

function nullableInteger(value: unknown, reason: string): number | null {
	if (value === null) return null;
	return nonnegativeInteger(value, reason);
}

function canonicalTimestamp(value: unknown, reason: string): string {
	if (typeof value !== "string" || !ISO_MILLIS.test(value)) return fail(reason);
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		return fail(reason);
	}
	return value;
}

function validateObservation(
	value: unknown,
	envelope: Record<string, unknown>,
	strengthTwoId: string,
): Record<(typeof SHADOW_KEYS)[number], unknown> {
	const observation = objectValue(value, "observation");
	exactKeys(observation, SHADOW_KEYS, "observation_keys");
	if (
		boundedString(observation.verdict_id, "observation_verdict", 80) !==
			autoNarrowVerdictId(String(envelope.question_id)) ||
		observation.run_id !== envelope.run_id ||
		observation.question_id !== envelope.question_id ||
		observation.gate_execution_id !== envelope.source_execution_id ||
		observation.repo_identity !== envelope.repo_identity ||
		observation.pr_number !== envelope.pr_number ||
		observation.head_sha !== envelope.head_sha
	) {
		fail("observation_binding");
	}
	canonicalTimestamp(observation.observed_at, "observation_at");
	if (
		observation.machine_class !== "docs_only" ||
		observation.machine_reason !== null
	) {
		fail("gate1");
	}
	nonnegativeInteger(observation.machine_file_count, "machine_file_count");
	nonnegativeInteger(observation.machine_candidate_count, "machine_candidates");
	nonnegativeInteger(
		observation.machine_declared_projected_count,
		"machine_declared",
	);
	nullableInteger(observation.machine_primary_snapshot_age_ms, "primary_age");
	nullableInteger(
		observation.machine_declared_max_snapshot_age_ms,
		"declared_age",
	);
	const basis = boundedString(
		observation.machine_basis_json,
		"machine_basis",
		16_384,
	);
	try {
		JSON.parse(basis);
	} catch {
		fail("machine_basis_json");
	}
	if (
		observation.s2_ran_status !== "satisfied" ||
		observation.s2_ran_reason !== "ok" ||
		observation.s2_record_status !== "satisfied" ||
		observation.s2_record_reason !== "ok" ||
		observation.s2_verdict !== "satisfied" ||
		observation.s2_basis_record_id !== strengthTwoId ||
		observation.shadow_version !== 1
	) {
		fail("gate3");
	}
	positiveInteger(observation.s2_row_count, "s2_row_count");
	nonnegativeInteger(
		observation.s2_other_head_row_count,
		"s2_other_head_count",
	);
	return observation as Record<(typeof SHADOW_KEYS)[number], unknown>;
}

export function parseAutoNarrowSourceEnvelope(
	value: unknown,
): AutoNarrowSourceEnvelopeV1 {
	const envelope = objectValue(value, "object");
	exactKeys(
		envelope,
		[
			"schema_version",
			"policy_version",
			"run_id",
			"issue_id",
			"question_id",
			"gate_node_id",
			"attempt",
			"source_execution_id",
			"repo_identity",
			"repo_slug",
			"pr_number",
			"head_sha",
			"response",
			"actor",
			"decision_source",
			"control",
			"declaration",
			"strength_two",
			"observation",
			"decision_at",
		],
		"keys",
	);
	if (
		Buffer.byteLength(JSON.stringify(value), "utf8") >
		AUTO_NARROW_SOURCE_MAX_BYTES
	) {
		fail("too_large");
	}
	if (
		envelope.schema_version !== 1 ||
		envelope.policy_version !== AUTO_NARROW_POLICY_VERSION
	) {
		fail("version");
	}
	boundedString(envelope.run_id, "run_id", 200);
	if (typeof envelope.issue_id !== "string" || !ISSUE.test(envelope.issue_id)) {
		fail("issue_id");
	}
	boundedString(envelope.question_id, "question_id", 200);
	boundedString(envelope.gate_node_id, "gate_node_id", 64);
	positiveInteger(envelope.attempt, "attempt");
	boundedString(envelope.source_execution_id, "source_execution_id", 200);
	if (
		typeof envelope.repo_identity !== "string" ||
		!REPO_IDENTITY.test(envelope.repo_identity)
	) {
		fail("repo_identity");
	}
	if (
		typeof envelope.repo_slug !== "string" ||
		!REPO_SLUG.test(envelope.repo_slug)
	) {
		fail("repo_slug");
	}
	positiveInteger(envelope.pr_number, "pr_number");
	if (typeof envelope.head_sha !== "string" || !SHA40.test(envelope.head_sha)) {
		fail("head_sha");
	}
	const response = objectValue(envelope.response, "response");
	exactKeys(response, ["approved"], "response_keys");
	if (response.approved !== true) fail("response");
	if (
		envelope.actor !== AUTO_NARROW_ACTOR ||
		envelope.decision_source !== AUTO_NARROW_DECISION_SOURCE
	) {
		fail("source_identity");
	}
	const control = objectValue(envelope.control, "control");
	exactKeys(
		control,
		[
			"event_id",
			"opening_event_id",
			"flag_revision",
			"opening_at",
			"founder_message_id",
		],
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
	canonicalTimestamp(control.opening_at, "opening_at");
	if (
		typeof control.founder_message_id !== "string" ||
		!SNOWFLAKE.test(control.founder_message_id)
	) {
		fail("founder_message_id");
	}
	const declaration = objectValue(envelope.declaration, "declaration");
	exactKeys(
		declaration,
		["declaration_id", "declaration_seq"],
		"declaration_keys",
	);
	if (
		typeof declaration.declaration_id !== "string" ||
		!UUID_V4.test(declaration.declaration_id)
	) {
		fail("declaration_id");
	}
	positiveInteger(declaration.declaration_seq, "declaration_seq");
	const strengthTwo = objectValue(envelope.strength_two, "strength_two");
	exactKeys(strengthTwo, ["basis_record_id"], "strength_two_keys");
	if (
		typeof strengthTwo.basis_record_id !== "string" ||
		!UUID_V4.test(strengthTwo.basis_record_id)
	) {
		fail("strength_two_id");
	}
	validateObservation(
		envelope.observation,
		envelope,
		strengthTwo.basis_record_id,
	);
	canonicalTimestamp(envelope.decision_at, "decision_at");
	return value as AutoNarrowSourceEnvelopeV1;
}
