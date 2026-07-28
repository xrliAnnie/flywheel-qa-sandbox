import {
	type ActionSnapshot,
	type JsonValue,
	type Kernel,
	type RecordActionIntentSpec,
	recordActionIntent,
	recordActionOutcome,
	type WriteTx,
} from "flywheel-v2-kernel";

export interface RunRecordedActionOptions<Result extends JsonValue> {
	kernel: Kernel;
	action: RecordActionIntentSpec;
	prepare?(tx: WriteTx): void;
	perform(): Result | Promise<Result>;
}

export type RunRecordedActionResult =
	| {
			disposition: "performed";
			action: ActionSnapshot & { state: "succeeded" };
	  }
	| {
			disposition: "replayed";
			action: ActionSnapshot;
	  };

export async function runRecordedAction<Result extends JsonValue>(
	options: RunRecordedActionOptions<Result>,
): Promise<RunRecordedActionResult> {
	const intent = options.kernel.write("record action intent", (tx) =>
		recordActionIntent(tx, options.action, { prepare: options.prepare }),
	);
	if (intent.outcome === "replayed") {
		return { disposition: "replayed", action: intent.action };
	}
	let result: Result;
	try {
		result = await options.perform();
	} catch (error) {
		try {
			options.kernel.write("record failed action outcome", (tx) =>
				recordActionOutcome(tx, {
					id: intent.action.id,
					actor: options.action.actor,
					state: "failed",
					result: {
						error: {
							name: error instanceof Error ? error.name : "Error",
							message: error instanceof Error ? error.message : String(error),
						},
					},
				}),
			);
		} catch {
			// Best effort only: preserve the original effect error and an honest intent.
		}
		throw error;
	}
	const action = options.kernel.write("record action outcome", (tx) =>
		recordActionOutcome(tx, {
			id: intent.action.id,
			actor: options.action.actor,
			state: "succeeded",
			result,
		}),
	);
	if (action.state !== "succeeded") {
		throw new Error(`action ${action.id} did not settle as succeeded`);
	}
	return {
		disposition: "performed",
		action: action as ActionSnapshot & { state: "succeeded" },
	};
}
