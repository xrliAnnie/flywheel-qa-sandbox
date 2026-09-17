import { expect, it } from "vitest";
import {
	ATTACHMENT_HARD_LIMIT,
	measureAttachmentLimit,
} from "../attachment-probe.js";
import { DiscordXhsSource } from "../discord-source.js";
import { reviewFile } from "../preview.js";

const policy = {
	guildId: "12345678901234567",
	channelId: "12345678901234568",
	botId: "12345678901234569",
	userChannelIds: ["12345678901234570"],
};
it.each([0, 11])(
	"runs the real Discord adapter probe protocol on dedicated channel type %s with credential-free CDN reads",
	async (type) => {
		const messageId = "12345678901234571",
			attachmentId = "12345678901234572";
		const api = `https://discord.com/api/v10/channels/${policy.channelId}`;
		const cdn =
			"https://cdn.discordapp.com/attachments/" +
			policy.channelId +
			"/" +
			attachmentId +
			"/xhs-attachment-probe.bin";
		let data = Buffer.alloc(0),
			content = "";
		const calls: string[] = [];
		const json = (value: unknown) =>
			new Response(JSON.stringify(value), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		const fetcher = async (url: string, init: RequestInit) => {
			calls.push(`${init.method ?? "GET"} ${url}`);
			expect(init.redirect).toBe("error");
			const headers = new Headers(init.headers);
			if (url === cdn) {
				expect(headers.has("Authorization")).toBe(false);
				return new Response(new Uint8Array(data));
			}
			expect(headers.get("Authorization")).toBe("Bot private-fixture-token");
			if (url === api)
				return json({ id: policy.channelId, guild_id: policy.guildId, type });
			if (url === `${api}/messages` && init.method === "POST") {
				const form = init.body as FormData,
					payload = JSON.parse(String(form.get("payload_json")));
				expect(payload.allowed_mentions).toEqual({
					parse: [],
					replied_user: false,
				});
				expect(payload.attachments).toEqual([
					{ id: 0, filename: "xhs-attachment-probe.bin" },
				]);
				const file = form.get("files[0]") as File;
				data = Buffer.from(await file.arrayBuffer());
				content = payload.content;
				expect(data.length).toBe(ATTACHMENT_HARD_LIMIT);
				return json({ id: messageId, channel_id: policy.channelId });
			}
			if (url === `${api}/messages/${messageId}`) {
				if (init.method === "DELETE")
					return new Response(null, { status: 204 });
				return json({
					id: messageId,
					channel_id: policy.channelId,
					author: { id: policy.botId },
					content,
					attachments: [
						{
							id: attachmentId,
							filename: "xhs-attachment-probe.bin",
							size: data.length,
							url: cdn,
						},
					],
				});
			}
			throw Error("unexpected fake HTTP");
		};
		const source = new DiscordXhsSource({
			channelId: policy.channelId,
			token: "private-fixture-token",
			fetch: fetcher,
			purpose: "probe",
		});
		const proof = await measureAttachmentLimit({
			policy,
			source,
			now: () => 1789470000000,
		});
		expect(proof).toMatchObject({
			guildId: policy.guildId,
			channelId: policy.channelId,
			measuredBytes: ATTACHMENT_HARD_LIMIT,
		});
		expect(calls).toEqual([
			`GET ${api}`,
			`POST ${api}/messages`,
			`GET ${api}/messages/${messageId}`,
			`GET ${cdn}`,
			`GET ${api}`,
			`DELETE ${api}/messages/${messageId}`,
		]);
		const before = calls.length;
		await expect(
			source.send("review", [reviewFile("review.txt", Buffer.from("x"))], {
				parse: [],
			}),
		).rejects.toThrow("preview_delivery_failed");
		expect(calls).toHaveLength(before);
		const review = new DiscordXhsSource({
			channelId: policy.channelId,
			token: "private-fixture-token",
			fetch: fetcher,
		});
		await expect(
			review.send(
				"probe",
				[reviewFile("xhs-attachment-probe.bin", Buffer.alloc(1))],
				{ parse: [] },
			),
		).rejects.toThrow("preview_delivery_failed");
		expect(calls).toHaveLength(before);
	},
);
