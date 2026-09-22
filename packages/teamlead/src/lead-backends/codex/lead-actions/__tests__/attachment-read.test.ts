import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
	createLeadAttachmentReader,
	type LeadAttachmentReadResult,
} from "../attachment-read.js";

const context = {
	projectsPath: "/registry/projects.json",
	projectName: "raya",
	leadId: "raya",
	identityDigest: "a".repeat(64),
};
const deliveryId = "chat:raya:444444444444444444";
const attachmentId = "333333333333333333";
const requestId = "123e4567-e89b-42d3-a456-426614174000";

function successResponse(
	data: Buffer,
	mimeType: string,
	overrides: Record<string, string> = {},
) {
	return new Response(data, {
		headers: {
			"content-type": mimeType,
			"content-length": String(data.length),
			"x-flywheel-request-id": requestId,
			"x-flywheel-source-message-id": "444444444444444444",
			"x-flywheel-source-channel-id": "111111111111111111",
			"x-flywheel-attachment-id": attachmentId,
			"x-flywheel-mime-type": mimeType,
			"x-flywheel-bytes": String(data.length),
			"x-flywheel-sha256": createHash("sha256").update(data).digest("hex"),
			"x-flywheel-receipt-digest": "d".repeat(64),
			...overrides,
		},
	});
}

function fixture(
	data = Buffer.from("marker-中文\nsecond line"),
	mimeType = "text/plain;charset=utf-8",
) {
	const bodies: Record<string, unknown>[] = [];
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		bodies.push(body);
		return body.mode === "validate"
			? new Response(null, { status: 204 })
			: successResponse(data, mimeType);
	});
	const reader = createLeadAttachmentReader({
		context,
		bridgeUrl: "http://127.0.0.1:9876",
		apiToken: "PRIVATE_API_TOKEN",
		carrierClaim: "PRIVATE_CARRIER_CLAIM",
		fetchImpl,
		requestId: () => requestId,
	});
	return { reader, fetchImpl, bodies, data };
}

function metadata(result: LeadAttachmentReadResult) {
	return JSON.parse(
		result.content[0]!.type === "text" ? result.content[0]!.text : "",
	) as Record<string, unknown>;
}

function png(width = 2, height = 3, bytes = 33) {
	const data = Buffer.alloc(bytes);
	Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(data);
	data.writeUInt32BE(width, 16);
	data.writeUInt32BE(height, 20);
	return data;
}

function jpeg(width = 3, height = 2) {
	const data = Buffer.alloc(21);
	data.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
	data.writeUInt16BE(height, 7);
	data.writeUInt16BE(width, 9);
	return data;
}

function webp(width = 3, height = 2) {
	const data = Buffer.alloc(30);
	data.write("RIFF", 0, "ascii");
	data.writeUInt32LE(data.length - 8, 4);
	data.write("WEBPVP8X", 8, "ascii");
	data.writeUInt32LE(10, 16);
	data.writeUIntLE(width - 1, 24, 3);
	data.writeUIntLE(height - 1, 27, 3);
	return data;
}

it("returns actual UTF-8 text only after the receipt validate round-trip", async () => {
	const f = fixture();
	const result = await f.reader.read({ deliveryId, attachmentId });
	expect(result.isError).not.toBe(true);
	expect(result.content).toEqual([
		{
			type: "text",
			text: expect.any(String),
		},
		{ type: "text", text: f.data.toString("utf8") },
	]);
	expect(metadata(result)).toMatchObject({
		deliveryId,
		messageId: "444444444444444444",
		originChannelId: "111111111111111111",
		attachmentId,
		mimeType: "text/plain;charset=utf-8",
		bytes: f.data.length,
		requestId,
		contentState: "supplied",
	});
	expect(f.bodies).toEqual([
		expect.objectContaining({
			schemaVersion: 1,
			mode: "read",
			projectName: "raya",
			leadId: "raya",
			identityDigest: "a".repeat(64),
			carrierClaim: "PRIVATE_CARRIER_CLAIM",
			deliveryId,
			attachmentId,
		}),
		expect.objectContaining({
			mode: "validate",
			receiptDigest: "d".repeat(64),
		}),
	]);
	expect(
		f.fetchImpl.mock.calls.every(
			(call) =>
				new Headers(call[1]?.headers).get("authorization") ===
				"Bearer PRIVATE_API_TOKEN",
		),
	).toBe(true);
});

it("returns a native MCP image block after PNG header and dimension validation", async () => {
	const image = png();
	const f = fixture(image, "image/png");
	const result = await f.reader.read({ deliveryId, attachmentId });
	expect(result.isError).not.toBe(true);
	expect(result.content[1]).toEqual({
		type: "image",
		data: image.toString("base64"),
		mimeType: "image/png",
	});
	expect(metadata(result)).toMatchObject({
		mimeType: "image/png",
		bytes: image.length,
	});
});

it.each([
	[jpeg(), "image/jpeg"],
	[webp(), "image/webp"],
])(
	"returns native JPEG/WebP blocks after bounded header validation",
	async (image, mimeType) => {
		const f = fixture(image, mimeType);
		const result = await f.reader.read({ deliveryId, attachmentId });
		expect(result.isError).not.toBe(true);
		expect(result.content[1]).toEqual({
			type: "image",
			data: image.toString("base64"),
			mimeType,
		});
	},
);

it("keeps a near-5 MiB native image response below the 7 MiB MCP frame cap", async () => {
	const image = png(4096, 1024, 5 * 1024 * 1024);
	const f = fixture(image, "image/png");
	const result = await f.reader.read({ deliveryId, attachmentId });
	expect(result.isError).not.toBe(true);
	expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
		7 * 1024 * 1024,
	);
});

