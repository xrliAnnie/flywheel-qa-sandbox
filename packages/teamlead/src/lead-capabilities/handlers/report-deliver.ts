import { z } from "zod";
import {
	type HandlerOutcome,
	type LeadOperationContext,
	type LeadOperationHandler,
	OperationRequestSchema,
} from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import { createLeadCapabilityContext } from "../runtime-context.js";

const operations = ["report.deliver"] as const;
const replySchema = z
	.object({
		requestId: z.string().uuid(),
		status: z.enum(["succeeded", "rejected", "unknown"]),
		resourceRefs: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,256}$/)).max(1),
		data: z.unknown().optional(),
		errorCode: z.string().max(128).optional(),
	})
	.strict();
const denied = () => new Error("report_deliver_scope_denied");
/** Parent-only delivery transport; uncertain writes reconcile by reading the existing Bridge outbox. */
export function createReportDeliverHandlers(
	options: {
		env: NodeJS.ProcessEnv;
		activationId: string;
		fetchImpl?: typeof fetch;
	},
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
	const endpoint = new URL(
			receiptOnly
				? "/api/lead-capabilities/reports/delivery-receipt"
				: "/api/lead-capabilities/reports/deliver",
			url,
		).href,
		fetchImpl = options.fetchImpl ?? fetch;
	const handlers = new Map<string, LeadOperationHandler>();
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
	for (const operationId of operations) {
		const definition = getLeadCapability(operationId)!;
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
				projectName: env.FLYWHEEL_PROJECT_NAME,
				capability: {
					schemaVersion: 1,
					operationId,
					requestId: context.requestId,
					leadId: env.FLYWHEEL_LEAD_ID,
					identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
					carrierClaim: claim,
					activationId,
					...input.data,
				},
			};
			const json = JSON.stringify(body);
			if (Buffer.byteLength(json) > 65536) throw denied();
			return json;
		}
		handlers.set(operationId, {
			authorize: async (raw, context) => {
				envelope(raw, context);
				await current(context);
			},
			execute: async (raw, context) => {
				const body = envelope(raw, context);
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
							(!/^\d+$/.test(length) || Number(length) > 8192)
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
							if (size > 8192) throw denied();
							chunks.push(item.value);
						}
						await current(context);
						signal.throwIfAborted();
						const text = new TextDecoder("utf-8", { fatal: true }).decode(
							Buffer.concat(chunks),
						);
						if (text.includes(token!) || text.includes(claim!)) throw denied();
						const parsed = replySchema.safeParse(JSON.parse(text));
						if (!parsed.success || parsed.data.requestId !== context.requestId)
							throw denied();
						const result = parsed.data;
						if (result.status === "succeeded") {
							const output = definition.outputSchema.safeParse(result.data);
							if (
								!response.ok ||
								!output.success ||
								output.data.reportId !== raw.reportId ||
								output.data.receiptId !== context.requestId ||
								result.resourceRefs.length !== 1 ||
								result.resourceRefs[0] !== output.data.messageId
							)
								throw denied();

							return {
								status: "succeeded",
								...(result.resourceRefs[0]
									? { providerRef: result.resourceRefs[0] }
									: {}),
								data: output.data,
							};
						}
						return { status: result.status };
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
	if (!receiptOnly) {
		const lookup = createReportDeliverHandlers(options, true).get(
			"report.deliver",
		)!;
		handlers.get("report.deliver")!.reconcile = (_receipt, raw, context) =>
			lookup.execute(raw, context);
	}
	return handlers;
}
