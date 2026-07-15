/**
 * FLY-191 Phase 2 — HeartbeatService.checkAwaitingReviewTimeout.
 *
 * Bridge-side review timeout: expired awaiting_review windows emit ONE
 * `gate_timed_out` via loopback /events (canonical FLY-159 escalation),
 * runner is NOT killed/transitioned. Dedup is the persisted
 * `gate_timeout_notified_at` stamp; ingest failure retries next cycle.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type HeartbeatNotifier,
	HeartbeatService,
} from "../HeartbeatService.js";
import { StateStore } from "../StateStore.js";

const EXEC = "exec-fly191-timeout";

function noopNotifier(): HeartbeatNotifier {
	return {
		onSessionStuck: vi.fn(),
		onSessionOrphaned: vi.fn(),
		onSessionStale: vi.fn(),
		onSessionMonitoringLost: vi.fn(),
	};
}

function backdateEnteredAt(
	store: StateStore,
	executionId: string,
	hoursAgo: number,
): void {
	// biome-ignore lint/complexity/useLiteralKeys: tests reach the raw sql.js db
	(store as unknown as { db: import("sql.js").Database })["db"].run(
		`UPDATE sessions SET awaiting_review_entered_at = datetime('now', '-${hoursAgo} hours') WHERE execution_id = ?`,
		[executionId],
	);
}

describe("HeartbeatService.checkAwaitingReviewTimeout (FLY-191 Phase 2)", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: EXEC,
			issue_id: "FLY-191",
			project_name: "flywheel",
			status: "running",
		});
		store.persistTransition(EXEC, "awaiting_review", {
			issue_id: "FLY-191",
			project_name: "flywheel",
		});
	});

	function makeService(fetchFn: typeof fetch): HeartbeatService {
		return new HeartbeatService(
			store,
			noopNotifier(),
			30,
			60_000,
			61,
			undefined,
			24,
			6 * 3_600_000,
			{
				bridgeBaseUrl: "http://127.0.0.1:9999",
				ingestToken: "tok",
				fetchFn,
			},
			48,
		);
	}

	it("emits gate_timed_out via loopback once and stamps the dedup column", async () => {
		backdateEnteredAt(store, EXEC, 50);
		const fetchFn = vi.fn(
			async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
		) as unknown as typeof fetch;
		const svc = makeService(fetchFn);

		await svc.checkAwaitingReviewTimeout();

		expect(fetchFn).toHaveBeenCalledTimes(1);
		const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(url).toBe("http://127.0.0.1:9999/events");
		const body = JSON.parse(init.body as string);
		expect(body.event_type).toBe("gate_timed_out");
		expect(body.execution_id).toBe(EXEC);
		expect(body.payload.checkpoint).toBe("approve_to_ship");
		expect(body.payload.timeout_behavior_source).toBe("bridge");
		expect(body.payload.original_message).toContain("NOT killed");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok",
		);

		// Runner NOT transitioned — still awaiting_review (escalation only)
		expect(store.getSession(EXEC)?.status).toBe("awaiting_review");

		// Dedup: second cycle emits nothing
		await svc.checkAwaitingReviewTimeout();
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("does NOT emit inside the review window", async () => {
		backdateEnteredAt(store, EXEC, 10); // 10h < 48h
		const fetchFn = vi.fn() as unknown as typeof fetch;
		await makeService(fetchFn).checkAwaitingReviewTimeout();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("retries next cycle when ingest fails (no premature dedup stamp)", async () => {
		backdateEnteredAt(store, EXEC, 50);
		vi.spyOn(console, "error").mockImplementation(() => {});
		let calls = 0;
		const fetchFn = vi.fn(async () => {
			calls++;
			if (calls === 1) return new Response("boom", { status: 503 });
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as unknown as typeof fetch;
		const svc = makeService(fetchFn);

		await svc.checkAwaitingReviewTimeout(); // 503 → no stamp
		expect(store.getSession(EXEC)?.gate_timeout_notified_at).toBeUndefined();

		await svc.checkAwaitingReviewTimeout(); // 200 → stamp
		expect(store.getSession(EXEC)?.gate_timeout_notified_at).toBeTruthy();
		expect(calls).toBe(2);
		vi.restoreAllMocks();
	});

	it("re-review reset re-arms the escalation for the new window", async () => {
		backdateEnteredAt(store, EXEC, 50);
		const fetchFn = vi.fn(
			async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
		) as unknown as typeof fetch;
		const svc = makeService(fetchFn);

		await svc.checkAwaitingReviewTimeout();
		expect(fetchFn).toHaveBeenCalledTimes(1);

		// changes_requested → runner re-requests review → window reset
		store.resetAwaitingReviewWindow(EXEC);
		backdateEnteredAt(store, EXEC, 50); // new window also expires
		await svc.checkAwaitingReviewTimeout();
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("is a no-op without the loopback wiring (legacy/test construction)", async () => {
		backdateEnteredAt(store, EXEC, 50);
		const svc = new HeartbeatService(store, noopNotifier(), 30, 60_000, 61);
		await expect(svc.checkAwaitingReviewTimeout()).resolves.toBeUndefined();
		expect(store.getSession(EXEC)?.gate_timeout_notified_at).toBeUndefined();
	});
});
