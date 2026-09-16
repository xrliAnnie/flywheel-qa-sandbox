import { createHash } from "node:crypto";
import { z } from "zod";
import type { LeadArtifactStore } from "../artifacts.js";
import { encodeAttachmentUpload } from "../attachment-upload.js";
import type {
	HandlerOutcome,
	LeadOperationContext,
	LeadOperationHandler,
} from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import { createLeadCapabilityContext } from "../runtime-context.js";

const denied = () => new Error("discord_attachment_denied");
/** Parent receives result bytes, never a CDN URL or a reusable authorization grant. */
export function createBridgeAttachmentHandlers(options: {
	env: NodeJS.ProcessEnv;
	activationId: string;
	store: LeadArtifactStore;
	secrets: readonly string[];
	fetchImpl?: typeof fetch;
}): ReadonlyMap<string, LeadOperationHandler> {
	const env = Object.freeze({ ...options.env }),
		trusted = createLeadCapabilityContext(env);
	const token = env.FLYWHEEL_API_TOKEN,
		claim = env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID,
		origin = new URL(env.FLYWHEEL_BRIDGE_URL ?? "");
	if (
		!token ||
		/[\r\n]/.test(token) ||
		token.length > 8192 ||
		!claim ||
		claim.length > 256 ||
		!options.activationId ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash ||
		origin.pathname !== "/" ||
		!["http:", "https:"].includes(origin.protocol) ||
		(origin.protocol === "http:" &&
			!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
	)
		throw denied();
	const endpoint = new URL("/api/lead-capabilities/discord", origin).href,
		definition = getLeadCapability("discord.message.attachments.get")!,
		fetchImpl = options.fetchImpl ?? fetch;
	const secrets = [...options.secrets, token, claim];
	async function current(context: LeadOperationContext) {
		context.signal.throwIfAborted();
		if (
			context.projectName !== env.FLYWHEEL_PROJECT_NAME ||
			context.leadId !== env.FLYWHEEL_LEAD_ID ||
			context.activationId !== options.activationId
		)
			throw denied();
		await context.assertCurrent();
		trusted.assertActivationCurrent();
		context.signal.throwIfAborted();
	}
	const authorize = async (
		raw: Record<string, unknown>,
		context: LeadOperationContext,
	) => {
		definition.inputSchema.parse(raw);
		await current(context);
	};
	const handlers = new Map<string, LeadOperationHandler>([
		[
			definition.operationId,
			{
				authorize,
				execute: async (raw, context) => {
					let response: Response | undefined,
						reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
					const timeout = new AbortController(),
						signal = AbortSignal.any([context.signal, timeout.signal]),
						timer = setTimeout(() => timeout.abort(), 15000);
					let rejectAbort!: (error: Error) => void;
					const aborted = new Promise<never>((_, reject) => {
						rejectAbort = reject;
					});
					void aborted.catch(() => {});
					const abort = () => {
						rejectAbort(denied());
						void reader?.cancel().catch(() => {});
					};
					signal.addEventListener("abort", abort, { once: true });
					try {
						await authorize(raw, context);
						signal.throwIfAborted();
						const pending = fetchImpl(endpoint, {
							method: "POST",
							redirect: "error",
							signal,
							headers: {
								authorization: `Bearer ${token}`,
								"content-type": "application/json",
							},
							body: JSON.stringify({
								schemaVersion: 1,
								operationId: definition.operationId,
								requestId: context.requestId,
								projectName: context.projectName,
								leadId: context.leadId,
								identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
								carrierClaim: claim,
								activationId: context.activationId,
								input: raw,
							}),
						});
						void pending.then(
							(r) => {
								if (signal.aborted) void r.body?.cancel().catch(() => {});
							},
							() => {},
						);
						response = await Promise.race([pending, aborted]);
						await current(context);
						signal.throwIfAborted();
						const size = response.headers.get("content-length"),
							sha = response.headers.get("x-flywheel-artifact-sha256"),
							mime = response.headers.get("x-flywheel-artifact-mime");
						if (
							response.status !== 200 ||
							!response.body ||
							response.headers.get("x-flywheel-request-id") !==
								context.requestId ||
							!size ||
							!/^\d+$/.test(size) ||
							Number(size) < 1 ||
							Number(size) > 26214400 ||
							!sha ||
							!/^[a-f0-9]{64}$/.test(sha) ||
							!mime
						)
							throw denied();
						reader = response.body.getReader();
						const chunks: Uint8Array[] = [];
						let bytes = 0;
						for (;;) {
							const next = await Promise.race([reader.read(), aborted]);
							signal.throwIfAborted();
							if (next.done) break;
							bytes += next.value.byteLength;
							if (bytes > Number(size)) throw denied();
							chunks.push(next.value);
						}
						const data = Buffer.concat(chunks);
						if (
							bytes !== Number(size) ||
							createHash("sha256").update(data).digest("hex") !== sha ||
							secrets.some((s) => s.length > 0 && data.includes(Buffer.from(s)))
						)
							throw denied();
						await current(context);
						signal.throwIfAborted();
						const artifact = await options.store.put(data, mime);
						await current(context);
						signal.throwIfAborted();
						return {
							status: "succeeded",
							providerRef: `artifact:${artifact.handle}`,
							data: definition.outputSchema.parse({
								artifactHandle: artifact.handle,
								bytes,
								receiptId: context.requestId,
								observedAt: new Date().toISOString(),
							}),
						};
					} catch {
						return { status: "unknown" };
					} finally {
						clearTimeout(timer);
						signal.removeEventListener("abort", abort);
						try {
							await (reader ? reader.cancel() : response?.body?.cancel());
						} catch {}
					}
				},
			},
		],
	]);
	const sendDefinition = getLeadCapability("discord.message.attachments.send")!;
	const replySchema = z
		.object({
			requestId: z.string().uuid(),
			status: z.enum(["succeeded", "unknown", "rejected"]),
			resourceRefs: z.array(z.string().max(256)).max(1),
			data: z.unknown().optional(),
			errorCode: z
				.string()
				.regex(/^[a-z][a-z0-9_]{0,95}$/)
				.optional(),
		})
		.strict();
	async function send(
		raw: Record<string, unknown>,
		context: LeadOperationContext,
		receiptOnly: boolean,
	): Promise<HandlerOutcome> {
		const timeout = new AbortController(),
			signal = AbortSignal.any([context.signal, timeout.signal]);
		const timer = setTimeout(() => timeout.abort(), 15000);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
			response: Response | undefined;
		let rejectAbort!: (error: Error) => void;
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = reject;
		});
		void aborted.catch(() => {});
		const abort = () => {
			rejectAbort(denied());
			void reader?.cancel().catch(() => {});
		};
		signal.addEventListener("abort", abort, { once: true });
		const guard = async () => {
			signal.throwIfAborted();
			await Promise.race([current(context), aborted]);
			signal.throwIfAborted();
		};
		try {
			const input = sendDefinition.inputSchema.parse(raw);
			await guard();
			if (secrets.some((s) => s && JSON.stringify(input).includes(s)))
				throw denied();
			const files = [];
			for (const handle of input.artifactHandles as string[]) {
				const { artifact, data } = await Promise.race([
					options.store.read(handle),
					aborted,
				]);
				await guard();
				if (secrets.some((s) => s && data.includes(Buffer.from(s))))
					throw denied();
				files.push({ handle, mimeType: artifact.mimeType, data });
			}
			const body = encodeAttachmentUpload(
				{
					schemaVersion: 1,
					operationId: sendDefinition.operationId,
					requestId: context.requestId,
					projectName: context.projectName,
					leadId: context.leadId,
					identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
					carrierClaim: claim,
					activationId: context.activationId,
					receiptOnly,
					input,
				},
				files,
			);
			await guard();
			const pending = fetchImpl(
				new URL("/api/lead-capabilities/discord/attachments", origin).href,
				{
					method: "POST",
					redirect: "error",
					signal,
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/octet-stream",
					},
					body: new Uint8Array(body),
				},
			);
			void pending.then(
				(r) => {
					if (signal.aborted) void r.body?.cancel().catch(() => {});
				},
				() => {},
			);
			response = await Promise.race([pending, aborted]);
			await guard();
			const length = response.headers.get("content-length");
			if (
				!response.body ||
				response.status !== 200 ||
				response.headers
					.get("content-type")
					?.split(";")[0]
					?.trim()
					.toLowerCase() !== "application/json" ||
				(length !== null && (!/^\d+$/.test(length) || Number(length) > 262144))
			)
				throw denied();
			reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			for (;;) {
				const next = await Promise.race([reader.read(), aborted]);
				signal.throwIfAborted();
				if (next.done) break;
				bytes += next.value.byteLength;
				if (bytes > 262144) throw denied();
				chunks.push(next.value);
			}
			await guard();
			const text = new TextDecoder("utf8", { fatal: true }).decode(
				Buffer.concat(chunks),
			);
			if (secrets.some((s) => s && text.includes(s))) throw denied();
			const reply = replySchema.parse(JSON.parse(text));
			if (reply.requestId !== context.requestId) throw denied();
			if (reply.status !== "succeeded")
				return {
					status: reply.status,
					...(reply.errorCode === "input_digest_conflict"
						? { errorCode: reply.errorCode }
						: {}),
				};
			const output = sendDefinition.outputSchema.parse(reply.data);
			if (
				output.receiptId !== context.requestId ||
				!/^[0-9]{17,20}$/.test(output.messageId as string) ||
				reply.resourceRefs.length !== 1 ||
				reply.resourceRefs[0] !== `discord-message:${output.messageId}`
			)
				throw denied();
			return {
				status: "succeeded",
				providerRef: reply.resourceRefs[0],
				data: output,
			};
		} catch {
			return { status: "unknown" };
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			void (reader ? reader.cancel() : response?.body?.cancel())?.catch(
				() => {},
			);
		}
	}
	handlers.set(sendDefinition.operationId, {
		authorize: async (raw, context) => {
			sendDefinition.inputSchema.parse(raw);
			await current(context);
		},
		execute: (raw, context) => send(raw, context, false),
		reconcile: async (receipt, raw, context) => {
			if (
				receipt.projectName !== context.projectName ||
				receipt.leadId !== context.leadId ||
				receipt.requestId !== context.requestId ||
				receipt.operationId !== sendDefinition.operationId
			)
				return { status: "unknown" };
			return send(raw, context, true);
		},
	});
	return handlers;
}
