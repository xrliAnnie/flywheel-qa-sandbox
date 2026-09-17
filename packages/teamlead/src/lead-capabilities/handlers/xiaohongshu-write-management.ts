import { authorityResponseSchemas } from "../../xiaohongshu-write/authority-client.js";
import { artifactSchema } from "../../xiaohongshu-write/contracts.js";
import type { LeadArtifactStore } from "../artifacts.js";
import type { HandlerOutcome, LeadOperationHandler } from "../broker.js";
import { createLeadCapabilityContext } from "../runtime-context.js";
import {
	xhsWritePrepareInput,
	xhsWriteProposalInput,
} from "../xiaohongshu-write-input.js";

/** Management changes proposals, never approval authority. Recovery is status-only. */
export function createXhsWriteManagementHandlers(options: {
	env: NodeJS.ProcessEnv;
	activationId: string;
	artifacts: Pick<LeadArtifactStore, "read">;
	client: {
		importArtifact(
			input: { data: Buffer; mimeType: string },
			signal?: AbortSignal,
		): Promise<unknown>;
		call(
			action: "prepare" | "status" | "cancel",
			input: unknown,
			signal?: AbortSignal,
		): Promise<unknown>;
	} | null;
}): ReadonlyMap<string, LeadOperationHandler> {
	const env = Object.freeze({ ...options.env }),
		activationId = options.activationId,
		client = options.client;
	const trusted = createLeadCapabilityContext(env);
	const unknown = (): HandlerOutcome => ({
		status: "unknown",
		errorCode: "provider_unknown",
	});
	return new Map(
		(["prepare", "status", "cancel"] as const).map((action) => {
			const schema =
				action === "prepare" ? xhsWritePrepareInput : xhsWriteProposalInput;
			const authorize: LeadOperationHandler["authorize"] = async (
				raw,
				context,
			) => {
				schema.parse(raw);
				context.signal.throwIfAborted();
				if (
					context.projectName !== env.FLYWHEEL_PROJECT_NAME ||
					context.leadId !== env.FLYWHEEL_LEAD_ID ||
					context.activationId !== activationId
				)
					throw Error("upstream_scope_denied");
				await context.assertCurrent();
				trusted.assertActivationCurrent();
				context.signal.throwIfAborted();
			};
			const handler: LeadOperationHandler = {
				authorize,
				execute: async (raw, context) => {
					await authorize(raw, context);
					if (!client)
						return {
							status: "rejected",
							errorCode: "founder_write_gate_absent",
						};
					try {
						if (action === "prepare") {
							const input = xhsWritePrepareInput.parse(raw);
							const artifactIds: string[] = [];
							for (const handle of input.artifactHandles) {
								const { artifact, data } = await options.artifacts.read(handle);
								await authorize(raw, context);
								const mimeType = artifactSchema.shape.mimeType.parse(
									artifact.mimeType,
								);
								if (
									artifact.handle !== handle ||
									data.length !== artifact.size ||
									artifact.size > 10 * 1024 * 1024
								)
									throw Error();
								const uploaded = artifactSchema.parse(
									await client.importArtifact(
										{ data, mimeType },
										context.signal,
									),
								);
								await authorize(raw, context);
								if (
									uploaded.sha256 !== artifact.sha256 ||
									uploaded.sizeBytes !== artifact.size ||
									uploaded.mimeType !== mimeType
								)
									throw Error();
								artifactIds.push(uploaded.artifactId);
							}

							const response = authorityResponseSchemas.prepare.parse(
								await client.call(
									"prepare",
									{
										prepareRequestId: context.requestId,
										operationId: input.operationId,
										accountSelector: input.accountSelector,
										payload: input.payload,
										artifactIds,
										targetHandle: input.resourceHandle ?? null,
									},
									context.signal,
								),
							);
							return {
								status: "succeeded",
								providerRef: response.proposalId,
								data: response,
							};
						}
						const input = xhsWriteProposalInput.parse(raw);
						const response = authorityResponseSchemas[action].parse(
							await client.call(action, input, context.signal),
						);
						if (
							"proposalId" in response &&
							response.proposalId !== input.proposalId
						)
							return unknown();
						if (response.state === "denied")
							return { status: "rejected", errorCode: "provider_rejected" };
						return {
							status: "succeeded",
							providerRef: input.proposalId,
							data: response,
						};
					} catch {
						return unknown();
					}
				},
			};
			if (action !== "status")
				handler.reconcile = async (_prior, raw, context) => {
					await authorize(raw, context);
					if (!client) return unknown();
					try {
						if (action === "prepare") {
							const response = authorityResponseSchemas.prepare.parse(
								await client.call(
									"status",
									{ prepareRequestId: context.requestId },
									context.signal,
								),
							);
							return {
								status: "succeeded",
								providerRef: response.proposalId,
								data: response,
							};
						}
						const input = xhsWriteProposalInput.parse(raw);
						const response = authorityResponseSchemas.status.parse(
							await client.call("status", input, context.signal),
						);
						if (response.proposalId !== input.proposalId) return unknown();
						const state =
							response.state === "consumed"
								? "already_started"
								: response.state;
						if (
							![
								"revoked",
								"rejected",
								"expired",
								"superseded",
								"already_started",
							].includes(state)
						)
							return unknown();
						return {
							status: "succeeded",
							providerRef: input.proposalId,
							data: { state },
						};
					} catch {
						return unknown();
					}
				};
			return [`xiaohongshu.write.${action}`, handler];
		}),
	);
}
