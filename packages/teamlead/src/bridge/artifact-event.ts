/**
 * GEO-151 A6 — `handleArtifactEvent`: Bridge-side handler for the
 * `artifact_emitted` POST that the Runner sends via `flywheel-comm notify`.
 *
 * Responsibilities:
 *   1. Resolve the owning Lead via `resolveLeadForIssue(projects,
 *      projectName, labels)` — try/catch since it throws on unknown project.
 *   2. Resolve the chat thread via `resolveChatThreadId(store, issueId,
 *      lead.chatChannel)`.
 *   3. Build the `HookPayload` with `event_type='artifact_delivery'` carrying
 *      paths + correlation fields (dedup_key, attempt) so completion can be
 *      keyed safely.
 *   4. Persist via `store.appendLeadEvent(lead.agentId, eventId,
 *      'artifact_delivery', JSON.stringify(payload), sessionKey): number seq`
 *      — REAL signature (returns numeric seq, not an envelope).
 *   5. Build the LeadEventEnvelope manually `{seq, event, sessionKey,
 *      leadId, timestamp}` for `runtime.deliver(envelope)`.
 *   6. `result.delivered === true` → `markLeadEventDelivered(seq)` + advance
 *      `session_params.proofshot.runs[dedupKey]` to `completed` ONLY when
 *      `runs[dedupKey].attempt === event.payload.attempt` (defends against
 *      stale artifacts marking the wrong run completed).
 *   7. `result.delivered === false` or `deliver` throws → `recordDeliveryFailure(seq, msg)`.
 *      HeartbeatService retry loop picks up `artifact_delivery` via the
 *      shared `RETRYABLE_LEAD_EVENT_TYPES` set.
 *
 * Returns `{handled}` so the /events route can short-circuit the generic
 * "always deliver" block — avoids double-delivery of the same artifact event
 * (R4#6 catch).
 */

import { randomUUID } from "node:crypto";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { resolveChatThreadId } from "./chat-thread-utils.js";
import { buildSessionKey, type HookPayload } from "./hook-payload.js";
import type { LeadEventEnvelope, LeadRuntime } from "./lead-runtime.js";
import { getProofShotParams, patchSessionParams } from "./proofshot-session.js";
import type { RuntimeRegistry } from "./runtime-registry.js";

/** Subset of IngestEvent we need — avoids depending on the full type. */
export interface ArtifactEmittedEvent {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	payload?: Record<string, unknown>;
}

export interface ArtifactEventResult {
	/** True if Bridge owned the event (delivery path took over). */
	handled: boolean;
	/** Set when handled — for tests + observability. */
	seq?: number;
	/** Set when handled — true if runtime.deliver returned `{delivered:true}`. */
	delivered?: boolean;
}

const DEFAULT_SIZE_CAP_BYTES = 25 * 1024 * 1024;
const DEFAULT_FILE_COUNT_CAP = 10;
const DEFAULT_OVERSIZE_FALLBACK =
	"部分文件 >25MB, 已跳过 Discord 附件; 见 GitHub PR comment.";

export async function handleArtifactEvent(
	store: StateStore,
	projects: ProjectEntry[],
	registry: RuntimeRegistry,
	event: ArtifactEmittedEvent,
): Promise<ArtifactEventResult> {
	const session = store.getSession(event.execution_id);
	if (!session) {
		console.warn(
			`[artifact-event] no session for execId=${event.execution_id} — generic delivery will skip too`,
		);
		return { handled: false };
	}

	const labels = store.getSessionLabels(event.execution_id) ?? [];

	// resolveLeadForIssue throws on unknown project — wrap.
	let leadAgentId: string;
	let leadChatChannel: string | undefined;
	try {
		const { lead } = resolveLeadForIssue(projects, event.project_name, labels);
		leadAgentId = lead.agentId;
		leadChatChannel = lead.chatChannel;
	} catch (err) {
		console.warn(
			`[artifact-event] resolveLeadForIssue failed for ${event.project_name}: ${(err as Error).message}`,
		);
		return { handled: false };
	}

	const chatThreadId = resolveChatThreadId(
		store,
		event.issue_id,
		leadChatChannel,
	);

	const payload = event.payload ?? {};
	const paths = Array.isArray(payload.paths)
		? (payload.paths as unknown[]).filter(
				(p): p is string => typeof p === "string",
			)
		: [];
	const kind = payload.kind === "3d" ? "3d" : "ui";
	const dedupKey =
		typeof payload.dedup_key === "string" ? payload.dedup_key : undefined;
	const attempt =
		typeof payload.attempt === "number" && Number.isInteger(payload.attempt)
			? payload.attempt
			: undefined;

	const hookPayload: HookPayload = {
		event_type: "artifact_delivery",
		execution_id: event.execution_id,
		issue_id: event.issue_id,
		issue_identifier: session.issue_identifier ?? undefined,
		issue_title: session.issue_title ?? undefined,
		project_name: event.project_name,
		paths,
		kind,
		chat_thread_id: chatThreadId,
		dedup_key: dedupKey,
		attempt,
		size_cap_bytes: DEFAULT_SIZE_CAP_BYTES,
		file_count_cap: DEFAULT_FILE_COUNT_CAP,
		oversize_fallback_text: DEFAULT_OVERSIZE_FALLBACK,
	};

	const eventId = event.event_id ?? randomUUID();
	const sessionKey = buildSessionKey(session);

	const seq = store.appendLeadEvent(
		leadAgentId,
		eventId,
		"artifact_delivery",
		JSON.stringify(hookPayload),
		sessionKey,
	);

	// Build envelope manually — appendLeadEvent returns numeric seq, not envelope.
	const envelope: LeadEventEnvelope = {
		seq,
		event: hookPayload,
		sessionKey,
		leadId: leadAgentId,
		timestamp: new Date().toISOString(),
	};

	// resolveWithLead can throw if no runtime registered for the lead.
	let runtime: LeadRuntime;
	try {
		const resolved = registry.resolveWithLead(
			projects,
			event.project_name,
			labels,
		);
		runtime = resolved.runtime;
	} catch (err) {
		store.recordDeliveryFailure(
			seq,
			`resolveWithLead: ${(err as Error).message}`,
		);
		return { handled: true, seq, delivered: false };
	}

	let result: { delivered: boolean; error?: string };
	try {
		result = await runtime.deliver(envelope);
	} catch (err) {
		store.recordDeliveryFailure(
			seq,
			`deliver threw: ${(err as Error).message}`,
		);
		return { handled: true, seq, delivered: false };
	}

	if (result.delivered === true) {
		store.markLeadEventDelivered(seq);
		// Advance run state to completed — ONLY when attempt matches the run
		// record (defends against stale artifacts from earlier attempts).
		if (dedupKey != null && attempt != null) {
			patchSessionParams(store, event.execution_id, (cur) => {
				const proofs = getProofShotParams(cur);
				const runs = proofs.runs ?? {};
				const run = runs[dedupKey];
				if (!run) return cur; // unknown dedupKey — ignore
				if (run.attempt !== attempt) return cur; // stale artifact, leave alone
				if (run.state !== "pending" && run.state !== "running") return cur;
				return {
					...cur,
					proofshot: {
						...proofs,
						runs: {
							...runs,
							[dedupKey]: {
								...run,
								state: "completed",
								updatedAt: Date.now(),
							},
						},
					},
				};
			});
		}
		return { handled: true, seq, delivered: true };
	}

	store.recordDeliveryFailure(
		seq,
		result.error ?? "runtime returned {delivered:false}",
	);
	return { handled: true, seq, delivered: false };
}
