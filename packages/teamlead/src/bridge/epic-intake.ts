import { createHash } from "node:crypto";
import { DepartmentRegistry } from "../department-registry.js";
import type { StateStore } from "../StateStore.js";
import type { EpicIntakeRecord } from "./epic-intake-store.js";
import type { collectEpicScope } from "./linear-epic-query.js";

export async function scanEpicIntakes(options: {
	store: Pick<
		StateStore,
		| "beginEpicIntakeScan"
		| "completeEpicIntakeScan"
		| "listEpicIntakes"
		| "setEpicIntakeActive"
		| "markEpicIntakePageDirty"
		| "recordEpicIntake"
		| "hasEpicDispatchRecord"
	>;
	projects: ProjectEntry[];
	projectName: string;
	apiKey: string;
	collect?: typeof collectEpicScope;
	enqueue: (record: EpicIntakeRecord) => void | Promise<void>;
	now?: () => Date;
}): Promise<void> {
	const { store, projectName } = options;
	const project = options.projects.find((p) => p.projectName === projectName);
	if (!project?.linear)
		throw new Error("Epic intake requires an explicit Linear binding");
	const now = options.now ?? (() => new Date());
	const scanStartedAt = now().toISOString();
	const cursor = store.beginEpicIntakeScan(projectName, scanStartedAt);
	const prior = store.listEpicIntakes(projectName);
	const collect =
		options.collect ??
		(await import("./linear-epic-query.js")).collectEpicScope;
	const scope = await collect(options.apiKey, project.linear, {
		now,
		lastSuccessfulScanStartedAt:
			cursor.lastSuccessfulScanStartedAt ?? undefined,
		pendingIssueIds: [
			...new Set(
				prior
					.filter(
						(row) =>
							row.active &&
							(row.workState === "pending" ||
								row.workState === "needs_founder"),
					)
					.map((row) => row.issueUuid),
			),
		],
	});
	const current = new Map(scope.candidates.map((root) => [root.id, root]));
	for (const row of prior) {
		const root = current.get(row.issueUuid);
		if (!root && !scope.missingIssueIds.includes(row.issueUuid)) continue;
		const owner = root ? resolveEpicIntakeOwner(options.projects, root) : null;
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
					: store.hasEpicDispatchRecord(projectName, root.id, root.identifier),
			}) &&
			root.episodes.some(
				(episode) => episode.active && episode.eventUid === row.eventUid,
			);
		store.setEpicIntakeActive(row.eventUid, active, scope.fetchedAt);
		if (
			root &&
			cursor.lastSuccessfulScanStartedAt &&
			Date.parse(root.updatedAt) >
				Date.parse(cursor.lastSuccessfulScanStartedAt)
		) {
			store.markEpicIntakePageDirty(row.eventUid, scope.fetchedAt);
		}
	}
	for (const root of scope.candidates) {
		const owner = resolveEpicIntakeOwner(options.projects, root);
		if (
			!owner.ok ||
			owner.projectName !== projectName ||
			["completed", "canceled"].includes(root.state.type)
		)
			continue;
		if (
			!root.hasChildIssues &&
			store.hasEpicDispatchRecord(projectName, root.id, root.identifier)
		)
			continue;
		for (const episode of root.episodes) {
			const old = episode.startedAt < cursor.bootstrapStartedAt;
			if (old && !episode.active) continue;
			const record = store.recordEpicIntake({
				issueUuid: root.id,
				identifier: root.identifier,
				startedAt: episode.startedAt,
				intakeAt: now().toISOString(),
				observedAt: scope.fetchedAt,
				projectName,
				leadId: owner.leadId,
				bindingDigest: owner.bindingDigest,
				sourceSpanIds: episode.sourceSpanIds,
				backfill: old,
				active: episode.active && root.state.type === "started",
				hasChildIssues: root.hasChildIssues,
			});
			if (
				record &&
				record.projectName === projectName &&
				record.leadId === owner.leadId
			)
				await options.enqueue(record);
		}
	}
	// Retry the same overlap until every root history is readable; healthy events
	// have already committed and retain their canonical identities on replay.
	if (!scope.historyFailures?.length)
		store.completeEpicIntakeScan(projectName, scanStartedAt);
}

import type { ProjectEntry } from "../ProjectConfig.js";

export function resolveEpicIntakeOwner(
	projects: ProjectEntry[],
	root: {
		team: { key: string };
		project: { name: string } | null;
		labels: string[];
		parent: { id: string } | null;
	},
):
	| { ok: true; projectName: string; leadId: string; bindingDigest: string }
	| { ok: false; reason: string } {
	if (root.parent !== null) return { ok: false, reason: "has_parent" };
	const labels = new Set(root.labels.map((label) => label.toLowerCase()));
	const matches = projects.filter(
		({ linear }) =>
			linear &&
			linear.team === root.team.key &&
			(!linear.project || linear.project === root.project?.name) &&
			(!linear.label || labels.has(linear.label.toLowerCase())),
	);
	if (matches.length !== 1)
		return {
			ok: false,
			reason: matches.length ? "project_ambiguous" : "project_unmatched",
		};
	const project = matches[0]!;
	const owner = new DepartmentRegistry(projects).resolveCanonicalLead(
		project.projectName,
		root.labels,
	);
	if (!owner.ok) return { ok: false, reason: owner.decision.reason };
	return {
		ok: true,
		projectName: project.projectName,
		leadId: owner.lead.agentId,
		bindingDigest: createHash("sha256")
			.update(
				JSON.stringify({
					projectName: project.projectName,
					linear: project.linear,
					leadId: owner.lead.agentId,
					labels: owner.lead.match.labels,
				}),
			)
			.digest("hex"),
	};
}

