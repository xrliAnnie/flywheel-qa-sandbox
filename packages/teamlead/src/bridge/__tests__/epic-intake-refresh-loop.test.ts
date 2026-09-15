import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	migrateEpicIntakes,
	readEpicIntakeRefreshState,
	recordEpicIntakeRefreshResult,
} from "../epic-intake-store.js";
import {
	createEpicPageSerializer,
	runEpicPageAttempt,
} from "../epic-page-refresher.js";

const at = "2026-09-14T20:00:00.000Z";
let store: StateStore;
let dir: string;
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "epic-refresh-"));
	store = await StateStore.create(join(dir, "state.db"));
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});
function intake() {
	return store.recordEpicIntake({
		issueUuid: "uuid",
		identifier: "TEST-1",
		startedAt: at,
		intakeAt: at,
		observedAt: at,
		projectName: "test",
		leadId: "test-lead",
		bindingDigest: "test",
		sourceSpanIds: ["span"],
		backfill: false,
		active: true,
		hasChildIssues: true,
	})!;
}
const evidence = {
	outcome: "complete" as const,
	childIssueIds: [],
	firstBatchIssueIds: [],
	ledgerObservedAt: at,
	threadId: "123456789012345678",
	messageId: "223456789012345678",
	founderQuestion: null,
};
function fixture() {
	let time = Date.parse(at);
	const materialize = vi.fn(async () => ({
		page: { header: { roots: { value: [] } } } as never,
		snapshot: null,
		receipt: {} as never,
	}));
	const publisher = {
		publishHosted: vi.fn(
			async (): Promise<
				| "ok:1"
				| "transient: publish_failed:blob"
				| "ok_unpublished:1:skipped_hosting_not_configured"
				| "ok_unpublished:1:skipped_hosting_unsupported"
			> => "ok:1",
		),
	};
	const deps = {
		store: {
			getNextEpicPageVersion: () => 1,
			insertEpicPageRenderReceipt: () => ({ version: 1 }) as never,
			insertEpicPageRefresh: vi.fn((input) =>
				store.insertEpicPageRefresh(input),
			),
		},
		intakeStore: store,
		retryStore: store,
		serializer: createEpicPageSerializer(),
		materialize,
		publisher,
		now: () => new Date(time),
	};
	const run = (trigger: "event" | "scan" = "event") =>
		runEpicPageAttempt(deps, {
			projectName: "test",
			binding: { team: "TEST" },
			apiKey: "fixture",
			trigger,
			reasons: trigger === "event" ? ["epic_intake"] : ["scan"],
		});
	return {
		deps,
		materialize,
		publisher,
		run,
		advance: (ms: number) => {
			time += ms;
		},
	};
}
it.each(["complete", "superseded"] as const)(
	"does not reactivate terminal %s intake rows",
	(outcome) => {
		let row = intake();
		if (outcome === "superseded") {
			store.setEpicIntakeActive(row.eventUid, false, at);
			row = store
				.listEpicIntakes("test")
				.find((r) => r.eventUid === row.eventUid)!;
		}
		store.resolveEpicIntake(row, { ...evidence, outcome }, at);
		store.setEpicIntakeActive(row.eventUid, false, at);
		store.clearPublishedEpicIntakes(store.listEpicIntakes("test"));
		store.setEpicIntakeActive(row.eventUid, true, "2026-09-14T20:01:00.000Z");
		expect(
			store.listEpicIntakes("test").find((r) => r.eventUid === row.eventUid),
		).toMatchObject({ active: false, pageDirty: false, workState: outcome });
	},
);
it("clears captured dirty revisions after successful publish when the page omits intake cells", async () => {
	const row = intake();
	await fixture().run();
	expect(
		store.listEpicIntakes("test").find((r) => r.eventUid === row.eventUid)
			?.pageDirty,
	).toBe(false);
});
it("retains a newer dirty revision written during materialization", async () => {
	const row = intake();
	const f = fixture();
	f.materialize.mockImplementationOnce(async () => {
		store.markEpicIntakePageDirty(row.eventUid, "2026-09-14T20:01:00.000Z");
		return {
			page: { header: { roots: { value: [] } } } as never,
			snapshot: null,
			receipt: {} as never,
		};
	});
	await f.run();
	expect(
		store.listEpicIntakes("test").find((r) => r.eventUid === row.eventUid)
			?.pageDirty,
	).toBe(true);
});
it.each([
	"transient: publish_failed:blob",
	"ok_unpublished:1:skipped_hosting_not_configured",
	"ok_unpublished:1:skipped_hosting_unsupported",
] as const)(
	"bounds %s attempts across repeated dirty scans and restart",
	async (outcome) => {
		const row = intake();
		const f = fixture();
		f.publisher.publishHosted.mockResolvedValue(outcome);
		for (let tick = 0; tick < 120; tick++) {
			await f.run();
			f.advance(30_000);
		}
		expect(f.materialize).toHaveBeenCalledTimes(3);
		expect(f.deps.store.insertEpicPageRefresh).toHaveBeenCalledTimes(3);
		expect(f.deps.store.insertEpicPageRefresh).toHaveBeenLastCalledWith(
			expect.objectContaining({
				outcome: "structural: intake_not_refreshable",
			}),
		);
		expect(
			store.listEpicIntakes("test").find((r) => r.eventUid === row.eventUid)
				?.pageDirty,
		).toBe(true);
		expect(store.getEpicIntakeRefreshState("test")).toMatchObject({
			failures: 3,
			notRefreshable: true,
		});
		store.close();
		store = await StateStore.create(join(dir, "state.db"));
		const restarted = fixture();
		await restarted.run();
		expect(restarted.materialize).not.toHaveBeenCalled();
		// An independent normal scan can verify repaired hosting and re-arm intake refresh.
		await restarted.run("scan");
		expect(store.getEpicIntakeRefreshState("test")).toMatchObject({
			failures: 0,
			notRefreshable: false,
		});
	},
);
it("also bounds persistent materialization failures and keeps projects independent", async () => {
	intake();
	const f = fixture();
	f.materialize.mockRejectedValue(new Error("snapshot unavailable"));
	for (let tick = 0; tick < 120; tick++) {
		await f.run();
		f.advance(30_000);
	}
	expect(f.materialize).toHaveBeenCalledTimes(3);
	expect(f.deps.store.insertEpicPageRefresh).toHaveBeenCalledTimes(3);
	expect(f.deps.store.insertEpicPageRefresh).toHaveBeenLastCalledWith(
		expect.objectContaining({ outcome: "structural: intake_not_refreshable" }),
	);
	expect(store.getEpicIntakeRefreshState("other").notRefreshable).toBe(false);
});

