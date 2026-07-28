import { randomUUID } from "node:crypto";
import {
	type RunRecordedActionResult,
	runRecordedAction,
} from "flywheel-v2-actions";
import {
	type ActionActor,
	FenceViolation,
	type JsonValue,
	type Kernel,
} from "flywheel-v2-kernel";
import { ENGINE_SQL } from "./sql.js";
import {
	readCutoverEpochTx,
	requireAttemptBindingTx,
	requireCurrentAgentTx,
} from "./transitions.js";
import type {
	AttemptHandle,
	ConversionActionSpec,
	EngineRuntime,
} from "./types.js";

interface RunnerActionBindingRow {
	attempt_id: string;
	attempt_generation: number;
	task_id: string;
}

export interface CapturedConversionActionContext {
	handle: AttemptHandle;
	cutoverEpoch: number;
	taskId?: string;
	attemptId?: string;
	attemptGeneration?: number;
}

export type { ConversionActionSpec } from "./types.js";

export function deriveConversionInvocationUid(
	messageUid: string,
	logicalEffectId: string,
	qualifier?: string,
): string {
	return JSON.stringify([
		"conversion",
		messageUid,
		logicalEffectId,
		qualifier ?? null,
	]);
}

export function validateConversionActionSpec(
	action: ConversionActionSpec,
): void {
	if (
		action.qualifier !== undefined &&
		(action.supersedesActionId === undefined || action.retryBasis === undefined)
	) {
		throw new TypeError(
			"action qualifier requires supersedesActionId and retryBasis",
		);
	}
}

export function captureConversionActionContext(
	kernel: Kernel,
	handle: AttemptHandle,
): CapturedConversionActionContext {
	return kernel.read((tx) => {
		requireCurrentAgentTx(tx, handle.agent);
		const binding = requireAttemptBindingTx(tx, handle);
		const cutoverEpoch = readCutoverEpochTx(tx);
		if (binding.mailbox_cutover_epoch !== cutoverEpoch) {
			throw new FenceViolation(
				`mailbox cutover epoch mismatch for ${handle.messageUid}`,
			);
		}
		if (handle.agent.kind === "lead") {
			return { handle, cutoverEpoch };
		}
		const dag = tx.get<RunnerActionBindingRow>(
			ENGINE_SQL.readRunnerActionBinding,
			{ activationId: handle.agent.activationId },
		);
		if (!dag) {
			throw new FenceViolation(
				`runner activation has no DAG binding: ${handle.agent.activationId}`,
			);
		}
		return {
			handle,
			cutoverEpoch,
			taskId: dag.task_id,
			attemptId: dag.attempt_id,
			attemptGeneration: dag.attempt_generation,
		};
	});
}

function actionActor(handle: AttemptHandle): ActionActor {
	const agent = handle.agent;
	return agent.kind === "runner"
		? {
				kind: "runner",
				agentId: agent.agentId,
				instanceId: agent.instanceId,
				generation: agent.generation,
				activationId: agent.activationId,
			}
		: {
				kind: "lead",
				agentId: agent.agentId,
				instanceId: agent.instanceId,
				generation: agent.generation,
			};
}

export function runConversionAction<Result extends JsonValue>(
	kernel: Kernel,
	runtime: EngineRuntime,
	captured: CapturedConversionActionContext,
	action: ConversionActionSpec,
	perform: () => Result | Promise<Result>,
): Promise<RunRecordedActionResult> {
	const { handle } = captured;
	return runRecordedAction({
		kernel,
		action: {
			id: randomUUID(),
			taskId: captured.taskId,
			attemptId: captured.attemptId,
			attemptGeneration: captured.attemptGeneration,
			actor: actionActor(handle),
			kind: action.kind,
			payload: action.payload,
			authorization: action.authorization,
			logicalEffectId: action.logicalEffectId,
			invocationUid: deriveConversionInvocationUid(
				handle.messageUid,
				action.logicalEffectId,
				action.qualifier,
			),
			supersedesActionId: action.supersedesActionId,
			retryBasis: action.retryBasis,
			cutoverEpoch: captured.cutoverEpoch,
			createdAt: runtime.clock.nowIso(),
		},
		prepare(tx) {
			requireCurrentAgentTx(tx, handle.agent);
			const binding = requireAttemptBindingTx(tx, handle);
			const currentEpoch = readCutoverEpochTx(tx);
			if (
				currentEpoch !== captured.cutoverEpoch ||
				binding.mailbox_cutover_epoch !== captured.cutoverEpoch
			) {
				throw new FenceViolation(
					`cutover epoch changed before action ${action.logicalEffectId}`,
				);
			}
		},
		perform,
	});
}
