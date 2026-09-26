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
	workflow?: {
		runId: string;
		nodeId: string;
		attempt: number;
		activationId: string;
		launchOrdinal?: number;
		dispatchCreatedAt?: string;
		purpose?: string;
	};
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
				livenessProbe?: {
					method: string;
					target: string;
					result: "alive";
					probed_at: string;
				};

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
	"generated_at",
	"workflow_event_id",
	"workflow_run_id",
	"workflow_node_id",
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
	"workflow_attempt",
	"blind_replacements",
	"max_blind_replacements",
	"pr_number",
	"concurrent_reestablished",
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
					[
						"ship_parked",
						"awaiting_review",
						"design_done",
						"approved_to_ship",
					].includes(String(value))
				)
			)
				return false;
		} else if (
			key === "summary" ||
			key === "notification_context" ||
			key === "stage_context"
		) {
			if (value !== "" && value !== evidence.templates?.[key]) return false;
		} else if (key === "liveness_probe") {
			if (
				evidence.kind !== "monitoring" ||
				!evidence.livenessProbe ||
				typeof value !== "object" ||
				Array.isArray(value)
			)
				return false;
			const probe = value as Record<string, unknown>;
			if (
				Object.keys(probe).length !== 4 ||
				probe.method !== "tmux_pane_probe" ||
				probe.result !== "alive" ||
				typeof probe.target !== "string" ||
				!probe.target ||
				typeof probe.probed_at !== "string" ||
				!Number.isFinite(Date.parse(probe.probed_at)) ||
				!Object.keys(evidence.livenessProbe).every(
					(field) =>
						probe[field] ===
						evidence.livenessProbe![
							field as keyof typeof evidence.livenessProbe
						],
				)
			)
				return false;
		} else if (key === "minutes_since_activity") {
			if (
				evidence.kind !== "monitoring" ||
				typeof value !== "number" ||
				!Number.isFinite(value) ||
				value < 0
			)
				return false;
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

export interface StartupResult {
	threadOutcome: "not_required" | "ready" | "failed" | "unknown";
	completed: boolean;
}

/** Read already committed admission/dispatch facts; never require future worktree CAS. */
export function startupNotificationIdentity(
	store: import("../StateStore.js").StateStore,
	executionId: string,
	startedAt: string,
): string {
	try {
		const node = store.getWorkflowRunNodeForExecution(executionId);
		const activation =
			node &&
			store.getWorkflowActivationForAttempt({
				executionId,
				runId: node.run_id,
				nodeId: node.node_id,
				attempt: node.attempt,
			});
		return `direct-started:${executionId}:${activation?.activation_id ?? startedAt}`;
	} catch {
		return `direct-started:${executionId}:${startedAt}`;
	}
}

export function startupNotificationEvidence(
	store: import("../StateStore.js").StateStore,
	binding: NotificationBinding,
	outcome: StartupResult,
): NotificationEvidenceV2 {
	const sourceRef = `session-event:${binding.eventId}:proof`;
	const evidence: NotificationEvidenceV2 = {
		version: 2,
		kind: "startup",
		binding,
		proof: {
			sourceRef,
			executionId: binding.executionId,
			action: { state: "unknown" },
		},
		registrationRef: "",
		handoff: "unknown",
		threadOutcome: outcome.threadOutcome,
	};
	try {
		const session = store.getSession(binding.executionId);
		if (
			!session ||
			session.project_name !== binding.projectName ||
			session.issue_id !== binding.issueId ||
			session.status !== "running"
		)
			return evidence;
		evidence.registrationRef = `session:${session.execution_id}:${session.started_at}`;
		const node = store.getWorkflowRunNodeForExecution(binding.executionId);
		if (!node) return evidence;
		const run = store.getWorkflowRun(node.run_id);
		const activation = store.getWorkflowActivationForAttempt({
			executionId: binding.executionId,
			runId: node.run_id,
			nodeId: node.node_id,
			attempt: node.attempt,
		});
		const latest = store.listWorkflowRunNodes(node.run_id, node.node_id).at(-1);
		if (
			!run ||
			run.engine_owned !== 1 ||
			run.status !== "active" ||
			run.project_name !== binding.projectName ||
			run.issue_id !== binding.issueId ||
			run.current_node_id !== node.node_id ||
			!["admitted", "running"].includes(node.state) ||
			latest?.attempt !== node.attempt ||
			latest.execution_id !== binding.executionId ||
			!activation ||
			session.workflow_node_id !== node.node_id
		)
			return evidence;
		const dispatch = store
			.listWorkflowSideEffects(node.run_id)
			.filter(
				(row) =>
					row.kind === "dispatch" &&
					row.node_id === node.node_id &&
					row.attempt === node.attempt,
			)
			.at(-1);
		if (
			!dispatch ||
			dispatch.execution_id !== binding.executionId ||
			dispatch.state === "abandoned"
		)
			return evidence;
		if (
			session.retry_predecessor ||
			(session.run_attempt ?? 1) > 1 ||
			activation.mode !== "spawn" ||
			dispatch.purpose !== "initial"
		) {
			evidence.handoff = "lead_required";
			return evidence;
		}
		evidence.handoff = "initial_notice";
		evidence.workflow = {
			runId: node.run_id,
			nodeId: node.node_id,
			attempt: node.attempt,
			activationId: activation.activation_id,
			launchOrdinal: dispatch.launch_ordinal,
			dispatchCreatedAt: dispatch.created_at,
			purpose: dispatch.purpose,
		};
		// Failures in the try body still execute finally; a running row cannot erase them.
		if (outcome.completed && !session.decision_route && !session.last_error) {
			evidence.proof.action = {
				state: "none",
				checkedRefs: [
					evidence.registrationRef,
					activation.activation_id,
					`workflow-dispatch:${dispatch.id}:${dispatch.launch_ordinal}`,
				],
			};
		}
		return evidence;
	} catch {
		// Unavailable authority restores immediate delivery, never drops the notification.
		evidence.proof.action = { state: "unknown" };
		return evidence;
	}
}

/** Preserve unrecognised extensions for the conservative payload guard. */
export function startupIngressPayload(
	env: import("flywheel-edge-worker").EventEnvelope,
): Record<string, unknown> {
	const fields: Record<string, string> = {
		executionId: "execution_id",
		issueId: "issue_id",
		projectName: "project_name",
		issueIdentifier: "issue_identifier",
		issueTitle: "issue_title",
		labels: "issue_labels",
		sessionRole: "session_role",
		designBackend: "design_backend",
		runnerBackend: "runner_backend",
		runnerModel: "runner_model",
		runAttempt: "run_attempt",
	};
	const trustedMetadata = new Set([
		"routeSummary",
		"chatThreadRole",
		"ponytailCondition",
		"skillFrameworkMode",
		"skillFrameworkModeVia",
		"docTier",
		"issueUrl",
	]);
	const payload: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(env)) {
		if (
			trustedMetadata.has(key) &&
			(value == null || typeof value === "string")
		)
			continue;
		if (key === "codexSkip" && (value == null || typeof value === "boolean"))
			continue;
		if (key === "retryPredecessor" && !value) continue;
		payload[fields[key] ?? key] = value;
	}
	return payload;
}
