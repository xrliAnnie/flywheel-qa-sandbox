import { createHash, randomUUID } from "node:crypto";
import type { DiscordInboundAttachmentFailureReason } from "../../../lead-capabilities/discord-attachments.js";
import type { LeadAttachmentContext } from "./attachment-context.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_FAILURE_BYTES = 4096;
const MAX_MCP_FRAME_BYTES = 7 * 1024 * 1024;
const MAX_IMAGE_SIDE = 16_384;
const MAX_IMAGE_PIXELS = 40_000_000;
const SNOWFLAKE = /^\d{17,20}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const FAILURE_REASONS = new Set<DiscordInboundAttachmentFailureReason>([
	"scope_denied",
	"producer_identity_missing",
	"invalid_metadata",
	"unsupported_type",
	"too_large",
	"not_found",
	"fetch_unavailable",
	"timeout",
	"invalid_content",
	"carrier_expired",
	"transport_unavailable",
	"busy",
]);

export type LeadAttachmentReadContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };
export interface LeadAttachmentReadResult {
	[key: string]: unknown;
	content: LeadAttachmentReadContent[];
	isError?: true;
}

export interface LeadAttachmentReader {
	read(input: {
		deliveryId: string;
		attachmentId: string;
	}): Promise<LeadAttachmentReadResult>;
}

export interface LeadAttachmentReaderOptions {
	context?: LeadAttachmentContext;
	bridgeUrl?: string;
	apiToken?: string;
	carrierClaim?: string;
	fetchImpl?: typeof fetch;
	requestId?: () => string;
}

function unavailable(
	requestId: string,
	reason: DiscordInboundAttachmentFailureReason,
): LeadAttachmentReadResult {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					requestId,
					contentState: "unavailable",
					reason,
				}),
			},
		],
		isError: true,
	};
}

function normalizeMime(value: string | null): string | undefined {
	if (!value) return undefined;
	const [rawType, ...parameters] = value
		.toLowerCase()
		.split(";")
		.map((part) => part.trim());
	if (["image/png", "image/jpeg", "image/webp"].includes(rawType ?? ""))
		return parameters.length === 0 ? rawType : undefined;
	if (rawType !== "text/plain") return undefined;
	if (parameters.length === 0) return "text/plain;charset=utf-8";
	return parameters.length === 1 &&
		/^charset\s*=\s*(?:utf-8|utf8)$/.test(parameters[0]!)
		? "text/plain;charset=utf-8"
		: undefined;
}

function imageDimensions(
	data: Buffer,
	mimeType: string,
): { width: number; height: number } | undefined {
	if (mimeType === "image/png") {
		if (
			data.length < 24 ||
			!data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
			data.readUInt32BE(8) !== 13 ||
			data.subarray(12, 16).toString("ascii") !== "IHDR"
		)
			return undefined;
		return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
	}
	if (mimeType === "image/jpeg") {
		if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8)
			return undefined;
		let offset = 2;
		while (offset + 4 <= data.length) {
			if (data[offset] !== 0xff) return undefined;
			while (data[offset] === 0xff) offset++;
			if (offset >= data.length) return undefined;
			const marker = data[offset++]!;
			if (marker === 0xd9 || marker === 0xda) return undefined;
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
			if (offset + 2 > data.length) return undefined;
			const length = data.readUInt16BE(offset);
			if (length < 2 || offset + length > data.length) return undefined;
			if (
				[
					0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
					0xce, 0xcf,
				].includes(marker)
			) {
				if (length < 7) return undefined;
				return {
					height: data.readUInt16BE(offset + 3),
					width: data.readUInt16BE(offset + 5),
				};
			}
			offset += length;
		}
		return undefined;
	}
	if (mimeType === "image/webp") {
		if (
			data.length < 30 ||
			data.subarray(0, 4).toString("ascii") !== "RIFF" ||
			data.subarray(8, 12).toString("ascii") !== "WEBP" ||
			data.readUInt32LE(4) !== data.length - 8
		)
			return undefined;
		const kind = data.subarray(12, 16).toString("ascii");
		const chunkSize = data.readUInt32LE(16);
		if (20 + chunkSize > data.length) return undefined;
		if (kind === "VP8X" && chunkSize >= 10) {
			return {
				width: 1 + data.readUIntLE(24, 3),
				height: 1 + data.readUIntLE(27, 3),
			};
		}
		if (
			kind === "VP8 " &&
			chunkSize >= 10 &&
			data.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
		) {
			return {
				width: data.readUInt16LE(26) & 0x3fff,
				height: data.readUInt16LE(28) & 0x3fff,
			};
		}
		if (kind === "VP8L" && chunkSize >= 5 && data[20] === 0x2f) {
			const bits = data.readUInt32LE(21);
			return {
				width: 1 + (bits & 0x3fff),
				height: 1 + ((bits >> 14) & 0x3fff),
			};
		}
	}
	return undefined;
}

