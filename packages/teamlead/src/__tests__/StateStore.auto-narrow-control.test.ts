import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const MESSAGE = "1517000000000000001";

describe("StateStore auto narrow control", () => {
	it("atomically stores the scoped flag change and immutable founder audit", async () => {
		const store = await StateStore.create(":memory:");
		const result = store.applyAutoNarrowControlChange({
			eventId: "11111111-1111-4111-8111-111111111111",
			projectName: "flywheel",
			mode: "auto",
			expectedChangeSeq: 0,
			founderMessageId: MESSAGE,
			founderChannelId: "1516209714097291335",
			founderAuthorId: "1138241636057481306",
			messageCreatedAt: "2026-09-09T02:45:00.000Z",
			messageDigest: "a".repeat(64),
			commandText: "现在放开",
			executedBy: "flywheel-eng-lead",
			reason: `founder ${MESSAGE}`,
			now: Date.parse("2026-09-09T02:46:00.000Z"),
		});
		expect(result).toMatchObject({
			ok: true,
			event: {
				mode: "auto",
				openingEventId: "11111111-1111-4111-8111-111111111111",
				founderMessageId: MESSAGE,
			},
		});
		expect(
			store.getFlagValueRow("auto_merge_narrow_gate", "flywheel"),
		).toMatchObject({
			raw: "auto",
			lastEffective: "auto",
			updatedBy: "flywheel-eng-lead",
		});
		expect(store.getAutoNarrowControlEventByMessageId(MESSAGE)).toEqual(
			result.ok ? result.event : undefined,
		);
		store.close();
	});

	it("keeps the first opening event across same-value auto reaffirmations", async () => {
		const store = await StateStore.create(":memory:");
		const first = store.applyAutoNarrowControlChange({
			eventId: "11111111-1111-4111-8111-111111111111",
			projectName: "flywheel",
			mode: "auto",
			expectedChangeSeq: 0,
			founderMessageId: "1517000000000000001",
			founderChannelId: "1516209714097291335",
			founderAuthorId: "1138241636057481306",
			messageCreatedAt: "2026-09-09T02:45:00.000Z",
			messageDigest: "a".repeat(64),
			commandText: "现在放开",
			executedBy: "flywheel-eng-lead",
			reason: "founder 1517000000000000001",
			now: Date.parse("2026-09-09T02:46:00.000Z"),
		});
		expect(first).toMatchObject({ ok: true });
		const reaffirmed = store.applyAutoNarrowControlChange({
			eventId: "22222222-2222-4222-8222-222222222222",
			projectName: "flywheel",
			mode: "auto",
			expectedChangeSeq: 1,
			founderMessageId: "1517000000000000002",
			founderChannelId: "1516209714097291335",
			founderAuthorId: "1138241636057481306",
			messageCreatedAt: "2026-09-09T02:47:00.000Z",
			messageDigest: "b".repeat(64),
			commandText: "现在放开",
			executedBy: "flywheel-eng-lead",
			reason: "founder 1517000000000000002",
			now: Date.parse("2026-09-09T02:48:00.000Z"),
		});
		expect(reaffirmed).toMatchObject({
			ok: true,
			event: { openingEventId: "11111111-1111-4111-8111-111111111111" },
		});

		const stopped = store.applyAutoNarrowControlChange({
			eventId: "33333333-3333-4333-8333-333333333333",
			projectName: "flywheel",
			mode: "dry_run",
			expectedChangeSeq: 2,
			founderMessageId: "1517000000000000003",
			founderChannelId: "1516209714097291335",
			founderAuthorId: "1138241636057481306",
			messageCreatedAt: "2026-09-09T02:49:00.000Z",
			messageDigest: "c".repeat(64),
			commandText: "现在停止",
			executedBy: "flywheel-eng-lead",
			reason: "founder 1517000000000000003",
			now: Date.parse("2026-09-09T02:50:00.000Z"),
		});
		expect(stopped).toMatchObject({ ok: true });
		const reopened = store.applyAutoNarrowControlChange({
			eventId: "44444444-4444-4444-8444-444444444444",
			projectName: "flywheel",
			mode: "auto",
			expectedChangeSeq: 3,
			founderMessageId: "1517000000000000004",
			founderChannelId: "1516209714097291335",
			founderAuthorId: "1138241636057481306",
			messageCreatedAt: "2026-09-09T02:51:00.000Z",
			messageDigest: "d".repeat(64),
			commandText: "现在放开",
			executedBy: "flywheel-eng-lead",
			reason: "founder 1517000000000000004",
			now: Date.parse("2026-09-09T02:52:00.000Z"),
		});
		expect(reopened).toMatchObject({
			ok: true,
			event: { openingEventId: "44444444-4444-4444-8444-444444444444" },
		});
		store.close();
	});

	it("generic scoped writer cannot bypass founder authority", async () => {
		const store = await StateStore.create(":memory:");
		expect(
			store.applyScopedFlagValueChange({
				name: "auto_merge_narrow_gate",
				scope: "flywheel",
				op: "set",
				rawTo: "auto",
				expectedChangeSeq: 0,
				actor: "bridge-local-operator",
				reason: "bypass",
			}),
		).toEqual({ ok: false, reason: "founder_message_required" });
		store.close();
	});
});