it.each([
	[Buffer.from([0xff]), "text/plain;charset=utf-8"],
	[Buffer.from("before\0after"), "text/plain"],
	[Buffer.from("not-an-image"), "image/png"],
	[Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00]), "image/jpeg"],
	[Buffer.from("RIFF\0\0\0\0WEBPVP8X"), "image/webp"],
	[png(20_000, 2), "image/png"],
])(
	"rejects invalid text/image content before validate or MCP release",
	async (data, mimeType) => {
		const f = fixture(data, mimeType);
		const result = await f.reader.read({ deliveryId, attachmentId });
		expect(result.isError).toBe(true);
		expect(metadata(result)).toMatchObject({
			requestId,
			contentState: "unavailable",
			reason:
				mimeType.startsWith("image/") && data.length >= 24
					? "too_large"
					: "invalid_content",
		});
		expect(f.bodies).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain("PRIVATE_");
	},
);

it.each([
	["request id", { "x-flywheel-request-id": "wrong" }],
	["message id", { "x-flywheel-source-message-id": "999999999999999999" }],
	["channel id", { "x-flywheel-source-channel-id": "wrong" }],
	["attachment id", { "x-flywheel-attachment-id": "999999999999999999" }],
	["MIME", { "x-flywheel-mime-type": "image/png" }],
	["SHA", { "x-flywheel-sha256": "e".repeat(64) }],
	["receipt digest", { "x-flywheel-receipt-digest": "wrong" }],
])(
	"rejects malformed %s proof and never validates the mismatched receipt",
	async (_label, overrides) => {
		const f = fixture();
		f.fetchImpl.mockResolvedValueOnce(
			successResponse(f.data, "text/plain;charset=utf-8", overrides),
		);
		const result = await f.reader.read({ deliveryId, attachmentId });
		expect(result.isError).toBe(true);
		expect(metadata(result)).toMatchObject({ reason: "invalid_content" });
		expect(f.fetchImpl).toHaveBeenCalledOnce();
	},
);

it("rejects a body shorter than its mutually consistent length proofs", async () => {
	const f = fixture();
	const declared = String(f.data.length + 1);
	f.fetchImpl.mockResolvedValueOnce(
		successResponse(f.data, "text/plain;charset=utf-8", {
			"content-length": declared,
			"x-flywheel-bytes": declared,
		}),
	);
	const result = await f.reader.read({ deliveryId, attachmentId });
	expect(result.isError).toBe(true);
	expect(metadata(result)).toMatchObject({ reason: "invalid_content" });
	expect(f.fetchImpl).toHaveBeenCalledOnce();
});

it("preserves bounded Bridge failure reasons without provider bodies", async () => {
	const f = fixture();
	f.fetchImpl.mockResolvedValueOnce(
		Response.json(
			{
				requestId,
				contentState: "unavailable",
				reason: "too_large",
				providerBody: "PRIVATE_PROVIDER_BODY",
			},
			{ status: 413 },
		),
	);
	const result = await f.reader.read({ deliveryId, attachmentId });
	expect(result.isError).toBe(true);
	expect(metadata(result)).toEqual({
		requestId,
		contentState: "unavailable",
		reason: "too_large",
	});
	expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_BODY");
});

it("returns transport_unavailable in direct mode without making a request", async () => {
	const fetchImpl = vi.fn<typeof fetch>();
	const reader = createLeadAttachmentReader({
		fetchImpl,
		requestId: () => requestId,
	});
	const result = await reader.read({ deliveryId, attachmentId });
	expect(metadata(result)).toEqual({
		requestId,
		contentState: "unavailable",
		reason: "transport_unavailable",
	});
	expect(fetchImpl).not.toHaveBeenCalled();
});

it("fails the third concurrent read as busy instead of queueing private bytes", async () => {
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const f = fixture();
	f.fetchImpl.mockImplementation(async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as { mode: string };
		if (body.mode === "read") await blocked;
		return body.mode === "validate"
			? new Response(null, { status: 204 })
			: successResponse(f.data, "text/plain;charset=utf-8");
	});
	const first = f.reader.read({ deliveryId, attachmentId });
	const second = f.reader.read({ deliveryId, attachmentId });
	while (f.fetchImpl.mock.calls.length < 2)
		await new Promise((resolve) => setTimeout(resolve, 1));
	const third = await f.reader.read({ deliveryId, attachmentId });
	expect(metadata(third)).toMatchObject({ reason: "busy" });
	release();
	expect((await first).isError).not.toBe(true);
	expect((await second).isError).not.toBe(true);
});

it("aborts a fetch that never resolves at the 15 second end-to-end deadline", async () => {
	vi.useFakeTimers();
	try {
		const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
		const reader = createLeadAttachmentReader({
			context,
			bridgeUrl: "http://127.0.0.1:9876",
			apiToken: "PRIVATE_API_TOKEN",
			carrierClaim: "PRIVATE_CARRIER_CLAIM",
			fetchImpl,
			requestId: () => requestId,
		});
		const pending = reader.read({ deliveryId, attachmentId });
		await vi.advanceTimersByTimeAsync(15_000);
		expect(metadata(await pending)).toMatchObject({ reason: "timeout" });
	} finally {
		vi.useRealTimers();
	}
});

it("serves 1000 sequential reads without accumulating request state", async () => {
	const f = fixture(Buffer.from("steady"));
	for (let index = 0; index < 1_000; index++) {
		const result = await f.reader.read({ deliveryId, attachmentId });
		expect(result.isError).not.toBe(true);
	}
	expect(f.fetchImpl).toHaveBeenCalledTimes(2_000);
});
