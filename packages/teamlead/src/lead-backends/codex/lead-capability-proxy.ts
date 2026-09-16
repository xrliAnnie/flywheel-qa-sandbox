import { closeSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { leadOperationRequestBytes } from "flywheel-comm/lead-operation-client";
import { z } from "zod";
import type {
	OperationRequest,
	OperationResult,
} from "../../lead-capabilities/broker.js";
import { getLeadCapability } from "../../lead-capabilities/catalog.js";
import {
	createLeadCapabilityManifest,
	type LeadCapabilityManifest,
	nativeSkillBaselineSchema,
	personaSkillGapSchema,
	skillInventorySchema,
} from "../../lead-capabilities/manifest.js";

import { RUNNER_ACTION_TOOL_NAMES } from "./runner-action-names.js";

export interface LeadCapabilityProxyOptions {
	manifest: LeadCapabilityManifest;
	socketPath: string;
	requestClient?: (
		socketPath: string,
		request: OperationRequest,
	) => Promise<OperationResult>;
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bounded = z.string().min(1).max(1024);
const manifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		bundleVersion: z.literal(2),
		projectName: bounded,
		leadId: bounded,
		identityDigest: hash,
		backend: z.literal("codex-app-server"),
		profile: z.literal("full-access"),
		activationId: bounded,
		browserGeneration: z.string().uuid().optional(),
		sourceRevision: bounded,
		operationIds: z.array(bounded).min(1).max(512),
		deniedOperationIds: z.array(bounded).max(512),
		ruleSources: z.array(z.object({ path: bounded, sha256: hash }).strict()),
		skillSources: z.array(
			z.object({ name: bounded, path: bounded, sha256: hash }).strict(),
		),
		integrations: z.array(
			z
				.object({ id: bounded, version: bounded, toolSchemaDigest: hash })
				.strict(),
		),
		nativeSkillBaseline: nativeSkillBaselineSchema.optional(),
		skillGaps: z.array(personaSkillGapSchema).max(128).optional(),
		skillInventory: z.array(skillInventorySchema).max(512).optional(),
		manifestDigest: hash,
	})
	.strict();
export function validateLeadCapabilityManifest(
	raw: unknown,
): LeadCapabilityManifest {
	try {
		const manifest = manifestSchema.parse(raw);
		const all = [...manifest.operationIds, ...manifest.deniedOperationIds];
		if (new Set(all).size !== all.length) throw new Error();
		const operations = all.map((operationId) => {
			const operation = getLeadCapability(operationId);
			if (
				!operation ||
				manifest.operationIds.includes(operationId) ===
					(operation.classification === "reserved")
			)
				throw new Error();
			return operation;
		});
		const verified = createLeadCapabilityManifest({ ...manifest, operations });
		if (verified.manifestDigest !== manifest.manifestDigest) throw new Error();
		return verified;
	} catch {
		throw new Error("invalid_capability_manifest");
	}
}
function validateSocket(path: string): void {
	if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path) > 103)
		throw new Error("invalid_capability_socket");
}
const resultSchema = z
	.object({
		requestId: z.string().uuid(),
		status: z.enum(["succeeded", "rejected", "pending", "unknown"]),
		resourceRefs: z.array(z.string().min(1).max(256)).max(100),
		data: z.unknown().optional(),
		errorCode: z
			.string()
			.regex(/^[a-z][a-z0-9_]{0,95}$/)
			.optional(),
	})
	.strict();
