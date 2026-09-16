import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { SummaryPresentationController } from "../summary-presentation-controller.js";

const TOKEN = "test-api-token";

function payload(roundId: string): string {
	return JSON.stringify({
		event_type: "summary_absorption_round",
		execution_id: roundId,
		project_name: "raya",
		contract_version: 2,
	});
}

async function prepareStore(slots: number[]) {
	const store = await StateStore.create(":memory:");
	const sourceDigests = { journal: "empty-at-cutover" };
	store.summaryPresentations.beginMigration({
		projectName: "raya",
		leadId: "raya",
		boundarySeq: 0,
		sourceDigests,
	});
	store.summaryPresentations.completeMigration({
		projectName: "raya",
		leadId: "raya",
		sourceDigests,
	});
	store.appendSummaryPresentationRounds(
		slots.map((slotStartMs) => {
			const eventId = `summary-absorption:${new Date(slotStartMs).toISOString()}`;
			return {
				leadId: "raya",
				eventId,
				projectName: "raya",
				slotStartMs,
				payload: payload(eventId),
			};
		}),
	);
	return store;
}

function controller(
	store: StateStore,
	handle: ReturnType<typeof vi.fn>,
): SummaryPresentationController {
	return new SummaryPresentationController({
		store,
		outbound: { handle },
		expectedApiToken: TOKEN,
		canonicalIdentity: {
			projectName: "raya",
			leadId: "raya",
			channelId: "123456789012345678",
		},
	});
}

async function beginAndRecordAll(
	ctrl: SummaryPresentationController,
	outcome: unknown = { changed: true },
) {
	const begun = await ctrl.handle({
		providedToken: TOKEN,
		body: { operation: "begin", projectName: "raya", leadId: "raya" },
	});
	expect(begun.httpStatus).toBe(200);
	const group = begun.body.group as { id: string };
	const members = begun.body.members as Array<{ roundId: string }>;
	for (const [index, member] of members.entries()) {
		const recorded = await ctrl.handle({
			providedToken: TOKEN,
			body: {
				operation: "record",
				projectName: "raya",
				leadId: "raya",
				groupId: group.id,
				roundId: member.roundId,
				businessState: "complete",
				outcome,
				evidenceRef: `ledger:${index}`,
			},
		});
		expect(recorded.httpStatus).toBe(200);
	}
	return { group, members };
}

