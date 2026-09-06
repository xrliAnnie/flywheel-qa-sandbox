import {
	CommDB,
	type EpicPageSignalQueryResult,
	type EpicPageSignalRow,
} from "flywheel-comm/db";
import { commDbPathForProject } from "../bridge/commdb-path.js";
import type { EpicPageSignalFacts, StateStore } from "../StateStore.js";
import type { Cell, EpicItem, Signal, StopReason } from "./model.js";
import { STOP_REASONS } from "./model.js";

const SIGNAL_WINDOW_MS = 14 * 24 * 60 * 60_000;

type SignalSourceCells = EpicItem["signal_sources"];

export interface EpicPageItemSignals {
	signals: Signal[];
	signal_sources: SignalSourceCells;
}

export interface ReadSignalsDeps {
	stateStore: Pick<StateStore, "getEpicPageSignalFacts">;
	openCommReadonly?: (
		path: string,
	) => Pick<CommDB, "listEpicPageSignals" | "close">;
	commDbPathForProject?: (projectName: string) => string;
}

export interface ReadSignalsInput {
	projectName: string;
	items: Array<{ uuid: string; identifier: string }>;
	now: Date;
}

interface Candidate {
	fullExecutionId: string;
	signal: Signal;
}

function sourceCell(
	kind: "statestore" | "commdb",
	item: ReadSignalsInput["items"][number],
	observedAt: string,
	count: number | undefined,
	missing?: "statestore_error" | "commdb_error" | "commdb_truncated",
): Cell<{ signals: number }> {
	const base = {
		provenance: {
			kind,
			table: kind === "statestore" ? "sessions" : "mailbox",
			key: {
				issue_id: item.uuid,
				issue_identifier: item.identifier,
			},
		},
		observed_at: observedAt,
	};
	return missing
		? { ...base, value: null, missing: { reason: missing } }
		: { ...base, value: { signals: count ?? 0 } };
}

function stateCandidate(
	fact: EpicPageSignalFacts["signals"][number],
	observedAt: string,
): Candidate {
	return {
		fullExecutionId: fact.execution_id,
		signal: {
			kind: fact.kind,
			since: fact.since,
			execution_id8: fact.execution_id.slice(0, 8),
			provenance: {
				kind: "statestore",
				table: fact.kind === "declared_blocked" ? "sessions" : "workflow_run",
				key:
					fact.kind === "declared_blocked"
						? { execution_id: fact.execution_id }
						: { run_id: fact.run_id },
			},
			observed_at: observedAt,
		},
	};
}

function commCandidate(row: EpicPageSignalRow, observedAt: string): Candidate {
	return {
		fullExecutionId: row.execution_id,
		signal: {
			kind: row.kind,
			since: row.since,
			execution_id8: row.execution_id.slice(0, 8),
			...(row.reason ? { reason: row.reason } : {}),
			provenance: {
				kind: "commdb",
				table: "mailbox",
				key: { execution_id: row.execution_id },
			},
			observed_at: observedAt,
		},
	};
}

function compareCandidates(left: Candidate, right: Candidate): number {
	return (
		left.signal.since.localeCompare(right.signal.since) ||
		left.fullExecutionId.localeCompare(right.fullExecutionId) ||
		STOP_REASONS.indexOf(left.signal.reason as StopReason) -
			STOP_REASONS.indexOf(right.signal.reason as StopReason) ||
		left.signal.kind.localeCompare(right.signal.kind)
	);
}

function deduplicate(candidates: Candidate[]): Signal[] {
	const seen = new Set<string>();
	return [...candidates].sort(compareCandidates).flatMap(({ signal }) => {
		const key = `${signal.execution_id8}\0${signal.kind}`;
		if (seen.has(key)) return [];
		seen.add(key);
		return [signal];
	});
}

export function readSignals(
	deps: ReadSignalsDeps,
	input: ReadSignalsInput,
): EpicPageItemSignals[] {
	const observedAt = input.now.toISOString();
	const stateReads: Array<EpicPageSignalFacts | undefined> = [];
	for (const item of input.items) {
		try {
			stateReads.push(
				deps.stateStore.getEpicPageSignalFacts(input.projectName, [
					item.uuid,
					item.identifier,
				]),
			);
		} catch (error) {
			console.error(
				"[EpicPage] StateStore signal projection failed:",
				error instanceof Error ? error.message : String(error),
			);
			stateReads.push(undefined);
		}
	}

	const executionToItems = new Map<string, number[]>();
	for (const [index, read] of stateReads.entries()) {
		for (const executionId of read?.execution_ids ?? []) {
			const indices = executionToItems.get(executionId) ?? [];
			indices.push(index);
			executionToItems.set(executionId, indices);
		}
	}
	const executionIds = [...executionToItems.keys()].sort();
	let commRead: EpicPageSignalQueryResult | undefined;
	let commMissing: "commdb_error" | "commdb_truncated" | undefined;
	try {
		const open = deps.openCommReadonly ?? CommDB.openReadonly;
		const resolvePath = deps.commDbPathForProject ?? commDbPathForProject;
		const db = open(resolvePath(input.projectName));
		try {
			commRead = db.listEpicPageSignals({
				executionIds,
				createdAfter: new Date(
					input.now.getTime() - SIGNAL_WINDOW_MS,
				).toISOString(),
				limit: Math.max(1, executionIds.length * 3),
			});
		} finally {
			db.close();
		}
		if (commRead.truncated) {
			commMissing = "commdb_truncated";
			commRead = undefined;
		}
	} catch (error) {
		console.error(
			"[EpicPage] CommDB signal projection failed:",
			error instanceof Error ? error.message : String(error),
		);
		commMissing = "commdb_error";
	}

	const candidates = input.items.map<Candidate[]>(() => []);
	for (const [index, read] of stateReads.entries()) {
		for (const fact of read?.signals ?? []) {
			candidates[index]!.push(stateCandidate(fact, observedAt));
		}
	}
	for (const row of commRead?.signals ?? []) {
		for (const index of executionToItems.get(row.execution_id) ?? []) {
			candidates[index]!.push(commCandidate(row, observedAt));
		}
	}

	return input.items.map((item, index) => {
		const signals = deduplicate(candidates[index]!);
		const stateCount = signals.filter(
			(signal) => signal.provenance.kind === "statestore",
		).length;
		const commCount = signals.length - stateCount;
		return {
			signals,
			signal_sources: {
				statestore: sourceCell(
					"statestore",
					item,
					observedAt,
					stateCount,
					stateReads[index] ? undefined : "statestore_error",
				),
				commdb: sourceCell("commdb", item, observedAt, commCount, commMissing),
			},
		};
	});
}
