import {
	type LeadConfig,
	type ProjectEntry,
	resolveLeadForIssue,
} from "../ProjectConfig.js";
import type { StateStore, WorkflowGateHolderRow } from "../StateStore.js";

interface FounderGateLeadResolverInput {
	store: StateStore;
	projects: ProjectEntry[];
	holder: WorkflowGateHolderRow;
}

export type FounderGateLeadResolution =
	| {
			ok: false;
			reason:
				| "run_missing"
				| "session_missing"
				| "labels_unavailable"
				| "lead_unavailable";
	  }
	| {
			ok: true;
			lead: LeadConfig;
			matchMethod: "label" | "general";
			labels: string[];
	  };

export function resolveLeadForHolder(
	input: FounderGateLeadResolverInput,
): FounderGateLeadResolution {
	const run = input.store.getWorkflowRun(input.holder.run_id);
	if (!run) return { ok: false, reason: "run_missing" };
	const source = input.store.getSession(input.holder.source_execution_id);
	if (!source) return { ok: false, reason: "session_missing" };
	let labels: string[];
	try {
		labels = input.store.getSessionLabels(input.holder.source_execution_id);
	} catch {
		return { ok: false, reason: "labels_unavailable" };
	}
	try {
		const { lead, matchMethod } = resolveLeadForIssue(
			input.projects,
			run.project_name,
			labels,
		);
		return { ok: true, lead, matchMethod, labels };
	} catch {
		return { ok: false, reason: "lead_unavailable" };
	}
}

export function resolveFounderGateBotToken(
	input: FounderGateLeadResolverInput & {
		fallbackToken?: string;
	},
): string | undefined {
	const resolved = resolveLeadForHolder(input);
	if (!resolved.ok) return undefined;
	return (resolved.lead.botToken ?? input.fallbackToken)?.trim() || undefined;
}

export type ShadowDeclarationLeadIdentity =
	| { ok: false; reason: "lead_identity_unavailable" }
	| {
			ok: true;
			agentId: string;
			botToken: string;
			botUserId: string;
			chatChannel: string;
	  };

export function resolveLeadIdentityForShadowDeclaration(
	input: FounderGateLeadResolverInput,
): ShadowDeclarationLeadIdentity {
	const resolved = resolveLeadForHolder(input);
	if (
		!resolved.ok ||
		resolved.labels.length === 0 ||
		resolved.matchMethod !== "label"
	) {
		return { ok: false, reason: "lead_identity_unavailable" };
	}
	const agentId = resolved.lead.agentId.trim();
	const botToken = resolved.lead.botToken?.trim() ?? "";
	const botUserId = resolved.lead.botUserId?.trim() ?? "";
	const chatChannel = resolved.lead.chatChannel.trim();
	if (!agentId || !botToken || !botUserId || !chatChannel) {
		return { ok: false, reason: "lead_identity_unavailable" };
	}
	return { ok: true, agentId, botToken, botUserId, chatChannel };
}
