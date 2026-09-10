import { describe, expect, it, vi } from "vitest";
import {
	handleAutoNarrowControlApply,
	handleAutoNarrowControlStage,
} from "../bridge/auto-narrow-control-route.js";
import {
	FleetAdminAudit,
	type FleetAuditRecord,
} from "../bridge/fleet-admin-audit.js";
import { StateStore } from "../StateStore.js";

const FOUNDER = "1138241636057481306";
const CHANNEL = "1516209714097291335";
const NOW = Date.parse("2026-09-09T02:46:00.000Z");
const MESSAGE = ((BigInt(NOW - 60_000 - 1420070400000) << 22n) + 7n).toString();

function deps(store: StateStore, content = "现在放开。") {
	let tokenSha = "";
	return {
		store,
		founderUserId: FOUNDER,
		engineeringChannelId: CHANNEL,
		leadId: "flywheel-eng-lead",
		botToken: "test-token",
		now: () => NOW,
		randomId: () => "11111111-1111-4111-8111-111111111111",
		fetchDiscordMessage: vi.fn(async () => ({
			ok: true as const,
			message: {
				id: MESSAGE,
				channelId: CHANNEL,
				authorId: FOUNDER,
				authorIsBot: false,
				timestampMs: NOW - 60_000,
				editedTimestampMs: null,
				content,
			},
		})),
		authorizeLeadRequest: vi.fn(() => true),
		tokens: {
			issue: vi.fn((sha: string) => {
				tokenSha = sha;
				return "confirm-token";
			}),
			verifyAndConsume: vi.fn((token: string, sha: string) =>
				token === "confirm-token" && sha === tokenSha
					? { ok: true as const }
					: { ok: false as const, reason: "invalid" },
			),
		},
		audit: { record: vi.fn<(record: FleetAuditRecord) => boolean>(() => true) },
	};
}

const auth = {
	leadId: "flywheel-eng-lead",
	projectName: "flywheel",
	identityDigest: "b".repeat(64),
};

