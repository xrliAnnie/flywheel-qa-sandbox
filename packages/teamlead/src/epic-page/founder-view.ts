export function identifierKey(
	id: string,
): [
	cls: 0 | 1,
	prefix: string,
	numLen: number,
	numDigits: string,
	raw: string,
] {
	const match = /^([A-Za-z]+)-(\d+)$/.exec(id);
	if (!match) return [1, "", 0, "", id];
	const digits = match[2]!.replace(/^0+(?=\d)/, "");
	return [0, match[1]!, digits.length, digits, id];
}

export function compareIdentifier(a: string, b: string): number {
	const left = identifierKey(a),
		right = identifierKey(b);
	for (let i = 0; i < left.length; i++) {
		if (left[i]! < right[i]!) return -1;
		if (left[i]! > right[i]!) return 1;
	}
	return 0;
}

import {
	type Cell,
	type EpicItem,
	type EpicPage,
	type RootCounts,
	resolvePointer,
} from "./model.js";
import { classifyItem, type ItemClass, rootOf } from "./rules.js";

export const ROOT_GROUP: Record<string, number> = {
	started: 0,
	unstarted: 1,
	backlog: 2,
	triage: 2,
};
export const CHILD_GROUP = {
	live: 0,
	waiting: 1,
	free: 2,
	idle: 3,
	unknown: 4,
} as const;
export type ViewRuleId =
	| "view.order.v1"
	| "view.epic_waiting.v1"
	| "view.blocker_scope.v1"
	| "view.progress.v1"
	| "view.epic_hidden.v1"
	| "view.terminal_tail.v1";
export interface ViewProvenance {
	rule: ViewRuleId;
	from: string[];
	observedAt: string;
}
export type ProgressLine =
	| { kind: "live"; node: string; attempt?: number; status?: string }
	| { kind: "missing"; reasons: string[] }
	| { kind: "waiting" | "free"; blockers: string[] }
	| { kind: "live_no_run" | "idle" };
export interface ChildView {
	itemIndex: number;
	identifier: string;
	title: string;
	url: string | null;
	cls: ItemClass | null;
	stateName: string;
	blockers: Array<{
		identifier: string;
		where: "same_epic" | "other_epic" | "outside";
		otherRoot?: string;
	}>;
	blockerScope: ViewProvenance | null;
	progress: ProgressLine & { view: ViewProvenance };
	signals: EpicItem["signals"];
}
export interface EpicView {
	rootIndex: number;
	identifier: string;
	title: string;
	url: string;
	state: { name: string; type: string };
	counts: RootCounts["counts"] | null;
	countsMissing?: Cell<RootCounts>["missing"];
	allWaitingOn: { blockers: string[]; view: ViewProvenance } | null;
	children: ChildView[];
	terminal: { done: number; canceled: number; view: ViewProvenance | null };
}
export type FounderView =
	| {
			scopeUnavailable: true;
			epics: [];
			unattached: [];
			hiddenDoneEpics: null;
			order: null;
	  }
	| {
			scopeUnavailable: false;
			epics: EpicView[];
			unattached: ChildView[];
			hiddenDoneEpics: { count: number; view: ViewProvenance };
			order: ViewProvenance;
	  };