function validateImage(
	data: Buffer,
	mimeType: string,
): DiscordInboundAttachmentFailureReason | undefined {
	const dimensions = imageDimensions(data, mimeType);
	if (!dimensions || dimensions.width === 0 || dimensions.height === 0)
		return "invalid_content";
	if (
		dimensions.width > MAX_IMAGE_SIDE ||
		dimensions.height > MAX_IMAGE_SIDE ||
		dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
	)
		return "too_large";
	return undefined;
}

async function readBounded(
	response: Response,
	limit: number,
	signal: AbortSignal,
): Promise<Buffer> {
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	let rejectAbort!: (error: Error) => void;
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	void aborted.catch(() => {});
	const abort = () => {
		rejectAbort(new Error("aborted"));
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const next = await Promise.race([reader.read(), aborted]);
			if (next.done) break;
			total += next.value.byteLength;
			if (total > limit) throw new Error("too_large");
			chunks.push(next.value);
		}
		return Buffer.concat(chunks);
	} finally {
		signal.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
	}
}

function responseFailureReason(
	data: Buffer,
): DiscordInboundAttachmentFailureReason {
	try {
		const value = JSON.parse(
			new TextDecoder("utf8", { fatal: true }).decode(data),
		) as {
			reason?: unknown;
		};
		return typeof value.reason === "string" &&
			FAILURE_REASONS.has(value.reason as DiscordInboundAttachmentFailureReason)
			? (value.reason as DiscordInboundAttachmentFailureReason)
			: "fetch_unavailable";
	} catch {
		return "fetch_unavailable";
	}
}

