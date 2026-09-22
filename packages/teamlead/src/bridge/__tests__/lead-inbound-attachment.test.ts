import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { createLeadAttachmentReader } from "../../lead-backends/codex/lead-actions/attachment-read.js";
import {
	DiscordInboundAttachmentError,
	type DiscordInboundAttachmentFailureReason,
} from "../../lead-capabilities/discord-attachments.js";
import {
	createLeadInboundAttachmentRouter,
	type InboundAttachmentScopeFactory,
} from "../lead-inbound-attachment.js";

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
});

const request = {
	schemaVersion: 1,
	mode: "read" as const,
	requestId: "123e4567-e89b-42d3-a456-426614174000",
	projectName: "flywheel",
	leadId: "raya",
	identityDigest: "a".repeat(64),
	carrierClaim: "raw-claim",
	deliveryId: "chat:raya:444444444444444444",
	attachmentId: "333333333333333333",
};

function fixture(mimeType = "text/plain;charset=utf-8") {
	const state = { current: true };
	const assertCurrent = vi.fn(async () => {
		if (!state.current)
			throw new DiscordInboundAttachmentError("carrier_expired");
	});
	const captureScope = vi.fn<InboundAttachmentScopeFactory>(async () => ({
		attachment: {
			attachmentId: request.attachmentId,
			name: "note.txt",
			type: mimeType,
			sizeKb: 5 / 1024,
		},
		messageId: "444444444444444444",
		originChannelId: "111111111111111111",
		botToken: "BOT_TOKEN",
		carrierInstanceDigest: "c".repeat(64),
		receiptDigest: "d".repeat(64),
		assertCurrent,
	}));
	const fetchAttachment = vi.fn(async () => ({
		data: Buffer.from("hello"),
		mimeType,
	}));
	const app = express();
	app.use(express.json());
	app.use(
		"/api/lead-inbound/attachment",
		createLeadInboundAttachmentRouter({
			apiToken: "API_TOKEN",
			projectsPath: "/unused/projects.json",
			homeDir: "/unused",
			captureScope,
			fetchAttachment,
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	servers.push(server);
	return new Promise<{
		url: string;
		state: typeof state;
		captureScope: typeof captureScope;
		fetchAttachment: typeof fetchAttachment;
		assertCurrent: typeof assertCurrent;
	}>((resolve) => {
		server.once("listening", () => {
			const address = server.address() as { port: number };
			resolve({
				url: `http://127.0.0.1:${address.port}/api/lead-inbound/attachment`,
				state,
				captureScope,
				fetchAttachment,
				assertCurrent,
			});
		});
	});
}

async function post(url: string, body: unknown = request, token = "API_TOKEN") {
	return fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	});
}

it("returns exact bounded bytes with receipt and source identity headers", async () => {
	const f = await fixture();
	const response = await post(f.url);
	expect(response.status).toBe(200);
	expect(Buffer.from(await response.arrayBuffer()).toString("utf8")).toBe(
		"hello",
	);
	expect(response.headers.get("content-type")).toBe("text/plain;charset=utf-8");
	expect(response.headers.get("x-flywheel-request-id")).toBe(request.requestId);
	expect(response.headers.get("x-flywheel-source-message-id")).toBe(
		"444444444444444444",
	);
	expect(response.headers.get("x-flywheel-source-channel-id")).toBe(
		"111111111111111111",
	);
	expect(response.headers.get("x-flywheel-attachment-id")).toBe(
		request.attachmentId,
	);
	expect(response.headers.get("x-flywheel-bytes")).toBe("5");
	expect(response.headers.get("x-flywheel-sha256")).toBe(
		"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
	);
	expect(response.headers.get("x-flywheel-receipt-digest")).toBe(
		"d".repeat(64),
	);
	expect(f.fetchAttachment).toHaveBeenCalledWith(
		expect.objectContaining({
			threadId: "111111111111111111",
			messageId: "444444444444444444",
			attachmentId: request.attachmentId,
			expected: {
				mimeType: "text/plain;charset=utf-8",
				sizeBytes: 5,
			},
		}),
	);
	expect(f.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it("delivers bare text/plain through the real router and reader", async () => {
	const f = await fixture("text/plain");
	const reader = createLeadAttachmentReader({
		context: {
			projectsPath: "/unused/projects.json",
			projectName: "flywheel",
			leadId: "raya",
			identityDigest: "a".repeat(64),
		},
		bridgeUrl: new URL(f.url).origin,
		apiToken: "API_TOKEN",
		carrierClaim: "raw-claim",
		requestId: () => request.requestId,
	});
	const result = await reader.read({
		deliveryId: request.deliveryId,
		attachmentId: request.attachmentId,
	});
	expect(result.isError).not.toBe(true);
	expect(result.content[1]).toEqual({ type: "text", text: "hello" });
});

it("requires the API bearer, strict request shape, and independent scope proof", async () => {
	const f = await fixture();
	expect((await post(f.url, request, "wrong")).status).toBe(401);
	expect((await post(f.url, { ...request, extra: true })).status).toBe(400);
	f.captureScope.mockRejectedValueOnce(
		new DiscordInboundAttachmentError("scope_denied"),
	);
	const denied = await post(f.url);
	expect(denied.status).toBe(403);
	expect(await denied.json()).toEqual({
		requestId: request.requestId,
		contentState: "unavailable",
		reason: "scope_denied",
	});
});

it("validates the same carrier and receipt without downloading again", async () => {
	const f = await fixture();
	const response = await post(f.url, {
		...request,
		mode: "validate",
		receiptDigest: "d".repeat(64),
	});
	expect(response.status).toBe(204);
	expect(f.fetchAttachment).not.toHaveBeenCalled();
	const mismatch = await post(f.url, {
		...request,
		mode: "validate",
		receiptDigest: "e".repeat(64),
	});
	expect(mismatch.status).toBe(403);
	expect(await mismatch.json()).toMatchObject({ reason: "scope_denied" });
});

it("does not release downloaded bytes after carrier generation drift", async () => {
	const f = await fixture();
	f.fetchAttachment.mockImplementationOnce(async () => {
		f.state.current = false;
		return {
			data: Buffer.from("private"),
			mimeType: "text/plain;charset=utf-8",
		};
	});
	const response = await post(f.url);
	expect(response.status).toBe(403);
	expect(await response.text()).not.toContain("private");
});

it.each<DiscordInboundAttachmentFailureReason>([
	"producer_identity_missing",
	"invalid_metadata",
	"unsupported_type",
	"too_large",
	"not_found",
	"fetch_unavailable",
	"timeout",
	"invalid_content",
	"carrier_expired",
])("returns a bounded typed %s failure", async (reason) => {
	const f = await fixture();
	f.fetchAttachment.mockRejectedValueOnce(
		new DiscordInboundAttachmentError(reason),
	);
	const response = await post(f.url);
	expect([403, 404, 408, 413, 415, 422, 503]).toContain(response.status);
	expect(await response.json()).toEqual({
		requestId: request.requestId,
		contentState: "unavailable",
		reason,
	});
});

it("fails the third concurrent request for one carrier without queuing it", async () => {
	const f = await fixture();
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.fetchAttachment.mockImplementation(async () => {
		await blocked;
		return {
			data: Buffer.from("hello"),
			mimeType: "text/plain;charset=utf-8",
		};
	});
	const first = post(f.url, { ...request, requestId: randomUUID() });
	const second = post(f.url, { ...request, requestId: randomUUID() });
	while (f.fetchAttachment.mock.calls.length < 2)
		await new Promise((resolve) => setTimeout(resolve, 1));
	const third = await post(f.url, {
		...request,
		requestId: randomUUID(),
	});
	expect(third.status).toBe(503);
	expect(await third.json()).toMatchObject({ reason: "busy" });
	release();
	expect((await first).status).toBe(200);
	expect((await second).status).toBe(200);
});
