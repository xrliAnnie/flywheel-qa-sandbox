import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	createEpicPageRefresher,
	createEpicPageSerializer,
	EPIC_PAGE_REFRESH_DEBOUNCE_MS,
	runEpicPageAttempt,
} from "../epic-page-refresher.js";
import { LinearUpstreamError } from "../linear-query.js";

const projects: ProjectEntry[] = [
	{
		projectName: "example",
		projectRoot: "/tmp/example",
		leads: [],
		linear: { team: "EPX", project: "Example" },
	},
	{
		projectName: "unbound",
		projectRoot: "/tmp/unbound",
		leads: [],
	},
];

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve = (_value: T): void => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("EpicPageSerializer", () => {
	it("serializes one project while allowing another project to proceed", async () => {
		const serializer = createEpicPageSerializer();
		const release = deferred<void>();
		const order: string[] = [];
		const first = serializer.run("example", async () => {
			order.push("example:first:start");
			await release.promise;
			order.push("example:first:end");
		});
		const second = serializer.run("example", async () => {
			order.push("example:second");
		});
		const other = serializer.run("other", async () => {
			order.push("other");
		});

		await other;
		expect(order).toEqual(["example:first:start", "other"]);
		release.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual([
			"example:first:start",
			"other",
			"example:first:end",
			"example:second",
		]);
	});
});

describe("createEpicPageRefresher", () => {
	it("debounces a burst into one attempt with the complete reason union", async () => {
		vi.useFakeTimers();
		const runAttempt = vi.fn(async () => undefined);
		const refresher = createEpicPageRefresher({
			projects,
			linearApiKey: "linear-key",
			store: { insertEpicPageRefresh: vi.fn() },
			runAttempt,
		});
		const reasons = [
			"session_started",
			"session_completed",
			"session_failed",
			"run_started",
			"run_resumed",
			"linear_done",
			"dependency_changed",
		] as const;
		for (let index = 0; index < 20; index += 1) {
			refresher.requestRefresh("example", reasons[index % reasons.length]!);
		}

		expect(runAttempt).not.toHaveBeenCalled();
		await refresher.flushForTest();
		expect(runAttempt).toHaveBeenCalledOnce();
		expect(runAttempt).toHaveBeenCalledWith({
			projectName: "example",
			binding: projects[0]!.linear,
			apiKey: "linear-key",
			trigger: "event",
			reasons: [...reasons].sort(),
		});
	});

	it("keeps eight representative events separate across debounce windows", async () => {
		vi.useFakeTimers();
		const runAttempt = vi.fn(async () => undefined);
		const refresher = createEpicPageRefresher({
			projects,
			linearApiKey: "linear-key",
			store: { insertEpicPageRefresh: vi.fn() },
			runAttempt,
		});
		const reasons = [
			"session_started",
			"session_completed",
			"session_failed",
			"run_started",
			"run_resumed",
			"linear_done",
			"dependency_changed",
			"dependency_changed",
		] as const;

		for (const reason of reasons) {
			refresher.requestRefresh("example", reason);
			await vi.advanceTimersByTimeAsync(EPIC_PAGE_REFRESH_DEBOUNCE_MS);
		}
		await refresher.flushForTest();

		expect(runAttempt).toHaveBeenCalledTimes(8);
		expect(runAttempt.mock.calls.map(([input]) => input.reasons)).toEqual(
			reasons.map((reason) => [reason]),
		);
	});

	it("runs one trailing attempt for signals received in flight", async () => {
		vi.useFakeTimers();
		const first = deferred<void>();
		const runAttempt = vi
			.fn()
			.mockImplementationOnce(() => first.promise)
			.mockResolvedValueOnce(undefined);
		const refresher = createEpicPageRefresher({
			projects,
			linearApiKey: "linear-key",
			store: { insertEpicPageRefresh: vi.fn() },
			runAttempt,
		});

		refresher.requestRefresh("example", "session_started");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(runAttempt).toHaveBeenCalledOnce();
		refresher.requestRefresh("example", "run_started");
		refresher.requestRefresh("example", "dependency_changed");
		first.resolve();
		await refresher.flushForTest();

		expect(runAttempt).toHaveBeenCalledTimes(2);
		expect(runAttempt.mock.calls[1]?.[0]).toMatchObject({
			reasons: ["dependency_changed", "run_started"],
		});
	});

	it("never throws to event callers and contains attempt failures", async () => {
		vi.useFakeTimers();
		const log = vi.fn();
		const refresher = createEpicPageRefresher({
			projects,
			linearApiKey: "linear-key",
			store: { insertEpicPageRefresh: vi.fn() },
			runAttempt: vi.fn(async () => {
				throw new Error("attempt failed");
			}),
			log,
		});

		expect(
			refresher.requestRefresh("example", "session_completed"),
		).toBeUndefined();
		await expect(refresher.flushForTest()).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("attempt failed"));
	});

	it("records each unbound or unconfigured project skip only once", () => {
		vi.useFakeTimers();
		const insertEpicPageRefresh = vi.fn();
		const withKey = createEpicPageRefresher({
			projects,
			linearApiKey: "linear-key",
			store: { insertEpicPageRefresh },
			runAttempt: vi.fn(),
			now: () => new Date("2026-09-03T04:00:00.000Z"),
		});
		withKey.requestRefresh("unbound", "run_started");
		withKey.requestRefresh("unbound", "run_resumed");
		withKey.requestRefresh("missing", "session_started");
		withKey.requestRefresh("missing", "session_failed");

		const withoutKey = createEpicPageRefresher({
			projects,
			store: { insertEpicPageRefresh },
			runAttempt: vi.fn(),
			now: () => new Date("2026-09-03T04:00:00.000Z"),
		});
		withoutKey.requestRefresh("example", "session_started");
		withoutKey.requestRefresh("example", "session_completed");

		expect(insertEpicPageRefresh).toHaveBeenCalledTimes(3);
		expect(
			insertEpicPageRefresh.mock.calls.map(([input]) => input.outcome),
		).toEqual([
			"skipped: project_unbound",
			"skipped: project_unbound",
			"skipped: linear_not_configured",
		]);
	});
});

