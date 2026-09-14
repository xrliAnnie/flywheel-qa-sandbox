import { z } from "zod";
import {
	readDiscordJson,
	discordMessage as rowSchema,
	discordId as snowflake,
} from "./discord-message.js";
import type { ScanReceipt } from "./sender.js";

/** Dedicated read-only scan; marker is correlation data, never proof of authorship. */
interface ScanInput {
	threadId: string;
	botUserId: string;
	botToken: string;
	marker: string;
	since: string;
	signal: AbortSignal;
	fetchImpl?: typeof fetch;
}
export async function scanJudgmentMessages(
	input: ScanInput,
): Promise<ScanReceipt> {
	return scanMessages(input, "opinion");
}
export type LearningScanReceipt =
	| Exclude<ScanReceipt, { kind: "found" }>
	| { kind: "found"; messageId: string; subjectId: string; visibleAt: string };
export async function scanLearningMessages(
	input: ScanInput & { purpose: "clarification" | "ack" },
): Promise<LearningScanReceipt> {
	const purpose = z.enum(["clarification", "ack"]).safeParse(input.purpose);
	if (!purpose.success) return { kind: "ambiguous" };
	const result = await scanMessages(input, purpose.data);
	if (result.kind !== "found") return result;
	return {
		kind: "found",
		messageId: result.messageId,
		subjectId: result.opinionId,
		visibleAt: result.visibleAt,
	};
}
async function scanMessages(
	input: ScanInput,
	kind: "opinion" | "clarification" | "ack",
): Promise<ScanReceipt> {
	const checked = z
		.object({
			threadId: snowflake,
			botUserId: snowflake,
			marker: z.string().min(1).max(220),
			since: z.string().datetime(),
		})
		.safeParse(input);
	if (!checked.success) return { kind: "ambiguous" };
	let before: string | undefined,
		frontier = "empty";
	const matches = new Map<string, Extract<ScanReceipt, { kind: "found" }>>();
	try {
		for (let page = 0; page < 4; page++) {
			input.signal.throwIfAborted();
			const query = new URLSearchParams({ limit: "100" });
			if (before) query.set("before", before);
			const response = await (input.fetchImpl ?? fetch)(
				`https://discord.com/api/v10/channels/${input.threadId}/messages?${query}`,
				{
					headers: { Authorization: `Bot ${input.botToken}` },
					signal: input.signal,
					redirect: "error",
				},
			);
			if (!response.ok) {
				await response.body?.cancel();
				return { kind: "ambiguous" };
			}
			const parsed = z
				.array(rowSchema)
				.max(100)
				.safeParse(await readDiscordJson(response, input.signal, 512 * 1024));
			if (!parsed.success) return { kind: "ambiguous" };
			const rows = parsed.data;
			if (page === 0) frontier = rows[0]?.id ?? "empty";
			let previous = before;
			for (const row of rows) {
				// Reject repeated/out-of-order cursors and foreign-channel data rather than guessing a boundary.
				if (
					row.channel_id !== input.threadId ||
					(previous && BigInt(row.id) >= BigInt(previous))
				)
					return { kind: "ambiguous" };
				previous = row.id;
				if (
					row.author.id !== input.botUserId ||
					row.author.bot !== true ||
					Date.parse(row.timestamp) < Date.parse(input.since)
				)
					continue;
				const prefix = `\`${input.marker} ${kind}:`;
				const line = row.content
					.split("\n")
					.find((line) => line.startsWith(prefix) && line.endsWith("`"));
				if (!line) continue;
				const opinionId = line.slice(prefix.length, -1);
				if (
					!(
						kind === "opinion" ? /^[a-zA-Z0-9:_-]{1,200}$/ : /^[a-f0-9]{64}$/
					).test(opinionId)
				)
					return { kind: "ambiguous" };
				const visibleAt = new Date(
					row.edited_timestamp ?? row.timestamp,
				).toISOString();
				if (Date.parse(visibleAt) < Date.parse(row.timestamp))
					return { kind: "ambiguous" };
				matches.set(row.id, {
					kind: "found",
					messageId: row.id,
					opinionId,
					visibleAt,
				});
			}
			if (matches.size > 1) return { kind: "ambiguous" };
			if (
				rows.length < 100 ||
				Date.parse(rows.at(-1)!.timestamp) <= Date.parse(input.since)
			)
				return matches.values().next().value ?? { kind: "none", frontier };
			before = rows.at(-1)!.id;
		}
	} catch {
		return { kind: "ambiguous" };
	}
	return { kind: "ambiguous" };
}