describe("FLY-2619 summary presentation controller", () => {
	it("combines two backlog rounds into one durable substantive send", async () => {
		const store = await prepareStore([60_000, 120_000]);
		try {
			const handle = vi.fn(async () => ({
				httpStatus: 200,
				status: "sent" as const,
				messageId: "123456789012345679",
			}));
			const ctrl = controller(store, handle);
			const { group, members } = await beginAndRecordAll(ctrl);
			expect(members).toHaveLength(2);

			const finalized = await ctrl.handle({
				providedToken: TOKEN,
				body: {
					operation: "finalize",
					projectName: "raya",
					leadId: "raya",
					groupId: group.id,
					decision: "substantive",
					reason: "new founder-relevant fact",
					text: "两轮检查合并后，有一项新的产品判断值得你知道。",
				},
			});

			expect(finalized).toMatchObject({
				httpStatus: 200,
				body: { status: "sent", group: { state: "sent" } },
			});
			expect(handle).toHaveBeenCalledTimes(1);
			expect(handle.mock.calls[0]![0].body).toMatchObject({
				projectName: "raya",
				leadId: "raya",
				channelId: "123456789012345678",
				text: "两轮检查合并后，有一项新的产品判断值得你知道。",
				idempotencyKey: `summary-presentation:${group.id}`,
			});
			await ctrl.handle({
				providedToken: TOKEN,
				body: {
					operation: "finalize",
					projectName: "raya",
					leadId: "raya",
					groupId: group.id,
					decision: "substantive",
					reason: "new founder-relevant fact",
					text: "两轮检查合并后，有一项新的产品判断值得你知道。",
				},
			});
			expect(handle).toHaveBeenCalledTimes(1);
		} finally {
			store.close();
		}
	});

	it("records three empty rounds while producing zero founder-visible sends", async () => {
		const store = await prepareStore([60_000, 120_000, 180_000]);
		try {
			const handle = vi.fn();
			const ctrl = controller(store, handle);
			const { group, members } = await beginAndRecordAll(ctrl, {
				changed: false,
			});
			expect(members).toHaveLength(3);
			const finalized = await ctrl.handle({
				providedToken: TOKEN,
				body: {
					operation: "finalize",
					projectName: "raya",
					leadId: "raya",
					groupId: group.id,
					decision: "silent",
					reason: "three rounds contained no substantive change",
				},
			});
			expect(finalized).toMatchObject({
				httpStatus: 200,
				body: { status: "silent", group: { state: "silent" } },
			});
			expect(handle).not.toHaveBeenCalled();
			expect(store.summaryPresentations.listMembers(group.id)).toHaveLength(3);
		} finally {
			store.close();
		}
	});

	it.each([
		"本轮 1/2 份已交，内容如下。",
		"缺交：growth-lead",
		"summary-absorption:1970-01-01T00:01:00.000Z 有更新",
		"TypeError: merge failed at worker.ts:10:2",
	])("rejects founder-visible diagnostic pollution: %s", async (text) => {
		const store = await prepareStore([60_000, 120_000]);
		try {
			const handle = vi.fn();
			const ctrl = controller(store, handle);
			const { group } = await beginAndRecordAll(ctrl, {
				changed: true,
				rawError: "TypeError: merge failed at worker.ts:10:2",
			});
			const finalized = await ctrl.handle({
				providedToken: TOKEN,
				body: {
					operation: "finalize",
					projectName: "raya",
					leadId: "raya",
					groupId: group.id,
					decision: "substantive",
					reason: "test",
					text,
				},
			});
			expect(finalized).toMatchObject({
				httpStatus: 400,
				body: { status: "rejected" },
			});
			expect(handle).not.toHaveBeenCalled();
			expect(store.summaryPresentations.getGroup(group.id)?.state).toBe(
				"collecting",
			);
		} finally {
			store.close();
		}
	});

	it("marks an uncertain send ambiguous and lets a later substantive group proceed", async () => {
		const store = await prepareStore([60_000]);
		try {
			const handle = vi
				.fn()
				.mockRejectedValueOnce(
					new Error("socket closed after Discord accepted"),
				)
				.mockResolvedValueOnce({
					httpStatus: 200,
					status: "sent",
					messageId: "123456789012345680",
				});
			const ctrl = controller(store, handle);
			const first = await beginAndRecordAll(ctrl);
			const uncertain = await ctrl.handle({
				providedToken: TOKEN,
				body: {
					operation: "finalize",
					projectName: "raya",
					leadId: "raya",
					groupId: first.group.id,
					decision: "substantive",
					reason: "first fact",
					text: "第一项有价值的新进展。",
				},
			});
			expect(uncertain).toMatchObject({
				httpStatus: 409,
				body: { status: "ambiguous" },
			});

			const eventId = "summary-absorption:1970-01-01T00:02:00.000Z";
			store.appendSummaryPresentationRounds([
				{
					leadId: "raya",
					eventId,
					projectName: "raya",
					slotStartMs: 120_000,
					payload: payload(eventId),
				},
			]);
			const second = await beginAndRecordAll(ctrl);
			expect(second.group.id).not.toBe(first.group.id);
			const sent = await ctrl.handle({
				providedToken: TOKEN,
				body: {
					operation: "finalize",
					projectName: "raya",
					leadId: "raya",
					groupId: second.group.id,
					decision: "substantive",
					reason: "second fact",
					text: "第二项有价值的新进展。",
				},
			});
			expect(sent).toMatchObject({ httpStatus: 200, body: { status: "sent" } });
			expect(handle).toHaveBeenCalledTimes(2);
		} finally {
			store.close();
		}
	});
});
