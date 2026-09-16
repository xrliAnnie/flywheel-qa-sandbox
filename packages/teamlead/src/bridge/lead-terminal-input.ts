import { executeLeadBridgeWrite } from "./lead-capability-write.js";

type Options = Parameters<typeof executeLeadBridgeWrite>[0];
/** Terminal-specific identity and effect; receipt lifecycle is shared by Bridge writes. */
export function executeLeadTerminalInput(
	options: Omit<
		Options,
		"operationId" | "providerPrefix" | "resultIdentity" | "effect" | "input"
	> & {
		input: { executionId: string; expectedSessionId: string; text: string };
		inputTerminal(): Promise<void>;
	},
) {
	return executeLeadBridgeWrite({
		...options,
		operationId: "terminal.input",
		providerPrefix: "terminal",
		resultIdentity: { executionId: options.input.executionId },
		effect: options.inputTerminal,
	});
}
