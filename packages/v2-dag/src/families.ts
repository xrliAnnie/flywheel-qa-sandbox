import type { Kernel } from "flywheel-v2-kernel";
import type { CanonicalValue } from "./digests.js";
import { canonicalJson } from "./digests.js";
import { appendEvent } from "./events.js";
import {
	insertEnvelope,
	makeEnvelope,
	readCutoverEpoch,
	readEnvelope,
	updateEnvelope,
} from "./meta.js";
import type { DagPorts } from "./types.js";

export interface ReviewFamilies {
	families: Record<string, { reviewer_agent_id: string }>;
}

export function registerReviewFamilies(
	kernel: Kernel,
	ports: DagPorts,
	input: {
		projectId: string;
		families: Record<string, { reviewerAgentId: string }>;
	},
): void {
	if (input.projectId.trim().length === 0)
		throw new TypeError("projectId is empty");
	const normalized: ReviewFamilies = { families: {} };
	for (const [family, config] of Object.entries(input.families).sort()) {
		if (
			family.trim().length === 0 ||
			config.reviewerAgentId.trim().length === 0
		) {
			throw new TypeError("review family is malformed");
		}
		normalized.families[family] = {
			reviewer_agent_id: config.reviewerAgentId,
		};
	}
	kernel.write("v2dag.families.register", (tx) => {
		const epoch = readCutoverEpoch(tx);
		const key = `review_families:${input.projectId}`;
		const current = readEnvelope<ReviewFamilies>(tx, key, epoch);
		if (
			current &&
			canonicalJson(current.data as unknown as CanonicalValue) ===
				canonicalJson(normalized as unknown as CanonicalValue)
		) {
			return;
		}
		if (current) {
			updateEnvelope(tx, key, current, normalized, ports.clock.nowIso());
		} else {
			insertEnvelope(
				tx,
				key,
				makeEnvelope(epoch, normalized),
				ports.clock.nowIso(),
			);
		}
		appendEvent(tx, {
			eventUid: `review_families_updated:${input.projectId}:${(current?.revision ?? 0) + 1}`,
			kind: "review_families_updated",
			sourceKind: "configuration",
			sourceId: input.projectId,
			payload: normalized as unknown as CanonicalValue,
			cutoverEpoch: epoch,
			createdAt: ports.clock.nowIso(),
		});
	});
}