function provenance(
	page: EpicPage,
	rule: ViewRuleId,
	paths: string[],
): ViewProvenance {
	const from = [...new Set(paths)].sort();
	const times = from.map(
		(path) => (resolvePointer(page, path) as Cell<unknown>).observed_at,
	);
	times.sort(
		(a, b) => Date.parse(a) - Date.parse(b) || (a < b ? -1 : a > b ? 1 : 0),
	);
	return { rule, from, observedAt: times.at(-1)! };
}
function progress(item: EpicItem, cls: ItemClass | null): ProgressLine {
	const missing = [item.run, item.attempt, item.session].filter(
		(c) => c.value === null,
	);
	if (missing.length)
		return {
			kind: "missing",
			reasons: [...new Set(missing.map((c) => c.missing!.reason))].sort(),
		};
	if (cls === "live") {
		const run = item.run.value![0];
		if (!run) return { kind: "live_no_run" };
		return {
			kind: "live",
			node: run.current_node_label,
			attempt: item.attempt.value![0]?.attempt,
			status: item.session.value!.latest[0]?.status,
		};
	}
	if (cls === "waiting" || cls === "free")
		return {
			kind: cls,
			blockers: item.blocked_by
				.value!.filter(
					(b) => cls === "free" || b.blocker_state_type !== "completed",
				)
				.map((b) => b.identifier)
				.sort(compareIdentifier),
		};
	return { kind: "idle" };
}
const open = (c: ChildView) => c.cls !== "done" && c.cls !== "canceled";
function childCompare(a: ChildView, b: ChildView) {
	const group = (c: ChildView) =>
		c.cls === "done" || c.cls === "canceled"
			? 5
			: CHILD_GROUP[c.cls ?? "unknown"];
	return group(a) - group(b) || compareIdentifier(a.identifier, b.identifier);
}
export function buildFounderView(page: EpicPage): FounderView {
	const roots = page.header.roots.value!;
	const byId = new Map(page.items.map((i) => [i.identifier, i]));
	const indexes = new Map(page.items.map((i, n) => [i.identifier, n]));
	const rootIds = new Set(roots.map((r) => r.identifier));
	const owners = new Map(
		page.items.map((i) => [i.identifier, rootOf(i, byId, rootIds)]),
	);
	function parentPaths(id: string): string[] {
		const paths: string[] = [];
		const visited = new Set<string>();
		while (byId.has(id) && !visited.has(id)) {
			visited.add(id);
			paths.push(`/items/${indexes.get(id)!}/parent`);
			const parent = byId.get(id)!.parent.value;
			if (parent === null) break;
			id = parent;
		}
		return paths;
	}
	const children: ChildView[] = page.items.map((item, itemIndex) => {
		const cls = classifyItem(item);
		const blockers = item.blocked_by
			.value!.filter((b) => b.blocker_state_type !== "completed")
			.map((b) => {
				const owner = owners.get(b.identifier);
				const where =
					!b.in_scope || !byId.has(b.identifier)
						? "outside"
						: owner != null && owner === owners.get(item.identifier)
							? "same_epic"
							: "other_epic";
				return {
					identifier: b.identifier,
					where,
					...(where === "other_epic" && owner ? { otherRoot: owner } : {}),
				} as ChildView["blockers"][number];
			})
			.sort((a, b) => compareIdentifier(a.identifier, b.identifier));
		const blockerPaths = item.blocked_by
			.value!.filter((b) => b.blocker_state_type !== "completed" && b.in_scope)
			.flatMap((b) => parentPaths(b.identifier));
		return {
			itemIndex,
			identifier: item.identifier,
			title: item.title.value!,
			url: item.url.value,
			cls,
			stateName: item.state.value!.name,
			blockers,
			blockerScope: blockers.length
				? provenance(page, "view.blocker_scope.v1", [
						"/header/items",
						"/header/roots",
						`/items/${itemIndex}/blocked_by`,
						...parentPaths(item.identifier),
						...blockerPaths,
					])
				: null,
			progress: {
				...progress(item, cls),
				view: provenance(
					page,
					"view.progress.v1",
					["state", "blocked_by", "run", "attempt", "session"].map(
						(k) => `/items/${itemIndex}/${k}`,
					),
				),
			},
			signals: item.signals,
		};
	});
	const epics: EpicView[] = [];
	let hidden = 0;
	for (const [rootIndex, root] of roots.entries()) {
		const members = children.filter(
			(c) => owners.get(c.identifier) === root.identifier,
		);
		const countsCell = page.header.root_counts[rootIndex]!;
		const counts = countsCell.value?.counts ?? null;
		const visible = members.filter(open).sort(childCompare);
		if (
			(counts
				? counts.live + counts.waiting + counts.free + counts.idle
				: visible.length) === 0
		) {
			// F1 excludes childless roots, but they are not completed Epics.
			if (counts && counts.total > 0) hidden++;
			continue;
		}
		const waiting = visible.filter((c) => c.cls === "waiting");
		epics.push({
			rootIndex,
			identifier: root.identifier,
			title: root.title,
			url: root.url,
			state: root.state,
			counts,
			...(countsCell.missing ? { countsMissing: countsCell.missing } : {}),
			allWaitingOn:
				counts &&
				counts.live === 0 &&
				counts.free === 0 &&
				counts.idle === 0 &&
				counts.waiting > 0
					? {
							blockers: [
								...new Set(
									waiting.flatMap((c) => c.blockers.map((b) => b.identifier)),
								),
							].sort(compareIdentifier),
							view: provenance(page, "view.epic_waiting.v1", [
								`/header/root_counts/${rootIndex}`,
								...waiting.flatMap((c) => [
									`/items/${c.itemIndex}/blocked_by`,
									`/items/${c.itemIndex}/state`,
								]),
							]),
						}
					: null,
			children: visible,
			terminal: {
				done: counts?.done ?? members.filter((c) => c.cls === "done").length,
				canceled:
					counts?.canceled ??
					members.filter((c) => c.cls === "canceled").length,
				view: counts
					? null
					: provenance(
							page,
							"view.terminal_tail.v1",
							members.flatMap((c) => [
								`/items/${c.itemIndex}/state`,
								`/items/${c.itemIndex}/parent`,
							]),
						),
			},
		});
	}
	epics.sort(
		(a, b) =>
			(ROOT_GROUP[a.state.type] ?? 3) - (ROOT_GROUP[b.state.type] ?? 3) ||
			compareIdentifier(a.identifier, b.identifier),
	);
	const rootPaths = [
		"/header/roots",
		...page.header.root_counts.map((_, i) => `/header/root_counts/${i}`),
	];
	return {
		scopeUnavailable: false,
		epics,
		unattached: children
			.filter((c) => owners.get(c.identifier) === null && open(c))
			.sort(childCompare),
		hiddenDoneEpics: {
			count: hidden,
			view: provenance(page, "view.epic_hidden.v1", rootPaths),
		},
		order: provenance(page, "view.order.v1", [
			...rootPaths,
			...page.items.flatMap((_, i) =>
				["parent", "state", "blocked_by"].map((k) => `/items/${i}/${k}`),
			),
		]),
	};
}