describe("auto narrow founder control route", () => {
	it("stages and applies a fresh exact founder open command", async () => {
		const store = await StateStore.create(":memory:");
		const d = deps(store);
		const staged = await handleAutoNarrowControlStage(
			d,
			{
				name: "auto_merge_narrow_gate",
				to: "auto",
				project: "flywheel",
				op: "set",
				reason: `founder ${MESSAGE}`,
				founderMessageRef: { channelId: CHANNEL, messageId: MESSAGE },
				leadAuth: auth,
			},
			"http://localhost:9876",
		);
		expect(staged.code).toBe(200);
		const body = staged.body as { canonical: never; confirmToken: string };
		const applied = await handleAutoNarrowControlApply(
			d,
			body.canonical,
			body.confirmToken,
			auth,
			"http://localhost:9876",
		);
		expect(applied).toMatchObject({
			code: 200,
			body: { ok: true, mode: "auto" },
		});
		expect(d.fetchDiscordMessage).toHaveBeenCalledTimes(2);
		expect(d.authorizeLeadRequest).toHaveBeenCalledTimes(3);
		store.close();
	});

	it("accepts the carrier passthrough key used by a Codex Lead", async () => {
		const store = await StateStore.create(":memory:");
		const d = deps(store);
		const carrierAuth = { ...auth, carrierClaim: "carrier-instance-1" };
		const staged = await handleAutoNarrowControlStage(
			d,
			{
				name: "auto_merge_narrow_gate",
				to: "auto",
				project: "flywheel",
				op: "set",
				reason: `founder ${MESSAGE}`,
				founderMessageRef: { channelId: CHANNEL, messageId: MESSAGE },
				leadAuth: carrierAuth,
				carrierClaim: carrierAuth.carrierClaim,
			},
			"http://localhost:9876",
		);
		expect(staged.code).toBe(200);
		expect(d.authorizeLeadRequest).toHaveBeenCalledWith(carrierAuth);
		store.close();
	});

	it("rejects a malformed carrier passthrough key", async () => {
		const store = await StateStore.create(":memory:");
		const result = await handleAutoNarrowControlStage(
			deps(store),
			{
				name: "auto_merge_narrow_gate",
				to: "auto",
				project: "flywheel",
				op: "set",
				reason: `founder ${MESSAGE}`,
				founderMessageRef: { channelId: CHANNEL, messageId: MESSAGE },
				leadAuth: auth,
				carrierClaim: 42,
			},
			"http://localhost:9876",
		);
		expect(result).toMatchObject({
			code: 400,
			body: { error: "invalid_protected_flag_request" },
		});
		store.close();
	});

	it("replays the original receipt while reporting the current effective mode", async () => {
		const store = await StateStore.create(":memory:");
		const d = deps(store);
		const staged = await handleAutoNarrowControlStage(
			d,
			{
				name: "auto_merge_narrow_gate",
				to: "auto",
				project: "flywheel",
				op: "set",
				reason: `founder ${MESSAGE}`,
				founderMessageRef: { channelId: CHANNEL, messageId: MESSAGE },
				leadAuth: auth,
			},
			"http://localhost:9876",
		);
		expect(staged.code).toBe(200);
		const original = staged.body as {
			canonical: never;
			confirmToken: string;
		};
		const first = await handleAutoNarrowControlApply(
			d,
			original.canonical,
			original.confirmToken,
			auth,
			"http://localhost:9876",
		);
		expect(first).toMatchObject({ code: 200, body: { mode: "auto" } });
		const stopTimestamp = NOW - 30_000;
		const stopMessage = (
			(BigInt(stopTimestamp - 1420070400000) << 22n) +
			9n
		).toString();
		expect(
			store.applyAutoNarrowControlChange({
				eventId: "22222222-2222-4222-8222-222222222222",
				projectName: "flywheel",
				mode: "dry_run",
				expectedChangeSeq: store.getFlagValueChangeSeq(
					"auto_merge_narrow_gate",
					"flywheel",
				),
				founderMessageId: stopMessage,
				founderChannelId: CHANNEL,
				founderAuthorId: FOUNDER,
				messageCreatedAt: new Date(stopTimestamp).toISOString(),
				messageDigest: "c".repeat(64),
				commandText: "现在停止",
				executedBy: "flywheel-eng-lead",
				reason: `founder ${stopMessage}`,
				now: NOW,
			}),
		).toMatchObject({ ok: true, replayed: false });

		const replayStage = await handleAutoNarrowControlStage(
			d,
			{
				name: "auto_merge_narrow_gate",
				to: "auto",
				project: "flywheel",
				op: "set",
				reason: `founder ${MESSAGE}`,
				founderMessageRef: { channelId: CHANNEL, messageId: MESSAGE },
				leadAuth: auth,
			},
			"http://localhost:9876",
		);
		expect(replayStage.code).toBe(200);
		const replay = replayStage.body as {
			canonical: never;
			confirmToken: string;
		};
		expect(
			await handleAutoNarrowControlApply(
				d,
				replay.canonical,
				replay.confirmToken,
				auth,
				"http://localhost:9876",
			),
		).toMatchObject({
			code: 200,
			body: {
				mode: "dry_run",
				replayed: true,
				controlEventId: "11111111-1111-4111-8111-111111111111",
			},
		});
		store.close();
	});

	it.each([
		["wrong author", { authorId: "1138241636057481307" }, "author_not_founder"],
		["edited", { editedTimestampMs: NOW - 1 }, "message_edited"],
		["bot", { authorIsBot: true }, "author_is_bot"],
	])("rejects %s", async (_label, override, reason) => {
		const store = await StateStore.create(":memory:");
		const d = deps(store);
		d.fetchDiscordMessage.mockResolvedValue({
			ok: true,
			message: {
				id: MESSAGE,
				channelId: CHANNEL,
				authorId: FOUNDER,
				authorIsBot: false,
				timestampMs: NOW - 60_000,
				editedTimestampMs: null,
				content: "现在放开",
				...override,
			},
		});
		const result = await handleAutoNarrowControlStage(
			d,
			{
				name: "auto_merge_narrow_gate",
				to: "auto",
				project: "flywheel",
				op: "set",
				reason: `founder ${MESSAGE}`,
				founderMessageRef: { channelId: CHANNEL, messageId: MESSAGE },
				leadAuth: auth,
			},
			"o",
		);
		expect(result).toMatchObject({
			code: expect.any(Number),
			body: { error: reason },
		});
		store.close();
	});

	it("rejects auto commands older than ten minutes and never offers off", async () => {
		const store = await StateStore.create(":memory:");
		const d = deps(store);
		const oldTimestamp = NOW - 600_001;
		const oldMessage = (
			(BigInt(oldTimestamp - 1420070400000) << 22n) +
			9n
		).toString();
		d.fetchDiscordMessage.mockResolvedValue({
			ok: true,
			message: {
				id: oldMessage,
				channelId: CHANNEL,
				authorId: FOUNDER,
				authorIsBot: false,
				timestampMs: oldTimestamp,
				editedTimestampMs: null,
				content: "现在放开",
			},
		});
		const old = await handleAutoNarrowControlStage(
			d,
			{
				name: "auto_merge_narrow_gate",
				to: "auto",
				project: "flywheel",
				op: "set",
				reason: `founder ${oldMessage}`,
				founderMessageRef: { channelId: CHANNEL, messageId: oldMessage },
				leadAuth: auth,
			},
			"o",
		);
		expect(old).toMatchObject({
			code: 422,
			body: { error: "control_message_expired" },
		});
		const off = await handleAutoNarrowControlStage(
			d,
			{
				name: "auto_merge_narrow_gate",
				to: "off",
				project: "flywheel",
				op: "set",
				reason: `founder ${MESSAGE}`,
				founderMessageRef: { channelId: CHANNEL, messageId: MESSAGE },
				leadAuth: auth,
			},
			"o",
		);
		expect(off).toMatchObject({
			code: 400,
			body: { error: "mode_not_controllable" },
		});
		store.close();
	});

	it("requires the Discord timestamp to equal the message snowflake timestamp", async () => {
		const store = await StateStore.create(":memory:");
		const d = deps(store);
		d.fetchDiscordMessage.mockResolvedValue({
			ok: true,
			message: {
				id: MESSAGE,
				channelId: CHANNEL,
				authorId: FOUNDER,
				authorIsBot: false,
				timestampMs: NOW - 59_500,
				editedTimestampMs: null,
				content: "现在放开",
			},
		});
		const result = await handleAutoNarrowControlStage(
			d,
			{
				name: "auto_merge_narrow_gate",
				to: "auto",
				project: "flywheel",
				op: "set",
				reason: `founder ${MESSAGE}`,
				founderMessageRef: { channelId: CHANNEL, messageId: MESSAGE },
				leadAuth: auth,
			},
			"o",
		);
		expect(result).toMatchObject({
			code: 422,
			body: { error: "message_timestamp_mismatch" },
		});
		store.close();
	});

	it("rejects unknown protected-control request keys", async () => {
		const store = await StateStore.create(":memory:");
		const d = deps(store);
		const result = await handleAutoNarrowControlStage(
			d,
			{
				name: "auto_merge_narrow_gate",
				to: "auto",
				project: "flywheel",
				op: "set",
				reason: `founder ${MESSAGE}`,
				founderMessageRef: { channelId: CHANNEL, messageId: MESSAGE },
				leadAuth: auth,
				unexpected: true,
			} as never,
			"o",
		);
		expect(result).toMatchObject({
			code: 400,
			body: { error: "invalid_protected_flag_request" },
		});
		store.close();
	});

	it("fails closed when an open command expires at the final StateStore lock", async () => {
		const store = await StateStore.create(":memory:");
		const d = deps(store);
		const now = vi
			.fn<() => number>()
			.mockReturnValueOnce(NOW)
			.mockReturnValueOnce(NOW)
			.mockReturnValueOnce(NOW + 600_001);
		d.now = now;
		const staged = await handleAutoNarrowControlStage(
			d,
			{
				name: "auto_merge_narrow_gate",
				to: "auto",
				project: "flywheel",
				op: "set",
				reason: `founder ${MESSAGE}`,
				founderMessageRef: { channelId: CHANNEL, messageId: MESSAGE },
				leadAuth: auth,
			},
			"o",
		);
		expect(staged.code).toBe(200);
		const body = staged.body as { canonical: never; confirmToken: string };
		const applied = await handleAutoNarrowControlApply(
			d,
			body.canonical,
			body.confirmToken,
			auth,
			"o",
		);
		expect(applied).toMatchObject({
			code: 422,
			body: { error: "control_message_expired" },
		});
		expect(
			store.getFlagValueRow("auto_merge_narrow_gate", "flywheel"),
		).toBeUndefined();
		store.close();
	});
});

