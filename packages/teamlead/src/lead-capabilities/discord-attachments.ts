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
