import { expect, it, vi } from "vitest";
import { scanJudgmentMessages } from "../discord-scan.js";

const row = {
	id: "123456789012345682",
	channel_id: "123456789012345679",
	author: { id: "123456789012345690", bot: true },
	content: "意见\n`ship-judgment:q opinion:op1`",
	timestamp: "2026-09-11T00:00:01.000Z",
	edited_timestamp: null,
};
const input = {
	threadId: row.channel_id,
	botUserId: row.author.id,
	botToken: "test-token",
	marker: "ship-judgment:q",
	since: "2026-09-11T00:00:00.000Z",
	signal: new AbortController().signal,
};
it("requires the exact bot identity and preserves actual edit visibility time", async () => {
	const fetchImpl = vi.fn(
		async () =>
			new Response(
				JSON.stringify([
					{ ...row, author: { id: "123456789012345691", bot: true } },
				]),
			),
	);
	expect(await scanJudgmentMessages({ ...input, fetchImpl })).toEqual({
		kind: "none",
		frontier: row.id,
	});
	fetchImpl.mockImplementationOnce(
		async () =>
			new Response(
				JSON.stringify([
					{ ...row, edited_timestamp: "2026-09-11T00:00:02.000+00:00" },
				]),
			),
	);
	expect(await scanJudgmentMessages({ ...input, fetchImpl })).toEqual({
		kind: "found",
		messageId: row.id,
		opinionId: "op1",
		visibleAt: "2026-09-11T00:00:02.000Z",
	});
	expect(fetchImpl.mock.calls.length).toBe(2);
});
it("does not infer absence or uniqueness from a capped scan", async () => {
	const rows = Array.from({ length: 100 }, (_, i) => ({
		...row,
		id: String(BigInt(row.id) + BigInt(100 - i)),
		content: "noise",
	}));
	const fetchImpl = vi.fn(async () => new Response(JSON.stringify(rows)));
	expect(await scanJudgmentMessages({ ...input, fetchImpl })).toEqual({
		kind: "ambiguous",
	});
	expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(4);
	const duplicate = vi.fn(
		async () =>
			new Response(JSON.stringify([{ ...row, id: "123456789012345683" }, row])),
	);
	expect(
		await scanJudgmentMessages({ ...input, fetchImpl: duplicate }),
	).toEqual({ kind: "ambiguous" });
});

it.each(["clarification", "ack"] as const)(
	"recovers %s with exact typed marker without adopting opinion messages",
	async (purpose) => {
		const { scanLearningMessages } = await import("../discord-scan.js");
		const subjectId = "a".repeat(64),
			marker = `ship-judgment:${purpose}:${subjectId}`;
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify([
						{
							...row,
							content: `Learning\n\`${marker} ${purpose}:${subjectId}\``,
						},
					]),
				),
		);
		expect(
			await scanLearningMessages({ ...input, marker, purpose, fetchImpl }),
		).toEqual({
			kind: "found",
			messageId: row.id,
			subjectId,
			visibleAt: row.timestamp,
		});
		expect(await scanJudgmentMessages({ ...input, marker, fetchImpl })).toEqual(
			{ kind: "none", frontier: row.id },
		);
		fetchImpl.mockImplementationOnce(
			async () =>
				new Response(
					JSON.stringify([
						{
							...row,
							content: `Wrong type\n\`${marker} opinion:${subjectId}\``,
						},
					]),
				),
		);
		expect(
			await scanLearningMessages({ ...input, marker, purpose, fetchImpl }),
		).toEqual({ kind: "none", frontier: row.id });
	},
);
