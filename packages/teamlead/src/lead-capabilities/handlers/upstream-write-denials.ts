import type { LeadOperationHandler } from "../broker.js";
import { createLeadCapabilityContext } from "../runtime-context.js";
import { UPSTREAM_TOOL_ROWS } from "../upstream-inputs.js";
/** Lead ruling 3a78eb55: no invented approval authority. Keep rows and durable refusal evidence. */
export function createUpstreamWriteDenials(options: {
	env: NodeJS.ProcessEnv;
	activationId: string;
}): ReadonlyMap<string, LeadOperationHandler> {
	const env = Object.freeze({ ...options.env }),
		trusted = createLeadCapabilityContext(env);
	return new Map(
		UPSTREAM_TOOL_ROWS.filter((row) => row.classification === "write").map(
			(row) => {
				const authorize: LeadOperationHandler["authorize"] = async (
					raw,
					context,
				) => {
					row.input.parse(raw);
					context.signal.throwIfAborted();
					if (
						context.projectName !== env.FLYWHEEL_PROJECT_NAME ||
						context.leadId !== env.FLYWHEEL_LEAD_ID ||
						context.activationId !== options.activationId
					)
						throw new Error("upstream_scope_denied");
					await context.assertCurrent();
					trusted.assertActivationCurrent();
					context.signal.throwIfAborted();
				};
				return [
					row.operationId,
					{
						authorize,
						execute: async (raw, context) => {
							await authorize(raw, context);
							return {
								status: "rejected" as const,
								errorCode: row.writeDenial!,
							};
						},
					},
				];
			},
		),
	);
}
