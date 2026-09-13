import {
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileInboundCursorStore } from "../lead-backends/codex/InboundCursorStore.js";
import { RestPollDiscordInboundSource } from "../lead-backends/codex/RestPollDiscordInboundSource.js";
import { seedLeadInboundCursor } from "./seed-lead-inbound-cursor.js";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "seed-lead-cursor-"));
	roots.push(root);
	return { root, path: join(root, "inbound-cursor.json") };
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

const seed = {
	schemaVersion: 1 as const,
	migrationId: "fly-2445-test",
	expectedBeforeSha256: null,
	writerStopped: true,
	unresolved: [] as string[],
	channels: [
		{
			channelId: "12345678901234567",
			lastConfirmedMessageId: "22345678901234567",
		},
		{
			channelId: "32345678901234567",
			lastConfirmedMessageId: "42345678901234567",
		},
	],
};

describe("seedLeadInboundCursor", () => {
	it("writes the exact owner-only standard cursor and is idempotent", () => {
		const { path } = fixture();
		const first = seedLeadInboundCursor({ path, seed });
		const bytes = readFileSync(path, "utf8");
		expect(first).toMatchObject({
			status: "seeded",
			migrationId: "fly-2445-test",
		});
		expect(JSON.parse(bytes)).toEqual({
			"12345678901234567": "22345678901234567",
			"32345678901234567": "42345678901234567",
		});
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		expect(seedLeadInboundCursor({ path, seed })).toMatchObject({
			status: "already_seeded",
		});
		expect(readFileSync(path, "utf8")).toBe(bytes);
	});

	it("seeds explicitly empty channels with the before-first-message cursor", () => {
		const { path } = fixture();
		const emptySeed = {
			...seed,
			channels: [],
			emptyChannels: ["12345678901234567"],
		};
		expect(seedLeadInboundCursor({ path, seed: emptySeed }).status).toBe(
			"seeded",
		);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			"12345678901234567": "0",
		});
		expect(seedLeadInboundCursor({ path, seed: emptySeed }).status).toBe(
			"already_seeded",
		);
		writeFileSync(
			path,
			JSON.stringify({ "12345678901234567": "22345678901234567" }),
			{ mode: 0o600 },
		);
		expect(seedLeadInboundCursor({ path, seed: emptySeed }).status).toBe(
			"already_advanced",
		);
	});
	it("rejects a channel declared both empty and nonempty", () => {
		const { path } = fixture();
		expect(() =>
			seedLeadInboundCursor({
				path,
				seed: { ...seed, emptyChannels: [seed.channels[0]!.channelId] },
			}),
		).toThrow("duplicated");
	});

	it("never moves a cursor backwards after the new owner advanced", () => {
		const { path } = fixture();
		writeFileSync(
			path,
			JSON.stringify({
				"12345678901234567": "22345678901234568",
				"32345678901234567": "42345678901234569",
			}),
			{ mode: 0o600 },
		);
		expect(seedLeadInboundCursor({ path, seed })).toMatchObject({
			status: "already_advanced",
		});
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			"12345678901234567": "22345678901234568",
			"32345678901234567": "42345678901234569",
		});
	});

	it.each([
		[{ ...seed, writerStopped: false }, "writer"],
		[{ ...seed, unresolved: ["unknown-side-effect"] }, "unresolved"],
		[
			{
				...seed,
				channels: [
					{ channelId: "1", lastConfirmedMessageId: "90071992547409930" },
				],
			},
			"snowflake",
		],
	])("fails closed for invalid migration evidence", (candidate, message) => {
		const { path } = fixture();
		expect(() => seedLeadInboundCursor({ path, seed: candidate })).toThrow(
			message,
		);
	});

	it("refuses a symlink target", () => {
		const { root, path } = fixture();
		const other = join(root, "other.json");
		writeFileSync(other, "{}", { mode: 0o600 });
		symlinkSync(other, path);
		expect(() => seedLeadInboundCursor({ path, seed })).toThrow("symlink");
	});
});

it("delivers the first downtime message after an empty-channel seed", async () => {
	const { path } = fixture();
	const channelId = "12345678901234567",
		messageId = "22345678901234567";
	seedLeadInboundCursor({
		path,
		seed: { ...seed, channels: [], emptyChannels: [channelId] },
	});
	const calls: string[] = [];
	const delivered: string[] = [];
	const source = new RestPollDiscordInboundSource({
		botToken: "TEST",
		channelIds: [channelId],
		cursorStore: new FileInboundCursorStore(path),
		setTimer: () => ({ cancel: () => {} }),
		fetchImpl: async (url) => {
			calls.push(String(url));
			const after = new URL(String(url)).searchParams.get("after");
			return new Response(
				JSON.stringify(
					after === "0"
						? [
								{
									id: messageId,
									channel_id: channelId,
									content: "during migration",
									author: { id: "32345678901234567", bot: false },
								},
							]
						: [],
				),
			);
		},
	});
	source.onMessage((message) => {
		delivered.push(message.content);
		return true;
	});
	try {
		await source.start();
		expect(delivered).toEqual(["during migration"]);
		expect(calls[0]).toContain("after=0");
		expect(new FileInboundCursorStore(path).load(channelId)).toBe(messageId);
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		expect(
			seedLeadInboundCursor({
				path,
				seed: { ...seed, channels: [], emptyChannels: [channelId] },
			}).status,
		).toBe("already_advanced");
	} finally {
		await source.stop();
	}
});
