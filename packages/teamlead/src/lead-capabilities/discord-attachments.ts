import { createHash } from "node:crypto";
import { z } from "zod";
import type { OperationResult } from "./broker.js";
import type { OperationReceipt, OperationReceiptStore } from "./receipts.js";

const snowflake = z.string().regex(/^[0-9]{17,20}$/);
const attachmentSchema = z.object({
	id: snowflake,
	size: z
		.number()
		.int()
		.min(1)
		.max(25 * 1024 * 1024),
	url: z.string().url().max(4096),
	content_type: z.string().max(128).optional(),
});
const messageSchema = z.object({
	id: snowflake,
	channel_id: snowflake,
	attachments: z.array(attachmentSchema).max(10),
});
const denied = () => new Error("discord_attachment_denied");
const knownMime = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"application/pdf",
	"text/html",
	"text/plain",
	"application/json",
]);

export type DiscordInboundAttachmentFailureReason =
	| "scope_denied"
	| "producer_identity_missing"
	| "invalid_metadata"
	| "unsupported_type"
	| "too_large"
	| "not_found"
	| "fetch_unavailable"
	| "timeout"
	| "invalid_content"
	| "carrier_expired"
	| "transport_unavailable"
	| "busy";

export class DiscordInboundAttachmentError extends Error {
	constructor(public readonly reason: DiscordInboundAttachmentFailureReason) {
		super("discord_inbound_attachment_unavailable");
		this.name = "DiscordInboundAttachmentError";
	}
}

const inboundAttachmentSchema = z.object({
	id: snowflake,
	size: z
		.number()
		.int()
		.min(0)
		.max(25 * 1024 * 1024),
	url: z.string().url().max(4096),
	content_type: z.string().min(1).max(128),
});
const inboundMessageSchema = z.object({
	id: snowflake,
	channel_id: snowflake,
	attachments: z.array(z.looseObject({})).max(10),
});
const inboundLimits = new Map<string, number>([
	["image/png", 5 * 1024 * 1024],
	["image/jpeg", 5 * 1024 * 1024],
	["image/webp", 5 * 1024 * 1024],
	["text/plain", 32 * 1024],
	["text/plain;charset=utf-8", 32 * 1024],
]);

function normalizeInboundMime(value: string): string | undefined {
	const [rawType, ...parameters] = value
		.toLowerCase()
		.split(";")
		.map((part) => part.trim());
	if (!rawType) return undefined;
	if (rawType !== "text/plain")
		return parameters.length === 0 && inboundLimits.has(rawType)
			? rawType
			: undefined;
	if (parameters.length === 0) return rawType;
	if (
		parameters.length === 1 &&
		/^charset\s*=\s*(?:utf-8|utf8)$/.test(parameters[0]!)
	)
		return "text/plain;charset=utf-8";
	return undefined;
}

function inboundFailure(reason: DiscordInboundAttachmentFailureReason) {
	return new DiscordInboundAttachmentError(reason);
}

/**
 * Receipt-bound inbound policy layered beside the legacy attachment reader.
 * The caller owns mailbox/carrier/channel scope; this primitive owns the exact
 * Discord lookup, allowlisted CDN transfer, and narrow MIME/byte policy.
 */
