import type { Goal } from "../contracts/index.js";
import type { PortfolioSnapshot } from "./types.js";

export type EvidenceGateResult =
	| { proceed: true; activeGoals: Goal[] }
	| {
			proceed: false;
			reason:
				| "goals_corrupt"
				| "no_active_goal"
				| "no_activity_readings"
				| "stale_snapshot";
	  };

// biome-ignore lint/complexity/noStaticOnlyClass: the approved design names this evidence boundary.
export class PatrolEvidenceGate {
	static check(input: {
		snapshot: PortfolioSnapshot;
		goals: Goal[] | Error;
		now: Date;
		staleAfterMs: number;
	}): EvidenceGateResult {
		if (input.goals instanceof Error) {
			return { proceed: false, reason: "goals_corrupt" };
		}
		const activeGoals = input.goals.filter((goal) => goal.status === "active");
		if (activeGoals.length === 0) {
			return { proceed: false, reason: "no_active_goal" };
		}
		if (!input.snapshot.activityAvailable) {
			return { proceed: false, reason: "no_activity_readings" };
		}
		const sampledAt = Date.parse(input.snapshot.sampledAt);
		if (
			!Number.isFinite(sampledAt) ||
			input.now.getTime() - sampledAt > input.staleAfterMs
		) {
			return { proceed: false, reason: "stale_snapshot" };
		}
		return { proceed: true, activeGoals };
	}
}
