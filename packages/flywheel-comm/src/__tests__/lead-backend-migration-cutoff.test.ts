import { expect, it } from "vitest";
import { collectMigrationCutoffs } from "../lead-backend-migration-cutoff.js";

const channel = "12345678901234567",
	bot = "22345678901234567";
const msg = (id: string, author = "32345678901234567") => ({
	id,
	author: { id: author },
});
function options(pages: unknown[][]) {
	const calls: string[] = [];
	return {
		calls,
		input: {
			botToken: "TEST_SECRET",
			botUserId: bot,
			channelIds: [channel],
			assertStopped: () => {},
			now: () => "2026-09-11T00:00:00.000Z",
			fetch: async (url: string) => {
				calls.push(url);
				return new Response(JSON.stringify(pages.shift() ?? []), {
					status: 200,
				});
			},
		},
	};
}
it("pins latest message and records only inbound after the old bot's last reply", async () => {
	const f = options([
		[
			msg("52345678901234567"),
			msg("42345678901234567", bot),
			msg("32345678901234567"),
		],
	]);
	const result = await collectMigrationCutoffs(f.input);
	expect(result.channels[0]).toMatchObject({
		channelId: channel,
		cutoffId: "52345678901234567",
		lastBotReplyId: "42345678901234567",
		unresolvedMessageIds: ["52345678901234567"],
		unresolvedBefore: null,
	});
	expect(JSON.stringify(result)).not.toContain("TEST_SECRET");
	expect(f.calls).toHaveLength(1);
});
it("retains all inbound as unresolved when no reply exists, without holding", async () => {
	const f = options([[msg("52345678901234567"), msg("42345678901234567")]]);
	const result = await collectMigrationCutoffs(f.input);
	expect(result.channels[0].unresolvedMessageIds).toEqual([
		"42345678901234567",
		"52345678901234567",
	]);
	expect(result.channels[0].lastBotReplyId).toBeNull();
});
it("represents an empty channel explicitly without inventing a message id", async () => {
	expect(
		(await collectMigrationCutoffs(options([[]]).input)).channels[0].cutoffId,
	).toBeNull();
});
it("does no REST request until stopped-writer proof passes", async () => {
	const f = options([[]]);
	f.input.assertStopped = () => {
		throw new Error("writer live");
	};
	await expect(collectMigrationCutoffs(f.input)).rejects.toThrow("writer live");
	expect(f.calls).toHaveLength(0);
});
it("retains an unresolved history range when the bounded page budget is exhausted", async () => {
	const page = Array.from({ length: 100 }, (_, i) =>
		msg(String(52345678901234567n - BigInt(i))),
	);
	const f = options([page]);
	const result = await collectMigrationCutoffs({ ...f.input, maxPages: 1 });
	expect(result.channels[0].unresolvedBefore).toBe(page[99].id);
	expect(result.channels[0].unresolvedMessageIds).toHaveLength(100);
});
it("does not retry a rate-limited request or expose the error body", async () => {
	const f = options([]);
	f.input.fetch = async (url) => {
		f.calls.push(url);
		return new Response("TEST_SECRET", { status: 429 });
	};
	await expect(collectMigrationCutoffs(f.input)).rejects.toThrow("HTTP 429");
	expect(f.calls).toHaveLength(1);
});
it("does not expose malformed response text through parsing errors", async () => {
	const f = options([]);
	f.input.fetch = async () =>
		new Response("PRIVATE_MESSAGE_NOT_JSON", { status: 200 });
	try {
		await collectMigrationCutoffs(f.input);
		throw new Error("expected rejection");
	} catch (error) {
		expect(String(error)).not.toContain("PRIVATE_MESSAGE_NOT_JSON");
		expect(String(error)).toContain("invalid Discord JSON");
	}
});
