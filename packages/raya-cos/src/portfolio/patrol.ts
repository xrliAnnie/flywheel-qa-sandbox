import {
	parseDriftEnvelope,
	type ScopedDriftContext,
	validateScopedDriftEnvelope,
} from "../contracts/drift-envelope.js";
import type { Goal } from "../contracts/goals.js";
import type { CoSPorts } from "../ports.js";
import { PatrolEvidenceGate } from "./evidence-gate.js";
import { renderSnapshot } from "./render.js";
import type { PortfolioSnapshot } from "./types.js";

export type PatrolPlan =
	| {
			status: "silent";
			snapshotId: string;
			reason:
				| "goals_corrupt"
				| "no_active_goal"
				| "no_activity_readings"
				| "stale_snapshot";
	  }
	| {
			status: "needs_judgment";
			snapshotId: string;
			prompt: string;
	  };

export function planPatrol(input: {
	snapshot: PortfolioSnapshot;
	goals: Goal[] | Error;
	now: Date;
	staleAfterMs: number;
}): PatrolPlan {
	const gate = PatrolEvidenceGate.check(input);
	if (!gate.proceed) {
		return {
			status: "silent",
			snapshotId: input.snapshot.snapshotId,
			reason: gate.reason,
		};
	}
	const goalLines = gate.activeGoals.map(
		(goal) => `- ${goal.id}: ${goal.text} (source: ${goal.sourceUrl})`,
	);
	return {
		status: "needs_judgment",
		snapshotId: input.snapshot.snapshotId,
		prompt: [
			"你正在当前标准 Raya Lead turn 中进行统管判断。不要启动另一个模型线程。",
			`snapshotId: ${input.snapshot.snapshotId}`,
			"Annie 的当前目标：",
			...goalLines,
			"只根据下面可验证的采样指出方向级偏离；证据不足就保持沉默。",
			renderSnapshot(input.snapshot),
		].join("\n"),
	};
}

export async function publishPatrolJudgment(
	input: { snapshotId: string; text: string; context?: ScopedDriftContext },
	ports: CoSPorts,
) {
	if (!input.context || input.context.snapshot.snapshotId !== input.snapshotId)
		throw new Error("patrol evidence context required");
	const validated = validateScopedDriftEnvelope(
		parseDriftEnvelope(input.text),
		input.context,
	);
	if (validated.kind !== "valid")
		throw new Error(`patrol evidence rejected: ${validated.reason}`);
	return ports.announce({
		eventId: `portfolio:${input.snapshotId}:judgment`,
		target: "chat",
		text: validated.content,
	});
}
