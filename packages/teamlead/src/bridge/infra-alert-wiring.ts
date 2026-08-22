/**
 * FLY-927 (W1): the Bridge wiring for the D1 Router — binds the pure
 * `createInfraAlertSink` to the real resolution chain
 * (sessions → resolveLeadForIssue → chat_threads) and the issue-thread
 * delivery leg. Extracted from plugin.ts so the glue is integration-testable
 * against a real (in-memory) StateStore.
 */

import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { correlationKeyFor } from "./AlertChannelHub.js";
import { emitIssueThreadInfraNotification } from "./founder-thread-notifier.js";
import {
	type AlertSinkLike,
	type BoundIssueThread,
	createInfraAlertSink,
	ISSUE_PROGRESS_KINDS,
} from "./infra-event-router.js";
import { escalatesAtEnqueue } from "./kind-contract.js";
import {
	deriveTicketProvider,
	ownerRegistryFromEnv,
	ownerTicketFace,
	resolveTicketOwner,
} from "./ticket-owner-map.js";

function parseLabels(raw: string | undefined | null): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((x): x is string => typeof x === "string")
			: [];
	} catch {
		return [];
	}
}

export interface InfraAlertRoutingDeps {
	store: StateStore;
	projects: ProjectEntry[];
	/** config.discordBotToken — fallback when the owning lead has no botToken. */
	globalBotToken?: string;
	/** The raw sink (Hub or notifier) — today's behavior + the fail-safe target. */
	rawSink: AlertSinkLike;
	/** FLY-1764 Flow 2: primary owner-mailbox last mile for ticket routes. */
	ticketSink?: AlertSinkLike;
	/** Optional Discord observation copy; default off. */
	copyTicketToChannel?: () => boolean;
	/** Test seams. */
	routingEnabled?: () => boolean;
	/** Test seam; production ticket enrichment is welded on by default. */
	ticketsEnabled?: () => boolean;
	fetchImpl?: typeof fetch;
	sleepFn?: (ms: number) => Promise<void>;
	logger?: (msg: string) => void;
	now?: () => number;
}

/**
 * The routed alert sink plugin.ts installs in front of every emission source.
 * Production routing is welded on; injected test seams may still isolate paths.
 */
