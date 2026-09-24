import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HttpPost } from "../lead-backends/codex/CodexOutboundSender.js";
import type { SqliteJournalStore } from "../lead-backends/codex/SqliteJournalStore.js";
import { resolveVoiceReplyDeliveryContext } from "../lead-backends/codex/voice-reply-delivery-context.js";
import { createLeadCapabilityContext } from "./runtime-context.js";

const base = z.object({
	projectName: z.string(),
	leadId: z.string(),
	channelId: z.string().regex(/^\d{17,20}$/),
});
const bodySchema = z.union([
	base.extend({ probe: z.literal(true) }).strict(),
	base
		.extend({
			text: z.string().min(1).max(12000),
			idempotencyKey: z.string().min(1).max(256),
			nonce: z.string().min(1).max(32),
			deliveryContext: z
				.string()
				.regex(/^chat:[A-Za-z0-9_.:-]+:voice-handoff:[0-9a-f-]{36}$/iu)
				.optional(),
		})
		.strict(),
]);
const responseSchema = z
	.object({
		requestId: z.string().uuid(),
		status: z.enum(["succeeded", "unknown", "rejected"]),
		resourceRefs: z.array(z.string()).max(0),
		errorCode: z.string().max(128).optional(),
		data: z
			.object({
				httpStatus: z.number().optional(),
				status: z.enum([
					"authorized",
					"sent",
					"deduped",
					"ambiguous",
					"rejected",
				]),
				messageId: z
					.string()
					.regex(/^\d{17,20}$/)
					.optional(),
				reason: z.string().max(128).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();
const denied = () => new Error("automatic_outbound_unverified");

/** Parent-only transport: the model never supplies its endpoint, credentials or journal binding. */
export function createAutomaticOutboundTransport(options: {
	env: NodeJS.ProcessEnv;
	activationId: string;
	journal: SqliteJournalStore;
	assertCurrent(): Promise<void>;
	fetchImpl?: typeof fetch;
}): HttpPost {
	const env = Object.freeze({ ...options.env });
	const trusted = createLeadCapabilityContext(env);
	const token = env.FLYWHEEL_API_TOKEN,
		claim = env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID;
	const origin = new URL(env.FLYWHEEL_BRIDGE_URL ?? "");
	if (
		!token ||
		token.length > 8192 ||
		/[\r\n]/.test(token) ||
		!claim ||
		claim.length > 256 ||
		!options.activationId ||
		options.activationId.length > 128 ||
		!["http:", "https:"].includes(origin.protocol) ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash ||
		origin.pathname !== "/" ||
		(origin.protocol === "http:" &&
			!["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname))
	)
		throw denied();
	const endpoint = new URL("/api/lead-capabilities/discord", origin).href;
	const activationId = options.activationId;
	const fetchImpl = options.fetchImpl ?? fetch;
	return async (request) => {
		if (Buffer.byteLength(request.body) > 65536) throw denied();
		const body = bodySchema.parse(JSON.parse(request.body));
		const probe = "probe" in body;
		const context = request.deliveryContext;
		const controller = new AbortController();
		const signal = request.signal
			? AbortSignal.any([request.signal, controller.signal])
			: controller.signal;
		const timer = setTimeout(() => controller.abort(), 15000);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let responseBody: ReadableStream<Uint8Array> | null | undefined;
		const check = async () => {
			signal.throwIfAborted();
			await options.assertCurrent();
			signal.throwIfAborted();
			const row = trusted.assertActivationCurrent();
			if (
				body.projectName !== env.FLYWHEEL_PROJECT_NAME ||
				body.leadId !== env.FLYWHEEL_LEAD_ID
			)
				throw denied();
			if (!probe) {
				if (!context || !/^[A-Za-z0-9_.:-]{1,512}$/.test(context))
					throw denied();
				const entry = options.journal.getById(context);
				if (
					!entry ||
					!["model_completed", "output_pending"].includes(entry.state) ||
					entry.output !== body.text ||
					body.channelId !== (entry.replyChannelId ?? row.lead.chatChannel) ||
					body.idempotencyKey !== `${entry.id}:out`
				)
					throw denied();
				const expectedVoiceContext = resolveVoiceReplyDeliveryContext(
					env.FLYWHEEL_LEAD_ID!,
					options.journal.listMemberIds(context),
				);
				if (body.deliveryContext !== expectedVoiceContext) throw denied();
			}
		};
		let cancel!: () => void;
		const aborted = new Promise<never>((_, reject) => {
			cancel = () => {
				void reader?.cancel().catch(() => {});
				reject(denied());
			};
			signal.addEventListener("abort", cancel, { once: true });
			if (signal.aborted) cancel();
		});
		try {
			return await Promise.race([
				aborted,
				(async () => {
					await check();
					signal.throwIfAborted();
					const requestId = randomUUID();
					const input = probe
						? { channelId: body.channelId }
						: {
								channelId: body.channelId,
								text: body.text,
								idempotencyKey: body.idempotencyKey,
								nonce: body.nonce,
							};
					const response = await fetchImpl(endpoint, {
						method: "POST",
						redirect: "error",
						signal,
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({
							schemaVersion: 1,
							operationId: probe
								? "discord.output.authorize"
								: "discord.output.deliver",
							requestId,
							projectName: body.projectName,
							leadId: body.leadId,
							identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
							carrierClaim: claim,
							activationId,
							...(!probe
								? { deliveryContext: body.deliveryContext ?? context }
								: {}),
							input,
						}),
					});
					responseBody = response.body;
					if (signal.aborted) {
						void responseBody?.cancel().catch(() => {});
						throw denied();
					}
					await check();
					if (response.status >= 300 && response.status < 400) throw denied();
					const length = response.headers.get("content-length");
					if (
						!response.body ||
						(length !== null &&
							(!/^\d+$/.test(length) || Number(length) > 8192))
					) {
						void response.body?.cancel().catch(() => {});
						throw denied();
					}
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
					const text = new TextDecoder("utf-8", { fatal: true }).decode(
						Buffer.concat(chunks),
					);
					if (text.includes(token) || text.includes(claim)) throw denied();
					const result = responseSchema.parse(JSON.parse(text));
					if (result.requestId !== requestId) throw denied();
					await check();
					if (result.status === "rejected")
						return {
							status: response.ok ? 403 : response.status,
							body: JSON.stringify({
								status: "rejected",
								reason: "automatic_outbound_rejected",
							}),
						};
					const data = result.data;
					if (
						!data ||
						(result.status === "succeeded" &&
							(!response.ok ||
								(probe
									? data.status !== "authorized"
									: !["sent", "deduped"].includes(data.status) ||
										!data.messageId))) ||
						(result.status === "unknown" && data.status !== "ambiguous")
					)
						throw denied();
					return { status: response.status, body: JSON.stringify(data) };
				})(),
			]);
		} catch {
			throw denied();
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			if (reader) void reader.cancel().catch(() => {});
			else void responseBody?.cancel().catch(() => {});
		}
	};
}
