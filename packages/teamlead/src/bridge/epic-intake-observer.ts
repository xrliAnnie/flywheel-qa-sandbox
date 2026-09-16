import {
	effectivePatrolIntervalMs,
	getGlobalPatrolConfigSnapshot,
	getProjectPatrolConfigSnapshot,
} from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { readEpicIntakeThreadMessage } from "./chat-thread-utils.js";
import { isIntakeEpic, resolveEpicIntakeOwner } from "./epic-intake.js";
import type { EpicIntakeRouterDeps } from "./epic-intake-route.js";
import {
	collectEpicScope,
	fetchLinearActiveScopeSnapshot,
} from "./linear-epic-query.js";
export function createEpicIntakeObserver(deps: {
	projects: ProjectEntry[];
	store: Pick<StateStore, "hasEpicDispatchRecord" | "getChatThreadByIssue">;
	apiKey?: string;
	fallbackBotToken?: string;
	collect?: typeof collectEpicScope;
	snapshot?: typeof fetchLinearActiveScopeSnapshot;
	readMessage?: typeof readEpicIntakeThreadMessage;
	patrolIntervalMs?: (project: ProjectEntry) => number;
	now?: () => Date;
}): EpicIntakeRouterDeps["observe"] {
	return async (row, evidence) => {
		const project = deps.projects.find(
			(p) => p.projectName === row.projectName,
		);
		const lead = project?.leads.find(
			(l) => l.agentId === row.leadId && l.canSpawnRunners !== false,
		);
		const token = lead?.botToken ?? deps.fallbackBotToken;
		if (
			!project?.linear ||
			!lead ||
			!deps.apiKey ||
			(evidence.messageId && (!lead.botUserId || !token))
		)
			throw new Error("intake_verification_unconfigured");
		const now = deps.now ?? (() => new Date());
		const scope = await (deps.collect ?? collectEpicScope)(
			deps.apiKey,
			project.linear,
			{ pendingIssueIds: [row.issueUuid], now },
		);
		const root = scope.candidates.find((r) => r.id === row.issueUuid);
		if (!root && !scope.missingIssueIds.includes(row.issueUuid))
			throw new Error("intake_scope_incomplete");
		const owner = root ? resolveEpicIntakeOwner(deps.projects, root) : null;
		const active =
			!!root &&
			owner?.ok === true &&
			owner.projectName === row.projectName &&
			owner.leadId === row.leadId &&
			isIntakeEpic({
				hasParent: root.parent !== null,
				departmentMatches: true,
				stateType: root.state.type,
				hasChildIssues: root.hasChildIssues,
				hasProjectDispatch: root.hasChildIssues
					? null
					: deps.store.hasEpicDispatchRecord(
							row.projectName,
							root.id,
							root.identifier,
						),
			}) &&
			root.episodes.some((e) => e.active && e.eventUid === row.eventUid);
		let directChildIds: string[] = [];
		if (active && root) {
			const snapshot = await (deps.snapshot ?? fetchLinearActiveScopeSnapshot)(
				deps.apiKey,
				project.linear,
				{
					collectedScope: { ...scope, candidates: [root] },
					now,
					hasProjectDispatch: (uuid, identifier) =>
						deps.store.hasEpicDispatchRecord(row.projectName, uuid, identifier),
					departmentMatches: () => true,
				},
			);
			directChildIds = snapshot.items
				.filter((child) => child.parent?.id === row.issueUuid)
				.map((child) => child.id);
		}
		const threads = [...new Set([row.issueUuid, row.identifier])]
			.map((id) => deps.store.getChatThreadByIssue(id, lead.chatChannel))
			.filter((t) => t !== undefined);
		const thread = threads[0];
		if (
			(!!evidence.messageId && !thread) ||
			threads.some(
				(t) =>
					t.thread_id !== thread?.thread_id ||
					(t.lead_id !== null && t.lead_id !== row.leadId),
			) ||
			(!!evidence.threadId && thread?.thread_id !== evidence.threadId)
		)
			throw new Error("intake_canonical_thread_missing");
		const message = evidence.messageId
			? await (deps.readMessage ?? readEpicIntakeThreadMessage)(
					thread!.thread_id,
					evidence.messageId,
					token!,
				)
			: null;
		return {
			active,
			directChildIds,
			canonicalThreadId: thread?.thread_id ?? null,
			message,
			leadBotUserId: lead.botUserId ?? null,
			now: now().toISOString(),
			patrolIntervalMs:
				deps.patrolIntervalMs?.(project) ??
				effectivePatrolIntervalMs(
					getProjectPatrolConfigSnapshot(project.projectRoot).config,
					getGlobalPatrolConfigSnapshot().config,
				),
		};
	};
}
