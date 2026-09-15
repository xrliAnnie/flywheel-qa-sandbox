import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { scanEpicIntakes } from "../epic-intake.js";

const t0 = "2026-09-14T20:00:00.000Z";
const t1 = "2026-09-14T20:01:00.000Z";
const project: ProjectEntry = {
	projectName: "test",
	projectRoot: "/tmp/test",
	linear: { team: "TEST" },
	leads: [
		{
			agentId: "lead",
			chatChannel: "test-channel",
			match: { labels: ["Engineering"] },
		},
	],
};
function root(startedAt = t0) {
	return {
		id: "uuid",
		identifier: "TEST-1",
		title: "Test",
		url: "https://linear.app/test/issue/TEST-1",
		updatedAt: startedAt,
		team: { key: "TEST" },
		project: null,
		labels: ["Engineering"],
		parent: null,
		state: { type: "started", name: "In Progress" },
		hasChildIssues: false,
		episodes: [
			{
				eventUid: `epic_intake:uuid:${startedAt}`,
				startedAt,
				endedAt: null,
				sourceSpanIds: [startedAt],
				active: true,
			},
		],
	};
}
describe("coordinated intake scan", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});
	afterEach(() => store.close());
	it("backfills only the current old episode and redelivers the same durable receipt on retry", async () => {
		const collect = vi.fn().mockResolvedValue({
			fetchedAt: t1,
			candidates: [root()],
			missingIssueIds: [],
		});
		const enqueue = vi.fn();
		const options = {
			store,
			projects: [project],
			projectName: "test",
			apiKey: "test",
			collect,
			enqueue,
			now: () => new Date(t1),
		};
		await scanEpicIntakes(options);
		await scanEpicIntakes(options);
		expect(enqueue).toHaveBeenCalledTimes(2);
		expect(enqueue.mock.calls[0][0]).toEqual(enqueue.mock.calls[1][0]);
		expect(enqueue.mock.calls[0][0]).toMatchObject({ backfill: true });
		expect(store.listEpicIntakes("test")).toHaveLength(1);
	});

	it("refreshes changed root metadata without generating a new episode or refreshing unchanged scans", async () => {
		const current = root();
		const collect = vi.fn().mockResolvedValue({
			fetchedAt: t0,
			candidates: [current],
			missingIssueIds: [],
		});
		const options = {
			store,
			projects: [project],
			projectName: "test",
			apiKey: "fixture",
			collect,
			enqueue: vi.fn(),
			now: () => new Date(t0),
		};
		await scanEpicIntakes(options);
		store.clearPublishedEpicIntakes(store.listEpicIntakes("test"));
		collect.mockResolvedValue({
			fetchedAt: t1,
			candidates: [current],
			missingIssueIds: [],
		});
		await scanEpicIntakes({ ...options, now: () => new Date(t1) });
		expect(store.listEpicIntakes("test")[0]?.pageDirty).toBe(false);
		collect.mockResolvedValue({
			fetchedAt: "2026-09-14T20:02:00.000Z",
			candidates: [
				{
					...current,
					updatedAt: "2026-09-14T20:01:30.000Z",
					hasChildIssues: true,
				},
			],
			missingIssueIds: [],
		});
		await scanEpicIntakes({
			...options,
			now: () => new Date("2026-09-14T20:02:00.000Z"),
		});
		expect(store.listEpicIntakes("test")).toHaveLength(1);
		expect(store.listEpicIntakes("test")[0]?.pageDirty).toBe(true);
	});
	it("records a new entry normally and invalidates the old active episode", async () => {
		const collect = vi
			.fn()
			.mockResolvedValueOnce({
				fetchedAt: t0,
				candidates: [root()],
				missingIssueIds: [],
			})
			.mockResolvedValueOnce({
				fetchedAt: t1,
				candidates: [root(t1)],
				missingIssueIds: [],
			});
		const options = {
			store,
			projects: [project],
			projectName: "test",
			apiKey: "test",
			collect,
			enqueue: vi.fn(),
			now: () => new Date(t0),
		};
		await scanEpicIntakes(options);
		await scanEpicIntakes({ ...options, now: () => new Date(t1) });
		expect(
			store
				.listEpicIntakes("test")
				.map((r) => [r.startedAt, r.active, r.backfill]),
		).toEqual([
			[t0, false, false],
			[t1, true, false],
		]);
	});
	it.each(["inactive", "complete"])(
		"stops re-querying %s episodes while admitting new started entries from the change window",
		async (status) => {
			const collect = vi.fn().mockResolvedValue({
				fetchedAt: t0,
				candidates: [root()],
				missingIssueIds: [],
			});
			const options = {
				store,
				projects: [project],
				projectName: "test",
				apiKey: "fixture",
				collect,
				enqueue: vi.fn(),
				now: () => new Date(t0),
			};
			await scanEpicIntakes(options);
			const row = store.listEpicIntakes("test")[0]!;
			if (status === "inactive")
				store.setEpicIntakeActive(row.eventUid, false, t0);
			else
				store.resolveEpicIntake(
					row,
					{
						outcome: "complete",
						childIssueIds: [],
						firstBatchIssueIds: [],
						ledgerObservedAt: t0,
						threadId: "123456789012345678",
						messageId: "223456789012345678",
						founderQuestion: null,
					},
					t0,
				);
			collect.mockResolvedValue({
				fetchedAt: t1,
				candidates: [],
				missingIssueIds: [],
			});
			await scanEpicIntakes({ ...options, now: () => new Date(t1) });
			expect(collect.mock.calls[1]![2].pendingIssueIds).toEqual([]);
			collect.mockResolvedValue({
				fetchedAt: t1,
				candidates: [root(t1)],
				missingIssueIds: [],
			});
			await scanEpicIntakes({ ...options, now: () => new Date(t1) });
			expect(store.listEpicIntakes("test")).toHaveLength(2);
			expect(
				store.listEpicIntakes("test").find((r) => r.startedAt === t1),
			).toMatchObject({ active: true, workState: "pending" });
		},
	);

	it("keeps the old cursor on upstream failure", async () => {
		const collect = vi.fn().mockRejectedValue(new Error("history unavailable"));
		await expect(
			scanEpicIntakes({
				store,
				projects: [project],
				projectName: "test",
				apiKey: "test",
				collect,
				enqueue: vi.fn(),
				now: () => new Date(t0),
			}),
		).rejects.toThrow("history unavailable");
		expect(store.beginEpicIntakeScan("test", t1)).toMatchObject({
			bootstrapStartedAt: t0,
			bootstrapCompleted: false,
			lastSuccessfulScanStartedAt: null,
		});
	});
	it("retains the watermark and failed root activity while healthy intakes proceed, then recovers without duplicates", async () => {
		const collect = vi.fn().mockResolvedValue({
			fetchedAt: t0,
			candidates: [root()],
			missingIssueIds: [],
		});
		const options = {
			store,
			projects: [project],
			projectName: "test",
			apiKey: "fixture",
			collect,
			enqueue: vi.fn(),
			now: () => new Date(t0),
		};
		await scanEpicIntakes(options);
		const healthy = {
			...root(t1),
			id: "healthy",
			identifier: "TEST-2",
			episodes: [
				{ ...root(t1).episodes[0]!, eventUid: `epic_intake:healthy:${t1}` },
			],
		};
		collect.mockResolvedValue({
			fetchedAt: t1,
			candidates: [healthy],
			missingIssueIds: [],
			historyFailures: [
				{
					issueUuid: "uuid",
					identifier: "TEST-1",
					reason: "intake_history_unavailable",
				},
			],
		});
		await scanEpicIntakes({ ...options, now: () => new Date(t1) });
		expect(store.listEpicIntakes("test")).toHaveLength(2);
		expect(
			store.listEpicIntakes("test").find((r) => r.issueUuid === "uuid")?.active,
		).toBe(true);
		expect(
			store.beginEpicIntakeScan("test", t1).lastSuccessfulScanStartedAt,
		).toBe(t0);
		collect.mockResolvedValue({
			fetchedAt: t1,
			candidates: [root(), healthy],
			missingIssueIds: [],
			historyFailures: [],
		});
		await scanEpicIntakes({ ...options, now: () => new Date(t1) });
		expect(store.listEpicIntakes("test")).toHaveLength(2);
		expect(
			store.beginEpicIntakeScan("test", t1).lastSuccessfulScanStartedAt,
		).toBe(t1);
	});

	it("retains committed episode after enqueue failure and retries its exact sequence", async () => {
		const collect = vi.fn().mockResolvedValue({
			fetchedAt: t0,
			candidates: [root()],
			missingIssueIds: [],
		});
		const enqueue = vi
			.fn()
			.mockRejectedValueOnce(new Error("queue unavailable"))
			.mockResolvedValue(undefined);
		const options = {
			store,
			projects: [project],
			projectName: "test",
			apiKey: "test",
			collect,
			enqueue,
			now: () => new Date(t0),
		};
		await expect(scanEpicIntakes(options)).rejects.toThrow("queue unavailable");
		expect(store.listEpicIntakes("test")).toHaveLength(1);
		expect(store.beginEpicIntakeScan("test", t1).bootstrapCompleted).toBe(
			false,
		);
		await scanEpicIntakes(options);
		expect(enqueue.mock.calls[1][0].leadEventSeq).toBe(
			enqueue.mock.calls[0][0].leadEventSeq,
		);
	});
	it("does not append terminal history and invalidates a missing root", async () => {
		const collect = vi
			.fn()
			.mockResolvedValueOnce({
				fetchedAt: t0,
				candidates: [root()],
				missingIssueIds: [],
			})
			.mockResolvedValueOnce({
				fetchedAt: t1,
				candidates: [
					{ ...root(t1), state: { type: "completed", name: "Done" } },
				],
				missingIssueIds: [],
			})
			.mockResolvedValueOnce({
				fetchedAt: t1,
				candidates: [],
				missingIssueIds: ["uuid"],
			});
		const options = {
			store,
			projects: [project],
			projectName: "test",
			apiKey: "test",
			collect,
			enqueue: vi.fn(),
			now: () => new Date(t0),
		};
		await scanEpicIntakes(options);
		await scanEpicIntakes(options);
		await scanEpicIntakes(options);
		expect(store.listEpicIntakes("test")).toHaveLength(1);
		expect(store.listEpicIntakes("test")[0].active).toBe(false);
	});
});