it("upgrades the existing scan table idempotently without moving its watermark", () => {
	const db = new Database(":memory:");
	try {
		db.exec(
			"CREATE TABLE epic_intake_scan(project_name TEXT PRIMARY KEY,bootstrap_started_at TEXT NOT NULL,bootstrap_completed INTEGER NOT NULL DEFAULT 0,last_successful_scan_started_at TEXT)",
		);
		db.prepare("INSERT INTO epic_intake_scan VALUES (?,?,1,?)").run(
			"test",
			at,
			at,
		);
		migrateEpicIntakes(db);
		expect(readEpicIntakeRefreshState(db, "test")).toEqual({
			failures: 0,
			retryAt: null,
			notRefreshable: false,
		});
		recordEpicIntakeRefreshResult(db, "test", false, at);
		migrateEpicIntakes(db);
		expect(readEpicIntakeRefreshState(db, "test").failures).toBe(1);
		expect(
			db
				.prepare(
					"SELECT last_successful_scan_started_at FROM epic_intake_scan WHERE project_name=?",
				)
				.get("test"),
		).toEqual({ last_successful_scan_started_at: at });
	} finally {
		db.close();
	}
});
it("recovers after a transient failure only when the retry is due", async () => {
	const row = intake();
	const f = fixture();
	f.publisher.publishHosted.mockResolvedValueOnce(
		"transient: publish_failed:blob",
	);
	await f.run();
	f.advance(30_000);
	await f.run();
	expect(f.materialize).toHaveBeenCalledTimes(1);
	f.advance(30_000);
	await f.run();
	expect(f.materialize).toHaveBeenCalledTimes(2);
	expect(store.getEpicIntakeRefreshState("test").failures).toBe(0);
	expect(
		store.listEpicIntakes("test").find((r) => r.eventUid === row.eventUid)
			?.pageDirty,
	).toBe(false);
});
