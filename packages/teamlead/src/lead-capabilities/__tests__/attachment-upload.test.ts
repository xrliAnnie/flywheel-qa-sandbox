import { expect, it } from "vitest";
import {
	decodeAttachmentUpload,
	encodeAttachmentUpload,
} from "../attachment-upload.js";

it("round trips a bounded envelope and exact binary files, rejecting modified or trailing bytes", () => {
	const files = [
		{
			handle: "a",
			data: Buffer.from([0, 255, 1]),
			mimeType: "application/octet-stream",
		},
	];
	const encoded = encodeAttachmentUpload({ requestId: "request" }, files);
	const decoded = decodeAttachmentUpload(encoded);
	expect(decoded.envelope).toEqual({ requestId: "request" });
	expect(decoded.files).toEqual(files);
	const modified = Buffer.from(encoded);
	modified[modified.length - 1] ^= 1;
	for (const data of [
		modified,
		encoded.subarray(0, encoded.length - 1),
		Buffer.concat([encoded, Buffer.from("extra")]),
		Buffer.alloc(4, 255),
	])
		expect(() => decodeAttachmentUpload(data)).toThrow(
			"attachment_upload_invalid",
		);
});
it("rejects missing files, excessive headers and inconsistent declared budgets", () => {
	expect(() => encodeAttachmentUpload({}, [])).toThrow();
	expect(() =>
		encodeAttachmentUpload({ value: "x".repeat(65536) }, [
			{ handle: "a", data: Buffer.from("x"), mimeType: "text/plain" },
		]),
	).toThrow();
	const header = Buffer.from(
		JSON.stringify({
			envelope: {},
			files: [
				{
					handle: "a",
					mimeType: "text/plain",
					size: 26214401,
					sha256: "a".repeat(64),
				},
			],
		}),
	);
	const prefix = Buffer.alloc(4);
	prefix.writeUInt32BE(header.length);
	expect(() =>
		decodeAttachmentUpload(Buffer.concat([prefix, header])),
	).toThrow();
});