export function buildInfraAlertRouting(
	deps: InfraAlertRoutingDeps,
): AlertSinkLike {
	const configuredLead = (payload: AlertPayload) =>
		deps.projects
			.find((project) => project.projectName === payload.projectName)
			?.leads.find((lead) => lead.agentId === payload.leadId);

	const resolveBoundIssueThread = (
		payload: AlertPayload,
	): BoundIssueThread | null => {
		// Ordinary issue-progress emitters carry the execution id in sessionKey.
		// Workflow alerts keep `wf:<run>` there for outbox/ticket grouping, so their
		// issue-thread copy resolves through the identity-bound metadata instead.
		// Their pinned issue + Lead identity keeps routing possible even when the
		// dead execution never had (or no longer has) a session row.
		const workflowEngine =
			payload.eventType === "workflow_engine_issue_alert"
				? payload.metadata?.workflowEngine
				: undefined;
		const executionId = workflowEngine?.executionId ?? payload.sessionKey;
		if (!executionId) return null;
		const session =
			deps.store.getSession(executionId) ??
			(workflowEngine?.issueId
				? deps.store.getSessionByIssue(workflowEngine.issueId)
				: undefined);
		const issueId = workflowEngine?.issueId ?? session?.issue_id;
		if (!issueId) return null;
		const lead = session
			? resolveLeadForIssue(
					deps.projects,
					session.project_name,
					parseLabels(session.issue_labels),
				).lead
			: configuredLead(payload);
		if (!lead) return null;
		const thread = deps.store.getChatThreadByIssue(issueId, lead.chatChannel);
		if (!thread?.thread_id) return null;
		return {
			threadId: thread.thread_id,
			channelId: thread.channel_id,
			issueId,
			issueIdentifier: session?.issue_identifier ?? undefined,
			executionId,
		};
	};

	const deliverToIssueThread = async (
		payload: AlertPayload,
		thread: BoundIssueThread,
	): Promise<AlertResult> => {
		const session =
			deps.store.getSession(thread.executionId) ??
			deps.store.getSessionByIssue(thread.issueId);
		const lead = session
			? resolveLeadForIssue(
					deps.projects,
					payload.projectName,
					parseLabels(session.issue_labels),
				).lead
			: configuredLead(payload);
		if (!lead) return (deps.ticketSink ?? deps.rawSink).alert(payload);
		const sev =
			payload.severity === "severe"
				? "🚨"
				: payload.severity === "warning"
					? "⚠️"
					: "ℹ️";
		// Fail-safe seam: undeliverable → the ORIGINAL alert goes through the RAW
		// sink (ticket queue), never back through the Router (no recursion).
		let fallback: AlertResult | null = null;
		const result = await emitIssueThreadInfraNotification(
			{
				executionId: thread.executionId,
				issueId: thread.issueId,
				issueIdentifier: thread.issueIdentifier,
				projectName: payload.projectName,
				kind: payload.eventType,
				content: `${sev} **${payload.title}**\n${payload.body}`,
				thread: {
					thread_id: thread.threadId,
					channel_id: thread.channelId,
					lead_id: lead.agentId,
					archived_at: null,
				},
				botToken: lead.botToken ?? deps.globalBotToken,
				onUndeliverable: async () => {
					fallback = await (deps.ticketSink ?? deps.rawSink).alert(payload);
				},
			},
			{
				store: deps.store,
				fetchImpl: deps.fetchImpl,
				sleepFn: deps.sleepFn,
			},
		);
		if (result.kind === "posted") return { sent: true };
		return fallback ?? { queued: true };
	};

	const routedSink = createInfraAlertSink({
		rawSink: deps.rawSink,
		ticketSink: deps.ticketSink,
		copyTicketToChannel: deps.copyTicketToChannel,
		routingEnabled: deps.routingEnabled,
		resolveBoundIssueThread,
		deliverToIssueThread,
		logger: deps.logger,
	});

	// FLY-927 (Task 2.3): owner @-target enrichment. The root POST is the ONLY
	// moment the mention can ride atomically (the Hub sees the messageId after
	// the fact), so the ticket context — owner, status, first-seen — is computed
	// HERE, before the sink. Ticket-queue kinds only; issue-progress kinds never
	// render a 🎫 header. Enrichment failure degrades to the un-enriched payload
	// (owner —), never blocks the alert.
	const ticketsEnabled = deps.ticketsEnabled ?? (() => true);
	const now = deps.now ?? (() => Date.now());
	const enrich = (payload: AlertPayload): AlertPayload => {
		if (!ticketsEnabled() || payload.ticket) return payload;
		if (ISSUE_PROGRESS_KINDS.has(payload.eventType)) return payload;
		try {
			const reg = ownerRegistryFromEnv(process.env);
			const session = payload.sessionKey
				? deps.store.getSession(payload.sessionKey)
				: undefined;
			// FLY-1082 (Task 2.5): a bot-down event has NO runner session to derive
			// a provider from — the dead side is an EXPLICIT event field
			// (metadata.infraBotDown.provider) and it wins over the derivations.
			const provider = payload.metadata?.infraBotDown
				? payload.metadata.infraBotDown.provider
				: session?.adapter_type
					? deriveTicketProvider({ adapterType: session.adapter_type })
					: deriveTicketProvider({
							leadBackend:
								deps.projects
									.find((p) => p.projectName === payload.projectName)
									?.leads.find((l) => l.agentId === payload.leadId)?.backend ??
								null,
						});
			const owner = resolveTicketOwner(payload.eventType, provider, reg);
			const face = ownerTicketFace(owner);
			// FLY-1082 (Task 1.5): (b)-type kinds land directly ESCALATED at
			// enqueue, contract-driven — the generalization of the old hardcoded
			// runner_lead_pending_unhandled special case (which, being an
			// issue-progress kind, never even reached this enrichment; the contract
			// keeps its semantics on the Hub path instead).
			const status = escalatesAtEnqueue(payload.eventType)
				? "ESCALATED"
				: "NEW";
			// first-seen: a re-fire of the SAME episode keeps the original stamp.
			const active = deps.store.getActiveAlertThread(
				correlationKeyFor(payload),
			);
			const firstSeenMs =
				active?.event_id === payload.eventId && active.first_seen_at
					? Date.parse(`${active.first_seen_at.replace(" ", "T")}Z`) || now()
					: now();
			const ownerRef =
				owner.kind === "infra_bot"
					? `infra_bot:${owner.side}`
					: owner.kind === "lead"
						? `lead:${owner.leadId}`
						: "";
			return {
				...payload,
				ticket: {
					ownerUserId: face.ownerUserId,
					ownerLabel: face.ownerLabel,
					status,
					firstSeenMs,
					ownerRef,
				},
			};
		} catch {
			return payload; // never block an alert on enrichment
		}
	};

	return { alert: (payload) => routedSink.alert(enrich(payload)) };
}
