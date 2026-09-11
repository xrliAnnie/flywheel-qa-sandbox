import type { AttentionCandidate, AttentionInput } from "../../attention.js";
import type { Cell } from "../../model.js";
export function sourceCell<T>(
	value: T,
	kind: "linear" | "statestore" | "commdb" = "statestore",
	table = "test",
): Cell<T> {
	return {
		value,
		provenance:
			kind === "linear"
				? { kind, entity: "issue", id: "linear-source", field: table }
				: { kind, table, key: { id: table } },
		observed_at: "2026-09-09T10:00:00Z",
	};
}
export function candidate(
	n: number,
	kind: string,
	storage: "linear" | "statestore" | "commdb",
	table: string,
): AttentionCandidate {
	const since: Cell<string> =
		kind === "founder_named"
			? {
					...sourceCell<string>("2026-09-09T09:00:00Z", storage, table),
					value: null,
					missing: { reason: "since_unknown" },
				}
			: sourceCell("2026-09-09T09:00:00Z", storage, table);
	const result: AttentionCandidate = {
		key: storage === "commdb" ? `question:q${n}` : `holder:q${n}`,
		issue_id: sourceCell(`uuid-${n}`, "linear", "id"),
		identifier: sourceCell(`FLY-${n}`, "linear", "identifier"),
		title: sourceCell(`待处理事项 ${n}`, "linear", "title"),
		sources: [
			{
				fact: sourceCell({ id: `q${n}`, kind, state: "open" }, storage, table),
				since,
				...(storage === "commdb"
					? { recipient_role: sourceCell("lead" as const, "commdb", "mailbox") }
					: {}),
			},
		],
		thread: sourceCell(
			{ thread_id: "456", channel_id: "321" },
			"statestore",
			"chat_threads",
		),
	};
	for (const cell of [result.issue_id, result.identifier, result.title])
		if (cell.provenance.kind === "linear") cell.provenance.id = `uuid-${n}`;

	if (storage === "commdb" || storage === "statestore")
		for (const cell of [
			result.sources[0]!.fact,
			result.sources[0]!.since,
			result.sources[0]!.recipient_role,
		]) {
			if (
				cell &&
				(cell.provenance.kind === "commdb" ||
					cell.provenance.kind === "statestore")
			)
				cell.provenance.key = { question_id: `q${n}` };
		}
	if (storage === "linear") {
		result.sources[0]!.fact.value!.id = `uuid-${n}`;
		if (result.sources[0]!.fact.provenance.kind === "linear")
			result.sources[0]!.fact.provenance.id = `uuid-${n}`;
	}
	return result;
}
export function attentionFixture(): AttentionInput {
	return {
		guildId: sourceCell("123", "statestore", "discord_config"),
		identityReads: {
			statestore: sourceCell(
				{ available: true },
				"statestore",
				"issue_identity",
			),
			linear: sourceCell({ available: true }, "linear", "identity_query"),
		},
		reads: {
			gates: sourceCell({ count: 1 }, "statestore", "workflow_gate_holder"),
			questions: sourceCell({ count: 1 }, "commdb", "mailbox"),
			founder_review: sourceCell({ count: 1 }, "linear", "founder-review"),
		},
		candidates: [
			candidate(1, "founder_gate", "statestore", "workflow_gate_holder"),
			candidate(2, "question", "commdb", "mailbox"),
			candidate(3, "founder_named", "linear", "labels"),
		],
	};
}
