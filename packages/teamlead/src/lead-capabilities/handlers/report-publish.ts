import { z } from "zod";
import type { LeadArtifactStore } from "../artifacts.js";
import {
	type HandlerOutcome,
	type LeadOperationContext,
	type LeadOperationHandler,
	OperationRequestSchema,
} from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import { createLeadCapabilityContext } from "../runtime-context.js";

const denied = () => new Error("report_publish_denied");
const reply = z
	.object({
		requestId: z.string().uuid(),
		reportId: z.string().regex(/^[a-f0-9]{32}$/),
		url: z.string().url(),
	})
	.strict();
/** Parent-only artifact upload. The broker journal owns dispatch-once/replay;
 * this transport never retries, invokes a shell or accepts a model URL/path. */
export function createReportPublishHandlers(
	options: {
		env: NodeJS.ProcessEnv;
		activationId: string;
		store: LeadArtifactStore;
		secrets: readonly string[];
		fetchImpl?: typeof fetch;
	},
	receiptOnly = false,
): ReadonlyMap<string, LeadOperationHandler> {
	const env = Object.freeze({ ...options.env }),
		activationId = options.activationId;
	let trusted: ReturnType<typeof createLeadCapabilityContext>;
	let url: URL;
	try {
		trusted = createLeadCapabilityContext(env);
		url = new URL(env.FLYWHEEL_BRIDGE_URL ?? "");
	} catch {
		throw denied();
	}
	const token = env.FLYWHEEL_API_TOKEN,
		claim = env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID;
	if (
		!token ||
		token.length > 8192 ||
		/[\r\n]/.test(token) ||
		!claim ||
		claim.length > 256 ||
		!activationId ||
		activationId.length > 128 ||
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		(url.protocol === "http:" &&
			!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
	)
		throw denied();
	const endpoint = new URL(
			receiptOnly
				? "/api/lead-capabilities/reports/publish-receipt"
				: "/api/lead-capabilities/reports/publish",
			url,
		).href,
		fetchImpl = options.fetchImpl ?? fetch;
	const secrets = [...options.secrets, token, claim].filter(Boolean);
	const definition = getLeadCapability("report.publish")!;
	function input(raw: Record<string, unknown>, context: LeadOperationContext) {
		OperationRequestSchema.parse({
			schemaVersion: 1,
			operationId: "report.publish",
			requestId: context.requestId,
			input: raw,
		});
		const parsed = definition.inputSchema.parse(raw) as {
			artifactHandle: string;
			title: string;
			issueId: string;
		};
		if (
			parsed.title.length > 200 ||
			!/^[A-Za-z0-9_.:-]{1,128}$/.test(parsed.issueId)
		)
			throw denied();
		return parsed;
	}
	async function current(context: LeadOperationContext) {
		context.signal.throwIfAborted();
		if (
			context.projectName !== env.FLYWHEEL_PROJECT_NAME ||
			context.leadId !== env.FLYWHEEL_LEAD_ID ||
			context.activationId !== activationId
		)
			throw denied();
		await context.assertCurrent();
		trusted.assertActivationCurrent();
		context.signal.throwIfAborted();
	}
	const handlers = new Map<string, LeadOperationHandler>([
		[
			"report.publish",
			{
				authorize: async (raw, context) => {
					input(raw, context);
					await current(context);
				},
				execute: async (raw, context) => {
					const parsed = input(raw, context);
					await current(context);
					let html: string | undefined;
					if (!receiptOnly) {
						const artifact = await options.store.read(parsed.artifactHandle);
						await current(context);
						if (
							artifact.artifact.mimeType !== "text/html" ||
							artifact.data.length > 512 * 1024
						)
							throw denied();
						const htmlText = new TextDecoder("utf-8", { fatal: true }).decode(
							artifact.data,
						);
						if (
							!htmlText.trim() ||
							secrets.some(
								(s) =>
									htmlText.includes(s) ||
									parsed.title.includes(s) ||
									parsed.issueId.includes(s),
							)
						)
							throw denied();
						html = htmlText;
					}
					const body = JSON.stringify({
						projectName: context.projectName,
						...(!receiptOnly ? { html, title: parsed.title } : {}),
						capability: {
							schemaVersion: 1,
							operationId: "report.publish",
							requestId: context.requestId,
							leadId: context.leadId,
							identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
							carrierClaim: claim,
							activationId,
							issueId: parsed.issueId,
						},
					});
					const controller = new AbortController(),
						signal = AbortSignal.any([context.signal, controller.signal]);
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
						const cancel = () => {
							void (reader ? reader.cancel() : responseBody?.cancel())?.catch(
								() => {},
							);
						};
						signal.addEventListener("abort", cancel, { once: true });
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
							if (!response.body) throw denied();
							const length = response.headers.get("content-length");
							if (
								length !== null &&
								(!/^\d+$/.test(length) || Number(length) > 8192)
							)
								throw denied();
							reader = response.body.getReader();
							let size = 0;
							const chunks: Uint8Array[] = [];
							for (;;) {
								const part = await reader.read();
								signal.throwIfAborted();
								if (part.done) break;
								size += part.value.byteLength;
								if (size > 8192) throw denied();
								chunks.push(part.value);
							}
							await current(context);
							signal.throwIfAborted();
							const text = new TextDecoder("utf-8", { fatal: true }).decode(
								Buffer.concat(chunks),
							);
							if (secrets.some((s) => text.includes(s))) throw denied();
							const json = JSON.parse(text);
							if (
								response.status === 403 &&
								json?.error === "report publish scope denied"
							)
								return { status: "rejected" };
							const result = reply.parse(json);
							if (!response.ok || result.requestId !== context.requestId)
								throw denied();
							const published = new URL(result.url);
							if (
								published.protocol !== "https:" ||
								published.username ||
								published.password ||
								published.search ||
								published.hash ||
								published.pathname !== `/r/${result.reportId}/`
							)
								throw denied();
							return {
								status: "succeeded",
								providerRef: result.reportId,
								data: definition.outputSchema.parse({
									reportId: result.reportId,
									url: result.url,
									receiptId: context.requestId,
									observedAt: new Date().toISOString(),
								}),
							};
						} catch {
							return { status: "unknown" };
						} finally {
							signal.removeEventListener("abort", cancel);
							cancel();
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
			},
		],
	]);
	if (!receiptOnly) {
		const lookup = createReportPublishHandlers(options, true).get(
			"report.publish",
		)!;
		handlers.get("report.publish")!.reconcile = (_receipt, raw, context) =>
			lookup.execute(raw, context);
	}
	return handlers;
}
