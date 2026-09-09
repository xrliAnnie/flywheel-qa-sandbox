import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDiscordMailboxStrategy } from "../../lead-backends/codex/CodexDiscordMailboxStrategy.js";
import { FileInboundCursorStore } from "../../lead-backends/codex/InboundCursorStore.js";
import { RestPollDiscordInboundSource } from "../../lead-backends/codex/RestPollDiscordInboundSource.js";

interface RawMessage {
	id: string;
	channel_id: string;
	content: string;
	timestamp: string;
	author: { id: string; bot: boolean };
	attachments?: Array<{
		filename: string;
		content_type?: string;
		size: number;
	}>;
}

const roots: string[] = [];
const queues: MailboxQueue[] = [];

afterEach(() => {
	queues.splice(0).forEach((queue) => queue.close());
	roots
		.splice(0)
		.forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "fly2445-raya-standard-"));
	roots.push(root);
	return root;
}

function discordFetch(
	botUserId: string,
	channels: Record<string, RawMessage[]>,
): typeof fetch {
	return vi.fn(async (url: string) => {
		const parsed = new URL(url);
		if (parsed.pathname.endsWith("/users/@me")) {
			return response(200, { id: botUserId });
		}
		const channelId = parsed.pathname.split("/")[4] ?? "";
		const after = parsed.searchParams.get("after") ?? undefined;
		const limit = Number(parsed.searchParams.get("limit") ?? "50");
		const log = channels[channelId] ?? [];
		const offset = after
			? Math.max(0, log.findIndex((message) => message.id === after) + 1)
			: Math.max(0, log.length - limit);
		const page = log.slice(offset, offset + limit);
		return response(200, [...page].reverse());
	}) as unknown as typeof fetch;
}

function response(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as unknown as Response;
}

function message(
	id: string,
	channelId: string,
	content: string,
	attachments: RawMessage["attachments"] = [],
): RawMessage {
	return {
		id,
		channel_id: channelId,
		content,
		timestamp: "2026-09-08T20:00:00.000Z",
		author: { id: "100000000000000001", bot: false },
		attachments,
	};
}

function wireMailbox(input: {
	root: string;
	leadId: string;
	channelId: string;
	botUserId: string;
	log: RawMessage[];
	seed: string;
}) {
	const dbPath = join(input.root, "comm.db");
	const cursorPath = join(input.root, "inbound-cursor.json");
	const queue = new MailboxQueue(dbPath);
	queues.push(queue);
	const cursorStore = new FileInboundCursorStore(cursorPath);
	cursorStore.save(input.channelId, input.seed);
	const strategy = new CodexDiscordMailboxStrategy({
		leadId: input.leadId,
		dbPath,
		queue,
		journal: { getByIdempotencyKey: () => undefined },
		router: { submit: vi.fn() },
		externalReceiptSaga: { complete: vi.fn() },
		mailboxReady: () => true,
	});
	let accepted = 0;
	const source = new RestPollDiscordInboundSource({
		botToken: `token-${input.leadId}`,
		channelIds: [input.channelId],
		fetchImpl: discordFetch(input.botUserId, {
			[input.channelId]: input.log,
		}),
		cursorStore,
		limit: 2,
		setTimer: () => ({ cancel: () => {} }),
	});
	source.onMessage((inbound) => {
		accepted += 1;
		return (
			strategy.accept({
				message: inbound,
				payload: inbound.content,
				createdAt: new Date(inbound.timestampMs ?? 0).toISOString(),
			}) !== "retry"
		);
	});
	return { queue, cursorPath, cursorStore, source, accepted: () => accepted };
}

describe("FLY-2445 Raya standard Lead migration chain", () => {
	it("drains a multi-page cutover window into isolated mailboxes and restart does not replay", async () => {
		const rayaChannel = "200000000000000001";
		const mufasaChannel = "200000000000000002";
		const rayaSeed = "300000000000000001";
		const mufasaSeed = "400000000000000001";
		const rayaLog = [
			message(rayaSeed, rayaChannel, "seed"),
			message("300000000000000002", rayaChannel, "window one"),
			message("300000000000000003", rayaChannel, "window two", [
				{ filename: "evidence.png", content_type: "image/png", size: 1536 },
			]),
			message("300000000000000004", rayaChannel, "window three"),
			message("300000000000000005", rayaChannel, "window four"),
			message("300000000000000006", rayaChannel, "window five"),
		];
		const mufasaLog = [
			message(mufasaSeed, mufasaChannel, "seed"),
			message("400000000000000002", mufasaChannel, "growth only"),
		];
		const raya = wireMailbox({
			root: fixtureRoot(),
			leadId: "raya",
			channelId: rayaChannel,
			botUserId: "500000000000000001",
			log: rayaLog,
			seed: rayaSeed,
		});
		const mufasa = wireMailbox({
			root: fixtureRoot(),
			leadId: "mufasa-lead",
			channelId: mufasaChannel,
			botUserId: "500000000000000002",
			log: mufasaLog,
			seed: mufasaSeed,
		});

		await raya.source.assertAuthenticatedBotUser("500000000000000001");
		await mufasa.source.assertAuthenticatedBotUser("500000000000000002");
		await Promise.all([raya.source.start(), mufasa.source.start()]);

		expect(raya.accepted()).toBe(5);
		expect(mufasa.accepted()).toBe(1);
		expect(raya.cursorStore.load(rayaChannel)).toBe("300000000000000006");
		expect(mufasa.cursorStore.load(mufasaChannel)).toBe("400000000000000002");
		expect(raya.queue.getById("chat:raya:400000000000000002")).toBeUndefined();
		expect(
			raya.queue.getById("chat:raya:300000000000000003")?.delivery_content,
		).toContain(
			'<attachment name="evidence.png" type="image/png" size_kb="1.5" />',
		);

		const restart = wireMailbox({
			root: join(raya.cursorPath, ".."),
			leadId: "raya",
			channelId: rayaChannel,
			botUserId: "500000000000000001",
			log: rayaLog,
			seed: "300000000000000006",
		});
		await restart.source.start();
		expect(restart.accepted()).toBe(0);
	});

	it("delivers a post-cutover summary as a durable Raya receipt", async () => {
		const channelId = "200000000000000003";
		const seed = "600000000000000001";
		const log = [
			message(seed, channelId, "seed"),
			message(
				"600000000000000002",
				channelId,
				"summary round-42 PR 123 ready for absorption",
			),
		];
		const raya = wireMailbox({
			root: fixtureRoot(),
			leadId: "raya",
			channelId,
			botUserId: "500000000000000001",
			log,
			seed,
		});

		await raya.source.start();
		const receipt = raya.queue.getById("chat:raya:600000000000000002");
		expect(receipt).toMatchObject({
			state: "QUEUED",
			to_agent: "raya",
			type: "discord_chat",
		});
		expect(receipt?.content).toContain("summary round-42 PR 123");
	});
});
