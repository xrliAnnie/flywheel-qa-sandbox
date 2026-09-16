import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	epicIntakeResultSchema,
	validateEpicIntakeEvidence,
} from "../epic-intake-result.js";

const at = "2026-09-14T20:00:00.000Z";
const result = () => ({
	outcome: "complete" as const,
	childIssueIds: [],
	firstBatchIssueIds: [],
	ledgerObservedAt: at,
	threadId: "123456789012345678",
	messageId: "223456789012345678",
	founderQuestion: null,
});
describe("intake business result", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});
	afterEach(() => store.close());
	it("requires a bounded unique child set and first-batch subset", () => {
		expect(
			epicIntakeResultSchema.safeParse({
				...result(),
				firstBatchIssueIds: ["12345678-1234-4234-8234-123456789abc"],
			}).success,
		).toBe(false);
		expect(
			epicIntakeResultSchema.safeParse({
				...result(),
				outcome: "needs_founder",
			}).success,
		).toBe(false);
	});
	it("persists business resolution separately, makes the page dirty, and rejects changed evidence", () => {
		const row = store.recordEpicIntake({
			issueUuid: "uuid",
			identifier: "TEST-1",
			startedAt: at,
			intakeAt: at,
			observedAt: at,
			projectName: "test",
			leadId: "lead",
			bindingDigest: "binding",
			sourceSpanIds: ["span"],
			backfill: false,
			active: true,
			hasChildIssues: true,
		})!;
		store.clearPublishedEpicIntakes([row]);
		expect(store.resolveEpicIntake(row, result(), at)).toMatchObject({
			workState: "complete",
			pageDirty: true,
			result: result(),
		});
		expect(store.resolveEpicIntake(row, result(), at)?.workState).toBe(
			"complete",
		);
		expect(() =>
			store.resolveEpicIntake(
				row,
				{ ...result(), messageId: "323456789012345678" },
				at,
			),
		).toThrow();
	});
	it("fences a result when the episode was invalidated during external verification", () => {
		const row = store.recordEpicIntake({
			issueUuid: "uuid",
			identifier: "TEST-1",
			startedAt: at,
			intakeAt: at,
			observedAt: at,
			projectName: "test",
			leadId: "lead",
			bindingDigest: "binding",
			sourceSpanIds: ["span"],
			backfill: false,
			active: true,
			hasChildIssues: true,
		})!;
		store.setEpicIntakeActive(row.eventUid, false, "2026-09-14T20:01:00.000Z");
		expect(() => store.resolveEpicIntake(row, result(), at)).toThrow();
	});
});

const child = "12345678-1234-4234-8234-123456789abc";
const observation = () => ({
	active: true,
	directChildIds: [child],
	canonicalThreadId: result().threadId,
	message: {
		id: result().messageId,
		channelId: result().threadId,
		authorId: "lead-bot",
	},
	leadBotUserId: "lead-bot",
	now: at,
	patrolIntervalMs: 60000,
});
it("verifies fresh ledger declaration, direct children and canonical message author", () => {
	const evidence = {
		...result(),
		childIssueIds: [child],
		firstBatchIssueIds: [child],
	};
	expect(() =>
		validateEpicIntakeEvidence(evidence, observation()),
	).not.toThrow();
	for (const truth of [
		{ ...observation(), active: false },
		{ ...observation(), directChildIds: [] },
		{ ...observation(), canonicalThreadId: "wrong" },
		{
			...observation(),
			message: { ...observation().message, authorId: "other" },
		},
		{
			...observation(),
			message: { ...observation().message, channelId: "other" },
		},
		{ ...observation(), message: { ...observation().message, id: "other" } },
		{ ...observation(), now: "2026-09-14T20:02:00.000Z" },
		{ ...observation(), now: "2026-09-14T19:59:59.000Z" },
	])
		expect(() => validateEpicIntakeEvidence(evidence, truth)).toThrow();
});
it("accepts superseded only with observed inactive scope and still requires owner reply", () => {
	const evidence = {
		...result(),
		outcome: "superseded" as const,
		childIssueIds: [child],
	};
	expect(() => validateEpicIntakeEvidence(evidence, observation())).toThrow();
	expect(() =>
		validateEpicIntakeEvidence(evidence, {
			...observation(),
			active: false,
			directChildIds: [],
		}),
	).not.toThrow();
	expect(() =>
		validateEpicIntakeEvidence(evidence, {
			...observation(),
			active: false,
			leadBotUserId: "",
		}),
	).toThrow();
});

it("FLY-2597: accepts quiet durable records but requires a message for founder decisions", () => {
	const { threadId: _thread, messageId: _message, ...quiet } = result();
	expect(epicIntakeResultSchema.safeParse(quiet).success).toBe(true);
	expect(
		epicIntakeResultSchema.safeParse({
			...quiet,
			outcome: "needs_founder",
			founderQuestion: "Decide",
		}).success,
	).toBe(false);
	expect(
		epicIntakeResultSchema.safeParse({
			...quiet,
			receipt: { kind: "bridge_record", leadId: "forged", verifiedAt: at },
		}).success,
	).toBe(false);
	expect(() =>
		validateEpicIntakeEvidence(quiet, {
			...observation(),
			canonicalThreadId: null,
			message: null,
			leadBotUserId: null,
		}),
	).not.toThrow();
});