export function createLeadAttachmentReader(
	options: LeadAttachmentReaderOptions,
): LeadAttachmentReader {
	const fetchImpl = options.fetchImpl ?? fetch;
	let active = 0;
	return {
		async read(input) {
			const requestId = (options.requestId ?? randomUUID)();
			if (active >= 2) return unavailable(requestId, "busy");
			active++;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 15000);
			try {
				if (
					!options.context ||
					!options.bridgeUrl ||
					!options.apiToken ||
					!options.carrierClaim
				)
					return unavailable(requestId, "transport_unavailable");
				if (
					typeof input.deliveryId !== "string" ||
					input.deliveryId.length > 256 ||
					typeof input.attachmentId !== "string" ||
					!SNOWFLAKE.test(input.attachmentId)
				)
					return unavailable(requestId, "invalid_metadata");
				const delivery = new RegExp(
					`^chat:${options.context.leadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d{17,20})$`,
				).exec(input.deliveryId);
				if (!delivery) return unavailable(requestId, "scope_denied");
				const call = async (
					mode: "read" | "validate",
					receiptDigest?: string,
				) => {
					const pending = fetchImpl(
						`${options.bridgeUrl!.replace(/\/+$/u, "")}/api/lead-inbound/attachment`,
						{
							method: "POST",
							redirect: "error",
							signal: controller.signal,
							headers: {
								"content-type": "application/json",
								authorization: `Bearer ${options.apiToken}`,
							},
							body: JSON.stringify({
								schemaVersion: 1,
								mode,
								requestId,
								projectName: options.context!.projectName,
								leadId: options.context!.leadId,
								identityDigest: options.context!.identityDigest,
								carrierClaim: options.carrierClaim,
								deliveryId: input.deliveryId,
								attachmentId: input.attachmentId,
								...(receiptDigest ? { receiptDigest } : {}),
							}),
						},
					);
					void pending.catch(() => {});
					let rejectAbort!: (error: Error) => void;
					const aborted = new Promise<never>((_resolve, reject) => {
						rejectAbort = reject;
					});
					void aborted.catch(() => {});
					const abort = () => rejectAbort(new Error("aborted"));
					controller.signal.addEventListener("abort", abort, { once: true });
					if (controller.signal.aborted) abort();
					try {
						return await Promise.race([pending, aborted]);
					} finally {
						controller.signal.removeEventListener("abort", abort);
					}
				};
				let response: Response;
				try {
					response = await call("read");
				} catch {
					return unavailable(
						requestId,
						controller.signal.aborted ? "timeout" : "fetch_unavailable",
					);
				}
				if (!response.ok) {
					let body: Buffer;
					try {
						body = await readBounded(
							response,
							MAX_FAILURE_BYTES,
							controller.signal,
						);
					} catch {
						return unavailable(
							requestId,
							controller.signal.aborted ? "timeout" : "fetch_unavailable",
						);
					}
					return unavailable(requestId, responseFailureReason(body));
				}
				const mimeType = normalizeMime(response.headers.get("content-type"));
				const headerMime = normalizeMime(
					response.headers.get("x-flywheel-mime-type"),
				);
				const bytes = response.headers.get("x-flywheel-bytes");
				const length = response.headers.get("content-length");
				const sha = response.headers.get("x-flywheel-sha256");
				const receiptDigest = response.headers.get("x-flywheel-receipt-digest");
				const maxBytes = mimeType?.startsWith("image/")
					? MAX_IMAGE_BYTES
					: mimeType?.startsWith("text/plain")
						? MAX_TEXT_BYTES
						: 0;
				if (
					response.status !== 200 ||
					!mimeType ||
					headerMime !== mimeType ||
					response.headers.get("x-flywheel-request-id") !== requestId ||
					response.headers.get("x-flywheel-source-message-id") !==
						delivery[1] ||
					!SNOWFLAKE.test(
						response.headers.get("x-flywheel-source-channel-id") ?? "",
					) ||
					response.headers.get("x-flywheel-attachment-id") !==
						input.attachmentId ||
					!bytes ||
					!/^\d+$/.test(bytes) ||
					length !== bytes ||
					Number(bytes) > maxBytes ||
					!DIGEST.test(sha ?? "") ||
					!DIGEST.test(receiptDigest ?? "")
				)
					return unavailable(requestId, "invalid_content");
				let data: Buffer;
				try {
					data = await readBounded(response, maxBytes, controller.signal);
				} catch {
					return unavailable(
						requestId,
						controller.signal.aborted ? "timeout" : "too_large",
					);
				}
				if (
					data.length !== Number(bytes) ||
					createHash("sha256").update(data).digest("hex") !== sha
				)
					return unavailable(requestId, "invalid_content");

				let content: LeadAttachmentReadContent;
				if (mimeType.startsWith("text/plain")) {
					let text: string;
					try {
						text = new TextDecoder("utf-8", { fatal: true }).decode(data);
					} catch {
						return unavailable(requestId, "invalid_content");
					}
					if (text.includes("\0"))
						return unavailable(requestId, "invalid_content");
					content = { type: "text", text };
				} else {
					const invalid = validateImage(data, mimeType);
					if (invalid) return unavailable(requestId, invalid);
					content = {
						type: "image",
						data: data.toString("base64"),
						mimeType,
					};
				}
				let validated: Response;
				try {
					validated = await call("validate", receiptDigest!);
				} catch {
					return unavailable(
						requestId,
						controller.signal.aborted ? "timeout" : "carrier_expired",
					);
				}
				if (validated.status !== 204) {
					let body: Buffer = Buffer.alloc(0);
					try {
						body = await readBounded(
							validated,
							MAX_FAILURE_BYTES,
							controller.signal,
						);
					} catch {}
					return unavailable(requestId, responseFailureReason(body));
				}
				const meta = {
					deliveryId: input.deliveryId,
					messageId: delivery[1],
					originChannelId: response.headers.get("x-flywheel-source-channel-id"),
					attachmentId: input.attachmentId,
					mimeType,
					bytes: data.length,
					sha256: sha,
					requestId,
					contentState: "supplied",
				};
				const result: LeadAttachmentReadResult = {
					content: [{ type: "text", text: JSON.stringify(meta) }, content],
				};
				if (Buffer.byteLength(JSON.stringify(result)) > MAX_MCP_FRAME_BYTES)
					return unavailable(requestId, "too_large");
				return result;
			} finally {
				clearTimeout(timer);
				active--;
			}
		},
	};
}
