import { createHash } from "node:crypto";
import { z } from "zod";

export const MAX_ATTACHMENT_UPLOAD_BYTES = 250 * 1024 * 1024 + 65536 + 4;
const invalid = () => new Error("attachment_upload_invalid");
const metadata = z
	.object({
		envelope: z.unknown(),
		files: z
			.array(
				z
					.object({
						handle: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/),
						mimeType: z.enum([
							"image/png",
							"image/jpeg",
							"image/webp",
							"application/pdf",
							"text/html",
							"text/plain",
							"application/json",
							"application/octet-stream",
						]),
						size: z
							.number()
							.int()
							.min(1)
							.max(25 * 1024 * 1024),
						sha256: z.string().regex(/^[a-f0-9]{64}$/),
					})
					.strict(),
			)
			.min(1)
			.max(10),
	})
	.strict();
export interface AttachmentUploadFile {
	handle: string;
	mimeType: string;
	data: Buffer;
}
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
/** Internal authenticated parent-to-Bridge framing: bounded JSON header, then exact raw bytes. */
export function encodeAttachmentUpload(
	envelope: unknown,
	files: readonly AttachmentUploadFile[],
): Buffer {
	try {
		const value = metadata.parse({
			envelope,
			files: files.map((f) => ({
				handle: f.handle,
				mimeType: f.mimeType,
				size: f.data.length,
				sha256: hash(f.data),
			})),
		});
		const header = Buffer.from(JSON.stringify(value));
		if (header.length > 65536) throw invalid();
		const length = Buffer.alloc(4);
		length.writeUInt32BE(header.length);
		return Buffer.concat([length, header, ...files.map((f) => f.data)]);
	} catch {
		throw invalid();
	}
}
export function decodeAttachmentUpload(data: Buffer): {
	envelope: unknown;
	files: AttachmentUploadFile[];
} {
	try {
		if (
			!Buffer.isBuffer(data) ||
			data.length < 4 ||
			data.length > MAX_ATTACHMENT_UPLOAD_BYTES
		)
			throw invalid();
		const headerLength = data.readUInt32BE(0);
		if (
			headerLength < 1 ||
			headerLength > 65536 ||
			headerLength + 4 > data.length
		)
			throw invalid();
		const header = metadata.parse(
			JSON.parse(
				new TextDecoder("utf8", { fatal: true }).decode(
					data.subarray(4, 4 + headerLength),
				),
			),
		);
		let offset = 4 + headerLength;
		if (
			offset + header.files.reduce((sum, f) => sum + f.size, 0) !==
			data.length
		)
			throw invalid();
		const files = header.files.map((f) => {
			const bytes = data.subarray(offset, offset + f.size);
			offset += f.size;
			if (hash(bytes) !== f.sha256) throw invalid();
			return { handle: f.handle, mimeType: f.mimeType, data: bytes };
		});
		return { envelope: header.envelope, files };
	} catch {
		throw invalid();
	}
}
