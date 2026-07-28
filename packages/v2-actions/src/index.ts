import {
	ActionSerializationError,
	type ActionSnapshot,
	type JsonValue,
	type Kernel,
	type RecordActionIntentSpec,
	recordActionIntent,
	recordActionOutcome,
	type WriteTx,
} from "flywheel-v2-kernel";

function valueKind(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "Array";
	if (typeof value !== "object") return typeof value;
	try {
		const prototypeConstructor = Object.getPrototypeOf(value)?.constructor as
			| { name?: unknown }
			| undefined;
		if (
			typeof prototypeConstructor?.name === "string" &&
			prototypeConstructor.name.length > 0
		) {
			return prototypeConstructor.name;
		}
	} catch {
		// A hostile prototype must not prevent honest terminalization.
	}
	return "object";
}

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
	let action: ActionSnapshot;
	try {
		action = options.kernel.write("record action outcome", (tx) =>
			recordActionOutcome(tx, {
				id: intent.action.id,
				actor: options.action.actor,
				state: "succeeded",
				result,
			}),
		);
	} catch (error) {
		if (!(error instanceof ActionSerializationError)) throw error;
		action = options.kernel.write(
			"record action outcome serialization fallback",
			(tx) =>
				recordActionOutcome(tx, {
					id: intent.action.id,
					actor: options.action.actor,
					state: "succeeded",
					result: {
						serialization_error: {
							name: error.name,
							message: error.message,
						},
						value_kind: valueKind(result),
					},
				}),
		);
	}
	if (action.state !== "succeeded") {
		throw new Error(`action ${action.id} did not settle as succeeded`);
	}
	return {
		disposition: "performed",
		action: action as ActionSnapshot & { state: "succeeded" },
	};
}
