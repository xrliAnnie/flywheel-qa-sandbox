/**
 * FLY-927 (W1): the Bridge wiring for the D1 Router — binds the pure
 * `createInfraAlertSink` to the real resolution chain
 * (sessions → resolveLeadForIssue → chat_threads) and the issue-thread
 * delivery leg. Extracted from plugin.ts so the glue is integration-testable
 * against a real (in-memory) StateStore.
 */

import type {
	AlertPayload,
	AlertResult,
} from "../LeadAlertNotifier.js";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { emitIssueThreadInfraNotification } from "./founder-thread-notifier.js";
import {
	type AlertSinkLike,
	type BoundIssueThread,
	createInfraAlertSink,
} from "./infra-event-router.js";

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
	/** Test seams. */
	routingEnabled?: () => boolean;
	fetchImpl?: typeof fetch;
	sleepFn?: (ms: number) => Promise<void>;
	logger?: (msg: string) => void;
}

/**
 * The routed alert sink plugin.ts installs in front of every emission source.
 * FLYWHEEL_ALERT_ROUTING unset ⇒ pure passthrough to `rawSink`.
 */
export function buildInfraAlertRouting(
	deps: InfraAlertRoutingDeps,
): AlertSinkLike {
	const resolveBoundIssueThread = (
		payload: AlertPayload,
	): BoundIssueThread | null => {
		// The three issue-progress emitters all carry the execution id in
		// sessionKey (gate-poller lead-pending/undelivered escalations + the
		// three-stage stuck alert). No sessionKey / unknown session ⇒ unbound.
		const executionId = payload.sessionKey;
		if (!executionId) return null;
		const session = deps.store.getSession(executionId);
		if (!session) return null;
		const { lead } = resolveLeadForIssue(
			deps.projects,
			session.project_name,
			parseLabels(session.issue_labels),
		);
		const thread = deps.store.getChatThreadByIssue(
			session.issue_id,
			lead.chatChannel,
		);
		if (!thread?.thread_id) return null;
		return {
			threadId: thread.thread_id,
			channelId: thread.channel_id,
			issueId: session.issue_id,
			issueIdentifier: session.issue_identifier ?? undefined,
			executionId,
		};
	};

	const deliverToIssueThread = async (
		payload: AlertPayload,
		thread: BoundIssueThread,
	): Promise<AlertResult> => {
		const session = deps.store.getSession(thread.executionId);
		const { lead } = resolveLeadForIssue(
			deps.projects,
			payload.projectName,
			parseLabels(session?.issue_labels),
		);
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
					fallback = await deps.rawSink.alert(payload);
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

	return createInfraAlertSink({
		rawSink: deps.rawSink,
		routingEnabled: deps.routingEnabled,
		resolveBoundIssueThread,
		deliverToIssueThread,
		logger: deps.logger,
	});
}
