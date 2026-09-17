import { expect, it, vi } from "vitest";
import { createXhsAuthorityReadHandlers } from "../handlers/xiaohongshu-authority-read.js";

vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({ assertActivationCurrent() {} }),
}));
const env = { FLYWHEEL_PROJECT_NAME: "demo", FLYWHEEL_LEAD_ID: "eng" };
const context = {
	projectName: "demo",
	leadId: "eng",
	activationId: "a1",
	requestId: "request-a",
	signal: new AbortController().signal,
	assertCurrent: async () => {},
};
it("preserves authority handles and returns the existing untrusted read receipt without MCP fallback", async () => {
	const text = JSON.stringify({
		feeds: [
			{ id: "feed-a", resourceHandle: "00000000-0000-4000-8000-000000000001" },
		],
		count: 1,
	});
	const call = vi.fn().mockResolvedValue({ text });
	const handlers = createXhsAuthorityReadHandlers({
		env,
		activationId: "a1",
		client: { call },
		secrets: [],
	});
	expect([...handlers.keys()]).toContain("xiaohongshu.list_feeds");
	const handler = handlers.get("xiaohongshu.list_feeds")!;
	expect(await handler.execute({}, context)).toMatchObject({
		status: "succeeded",
		data: {
			result: { content: [{ type: "text", text }] },
			untrusted: true,
			receiptId: "request-a",
		},
	});
	expect(call).toHaveBeenCalledWith("list_feeds", {}, context.signal);
	call.mockRejectedValue(Error("private-cookie"));
	expect(await handler.execute({}, context)).toEqual({ status: "unknown" });
	expect(call).toHaveBeenCalledTimes(2);
});
it("keeps the legacy handler map when no authority exists and rejects changed scope or secret output", async () => {
	expect(
		createXhsAuthorityReadHandlers({
			env,
			activationId: "a1",
			client: null,
			secrets: [],
		}).size,
	).toBe(0);
	const call = vi.fn().mockResolvedValue({ text: "SYNTHETIC_SECRET" });
	const handler = createXhsAuthorityReadHandlers({
		env,
		activationId: "a1",
		client: { call },
		secrets: ["SYNTHETIC_SECRET"],
	}).get("xiaohongshu.list_feeds")!;
	expect(
		await handler.execute({}, { ...context, activationId: "other" }),
	).toEqual({ status: "unknown" });
	expect(call).not.toHaveBeenCalled();
	expect(await handler.execute({}, context)).toEqual({ status: "unknown" });
	call.mockImplementation(async () => {
		return { text: "{}", cookie: "private" };
	});
	expect(await handler.execute({}, context)).toEqual({ status: "unknown" });
});

it("forwards list and detail operations with validated input and no authority-error fallback", async () => {
	const call = vi.fn().mockResolvedValue({ text: "{}" });
	const handlers = createXhsAuthorityReadHandlers({
		env,
		activationId: "a1",
		client: { call },
		secrets: [],
	});
	expect(handlers.size).toBe(8);
	for (const [action, input] of [
		["search_feeds", { keyword: "query" }],
		["list_saved_content", {}],
		["list_collections", {}],
		["get_collection_content", { collection_id: "collection-a" }],
		[
			"get_feed_detail",
			{
				feed_id: "feed-a",
				resourceHandle: "00000000-0000-4000-8000-000000000001",
			},
		],
	] as const) {
		const handler = handlers.get(`xiaohongshu.${action}`)!;
		expect(await handler.execute(input, context)).toMatchObject({
			status: "succeeded",
		});
		expect(call).toHaveBeenLastCalledWith(action, input, context.signal);
		const count = call.mock.calls.length;
		expect(
			await handler.execute({ ...input, xsec_token: "forged" }, context),
		).toEqual({ status: "unknown" });
		expect(call).toHaveBeenCalledTimes(count);
	}
});

it("renders authority QR as image content and status as text without private metadata", async () => {
	const image =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==";
	const expiresAt = Date.now() + 60000;
	const call = vi.fn().mockResolvedValue({ loggedIn: false, image, expiresAt });
	const handlers = createXhsAuthorityReadHandlers({
		env,
		activationId: "a1",
		client: { call },
		secrets: [],
	});
	const qr = handlers.get("xiaohongshu.get_login_qrcode")!;
	expect(await qr.execute({}, context)).toMatchObject({
		status: "succeeded",
		data: {
			untrusted: true,
			result: {
				content: [
					{
						type: "text",
						text: JSON.stringify({ loggedIn: false, expiresAt }),
					},
					{ type: "image", mimeType: "image/png", data: image.split(",")[1] },
				],
			},
		},
	});
	call.mockResolvedValue({ loggedIn: false });
	expect(
		await handlers.get("xiaohongshu.check_login_status")!.execute({}, context),
	).toMatchObject({
		status: "succeeded",
		data: {
			result: { content: [{ type: "text", text: '{"loggedIn":false}' }] },
		},
	});
	call.mockResolvedValue({
		loggedIn: false,
		image: "https://unsafe.test/qr",
		expiresAt,
	});
	expect(await qr.execute({}, context)).toEqual({ status: "unknown" });
});
