import type { CommDB } from "flywheel-comm/db";
import type { StateStore } from "../../StateStore.js";
import { parseSqliteUtcMs } from "../founder-notify-utils.js";
import { activityWindowMs } from "../liveness-evidence.js";

export interface LivenessEvidence {
	heartbeatAtMs: number | null;
	lastActivityAtMs: number | null;
	recentOutboundInWindow: boolean;
	observedAtMs: number;
}

export type LivenessVerdict = "alive" | "absent" | "unknown";

export function classifyRecipientLiveness(
	evidence: LivenessEvidence,
	nowMs: number,
	windowMs: number = activityWindowMs(),
): LivenessVerdict {
	if (evidence.recentOutboundInWindow) return "alive";
	const stamps = [evidence.heartbeatAtMs, evidence.lastActivityAtMs].filter(
		(timestamp): timestamp is number =>
			timestamp !== null && Number.isFinite(timestamp),
	);
	if (stamps.length === 0) return "unknown";
	const latest = Math.max(...stamps);
	return latest <= nowMs && nowMs - latest <= windowMs ? "alive" : "absent";
}

export function collectRecipientLivenessEvidence(input: {
	store: StateStore;
	commDb: CommDB;
	executionId: string;
	nowMs: number;
	windowMs?: number;
}): LivenessEvidence {
	const session = input.store.getSession(input.executionId);
	const windowMs = input.windowMs ?? activityWindowMs();
	return {
		heartbeatAtMs: parseSqliteUtcMs(session?.heartbeat_at),
		lastActivityAtMs: parseSqliteUtcMs(session?.last_activity_at),
		recentOutboundInWindow: input.commDb.hasMessagesFromAfter(
			input.executionId,
			new Date(input.nowMs - windowMs).toISOString(),
		),
		observedAtMs: input.nowMs,
	};
}
