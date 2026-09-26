/** Internal producer evidence. HTTP/Runner payloads never construct this value. */
export interface NotificationBinding {
	projectName: string;
	leadId: string;
	eventId: string;
	executionId: string;
	issueId: string;
}

export type NotificationAction =
	| { state: "none"; checkedRefs: readonly string[] }
	| { state: "resolved"; resolutionRef: string; decisionRoute?: string }
	| { state: "pending" | "unknown" };

interface NotificationProof {
	sourceRef: string;
	executionId: string;
	action: NotificationAction;
}

interface NotificationEvidenceBase {
	version: 2;
	binding: NotificationBinding;
	proof: NotificationProof;
	/** Only exact, locally rendered producer templates, never ingress text. */
	templates?: Partial<
		Record<"summary" | "notification_context" | "stage_context", string>
	>;
}

export type NotificationEvidenceV2 = NotificationEvidenceBase &
	(
		| { kind: "stage"; stage: string; ownerRef?: string }
		| {
				kind: "startup";
				registrationRef: string;
				handoff: "initial_notice" | "lead_required" | "unknown";
				threadOutcome: "not_required" | "ready" | "failed" | "unknown";
		  }
		| {
				kind: "monitoring";
				episodeRef: string;
				probeRef: string;
				alertState: "none" | "resolved" | "open" | "unknown";
				resolutionRef?: string;
				legalPark?: boolean;
				recoveredLostEventIds?: readonly string[];
		  }
		| {
				kind: "replacement_notice";
				attemptRef: string;
				scheduleRef: string;
				nextCheckAt: string;
				observedAt: string;
				disposition: string;
		  }
	);

export interface NotificationDecisionContext {
	binding: NotificationBinding;
	enabled: boolean;
	projection?: Record<string, unknown>;
}

const TEXT_METADATA = new Set([
	"event_type",
	"execution_id",
	"issue_id",
	"issue_identifier",
	"issue_title",
	"project_name",
	"lead_id",
	"event_id",
	"timestamp",
	"created_at",
	"stage",
	"chat_channel",
	"chat_thread_id",
	"session_role",
	"design_backend",
	"plan_path",
	"runner_backend",
	"runner_model",
	"source",
	"thread_id",
	"session_key",
	"run_id",
	"node_id",
	"activation_id",
	"next_check_at",
	"next_check_disposition",
]);
const NUMBER_METADATA = new Set([
	"commit_count",
	"lines_added",
	"lines_removed",
	"attempt",
	"launch_ordinal",
	"run_attempt",
]);
const ACTION_TEXT = new Set([
	"question_id",
	"question",
	"question_kind",
	"ask",
	"prompt",
	"founder_message",
	"checkpoint",
	"error",
	"last_error",
	"failure_kind",
	"failureKind",
	"review",
	"ship",
]);
const ACTION_BOOLEAN = new Set([
	"needs_action",
	"requires_action",
	"action_required",
	"blocked",
]);
const BINDING_KEYS = [
	"projectName",
	"leadId",
	"eventId",
	"executionId",
	"issueId",
] as const;
const PAYLOAD_BINDING = {
	project_name: "projectName",
	lead_id: "leadId",
	event_id: "eventId",
	execution_id: "executionId",
	issue_id: "issueId",
} as const;

export function matchesNotificationBinding(
	left: NotificationBinding,
	right: NotificationBinding,
): boolean {
	return BINDING_KEYS.every(
		(key) =>
			typeof left[key] === "string" &&
			left[key].length > 0 &&
			left[key] === right[key],
	);
}

/** Schema checks, not keyword/truthiness classification. Unknown shapes wake. */
export function notificationPayloadIsPure(
	payload: Record<string, unknown>,
	evidence: NotificationEvidenceV2,
): boolean {
	for (const [key, value] of Object.entries(payload)) {
		if (value === undefined || value === null) continue;
		if (key in PAYLOAD_BINDING) {
			if (
				value !==
				evidence.binding[PAYLOAD_BINDING[key as keyof typeof PAYLOAD_BINDING]]
			)
				return false;
		} else if (ACTION_TEXT.has(key)) {
			if (value !== "") return false;
		} else if (ACTION_BOOLEAN.has(key)) {
			if (value !== false) return false;
		} else if (key === "messages") {
			// Even an empty structured extension is not a validated no-action proof.
			return false;
		} else if (key === "decision_route") {
			if (
				value !== "" &&
				!(
					evidence.proof.action.state === "resolved" &&
					value === evidence.proof.action.decisionRoute
				)
			)
				return false;
		} else if (key === "status") {
			if (
				value !== "running" &&
				!(
					evidence.kind === "stage" &&
					["design_review", "code_review", "pr_created"].includes(
						evidence.stage,
					) &&
					value === "awaiting_review"
				) &&
				!(
					evidence.kind === "monitoring" &&
					evidence.legalPark &&
					["ship_parked", "phase_parked", "parked"].includes(String(value))
				)
			)
				return false;
		} else if (
			key === "summary" ||
			key === "notification_context" ||
			key === "stage_context"
		) {
			if (value !== "" && value !== evidence.templates?.[key]) return false;
		} else if (key === "filter_priority") {
			if (!["high", "normal", "low"].includes(String(value))) return false;
		} else if (key === "issue_labels") {
			if (
				!Array.isArray(value) ||
				!value.every((item) => typeof item === "string")
			)
				return false;
		} else if (TEXT_METADATA.has(key)) {
			if (typeof value !== "string") return false;
		} else if (NUMBER_METADATA.has(key)) {
			if (!Number.isSafeInteger(value) || (value as number) < 0) return false;
		} else {
			return false;
		}
	}
	return true;
}
