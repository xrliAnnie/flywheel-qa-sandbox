import type {
	ShipJudgmentLegacyRetirementRow,
	StateStore,
} from "../StateStore.js";

const RETIREMENT_COPY = "旧三闸已退役，以本卡三点判断为准。";

export interface LegacyRetirementDeps {
	store: Pick<
		StateStore,
		| "seedShipJudgmentLegacyRetirement"
		| "listShipJudgmentLegacyRetirementWork"
		| "claimShipJudgmentLegacyRetirement"
		| "finishShipJudgmentLegacyRetirement"
		| "deferShipJudgmentLegacyRetirement"
	>;
	mode: "off" | "dry_run" | "auto";
	owner: string;
	now?: () => string;
	edit(input: {
		work: ShipJudgmentLegacyRetirementRow;
		messageId: string;
		content: string;
	}): Promise<{ ok: boolean; unavailable?: boolean }>;
	scan(input: {
		work: ShipJudgmentLegacyRetirementRow;
	}): Promise<
		{ kind: "found"; messageId: string } | { kind: "none" | "ambiguous" }
	>;
	clearReaction?(input: {
		work: ShipJudgmentLegacyRetirementRow;
	}): Promise<void>;
}

export interface LegacyRetirementResult {
	scanned: number;
	retired: number;
	unavailable: number;
	deferred: number;
}

/** Reads old rows once, then mutates only the new versioned retirement ledger. */
export async function reconcileShipJudgmentLegacyRetirement(
	deps: LegacyRetirementDeps,
): Promise<LegacyRetirementResult> {
	const result: LegacyRetirementResult = {
		scanned: 0,
		retired: 0,
		unavailable: 0,
		deferred: 0,
	};
	if (deps.mode === "off") return result;
	const sweepAt = deps.now?.() ?? new Date().toISOString();
	deps.store.seedShipJudgmentLegacyRetirement(sweepAt);
	for (const candidate of deps.store.listShipJudgmentLegacyRetirementWork(
		sweepAt,
		20,
	)) {
		result.scanned += 1;
		const now = deps.now?.() ?? sweepAt;
		const work = deps.store.claimShipJudgmentLegacyRetirement({
			questionId: candidate.questionId,
			owner: deps.owner,
			at: now,
		});
		if (!work) continue;
		let messageId = work.legacyMessageId;
		if (!messageId) {
			const scan = await deps.scan({ work });
			if (scan.kind !== "found") {
				deps.store.deferShipJudgmentLegacyRetirement({
					questionId: work.questionId,
					owner: deps.owner,
					generation: work.generation,
					at: deps.now?.() ?? now,
					reason: `scan_${scan.kind}`,
				});
				result.deferred += 1;
				continue;
			}
			messageId = scan.messageId;
		}
		const edited = await deps.edit({
			work,
			messageId,
			content: `${RETIREMENT_COPY}\n\`${work.legacyMarker}\``,
		});
		if (!edited.ok) {
			if (edited.unavailable) {
				deps.store.finishShipJudgmentLegacyRetirement({
					questionId: work.questionId,
					owner: deps.owner,
					generation: work.generation,
					at: deps.now?.() ?? now,
					status: "unavailable",
					reason: "discord_unavailable",
					messageId,
				});
				result.unavailable += 1;
			} else {
				deps.store.deferShipJudgmentLegacyRetirement({
					questionId: work.questionId,
					owner: deps.owner,
					generation: work.generation,
					at: deps.now?.() ?? now,
					reason: "edit_failed",
				});
				result.deferred += 1;
			}
			continue;
		}
		await deps.clearReaction?.({ work });
		if (
			deps.store.finishShipJudgmentLegacyRetirement({
				questionId: work.questionId,
				owner: deps.owner,
				generation: work.generation,
				at: deps.now?.() ?? now,
				status: "retired",
				reason: "three_point_only",
				messageId,
			})
		) {
			result.retired += 1;
		} else {
			result.deferred += 1;
		}
	}
	return result;
}
