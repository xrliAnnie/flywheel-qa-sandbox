import type { DependencyReviewEntry, EpicItem } from "./model.js";
import { isSchedulable } from "./rules.js";
import { EpicPageSchemaError } from "./schema-error.js";

const TERMINAL_STATES = new Set(["completed", "canceled"]);

export function computeDependencyReview(
	items: EpicItem[],
	ready: string[],
): DependencyReviewEntry[] {
	for (const item of items) {
		if (
			item.state.value === null ||
			item.state.missing !== undefined ||
			item.blocked_by.value === null ||
			item.blocked_by.missing !== undefined
		) {
			throw new EpicPageSchemaError(
				"dependency_review requires known state/blocked_by",
			);
		}
	}
	const schedulable = items.filter(isSchedulable);
	const canceled: Extract<
		DependencyReviewEntry,
		{ kind: "canceled_blocker" }
	>[] = schedulable
		.flatMap((item) =>
			item.state.value &&
			!TERMINAL_STATES.has(item.state.value.type) &&
			item.blocked_by.value
				? item.blocked_by.value
						.filter((entry) => entry.blocker_state_type === "canceled")
						.map((entry) => ({
							kind: "canceled_blocker" as const,
							item: item.identifier,
							blocker: entry.identifier,
						}))
				: [],
		)
		.sort(
			(left, right) =>
				left.item.localeCompare(right.item) ||
				left.blocker.localeCompare(right.blocker),
		)
		.filter(
			(entry, index, entries) =>
				index === 0 ||
				entry.item !== entries[index - 1]!.item ||
				entry.blocker !== entries[index - 1]!.blocker,
		);
	const identifiers = new Set(schedulable.map((item) => item.identifier));
	const edges = new Map(
		[...identifiers]
			.sort((left, right) => left.localeCompare(right))
			.map((identifier) => [identifier, new Set<string>()]),
	);
	for (const item of schedulable) {
		for (const blocker of item.blocked_by.value ?? []) {
			if (identifiers.has(blocker.identifier)) {
				edges.get(blocker.identifier)?.add(item.identifier);
			}
		}
	}

	let nextIndex = 0;
	const indexes = new Map<string, number>();
	const lowLinks = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const cycles: Extract<DependencyReviewEntry, { kind: "dependency_cycle" }>[] =
		[];
	const visit = (identifier: string): void => {
		indexes.set(identifier, nextIndex);
		lowLinks.set(identifier, nextIndex);
		nextIndex += 1;
		stack.push(identifier);
		onStack.add(identifier);

		for (const dependent of [...(edges.get(identifier) ?? [])].sort(
			(left, right) => left.localeCompare(right),
		)) {
			if (!indexes.has(dependent)) {
				visit(dependent);
				lowLinks.set(
					identifier,
					Math.min(lowLinks.get(identifier)!, lowLinks.get(dependent)!),
				);
			} else if (onStack.has(dependent)) {
				lowLinks.set(
					identifier,
					Math.min(lowLinks.get(identifier)!, indexes.get(dependent)!),
				);
			}
		}

		if (lowLinks.get(identifier) !== indexes.get(identifier)) return;
		const members: string[] = [];
		let member: string;
		do {
			member = stack.pop()!;
			onStack.delete(member);
			members.push(member);
		} while (member !== identifier);
		members.sort((left, right) => left.localeCompare(right));
		if (members.length > 1 || edges.get(identifier)?.has(identifier)) {
			cycles.push({ kind: "dependency_cycle", members });
		}
	};

	for (const identifier of edges.keys()) {
		if (!indexes.has(identifier)) visit(identifier);
	}
	cycles.sort((left, right) =>
		left.members[0]!.localeCompare(right.members[0]!),
	);

	const nonTerminal = schedulable.filter(
		(item) => item.state.value && !TERMINAL_STATES.has(item.state.value.type),
	);
	const allEdges = nonTerminal
		.flatMap((item) =>
			(item.blocked_by.value ?? [])
				.filter((blocker) => blocker.blocker_state_type !== "completed")
				.map((blocker) => ({
					blocker: blocker.identifier,
					blocked: item.identifier,
					blocker_state_type: blocker.blocker_state_type,
					in_scope: identifiers.has(blocker.identifier),
				})),
		)
		.sort(
			(left, right) =>
				left.blocked.localeCompare(right.blocked) ||
				left.blocker.localeCompare(right.blocker),
		);
	const allBlocked: DependencyReviewEntry[] =
		ready.length === 0 && nonTerminal.length > 0
			? [
					{
						kind: "all_blocked",
						non_terminal: nonTerminal.length,
						blocking_edges: allEdges.slice(0, 50),
						blocking_edges_truncated: allEdges.length > 50,
					},
				]
			: [];
	const review = [...canceled, ...cycles, ...allBlocked];
	if (review.length > 5000) {
		throw new EpicPageSchemaError(
			"dependency review exceeds 5000 entries",
			"size",
		);
	}
	return review;
}