describe("narrow control denial audit", () => {
	it.each([
		["author", { authorId: "1200000000000000009" }],
		["bot", { authorIsBot: true }],
		["edited", { editedTimestampMs: NOW - 1 }],
		["question", { content: "现在放开？" }],
		["near sentence", { content: "请现在放开" }],
		["channel", {}],
	])(
		"persists one denied row for %s at stage and apply",
		async (label, override) => {
			const store = await StateStore.create(":memory:");
			const audit = new FleetAdminAudit(":memory:");
			const d = deps(store);
			d.audit.record = vi.fn(audit.record.bind(audit));
			const input = {
				name: "auto_merge_narrow_gate",
				to: "auto",
				project: "flywheel",
				op: "set",
				reason: `founder ${MESSAGE}`,
				founderMessageRef: { channelId: CHANNEL, messageId: MESSAGE },
				leadAuth: auth,
			};
			try {
				const good = await handleAutoNarrowControlStage(d, input, "o");
				expect(good.code).toBe(200);
				const goodCall = d.audit.record.mock.calls[0][0];
				expect(audit.forBatch(goodCall.batchId)).toHaveLength(1);
				const original = await d.fetchDiscordMessage();
				d.fetchDiscordMessage.mockResolvedValue({
					...original,
					message: { ...original.message, ...override },
				});
				if (label === "channel") d.engineeringChannelId = "1516209714097299999";
				for (const phase of ["stage", "apply"]) {
					d.audit.record.mockClear();
					const body = good.body as { canonical: never; confirmToken: string };
					const result =
						phase === "stage"
							? await handleAutoNarrowControlStage(d, input, "o")
							: await handleAutoNarrowControlApply(
									d,
									body.canonical,
									body.confirmToken,
									auth,
									"o",
								);
					expect(result.code).not.toBe(200);
					expect(d.audit.record).toHaveBeenCalledTimes(1);
					const row = d.audit.record.mock.calls[0][0];
					expect(row).toMatchObject({
						event: "denied",
						reason: (result.body as { error: string }).error,
					});
					const persisted = audit
						.forBatch(row.batchId)
						.filter((r) => r.attempt_id === row.attemptId);
					expect(persisted).toHaveLength(1);
					expect(persisted[0].canonical_request).toContain(MESSAGE);
					expect(persisted[0].canonical_request).not.toContain(
						auth.identityDigest,
					);
				}
			} finally {
				audit.close();
				store.close();
			}
		},
	);
});