describe("runEpicPageAttempt", () => {
	function base() {
		const page = {
			freshness: { current: { value: { version: 4 } } },
		} as never;
		const receipt = { source_digest: "digest" } as never;
		const store = {
			getNextEpicPageVersion: vi.fn(() => 4),
			insertEpicPageRenderReceipt: vi.fn(() => ({ version: 4 })),
			insertEpicPageRefresh: vi.fn(),
		};
		const materialize = vi.fn(async () => ({
			page,
			snapshot: { items: [] },
			receipt,
		}));
		const publisher = {
			publishHosted: vi.fn(async () => "ok:4" as const),
		};
		return { store, materialize, publisher, page, receipt };
	}

	it("materializes once, writes one receipt, publishes, and settles once", async () => {
		const deps = base();
		const result = await runEpicPageAttempt(
			{
				...deps,
				serializer: createEpicPageSerializer(),
				now: () => new Date("2026-09-03T04:00:00.000Z"),
			},
			{
				projectName: "example",
				binding: projects[0]!.linear!,
				apiKey: "linear-key",
				trigger: "event",
				reasons: ["session_completed"],
			},
		);

		expect(result).toMatchObject({ kind: "materialized", outcome: "ok:4" });
		expect(deps.materialize).toHaveBeenCalledOnce();
		expect(deps.store.insertEpicPageRenderReceipt).toHaveBeenCalledOnce();
		expect(deps.publisher.publishHosted).toHaveBeenCalledOnce();
		expect(deps.store.insertEpicPageRefresh).toHaveBeenCalledOnce();
	});

	it("publishes and records one ok outcome for a scan attempt", async () => {
		const deps = base();
		const result = await runEpicPageAttempt(
			{
				...deps,
				serializer: createEpicPageSerializer(),
				now: () => new Date("2026-09-03T04:00:00.000Z"),
			},
			{
				projectName: "example",
				binding: projects[0]!.linear!,
				apiKey: "linear-key",
				trigger: "scan",
				reasons: ["scan"],
			},
		);

		expect(result).toMatchObject({ kind: "materialized", outcome: "ok:4" });
		expect(deps.publisher.publishHosted).toHaveBeenCalledOnce();
		expect(deps.store.insertEpicPageRefresh).toHaveBeenCalledOnce();
		expect(deps.store.insertEpicPageRefresh).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: "scan",
				reasons: ["scan"],
				outcome: "ok:4",
			}),
		);
	});

	it("records one canonical failure when materialization fails", async () => {
		const deps = base();
		deps.materialize.mockRejectedValueOnce(new LinearUpstreamError("secret"));

		const result = await runEpicPageAttempt(
			{
				...deps,
				serializer: createEpicPageSerializer(),
				now: () => new Date("2026-09-03T04:00:00.000Z"),
			},
			{
				projectName: "example",
				binding: projects[0]!.linear!,
				apiKey: "linear-key",
				trigger: "event",
				reasons: ["session_failed"],
			},
		);

		expect(result).toMatchObject({
			kind: "unavailable",
			token: "transient: linear_unavailable",
		});
		expect(deps.materialize).toHaveBeenCalledOnce();
		expect(deps.store.insertEpicPageRenderReceipt).not.toHaveBeenCalled();
		expect(deps.publisher.publishHosted).not.toHaveBeenCalled();
		expect(deps.store.insertEpicPageRefresh).toHaveBeenCalledOnce();
	});

	it("treats receipt drift as failed and does not publish", async () => {
		const deps = base();
		deps.store.insertEpicPageRenderReceipt.mockImplementationOnce(() => {
			throw new Error("epic_page_version_drift");
		});

		const result = await runEpicPageAttempt(
			{
				...deps,
				serializer: createEpicPageSerializer(),
				now: () => new Date("2026-09-03T04:00:00.000Z"),
			},
			{
				projectName: "example",
				binding: projects[0]!.linear!,
				apiKey: "linear-key",
				trigger: "scan",
				reasons: ["scan"],
			},
		);

		expect(result).toMatchObject({
			kind: "unavailable",
			token: "transient: epic_scan_failed",
		});
		expect(deps.publisher.publishHosted).not.toHaveBeenCalled();
		expect(deps.store.insertEpicPageRefresh).toHaveBeenCalledOnce();
		expect(deps.store.insertEpicPageRefresh).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: "scan",
				reasons: ["scan"],
				outcome: "transient: epic_scan_failed",
			}),
		);
	});

	it("manual generation settles without invoking the hosted publisher", async () => {
		const deps = base();
		const result = await runEpicPageAttempt(
			{
				...deps,
				serializer: createEpicPageSerializer(),
				now: () => new Date("2026-09-03T04:00:00.000Z"),
			},
			{
				projectName: "example",
				binding: projects[0]!.linear!,
				apiKey: "linear-key",
				trigger: "manual",
				reasons: ["manual"],
			},
		);

		expect(result).toMatchObject({
			kind: "materialized",
			outcome: "ok_unpublished:4:manual",
		});
		expect(deps.publisher.publishHosted).not.toHaveBeenCalled();
		expect(deps.store.insertEpicPageRefresh).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "ok_unpublished:4:manual" }),
		);
	});
});
