import { expect, it, vi } from "vitest";
import {
	ATTACHMENT_HARD_LIMIT,
	effectiveAttachmentLimit,
	measureAttachmentLimit,
} from "../attachment-probe.js";
import type { ReviewFile } from "../preview.js";

const now = 1789470000000;
const policy = {
	guildId: "12345678901234567",
	channelId: "12345678901234568",
	botId: "12345678901234569",
	userChannelIds: ["12345678901234570"],
};
function setup() {
	let file: ReviewFile, content: string;
	const source = {
		channelGuild: vi.fn(async () => policy.guildId),
		send: vi.fn(
			async (text: string, files: ReviewFile[], mentions: unknown) => {
				expect(mentions).toEqual({ parse: [] });
				content = text;
				file = files[0]!;
				return "12345678901234571";
			},
		),
		fetch: vi.fn(async () => ({
			id: "12345678901234571",
			channelId: policy.channelId,
			authorId: policy.botId,
			content,
			attachments: [
				{ id: "12345678901234572", name: file.name, size: file.bytes.length },
			],
		})),
		readAttachment: vi.fn(async () => file.bytes),
		remove: vi.fn(async () => {}),
	};
	return source;
}
it("measures the hard ceiling only on a designated non-user channel and returns proof after deletion", async () => {
	const source = setup();
	const proof = await measureAttachmentLimit({
		policy,
		source,
		now: () => now,
	});
	expect(proof).toMatchObject({
		guildId: policy.guildId,
		channelId: policy.channelId,
		botId: policy.botId,
		measuredBytes: 10 * 1024 * 1024,
		probedAt: now,
		expiresAt: now + 86400_000,
	});
	expect(source.remove).toHaveBeenCalledWith("12345678901234571");
	expect(effectiveAttachmentLimit(proof, policy, now + 1)).toBe(
		ATTACHMENT_HARD_LIMIT,
	);
	const calls = source.send.mock.calls.length;
	expect(
		await measureAttachmentLimit({
			policy: { ...policy, channelId: policy.userChannelIds[0]! },
			source,
			now: () => now,
		}),
	).toBeNull();
	expect(source.send).toHaveBeenCalledTimes(calls);
});
it.each(["guild", "bytes", "delete"] as const)(
	"does not issue proof after %s failure",
	async (mode) => {
		const source = setup();
		if (mode === "guild")
			source.channelGuild.mockResolvedValue("22345678901234567");
		if (mode === "bytes")
			source.readAttachment.mockResolvedValue(Buffer.from("wrong"));
		if (mode === "delete")
			source.remove.mockRejectedValue(Error("private details"));
		expect(
			await measureAttachmentLimit({ policy, source, now: () => now }),
		).toBeNull();
		if (mode === "guild") expect(source.send).not.toHaveBeenCalled();
		else expect(source.remove).toHaveBeenCalledOnce();
	},
);
it("falls back for missing, expired, altered binding or inflated receipts and only accepts a lower bound", async () => {
	const proof = await measureAttachmentLimit({
		policy,
		source: setup(),
		now: () => now,
	});
	for (const value of [
		null,
		{ ...proof, expiresAt: now },
		{ ...proof, guildId: "22345678901234567" },
		{ ...proof, measuredBytes: ATTACHMENT_HARD_LIMIT + 1 },
		{ ...proof, expiresAt: now + 30 * 86400_000 },
	])
		expect(effectiveAttachmentLimit(value, policy, now + 1)).toBe(
			ATTACHMENT_HARD_LIMIT,
		);
	expect(
		effectiveAttachmentLimit(
			{ ...proof, measuredBytes: 1024 },
			policy,
			now + 1,
		),
	).toBe(1024);
});
