import type { MemoryService } from "flywheel-edge-worker";
import { getLeadCapability } from "../lead-capabilities/catalog.js";
import { executeLeadBridgeWrite } from "./lead-capability-write.js";

type Options = Parameters<typeof executeLeadBridgeWrite>[0];
export function executeLeadMemoryAdd(
	options: Omit<
		Options,
		| "operationId"
		| "providerPrefix"
		| "resultIdentity"
		| "effect"
		| "authorize"
		| "sideEffectsPossible"
	> & { memory: Pick<MemoryService, "addMessages"> },
) {
	const input = getLeadCapability("memory.add")!.inputSchema.parse(
		options.input,
	) as {
		project: string;
		text: string;
		collection: string;
		noteId: string;
		opId: string;
		runKey: string;
	};
	let attempted = false;
	const authorize = async () => {
		await options.assertCurrent();
		options.signal.throwIfAborted();
		if (
			options.secrets
				.filter(Boolean)
				.some((secret) =>
					Object.values(input).some((value) => value.includes(secret)),
				)
		)
			throw new Error("memory_secret_denied");
		if (input.project !== options.projectName)
			throw new Error("memory_project_mismatch");
	};
	return executeLeadBridgeWrite({
		...options,
		operationId: "memory.add",
		providerPrefix: "memory",
		resultIdentity: { opId: input.opId },
		authorize,
		sideEffectsPossible: () => attempted,
		effect: async () => {
			await authorize();
			attempted = true;
			await options.memory.addMessages({
				projectName: options.projectName,
				agentId: options.leadId,
				userId: options.projectName,
				messages: [{ role: "user", content: input.text }],
				metadata: {
					source: "xiaohongshu",
					collection: input.collection,
					note_id: input.noteId,
					op_id: input.opId,
					run_key: input.runKey,
				},
			});
		},
	});
}