const failure = (code: string, requestId?: string) => ({
	isError: true,
	content: [
		{
			type: "text" as const,
			text: JSON.stringify({
				errorCode: code,
				...(requestId
					? { requestId, status: "unknown", resourceRefs: [] }
					: {}),
			}),
		},
	],
});
/** Native MCP façade only. The trusted parent owns authorization, credentials and all provider calls. */
export function createLeadCapabilityProxy(
	options: LeadCapabilityProxyOptions,
): Server {
	const manifest = validateLeadCapabilityManifest(options.manifest);
	validateSocket(options.socketPath);
	const operations = manifest.operationIds.map((id) => getLeadCapability(id)!);
	const runnerOperations = RUNNER_ACTION_TOOL_NAMES.filter((name) =>
		manifest.operationIds.includes(name),
	).map((name) => getLeadCapability(name)!);
	const variants = operations.map((operation) =>
		z
			.object({
				schemaVersion: z.literal(1),
				operationId: z.literal(operation.operationId),
				requestId: z.string().uuid(),
				input: operation.inputSchema,
			})
			.strict(),
	);
	const schemas = variants.map((variant) => {
		const schema = z.toJSONSchema(variant);
		delete schema.$schema;
		return schema;
	});
	const server = new Server(
		{ name: "flywheel-lead-capability-proxy", version: "2.0.0" },
		{ capabilities: { tools: {} } },
	);
	const requestClient =
		options.requestClient ??
		(async (socketPath, request) => {
			const { requestLeadOperation } = await import(
				"flywheel-comm/lead-operation-client"
			);
			return requestLeadOperation(socketPath, request);
		});
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: "lead_operation",
				description:
					"Run an explicitly available Lead operation. Keep the same requestId when retrying or reconciling an uncertain result.",
				inputSchema: { type: "object" as const, oneOf: schemas },
			},
			...runnerOperations.map((operation) => {
				const schema = z.toJSONSchema(
					operation.inputSchema.extend({ requestId: z.string().uuid() }),
				);
				delete schema.$schema;
				return {
					name: operation.operationId,
					description:
						"Scoped runner action through the trusted broker. Supply requestId and preserve it across retries; existing business idempotency keys also remain required.",
					inputSchema: { ...schema, type: "object" as const },
				};
			}),
		],
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const isRunner = runnerOperations.some(
			(operation) => operation.operationId === request.params.name,
		);
		if (request.params.name !== "lead_operation" && !isRunner)
			return failure("unknown_tool");
		let args = request.params.arguments;
		if (isRunner) {
			const { requestId, ...input } = args ?? {};
			args = {
				schemaVersion: 1,
				operationId: request.params.name,
				requestId,
				input,
			};
		}
		const index = operations.findIndex(
			(operation) => operation.operationId === args?.operationId,
		);
		if (index < 0) return failure("operation_not_in_manifest");
		const parsed = variants[index]!.safeParse(args);
		if (!parsed.success) return failure("invalid_operation_request");
		if (
			Buffer.byteLength(JSON.stringify(parsed.data)) + 1 >
			leadOperationRequestBytes(parsed.data.operationId)
		)
			return failure("request_too_large");
		try {
			const result = resultSchema.parse(
				await requestClient(options.socketPath, parsed.data),
			);
			if (result.requestId !== parsed.data.requestId)
				return failure("invalid_broker_result", parsed.data.requestId);
			if (
				result.status === "succeeded" &&
				result.data !== undefined &&
				!operations[index]!.outputSchema.safeParse(result.data).success
			)
				return failure("invalid_broker_result", parsed.data.requestId);
			const text = JSON.stringify(result);
			if (Buffer.byteLength(text) > 262144)
				return failure("invalid_broker_result", parsed.data.requestId);
			return {
				isError: result.status === "rejected",
				content: [{ type: "text" as const, text }],
			};
		} catch {
			return {
				isError: true,
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							requestId: parsed.data.requestId,
							status: "unknown",
							resourceRefs: [],
							errorCode: "broker_unavailable",
						}),
					},
				],
			};
		}
	});
	return server;
}
/** Reads only the two public capability coordinates; legacy token/claim variables are not forwarded. */
export function loadLeadCapabilityProxyConfig(
	env: Record<string, string | undefined> = process.env,
): LeadCapabilityProxyOptions {
	const socketPath = env.FLYWHEEL_LEAD_CAPABILITY_SOCKET;
	const manifestPath = env.FLYWHEEL_LEAD_CAPABILITY_MANIFEST;
	if (
		!socketPath ||
		!manifestPath ||
		!isAbsolute(manifestPath) ||
		manifestPath.includes("\0")
	)
		throw new Error("capability_coordinates_required");
	validateSocket(socketPath);
	let fd: number | undefined;
	try {
		fd = openSync(manifestPath, "r");
		const bytes = Buffer.alloc(1048577);
		const count = readSync(fd, bytes, 0, bytes.length, 0);
		if (count > 1048576) throw new Error();
		return {
			socketPath,
			manifest: validateLeadCapabilityManifest(
				JSON.parse(bytes.subarray(0, count).toString("utf8")),
			),
		};
	} catch {
		throw new Error("invalid_capability_manifest");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
/** Explicit entry for the managed launcher; importing this module never starts an MCP process. */
export async function runLeadCapabilityProxy(
	env: Record<string, string | undefined> = process.env,
): Promise<Server> {
	const server = createLeadCapabilityProxy(loadLeadCapabilityProxyConfig(env));
	await server.connect(new StdioServerTransport());
	return server;
}
