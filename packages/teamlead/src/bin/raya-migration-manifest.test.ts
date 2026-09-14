import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildCutoverSeed,
	verifyMigrationAuthorization,
} from "./raya-migration-manifest.js";
import { seedLeadInboundCursor } from "./seed-lead-inbound-cursor.js";

const target = "9d63a2b2e6736bcdd5e699945b3bf8655c06c5e9";
const founderId = "123456789012345678";
const channelId = "223456789012345678";
const canonical =
	"FLY-2496 AUTHORIZE register cutover=9d63a2b2 urgent-restart baseline=quiet15m";
const message = {
	id: "323456789012345678",
	channel_id: channelId,
	author: { id: founderId },
	content: `批准以下激活步骤：\n${canonical}`,
	timestamp: "2026-09-13T00:00:00.000Z",
};
const authorization = (
	value: unknown = message,
	env: NodeJS.ProcessEnv = { DISCORD_OWNER_USER_ID: founderId },
) =>
	verifyMigrationAuthorization({
		message: value,
		targetRayaSha: target,
		channelId,
		messageId: message.id,
		founder: { argsEnv: env, processEnv: {} },
	});

describe("Raya migration authorization", () => {
	it("binds the founder message, exact scope and baseline to the frozen target", () => {
		expect(authorization()).toMatchObject({
			legacy_stop: true,
			granted_by: "founder",
			canonical_line: canonical,
			evidence_message_id: message.id,
			evidence_channel_id: channelId,
			evidence_author_id: founderId,
			content_sha256: createHash("sha256")
				.update(message.content)
				.digest("hex"),
		});
	});

	it.each([
		{ ...message, author: { id: "423456789012345678" } },
		{ ...message, content: "FLY-2496 不批准停旧壳" },
		{ ...message, content: canonical.replace("9d63a2b2", "0f77e977") },
		{ ...message, content: canonical.replace(" urgent-restart", "") },
		{ ...message, content: canonical.replace(" baseline=quiet15m", "") },
		{ ...message, channel_id: "523456789012345678" },
		{ ...message, id: "623456789012345678" },
	])("refuses insufficient or mismatched authorization", (value) => {
		expect(() => authorization(value)).toThrow();
	});

	it("fails closed when the two founder identities conflict", () => {
		expect(() =>
			authorization(message, {
				DISCORD_OWNER_USER_ID: founderId,
				FLYWHEEL_FOUNDER_USER_ID: "423456789012345678",
			} as NodeJS.ProcessEnv),
		).toThrow(/mismatch/i);
	});
});

describe("Raya cutover cursor", () => {
	const t0 = Date.parse("2026-09-13T00:00:00Z");
	const t1 = t0 + 10;
	const id = (time: number) =>
		((BigInt(time) - 1420070400000n) << 22n).toString();
	const msg = (time: number, bot = false) => ({
		id: id(time),
		author: { id: founderId, bot },
	});
	const messages = [
		msg(t0 - 16 * 60_000, true),
		msg(t0 - 1, true),
		msg(t0 + 1),
		msg(t1),
	];
	const input = {
		migrationId: "test-activation",
		channelId,
		probeMessageId: id(t1 + 1),
		legacyOwners: [
			{ stop_started_at_ms: t0, stopped_at_ms: t0 + 5 },
			{ stop_started_at_ms: t0 + 5, stopped_at_ms: t1 },
		],
		messages,
		historyComplete: false,
		expectedBeforeSha256: null,
	};
	it("keeps B0 behind a quiet-window message explicitly ruled unprocessed by the Lead", () => {
		const quiet = msg(t0 - 5);
		const result = buildCutoverSeed({
			...input,
			messages: [...messages, quiet],
			resolutions: [
				{
					target: quiet.id,
					as: "confirmed_unprocessed",
					evidence: "Lead ruled",
					reason: "quiet-window-violated",
				},
				{
					target: messages[2]!.id,
					as: "confirmed_unprocessed",
					evidence: "Lead ruled",
				},
				{
					target: messages[3]!.id,
					as: "confirmed_unprocessed",
					evidence: "Lead ruled",
				},
			],
		});
		expect(result.unresolved).toEqual([]);
		expect(result.boundaryMessageId).toBe(messages[0]!.id);
	});
	it.each([
		{
			states: ["confirmed_processed", "confirmed_processed"],
			boundary: id(t1),
		},
		{
			states: ["confirmed_processed", "confirmed_unprocessed"],
			boundary: id(t0 + 1),
		},
		{
			states: ["confirmed_unprocessed", "confirmed_unprocessed"],
			boundary: id(t0 - 1),
		},
	])(
		"writes a real cursor at the final continuous boundary: $states",
		({ states, boundary }) => {
			const result = buildCutoverSeed({
				...input,
				resolutions: states.map((as, i) => ({
					target: messages[i + 2].id,
					as,
					evidence: "manual reconciliation",
				})),
			});
			expect(result.unresolved).toEqual([]);
			expect(result.boundaryMessageId).toBe(boundary);
			const root = mkdtempSync(join(tmpdir(), "raya-cutover-"));
			try {
				const path = join(root, "inbound-cursor.json");
				expect(seedLeadInboundCursor({ path, seed: result.seed! }).status).toBe(
					"seeded",
				);
				expect(JSON.parse(readFileSync(path, "utf8"))[channelId]).toBe(
					boundary,
				);
				expect(BigInt(boundary)).toBeLessThan(BigInt(input.probeMessageId));
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
	it("refuses processed work after an unprocessed gap", () => {
		expect(() =>
			buildCutoverSeed({
				...input,
				resolutions: [
					{
						target: messages[2].id,
						as: "confirmed_unprocessed",
						evidence: "operator",
					},
					{
						target: messages[3].id,
						as: "confirmed_processed",
						evidence: "operator",
					},
				],
			}),
		).toThrow(/non-contiguous/);
	});
	it("leaves same-millisecond stop-window human input unresolved without a seed", () => {
		const result = buildCutoverSeed({
			...input,
			messages: [...messages, msg(t0)],
			resolutions: [],
		});
		expect(result.seed).toBeUndefined();
		expect(result.unresolved).toEqual(
			expect.arrayContaining([
				{ message_id: id(t0), reason: "stop-window" },
				{ message_id: id(t1), reason: "stop-window" },
			]),
		);
	});
	it("does not infer processing from bot replies, and refuses an uncovered quiet window", () => {
		const result = buildCutoverSeed({
			...input,
			messages: [msg(t0 - 5), msg(t0 - 1, true)],
			resolutions: [],
		});
		expect(result.seed).toBeUndefined();
		expect(result.unresolved).toEqual(
			expect.arrayContaining([
				{ reason: "lookback_exhausted" },
				{ message_id: id(t0 - 5), reason: "quiet-window-violated" },
			]),
		);
	});
});
