import type { LeadArtifactStore } from "../artifacts.js";
import type { LeadOperationHandler } from "../broker.js";
import { getLeadCapability } from "../catalog.js";

/** Local parent ingress only. Provider writes retain their independent authorization. */
export function createArtifactTextHandler(options: {
	projectName: string;
	leadId: string;
	activationId: string;
	store: LeadArtifactStore;
	secrets: readonly string[];
	assertCurrent(): void;
}): LeadOperationHandler {
	const definition = getLeadCapability("artifact.text.create")!;
	const secrets = options.secrets.filter(Boolean);
	const parse = (raw: Record<string, unknown>) => {
		const input = definition.inputSchema.parse(raw) as {
			mimeType: string;
			text: string;
		};
		if (secrets.some((secret) => input.text.includes(secret)))
			throw new Error("artifact_text_denied");
		return input;
	};
	const authorize: LeadOperationHandler["authorize"] = async (raw, context) => {
		parse(raw);
		context.signal.throwIfAborted();
		if (
			context.projectName !== options.projectName ||
			context.leadId !== options.leadId ||
			context.activationId !== options.activationId
		)
			throw new Error("artifact_text_denied");
		await context.assertCurrent();
		options.assertCurrent();
		context.signal.throwIfAborted();
	};
	return {
		authorize,
		execute: async (raw, context) => {
			await authorize(raw, context);
			const input = parse(raw);
			const artifact = await options.store.put(
				Buffer.from(input.text, "utf8"),
				input.mimeType,
			);
			return {
				status: "succeeded",
				providerRef: artifact.handle,
				data: { artifactHandle: artifact.handle },
			};
		},
	};
}