/** Shared admission rule for intake, page roots and pending invalidation. */
export function isIntakeEpic(input: {
	hasParent: boolean;
	departmentMatches: boolean;
	stateType: string;
	hasChildIssues: boolean | null;
	hasProjectDispatch: boolean | null;
}): boolean {
	return (
		!input.hasParent &&
		input.departmentMatches &&
		input.stateType === "started" &&
		input.hasChildIssues !== null &&
		(input.hasChildIssues || input.hasProjectDispatch === false)
	);
}

export interface StartedEpisode {
	eventUid: string;
	startedAt: string;
	endedAt: string | null;
	sourceSpanIds: string[];
	active: boolean;
}

interface StateSpan {
	id: string;
	stateId: string;
	stateType: string;
	startedAt: string;
	endedAt: string | null;
}

function timestamp(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
			value,
		) ||
		!Number.isFinite(Date.parse(value))
	) {
		throw new Error("Invalid Epic stateHistory timestamp");
	}
	return new Date(value).toISOString();
}

/** Call only after collecting all history pages. Reject gaps rather than invent entries. */
export function collectStartedEpisodes(
	issueUuid: string,
	history: unknown[],
): StartedEpisode[] {
	if (!issueUuid || issueUuid.includes(":"))
		throw new Error("Invalid Epic issue identity");
	const unique = new Map<string, StateSpan>();
	for (const raw of history) {
		if (!raw || typeof raw !== "object")
			throw new Error("Invalid Epic stateHistory span");
		const item = raw as Record<string, unknown>;
		const state = item.state as { type?: unknown } | null;
		if (
			typeof item.id !== "string" ||
			!item.id ||
			typeof item.stateId !== "string" ||
			!item.stateId ||
			!state ||
			typeof state.type !== "string" ||
			!state.type
		) {
			throw new Error("Missing Epic stateHistory identity or state type");
		}
		const span: StateSpan = {
			id: item.id,
			stateId: item.stateId,
			stateType: state.type,
			startedAt: timestamp(item.startedAt),
			endedAt: item.endedAt === null ? null : timestamp(item.endedAt),
		};
		if (span.endedAt !== null && span.endedAt <= span.startedAt)
			throw new Error("Invalid Epic stateHistory interval");
		const previous = unique.get(span.id);
		if (previous && JSON.stringify(previous) !== JSON.stringify(span))
			throw new Error("Conflicting Epic stateHistory duplicate");
		unique.set(span.id, span);
	}
	const spans = [...unique.values()].sort(
		(a, b) =>
			a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
	);
	const episodes: StartedEpisode[] = [];
	for (const [index, span] of spans.entries()) {
		const previous = spans[index - 1];
		if (previous && previous.endedAt !== span.startedAt)
			throw new Error("Incomplete or overlapping Epic stateHistory");
		if (span.stateType !== "started") continue;
		const episode = episodes.at(-1);
		if (previous?.stateType === "started" && episode) {
			episode.endedAt = span.endedAt;
			episode.active = span.endedAt === null;
			episode.sourceSpanIds.push(span.id);
		} else {
			episodes.push({
				eventUid: `epic_intake:${issueUuid}:${span.startedAt}`,
				startedAt: span.startedAt,
				endedAt: span.endedAt,
				sourceSpanIds: [span.id],
				active: span.endedAt === null,
			});
		}
	}
	return episodes;
}

/** Cheap rider for GatePoller; network work is bounded and never awaited by tick. */
export function createEpicIntakeScheduler(options: {
	projects: () => string[];
	run: (projectName: string) => Promise<void>;
	onError: (projectName: string, error: unknown) => void;
	now?: () => number;
	maxConcurrent?: number;
}): { tick: () => void } {
	const nextDue = new Map<string, number>();
	const active = new Set<string>();
	const maxConcurrent = options.maxConcurrent ?? 4;
	if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)
		throw new Error("Invalid intake concurrency");
	let cursor = 0;
	return {
		tick() {
			const projects = [...new Set(options.projects())];
			const now = (options.now ?? Date.now)();
			const start = cursor % Math.max(projects.length, 1);
			for (
				let offset = 0;
				offset < projects.length && active.size < maxConcurrent;
				offset++
			) {
				const index = (start + offset) % projects.length;
				const project = projects[index]!;
				if (active.has(project) || (nextDue.get(project) ?? -Infinity) > now)
					continue;
				cursor = index + 1;
				active.add(project);
				nextDue.set(project, now + 30000);
				void Promise.resolve()
					.then(() => options.run(project))
					.catch((error) => options.onError(project, error))
					.finally(() => active.delete(project));
			}
		},
	};
}
