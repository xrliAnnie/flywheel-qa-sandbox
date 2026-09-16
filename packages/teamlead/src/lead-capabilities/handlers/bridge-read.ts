import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import { RUNNER_ACTION_TOOL_NAMES } from "../../lead-backends/codex/runner-action-names.js";
import type { LeadArtifactStore } from "../artifacts.js";
import {
	type HandlerOutcome,
	type LeadOperationContext,
	type LeadOperationHandler,
	OperationRequestSchema,
} from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import { PatrolArtifactProjection } from "../patrol-artifacts.js";
import { prefetchPatrolGithubFacts } from "../patrol-github-facts.js";
import { createLeadCapabilityContext } from "../runtime-context.js";

const operations = [
	"bridge.read",
	"terminal.capture",
	"terminal.search",
	"terminal.status",
	"terminal.list",
] as const;
const replySchema = z
	.object({
		requestId: z.string().uuid(),
		status: z.enum(["succeeded", "rejected", "unknown"]),
		resourceRefs: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,256}$/)).max(1),
		data: z.unknown().optional(),
		errorCode: z.string().max(128).optional(),
	})
	.strict();
const denied = () => new Error("bridge_read_scope_denied");
/** Parent-only fixed read transport. Canonical scope and DTO projection remain inside Bridge. */
interface BridgeHandlerOptions {
	env: NodeJS.ProcessEnv;
	activationId: string;
	fetchImpl?: typeof fetch;
	secrets?: readonly string[];
	patrol?: { projection: PatrolArtifactProjection; githubClient: Octokit };
}
export function createPatrolHandlers(
	options: Omit<BridgeHandlerOptions, "patrol"> & {
		artifacts: LeadArtifactStore;
		secrets: readonly string[];
		githubClient: Octokit;
	},
): ReadonlyMap<string, LeadOperationHandler> {
	return createBridgeHandlers(
		{
			...options,
			patrol: {
				projection: new PatrolArtifactProjection(
					options.artifacts,
					Object.freeze([...options.secrets]),
				),
				githubClient: options.githubClient,
			},
		},
		["patrol.snapshot", "patrol.judgment.record"],
	);
}
export function createBridgeReadHandlers(
	options: BridgeHandlerOptions,
): ReadonlyMap<string, LeadOperationHandler> {
	return createBridgeHandlers(options, operations);
}
export function createMemoryBridgeHandlers(
	options: BridgeHandlerOptions,
): ReadonlyMap<string, LeadOperationHandler> {
	return createBridgeHandlers(options, ["memory.add", "memory.search"]);
}
export function createGithubBridgeHandlers(
	options: BridgeHandlerOptions,
): ReadonlyMap<string, LeadOperationHandler> {
	return createBridgeHandlers(options, [
		"github.pr.comment",
		"github.pr.edit",
		"github.pr.review",
		"github.pr.ready",
		"github.run.rerun",
	]);
}

export function createRunnerBridgeHandlers(
	options: BridgeHandlerOptions,
): ReadonlyMap<string, LeadOperationHandler> {
	return createBridgeHandlers(options, RUNNER_ACTION_TOOL_NAMES);
}