it("keeps the newer OPEN when an older STOP arrives (plan sections 4/11)", async () => {
	const store = await StateStore.create(":memory:");
	try {
		const d = deps(store);
		const input = {
			name: "auto_merge_narrow_gate",
			to: "auto",
			project: "flywheel",
			op: "set",
			reason: `founder ${MESSAGE}`,
			founderMessageRef: { channelId: CHANNEL, messageId: MESSAGE },
			leadAuth: auth,
		};
		const staged = await handleAutoNarrowControlStage(d, input, "o");
		expect(staged.code).toBe(200);
		const body = staged.body as { canonical: never; confirmToken: string };
		expect(
			await handleAutoNarrowControlApply(
				d,
				body.canonical,
				body.confirmToken,
				auth,
				"o",
			),
		).toMatchObject({ code: 200, body: { mode: "auto" } });
		const timestampMs = NOW - 4 * 3_600_000;
		const oldId = (
			(BigInt(timestampMs - 1420070400000) << 22n) +
			11n
		).toString();
		const original = await d.fetchDiscordMessage();
		d.fetchDiscordMessage.mockResolvedValue({
			...original,
			message: {
				...original.message,
				id: oldId,
				timestampMs,
				content: "现在停止",
			},
		});
		// Lead ruling 65eadca8: plan sections 4/11 override the earlier QA
		// fixture semantics. STOP has no age expiry but still obeys ordering.
		expect(
			await handleAutoNarrowControlStage(
				d,
				{
					...input,
					to: "dry_run",
					reason: `founder ${oldId}`,
					founderMessageRef: { channelId: CHANNEL, messageId: oldId },
				},
				"o",
			),
		).toMatchObject({ code: 409, body: { error: "message_order_conflict" } });
		expect(store.getLatestAutoNarrowControlEvent("flywheel")?.mode).toBe(
			"auto",
		);
	} finally {
		store.close();
	}
});