export async function fetchInboundDiscordAttachment(options: {
	threadId: string;
	messageId: string;
	attachmentId: string;
	botToken: string;
	secrets: readonly string[];
	signal: AbortSignal;
	assertCurrent(): void | Promise<void>;
	expected: { mimeType: string; sizeBytes: number };
	fetchImpl?: typeof fetch;
}): Promise<{ data: Buffer; mimeType: string }> {
	const timeout = new AbortController();
	const signal = AbortSignal.any([options.signal, timeout.signal]);
	const timer = setTimeout(() => timeout.abort(), 15000);
	const fetchImpl = options.fetchImpl ?? fetch;
	const current = async () => {
		if (timeout.signal.aborted) throw inboundFailure("timeout");
		if (options.signal.aborted) throw inboundFailure("scope_denied");
		await options.assertCurrent();
		if (timeout.signal.aborted) throw inboundFailure("timeout");
		if (options.signal.aborted) throw inboundFailure("scope_denied");
	};
	const secret = (data: Buffer) =>
		[...options.secrets, options.botToken].some(
			(value) => value.length > 0 && data.includes(Buffer.from(value)),
		);
	async function read(
		url: string,
		limit: number,
		authenticated: boolean,
		kind: "metadata" | "content",
		exactBytes?: number,
	) {
		await current();
		let response: Response | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let rejectAbort!: (error: Error) => void;
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = reject;
		});
		void aborted.catch(() => {});
		const abort = () => {
			rejectAbort(
				inboundFailure(timeout.signal.aborted ? "timeout" : "scope_denied"),
			);
			void reader?.cancel().catch(() => {});
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			response = await Promise.race([
				fetchImpl(url, {
					method: "GET",
					redirect: "error",
					signal,
					headers: authenticated
						? { authorization: `Bot ${options.botToken}` }
						: {},
				}),
				aborted,
			]);
			await current();
			if (response.status === 404) throw inboundFailure("not_found");
			if (response.status !== 200 || !response.body)
				throw inboundFailure("fetch_unavailable");
			const length = response.headers.get("content-length");
			if (
				length !== null &&
				(!/^\d+$/.test(length) ||
					Number(length) > limit ||
					(exactBytes !== undefined && Number(length) !== exactBytes))
			)
				throw inboundFailure(
					kind === "metadata" ? "invalid_metadata" : "invalid_content",
				);
			reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let total = 0;
			for (;;) {
				const next = await Promise.race([reader.read(), aborted]);
				if (next.done) break;
				total += next.value.byteLength;
				if (total > limit)
					throw inboundFailure(
						kind === "metadata" ? "invalid_metadata" : "invalid_content",
					);
				chunks.push(next.value);
			}
			await current();
			const data = Buffer.concat(chunks);
			if (exactBytes !== undefined && data.length !== exactBytes)
				throw inboundFailure("invalid_content");
			if (secret(data)) throw inboundFailure("invalid_content");
			return {
				data,
				contentType: response.headers.get("content-type") ?? undefined,
			};
		} catch (error) {
			if (error instanceof DiscordInboundAttachmentError) throw error;
			if (timeout.signal.aborted) throw inboundFailure("timeout");
			if (options.signal.aborted) throw inboundFailure("scope_denied");
			throw inboundFailure("fetch_unavailable");
		} finally {
			signal.removeEventListener("abort", abort);
			try {
				await (reader ? reader.cancel() : response?.body?.cancel());
			} catch {}
		}
	}
	try {
		snowflake.parse(options.threadId);
		snowflake.parse(options.messageId);
		snowflake.parse(options.attachmentId);
		if (
			!options.botToken ||
			options.botToken.length > 8192 ||
			/\s/.test(options.botToken) ||
			!Number.isSafeInteger(options.expected.sizeBytes) ||
			options.expected.sizeBytes < 0
		)
			throw inboundFailure("invalid_metadata");
		const expectedMime = normalizeInboundMime(options.expected.mimeType);
		if (!expectedMime) throw inboundFailure("unsupported_type");
		const metadata = await read(
			`https://discord.com/api/v10/channels/${options.threadId}/messages/${options.messageId}`,
			262144,
			true,
			"metadata",
		);
		if (
			metadata.contentType?.split(";")[0]?.trim().toLowerCase() !==
			"application/json"
		)
			throw inboundFailure("invalid_metadata");
		let message: z.infer<typeof inboundMessageSchema>;
		try {
			message = inboundMessageSchema.parse(
				JSON.parse(
					new TextDecoder("utf8", { fatal: true }).decode(metadata.data),
				),
			);
		} catch {
			throw inboundFailure("invalid_metadata");
		}
		if (
			message.id !== options.messageId ||
			message.channel_id !== options.threadId
		)
			throw inboundFailure("invalid_metadata");
		const matches = message.attachments.filter(
			(attachment) => attachment.id === options.attachmentId,
		);
		if (matches.length === 0) throw inboundFailure("not_found");
		if (matches.length !== 1) throw inboundFailure("invalid_metadata");
		let attachment: z.infer<typeof inboundAttachmentSchema>;
		try {
			attachment = inboundAttachmentSchema.parse(matches[0]);
		} catch {
			throw inboundFailure("invalid_metadata");
		}
		const declaredMime = normalizeInboundMime(attachment.content_type);
		if (!declaredMime) throw inboundFailure("unsupported_type");
		if (
			attachment.size !== options.expected.sizeBytes ||
			declaredMime !== expectedMime
		)
			throw inboundFailure("invalid_metadata");
		const limit = inboundLimits.get(declaredMime)!;
		if (
			attachment.size > limit ||
			(declaredMime.startsWith("image/") && attachment.size === 0)
		)
			throw inboundFailure("too_large");
		const url = new URL(attachment.url);
		const parts = url.pathname.split("/");
		if (
			url.protocol !== "https:" ||
			!["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) ||
			url.port ||
			url.username ||
			url.password ||
			url.hash ||
			parts.length !== 5 ||
			parts[1] !== "attachments" ||
			parts[2] !== options.threadId ||
			parts[3] !== options.attachmentId
		)
			throw inboundFailure("invalid_metadata");
		let filename: string;
		try {
			filename = decodeURIComponent(parts[4]!);
		} catch {
			throw inboundFailure("invalid_metadata");
		}
		if (
			!filename ||
			filename === "." ||
			filename === ".." ||
			/[\\/]/.test(filename) ||
			[...filename].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
		)
			throw inboundFailure("invalid_metadata");
		const downloaded = await read(
			url.href,
			limit,
			false,
			"content",
			attachment.size,
		);
		const responseMime = downloaded.contentType
			? normalizeInboundMime(downloaded.contentType)
			: undefined;
		if (!responseMime || responseMime !== declaredMime)
			throw inboundFailure("invalid_content");
		return { data: downloaded.data, mimeType: declaredMime };
	} catch (error) {
		if (error instanceof DiscordInboundAttachmentError) throw error;
		if (timeout.signal.aborted) throw inboundFailure("timeout");
		throw inboundFailure("invalid_metadata");
	} finally {
		clearTimeout(timer);
	}
}
/** Bridge/parent only. Message ownership is supplied by the current canonical scope guard. */
export async function fetchDiscordAttachment(options: {
	threadId: string;
	messageId: string;
	attachmentId: string;
	botToken: string;
	secrets: readonly string[];
	signal: AbortSignal;
	assertCurrent(): void | Promise<void>;
	fetchImpl?: typeof fetch;
}): Promise<{ data: Buffer; mimeType: string }> {
	const timeout = new AbortController(),
		signal = AbortSignal.any([options.signal, timeout.signal]);
	const timer = setTimeout(() => timeout.abort(), 15000),
		fetchImpl = options.fetchImpl ?? fetch;
	const current = async () => {
		signal.throwIfAborted();
		await options.assertCurrent();
		signal.throwIfAborted();
	};
	const secret = (data: Buffer) =>
		[...options.secrets, options.botToken].some(
			(value) => value.length > 0 && data.includes(Buffer.from(value)),
		);
	async function read(url: string, limit: number, authenticated: boolean) {
		await current();
		let response: Response | undefined,
			reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let rejectAbort!: (error: Error) => void;
		const abortPromise = new Promise<never>((_, reject) => {
			rejectAbort = reject;
		});
		const abort = () => {
			rejectAbort(denied());
			void reader?.cancel().catch(() => {});
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			signal.throwIfAborted();
			const pending = fetchImpl(url, {
				method: "GET",
				redirect: "error",
				signal,
				headers: authenticated
					? { authorization: `Bot ${options.botToken}` }
					: {},
			});
			void pending.then(
				(r) => {
					if (signal.aborted) void r.body?.cancel().catch(() => {});
				},
				() => {},
			);
			response = await Promise.race([pending, abortPromise]);
			await current();
			const length = response.headers.get("content-length");
			if (
				response.status !== 200 ||
				!response.body ||
				(length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
			)
				throw denied();
			reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let total = 0;
			for (;;) {
				const next = await Promise.race([reader.read(), abortPromise]);
				signal.throwIfAborted();
				if (next.done) break;
				total += next.value.byteLength;
				if (total > limit) throw denied();
				chunks.push(next.value);
			}
			await current();
			const data = Buffer.concat(chunks);
			if (secret(data)) throw denied();
			return {
				data,
				contentType: response.headers
					.get("content-type")
					?.split(";")[0]
					?.trim()
					.toLowerCase(),
			};
		} finally {
			signal.removeEventListener("abort", abort);
			try {
				await (reader ? reader.cancel() : response?.body?.cancel());
			} catch {}
		}
	}
	try {
		snowflake.parse(options.threadId);
		snowflake.parse(options.messageId);
		snowflake.parse(options.attachmentId);
		if (
			!options.botToken ||
			options.botToken.length > 8192 ||
			/\s/.test(options.botToken)
		)
			throw denied();
		const metadata = await read(
			`https://discord.com/api/v10/channels/${options.threadId}/messages/${options.messageId}`,
			262144,
			true,
		);
		if (metadata.contentType !== "application/json") throw denied();
		const message = messageSchema.parse(
			JSON.parse(
				new TextDecoder("utf8", { fatal: true }).decode(metadata.data),
			),
		);
		if (
			message.id !== options.messageId ||
			message.channel_id !== options.threadId
		)
			throw denied();
		const matches = message.attachments.filter(
			(a) => a.id === options.attachmentId,
		);
		if (matches.length !== 1) throw denied();
		const attachment = matches[0]!,
			url = new URL(attachment.url),
			parts = url.pathname.split("/");
		if (
			url.protocol !== "https:" ||
			!["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) ||
			url.port ||
			url.username ||
			url.password ||
			url.hash ||
			parts.length !== 5 ||
			parts[1] !== "attachments" ||
			parts[2] !== options.threadId ||
			parts[3] !== options.attachmentId
		)
			throw denied();
		const filename = decodeURIComponent(parts[4]!);
		if (
			!filename ||
			filename === "." ||
			filename === ".." ||
			/[\\/]/.test(filename) ||
			[...filename].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
		)
			throw denied();
		const downloaded = await read(url.href, attachment.size, false);
		if (downloaded.data.length !== attachment.size) throw denied();
		const declared = attachment.content_type
			?.split(";")[0]
			?.trim()
			.toLowerCase();
		if (
			declared &&
			downloaded.contentType &&
			declared !== downloaded.contentType
		)
			throw denied();
		const mime =
			declared ?? downloaded.contentType ?? "application/octet-stream";
		return {
			data: downloaded.data,
			mimeType: knownMime.has(mime) ? mime : "application/octet-stream",
		};
	} catch {
		throw denied();
	} finally {
		clearTimeout(timer);
	}
}

const uploadExtensions: Readonly<Record<string, string>> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"application/pdf": "pdf",
	"text/html": "html",
	"text/plain": "txt",
	"application/json": "json",
	"application/octet-stream": "bin",
};
/**
 * Trusted Bridge transport only. Caller must durably claim the request and bind
 * its file digests before invoking this effect. Errors are ambiguous: never
 * retry from this primitive; the durable caller owns read-only reconciliation.
 */
export async function sendDiscordAttachments(options: {
	threadId: string;
	nonce: string;
	text?: string;
	files: readonly { data: Buffer; mimeType: string }[];
	botToken: string;
	secrets: readonly string[];
	signal: AbortSignal;
	assertCurrent(): void | Promise<void>;
	fetchImpl?: typeof fetch;
}): Promise<{ messageId: string }> {
	const timeout = new AbortController();
	const signal = AbortSignal.any([options.signal, timeout.signal]);
	const timer = setTimeout(() => timeout.abort(), 15000);
	const failed = () => new Error("discord_attachment_send_unknown");
	let response: Response | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let rejectAbort!: (error: Error) => void;
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	// Validation can fail before the first race is installed.
	void aborted.catch(() => {});
	const abort = () => {
		rejectAbort(failed());
		void reader?.cancel().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	const current = async () => {
		signal.throwIfAborted();
		await Promise.race([
			Promise.resolve().then(() => options.assertCurrent()),
			aborted,
		]);
		signal.throwIfAborted();
	};
	try {
		snowflake.parse(options.threadId);
		z.string()
			.regex(/^[a-zA-Z0-9_-]{1,25}$/)
			.parse(options.nonce);
		const content = z
			.string()
			.max(2000)
			.parse(options.text ?? "");
		if (
			!options.botToken ||
			options.botToken.length > 8192 ||
			/\s/.test(options.botToken)
		)
			throw failed();
		if (options.files.length < 1 || options.files.length > 10) throw failed();
		const credentials = [...options.secrets, options.botToken]
			.filter(Boolean)
			.map((s) => Buffer.from(s));
		const hasSecret = (bytes: Buffer) =>
			credentials.some((secret) => bytes.includes(secret));
		if (hasSecret(Buffer.from(content))) throw failed();
		const form = new FormData();
		const attachments: { id: number; filename: string }[] = [];
		for (const [index, file] of options.files.entries()) {
			if (
				!Buffer.isBuffer(file.data) ||
				!file.data.length ||
				file.data.length > 25 * 1024 * 1024 ||
				!Object.hasOwn(uploadExtensions, file.mimeType) ||
				hasSecret(file.data)
			)
				throw failed();
			const filename = `attachment-${index + 1}.${uploadExtensions[file.mimeType]}`;
			attachments.push({ id: index, filename });
			// Blob copies the validated bytes synchronously before any async scope check.
			form.append(
				`files[${index}]`,
				new Blob([new Uint8Array(file.data)], { type: file.mimeType }),
				filename,
			);
		}
		form.append(
			"payload_json",
			JSON.stringify({
				content,
				nonce: options.nonce,
				enforce_nonce: true,
				allowed_mentions: { parse: [] },
				attachments,
			}),
		);
		await current();
		const pending = (options.fetchImpl ?? fetch)(
			`https://discord.com/api/v10/channels/${options.threadId}/messages`,
			{
				method: "POST",
				redirect: "error",
				signal,
				headers: { authorization: `Bot ${options.botToken}` },
				body: form,
			},
		);
		void pending.then(
			(r) => {
				if (signal.aborted) void r.body?.cancel().catch(() => {});
			},
			() => {},
		);
		response = await Promise.race([pending, aborted]);
		await current();
		const length = response.headers.get("content-length");
		if (
			response.status !== 200 ||
			!response.body ||
			response.headers
				.get("content-type")
				?.split(";")[0]
				?.trim()
				.toLowerCase() !== "application/json" ||
			(length !== null && (!/^\d+$/.test(length) || Number(length) > 262144))
		)
			throw failed();
		reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		for (;;) {
			const next = await Promise.race([reader.read(), aborted]);
			signal.throwIfAborted();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > 262144) throw failed();
			chunks.push(next.value);
		}
		const data = Buffer.concat(chunks);
		if (hasSecret(data)) throw failed();
		const message = z
			.object({ id: snowflake, channel_id: snowflake })
			.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(data)));
		if (message.channel_id !== options.threadId) throw failed();
		await current();
		return { messageId: message.id };
	} catch {
		throw failed();
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		// Do not let an uncooperative provider's cancellation stall the caller.
		void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {});
	}
}