export function createTerminalInputHandlers(
	options: BridgeHandlerOptions,
): ReadonlyMap<string, LeadOperationHandler> {
	return createBridgeHandlers(options, ["terminal.input"]);
}
export function createInboxBatchAckHandlers(
	options: BridgeHandlerOptions,
): ReadonlyMap<string, LeadOperationHandler> {
	return createBridgeHandlers(options, ["inbox.batch.ack"]);
}
export function createInboxEventAckHandlers(
	options: BridgeHandlerOptions,
): ReadonlyMap<string, LeadOperationHandler> {
	return createBridgeHandlers(options, ["inbox.event.ack"]);
}
function createBridgeHandlers(
	options: BridgeHandlerOptions,
	operationIds: readonly string[],
	receiptOnly = false,
): ReadonlyMap<string, LeadOperationHandler> {
	const env = Object.freeze({ ...options.env }),
		activationId = options.activationId;
	let trusted: ReturnType<typeof createLeadCapabilityContext>, url: URL;
	const token = env.FLYWHEEL_API_TOKEN,
		claim = env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID;
	try {
		trusted = createLeadCapabilityContext(env);
		url = new URL(env.FLYWHEEL_BRIDGE_URL ?? "");
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/" ||
			(url.protocol === "http:" &&
				!["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) ||
			!token ||
			token.length > 8192 ||
			/[\r\n]/.test(token) ||
			!claim ||
			claim.length > 256 ||
			!activationId ||
			activationId.length > 128
		)
			throw denied();
	} catch {
		throw denied();
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const handlers = new Map<string, LeadOperationHandler>();
	const secrets = [token!, claim!, ...(options.secrets ?? [])].filter(Boolean);
	async function current(context: LeadOperationContext) {
		if (
			context.projectName !== env.FLYWHEEL_PROJECT_NAME ||
			context.leadId !== env.FLYWHEEL_LEAD_ID ||
			context.activationId !== activationId ||
			context.signal.aborted
		)
			throw denied();
		try {
			await context.assertCurrent();
			trusted.assertActivationCurrent();
		} catch {
			throw denied();
		}
		if (context.signal.aborted) throw denied();
	}
	for (const operationId of operationIds) {
		const runnerOperation = (
			RUNNER_ACTION_TOOL_NAMES as readonly string[]
		).includes(operationId);
		const githubOperation = operationId.startsWith("github.");
		const writeRoute =
			operationId === "memory.add"
				? "memory-add"
				: runnerOperation
					? "runners"
					: githubOperation
						? "github"
						: operationId === "patrol.snapshot"
							? "patrol-snapshot"
							: operationId === "patrol.judgment.record"
								? "patrol-judgment"
								: operationId === "terminal.input"
									? "terminal-input"
									: operationId === "inbox.batch.ack"
										? "inbox-batch-ack"
										: operationId === "inbox.event.ack"
											? "inbox-event-ack"
											: undefined;
		const providerPrefix =
			operationId === "memory.add"
				? "memory"
				: operationId === "terminal.input"
					? "terminal"
					: operationId === "inbox.event.ack"
						? "inbox-event"
						: "inbox-batch";
		const endpoint = new URL(
			writeRoute
				? `/api/lead-capabilities/${writeRoute}${receiptOnly && !runnerOperation ? "-receipt" : ""}`
				: "/api/lead-capabilities/read",
			url,
		).href;
		const reconcileHandler =
			writeRoute &&
			!receiptOnly &&
			(!runnerOperation ||
				getLeadCapability(operationId)!.classification === "write")
				? createBridgeHandlers(options, [operationId], true).get(operationId)
				: undefined;
		const definition = getLeadCapability(operationId)!;
		const patrolOperation = operationId.startsWith("patrol.");
		const byteLimit =
			operationId === "patrol.snapshot" ? 1024 * 1024 + 16384 : 262144;
		function envelope(
			raw: Record<string, unknown>,
			context: LeadOperationContext,
		) {
			const request = OperationRequestSchema.safeParse({
					schemaVersion: 1,
					operationId,
					requestId: context.requestId,
					input: raw,
				}),
				input = definition.inputSchema.safeParse(raw);
			if (!request.success || !input.success) throw denied();
			const body = {
				schemaVersion: 1,
				operationId,
				requestId: context.requestId,
				projectName: env.FLYWHEEL_PROJECT_NAME,
				leadId: env.FLYWHEEL_LEAD_ID,
				identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
				carrierClaim: claim,
				activationId,
				input: input.data,
				...(runnerOperation ? { receiptOnly } : {}),
			};
			if (
				runnerOperation &&
				secrets.some((secret) => JSON.stringify(input.data).includes(secret))
			)
				throw denied();
			const json = JSON.stringify(body);
			if (Buffer.byteLength(json) > 65536) throw denied();
			return json;
		}
		handlers.set(operationId, {
			...(reconcileHandler
				? {
						reconcile: async (receipt, raw, context) => {
							if (
								runnerOperation &&
								(receipt.requestId !== context.requestId ||
									receipt.projectName !== context.projectName ||
									receipt.leadId !== context.leadId ||
									receipt.operationId !== operationId)
							)
								return { status: "unknown" };
							return reconcileHandler.execute(raw, context);
						},
					}
				: {}),
			authorize: async (raw, context) => {
				envelope(raw, context);
				if (operationId === "patrol.judgment.record")
					await options.patrol!.projection.input(raw);
				await current(context);
			},
			execute: async (raw, context) => {
				let body = envelope(raw, context);
				await current(context);
				const controller = new AbortController(),
					signal = AbortSignal.any([controller.signal, context.signal]);
				let onAbort = () => {};
				const aborted = new Promise<HandlerOutcome>((resolve) => {
					onAbort = () => resolve({ status: "unknown" });
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) onAbort();
				});
				const timer = setTimeout(() => controller.abort(), 15000);
				const work = async (): Promise<HandlerOutcome> => {
					let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
					let responseBody: ReadableStream<Uint8Array> | null = null;
					const cancelBody = () => {
						void (reader ? reader.cancel() : responseBody?.cancel())?.catch(
							() => {},
						);
					};
					signal.addEventListener("abort", cancelBody, { once: true });
					try {
						signal.throwIfAborted();
						trusted.assertActivationCurrent();
						if (operationId === "patrol.snapshot" && !receiptOnly) {
							const prior = await reconcileHandler!.execute(raw, {
								...context,
								signal,
							});
							if (prior.status !== "unknown") return prior;
							signal.throwIfAborted();
							const githubFacts = await prefetchPatrolGithubFacts(
								{ env, activationId, client: options.patrol!.githubClient },
								{ ...context, signal },
							);
							body = JSON.stringify({ ...JSON.parse(body), githubFacts });
						}
						if (operationId === "patrol.judgment.record")
							body = JSON.stringify({
								...JSON.parse(body),
								input: await options.patrol!.projection.input(raw),
							});
						if (Buffer.byteLength(body) > 65536) throw denied();
						await current(context);
						signal.throwIfAborted();
						const response = await fetchImpl(endpoint, {
							method: "POST",
							redirect: "error",
							headers: {
								"content-type": "application/json",
								authorization: `Bearer ${token}`,
							},
							body,
							signal,
						});
						responseBody = response.body;
						await current(context);
						signal.throwIfAborted();
						if (
							(response.status >= 300 && response.status < 400) ||
							!response.body
						)
							throw denied();
						const length = response.headers.get("content-length");
						if (
							length !== null &&
							(!/^\d+$/.test(length) || Number(length) > byteLimit)
						)
							throw denied();
						reader = response.body.getReader();
						let size = 0;
						const chunks: Uint8Array[] = [];
						while (true) {
							const item = await reader.read();
							signal.throwIfAborted();
							if (item.done) break;
							size += item.value.byteLength;
							if (size > byteLimit) throw denied();
							chunks.push(item.value);
						}
						await current(context);
						signal.throwIfAborted();
						const text = new TextDecoder("utf-8", { fatal: true }).decode(
							Buffer.concat(chunks),
						);
						if (secrets.some((secret) => text.includes(secret))) throw denied();
						const parsed = replySchema.safeParse(JSON.parse(text));
						if (!parsed.success || parsed.data.requestId !== context.requestId)
							throw denied();
						const result = parsed.data;
						if (result.status === "succeeded") {
							if (!response.ok) throw denied();
							if (runnerOperation) {
								const data = definition.outputSchema.parse(result.data),
									output = data.result as Record<string, unknown>;
								if (data.receiptId !== context.requestId) throw denied();
								if (
									operationId === "get_runner_status" ||
									operationId === "read_runner_tmux" ||
									operationId === "send_runner"
								) {
									if (output.executionId !== raw.executionId) throw denied();
								}
								const expected =
									operationId === "start_runner"
										? `runner-execution:${output.executionId}`
										: operationId === "send_runner"
											? `runner-instruction:${output.instructionId}`
											: operationId === "respond_runner"
												? `runner-response:${output.responseId}`
												: undefined;
								if (
									expected
										? result.resourceRefs.length !== 1 ||
											result.resourceRefs[0] !== expected
										: result.resourceRefs.length !== 0
								)
									throw denied();
								if (
									operationId === "start_runner" &&
									(output.outcome !== "started" ||
										output.idempotencyKey !== raw.idempotencyKey ||
										!z.string().uuid().safeParse(output.executionId).success)
								)
									throw denied();
								return {
									status: "succeeded",
									...(expected ? { providerRef: expected } : {}),
									data,
								};
							}
							if (githubOperation) {
								const ref = result.resourceRefs[0];
								if (result.resourceRefs.length !== 1 || !ref) throw denied();
								const expected =
									operationId === "github.run.rerun"
										? `run:${raw.runId}`
										: operationId === "github.pr.ready" ||
												operationId === "github.pr.edit"
											? `pr:${raw.number}`
											: undefined;
								if (
									expected
										? ref !== expected
										: !(
												/^[1-9][0-9]{0,15}$/.test(ref) &&
												Number.isSafeInteger(Number(ref))
											)
								)
									throw denied();
								if (result.data === undefined)
									return { status: "succeeded", providerRef: ref };
								const data = definition.outputSchema.parse(result.data);
								if (data.receiptId !== context.requestId) throw denied();
								if (
									operationId === "github.pr.comment" ||
									operationId === "github.pr.review"
								) {
									if ((data.commentId ?? data.reviewId) !== ref) throw denied();
									const link = new URL(data.url as string),
										slug =
											trusted.assertActivationCurrent().project.projectRepo;
									if (
										link.origin !== "https://github.com" ||
										link.username ||
										link.password ||
										!slug ||
										![
											`/${slug}/pull/${raw.number}`,
											`/${slug}/issues/${raw.number}`,
										].some(
											(path) =>
												link.pathname.toLowerCase() === path.toLowerCase(),
										)
									)
										throw denied();
								}
								if (
									operationId === "github.pr.ready" &&
									data.number !== raw.number
								)
									throw denied();
								if (
									operationId === "github.pr.edit" &&
									(data.pullRequest as { number: number }).number !== raw.number
								)
									throw denied();
								if (
									operationId === "github.run.rerun" &&
									data.runId !== raw.runId
								)
									throw denied();
								await current(context);
								signal.throwIfAborted();
								return { status: "succeeded", providerRef: ref, data };
							}

							const projected =
								operationId === "patrol.snapshot"
									? await options.patrol!.projection.accept(
											result.data,
											context.requestId,
											raw.tickId as string,
											result.resourceRefs,
										)
									: result.data;
							await current(context);
							signal.throwIfAborted();
							const output = definition.outputSchema.safeParse(projected);
							if (
								!response.ok ||
								!output.success ||
								(operationId === "bridge.read" &&
									(output.data.result as { resource: string }).resource !==
										(raw.request as { resource: string }).resource) ||
								output.data.receiptId !== context.requestId ||
								(operationId === "memory.add" &&
									output.data.opId !== raw.opId) ||
								(writeRoute &&
									!patrolOperation &&
									result.resourceRefs[0] !==
										`${providerPrefix}:${context.requestId}`) ||
								(definition.classification === "write" &&
									result.resourceRefs.length !== 1)
							)
								throw denied();
							if (operationId === "patrol.judgment.record") {
								const ref = result.resourceRefs[0] ?? "";
								const gates = output.data.gates as Array<{
									gate: number;
									passed: boolean;
									exitCode: number | null;
								}>;
								const codes = gates
									.map((g) => (g.exitCode === null ? "n" : String(g.exitCode)))
									.join(".");
								if (
									output.data.judgmentId !== context.requestId ||
									!/^pj:[0-9]{8}T[0-9]{6}Z-tick(?:NA|[0-9]{1,16})\.md:[a-f0-9]{64}:[a-f0-9]{64}:(?:n|-?[0-9]{1,3})\.(?:n|-?[0-9]{1,3})\.(?:n|-?[0-9]{1,3})$/.test(
										ref,
									) ||
									ref.split(":")[2] !== output.data.reportSha256 ||
									!ref.endsWith(`:${codes}`) ||
									gates.some(
										(g, i) =>
											g.gate !== i + 1 || g.passed !== (g.exitCode === 0),
									) ||
									output.data.complete !== gates.every((g) => g.passed)
								)
									throw denied();
							}
							if (
								operationId.startsWith("terminal.") &&
								operationId !== "terminal.list"
							) {
								const received =
									operationId === "terminal.status"
										? (output.data.execution as { executionId: string })
												.executionId
										: output.data.executionId;
								if (received !== raw.executionId) throw denied();
							}
							if (
								operationId === "inbox.batch.ack" &&
								output.data.batchId !== raw.batchId
							)
								throw denied();
							const requested = (raw.request ?? {}) as {
								resource: string;
								executionId?: string;
								targetRepo?: string;
								headSha?: string;
							};
							if (
								requested.resource === "session.resident-hold" &&
								(output.data.result as { executionId: string }).executionId !==
									requested.executionId
							)
								throw denied();

							if (requested.resource === "session.code-review") {
								const received = output.data.result as {
									executionId: string;
									targetRepo: string;
									headSha: string;
								};
								if (
									received.executionId !== requested.executionId ||
									received.targetRepo !== requested.targetRepo ||
									received.headSha !== requested.headSha
								)
									throw denied();
							}
							return {
								status: "succeeded",
								...(result.resourceRefs[0]
									? { providerRef: result.resourceRefs[0] }
									: {}),
								data: output.data,
							};
						}
						return {
							status: result.status,
							...(githubOperation ||
							operationId === "terminal.input" ||
							operationId === "inbox.event.ack"
								? { errorCode: result.errorCode }
								: {}),
						};
					} catch {
						return { status: "unknown" };
					} finally {
						signal.removeEventListener("abort", cancelBody);
						await (reader ? reader.cancel() : responseBody?.cancel())?.catch(
							() => {},
						);
					}
				};
				try {
					return await Promise.race([work(), aborted]);
				} finally {
					clearTimeout(timer);
					signal.removeEventListener("abort", onAbort);
					controller.abort();
				}
			},
		});
	}
	return handlers;
}
