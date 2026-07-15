/**
 * FLY-203: postDiscordMessageWithFile unit tests — mocked fetch, buffer input
 * (the route layer owns file reading via a pinned fd; this helper never
 * touches the filesystem — code review R1#2).
 */

import { describe, expect, it, vi } from "vitest";
import { postDiscordMessageWithFile } from "../bridge/discord-post-file.js";

const PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const FILE = { data: PNG_BUFFER, filename: "report-preview.png" };

describe("postDiscordMessageWithFile", () => {
	it("posts multipart with payload_json (allowed_mentions off) + file part", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }),
			);

		const result = await postDiscordMessageWithFile(
			"chan_1",
			"📊 **Title** · proj\n<https://x.vercel.app/r/t/>",
			FILE,
			"bot-token",
			fetchMock as unknown as typeof fetch,
		);

		expect(result).toEqual({ ok: true, messageId: "msg_1" });
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://discord.com/api/v10/channels/chan_1/messages");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bot bot-token",
		);
		// no manual Content-Type — fetch must set the multipart boundary
		expect(
			Object.keys(init.headers as Record<string, string>).map((k) =>
				k.toLowerCase(),
			),
		).not.toContain("content-type");

		const form = init.body as FormData;
		expect(form).toBeInstanceOf(FormData);
		const payload = JSON.parse(form.get("payload_json") as string);
		expect(payload.content).toMatch(/^🤖\[自动\] /);
		expect(payload.content).toContain("📊 **Title**");
		expect(payload.allowed_mentions).toEqual({ parse: [] });
		expect(payload.attachments).toEqual([
			{ id: 0, filename: "report-preview.png" },
		]);
		const file = form.get("files[0]") as File;
		expect(file).toBeTruthy();
		expect(file.name).toBe("report-preview.png");
		expect(file.size).toBe(PNG_BUFFER.length);
	});

	it("returns error envelope on non-2xx", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
		const result = await postDiscordMessageWithFile(
			"c",
			"m",
			FILE,
			"t",
			fetchMock as unknown as typeof fetch,
		);
		expect(result).toEqual({ ok: false, error: "Discord 403: forbidden" });
	});

	it("returns error envelope on network failure", async () => {
		const fetchMock = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET"));
		const result = await postDiscordMessageWithFile(
			"c",
			"m",
			FILE,
			"t",
			fetchMock as unknown as typeof fetch,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("ECONNRESET");
	});

	it("returns error envelope when response lacks message id", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
		const result = await postDiscordMessageWithFile(
			"c",
			"m",
			FILE,
			"t",
			fetchMock as unknown as typeof fetch,
		);
		expect(result).toEqual({
			ok: false,
			error: "Discord response missing message id",
		});
	});
});