/** Bridge-owned existing operation receipt table, not a parent authorization grant.
 * The digest includes immutable file snapshots as well as public operation input.
 */
export async function executeDiscordAttachmentSend(
	options: Omit<
		Parameters<typeof sendDiscordAttachments>[0],
		"nonce" | "files"
	> & {
		projectName: string;
		leadId: string;
		activationId: string;
		requestId: string;
		files: readonly { handle: string; data: Buffer; mimeType: string }[];
		receipts: OperationReceiptStore;
		receiptOnly?: boolean;
	},
): Promise<OperationResult> {
	const key = {
		projectName: options.projectName,
		leadId: options.leadId,
		operationId: "discord.message.attachments.send",
		requestId: options.requestId,
	};
	const result = (
		status: OperationResult["status"],
		errorCode?: string,
	): OperationResult => ({
		requestId: key.requestId,
		status,
		resourceRefs: [],
		...(errorCode ? { errorCode } : {}),
	});
	const timeout = new AbortController(),
		signal = AbortSignal.any([options.signal, timeout.signal]);
	const timer = setTimeout(() => timeout.abort(), 15000);
	let rejectAbort!: () => void;
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = () => reject(new Error("aborted"));
	});
	void aborted.catch(() => {});
	signal.addEventListener("abort", rejectAbort, { once: true });
	const current = async () => {
		signal.throwIfAborted();
		await Promise.race([
			Promise.resolve().then(() => options.assertCurrent()),
			aborted,
		]);
		signal.throwIfAborted();
	};
	let claimed: { inputDigest: string; activationId: string } | undefined;
	let dispatched = false;
	try {
		const threadId = snowflake.parse(options.threadId),
			text = z
				.string()
				.max(2000)
				.parse(options.text ?? "");
		if (options.files.length < 1 || options.files.length > 10)
			return result("rejected", "discord_attachment_invalid");
		const files = options.files.map((file) => {
			const handle = z
				.string()
				.regex(/^[a-zA-Z0-9_-]{1,256}$/)
				.parse(file.handle);
			if (
				!Buffer.isBuffer(file.data) ||
				!file.data.length ||
				file.data.length > 25 * 1024 * 1024 ||
				!Object.hasOwn(uploadExtensions, file.mimeType)
			)
				throw new Error("invalid");
			return { handle, data: Buffer.from(file.data), mimeType: file.mimeType };
		});
		const inputDigest = createHash("sha256")
			.update(
				JSON.stringify([
					threadId,
					text,
					files.map((f) => [
						f.handle,
						f.mimeType,
						f.data.length,
						createHash("sha256").update(f.data).digest("hex"),
					]),
				]),
			)
			.digest("hex");
		await current();
		const replay = (prior: OperationReceipt | undefined): OperationResult => {
			if (!prior) return result("unknown");
			if (prior.inputDigest !== inputDigest)
				return result("rejected", "input_digest_conflict");
			if (
				prior.state === "succeeded" &&
				/^discord-message:[0-9]{17,20}$/.test(prior.providerRef ?? "")
			)
				return {
					requestId: key.requestId,
					status: "succeeded",
					resourceRefs: [prior.providerRef!],
					data: {
						messageId: prior.providerRef!.slice("discord-message:".length),
						receiptId: key.requestId,
						observedAt: new Date(prior.updatedAt).toISOString(),
					},
				};
			return result(
				prior.state === "rejected" ? "rejected" : "unknown",
				prior.errorCode ?? undefined,
			);
		};
		if (options.receiptOnly) return replay(options.receipts.get(key));
		// An existing prepared/dispatched/unknown row is never dispatched again.
		const prior = options.receipts.get(key);
		if (prior) return replay(prior);
		const coordinate = { inputDigest, activationId: options.activationId };
		const prepared = options.receipts.prepare({
			...key,
			...coordinate,
			now: Date.now(),
		});
		if (prepared.disposition !== "prepared") return replay(prepared.receipt);
		claimed = coordinate;
		await current();
		options.receipts.transition({
			...key,
			...coordinate,
			from: "prepared",
			to: "dispatched",
			now: Date.now(),
		});
		dispatched = true;
		const nonce = createHash("sha256")
			.update(
				JSON.stringify([
					key.projectName,
					key.leadId,
					key.operationId,
					key.requestId,
				]),
			)
			.digest("hex")
			.slice(0, 25);
		const sent = await sendDiscordAttachments({
			...options,
			threadId,
			text,
			files,
			nonce,
			signal,
			assertCurrent: current,
		});
		await current();
		const receipt = options.receipts.transition({
			...key,
			...coordinate,
			from: "dispatched",
			to: "succeeded",
			providerRef: `discord-message:${sent.messageId}`,
			now: Date.now(),
		});
		return replay(receipt);
	} catch (error) {
		const code = dispatched
			? "discord_attachment_send_unknown"
			: error instanceof Error && error.message === "input_digest_conflict"
				? "input_digest_conflict"
				: "discord_attachment_scope_denied";
		if (claimed) {
			try {
				options.receipts.transition({
					...key,
					...claimed,
					from: dispatched ? "dispatched" : "prepared",
					to: dispatched ? "unknown" : "rejected",
					errorCode: code,
					now: Date.now(),
				});
			} catch {
				/* A stopped/recovered dispatcher must never overwrite newer durable state. */
			}
		}
		return result(dispatched ? "unknown" : "rejected", code);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", rejectAbort);
	}
}
