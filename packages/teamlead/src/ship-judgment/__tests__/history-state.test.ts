import { expect, it } from "vitest";
import { historyContentDigest } from "../history-pages.js";
import { bindingFixture, NOW } from "./binding-fixture.js";

it("durably reserves rounds, restores a frozen partial manifest and rejects stale leases", async () => {
	const { store } = await bindingFixture();
	try {
		const state = store.getShipJudgmentHistoryState(),
			now = Date.parse(NOW);
		const claim = state.claim("one", now);
		expect(claim.status).toBe("claimed");
		if (claim.status !== "claimed") throw new Error(claim.status);
		const snapshot = store.getShipJudgmentHistory().read(NOW);
		expect(
			state.begin(claim, snapshot, "https://reports.example.com", now).status,
		).toBe("building");
		const page = {
			token: "a".repeat(32),
			url: "https://reports.example.com/r/" + "a".repeat(32),
			html: "<!doctype html><html><head></head><body>fixture</body></html>",
			createdAt: NOW,
		};
		expect(state.stagePage(claim, 1, page, now + 1)).toBe(true);
		expect(state.fail(claim, "transport_failed", now + 2)).toBe(true);
		const restarted = store.getShipJudgmentHistoryState();
		expect(restarted.claim("two", now + 120001).status).toBe("deferred");
		const next = restarted.claim("two", now + 1800000);
		if (next.status !== "claimed") throw new Error(next.status);
		const changedRows = snapshot.rows.map((row) => ({
			...row,
			summary: "new snapshot",
		}));
		const resumed = restarted.begin(
			next,
			{
				...snapshot,
				rows: changedRows,
				digest: historyContentDigest(changedRows),
				asOf: new Date(now + 1800000).toISOString(),
			},
			"https://reports.example.com",
			now + 1800000,
		);
		expect(resumed).toMatchObject({
			status: "building",
			manifest: { asOf: NOW, pages: [page] },
		});
		expect(state.verifyPage(claim, 1, now + 1800001)).toBe(false);
		expect(restarted.verifyPage(next, 1, now + 1800001)).toBe(true);
		expect(restarted.finish(next, now + 1800002)).toBe(true);
		expect(restarted.view()).toMatchObject({
			url: page.url,
			asOf: NOW,
			error: null,
			dirty: true,
		});
	} finally {
		store.close();
	}
});
it("keeps the previous entry on failure and performs unchanged versus renewal decisions", async () => {
	const { store, db } = await bindingFixture();
	try {
		const state = store.getShipJudgmentHistoryState(),
			now = Date.parse(NOW),
			snapshot = store.getShipJudgmentHistory().read(NOW);
		const claim = state.claim("one", now);
		if (claim.status !== "claimed") throw new Error(claim.status);
		state.begin(claim, snapshot, "https://reports.example.com", now);
		const page = {
			token: "b".repeat(32),
			url: "https://reports.example.com/r/" + "b".repeat(32),
			html: "<html></html>",
			createdAt: NOW,
		};
		state.stagePage(claim, 1, page, now);
		state.verifyPage(claim, 1, now);
		state.finish(claim, now);
		const unchanged = state.claim("two", now + 1800000);
		if (unchanged.status !== "claimed") throw new Error(unchanged.status);
		expect(
			state.begin(
				unchanged,
				snapshot,
				"https://reports.example.com",
				now + 1800000,
			).status,
		).toBe("unchanged");
		expect(state.view()).toMatchObject({ url: page.url, asOf: NOW });
		const failedQuery = state.claim("query-failed", now + 3600000);
		if (failedQuery.status !== "claimed") throw new Error(failedQuery.status);
		state.fail(failedQuery, "query_failed", now + 3600001);
		const recovered = state.claim("query-recovered", now + 5400000);
		if (recovered.status !== "claimed") throw new Error(recovered.status);
		expect(
			state.begin(
				recovered,
				snapshot,
				"https://reports.example.com",
				now + 5400000,
			).status,
		).toBe("unchanged");
		expect(state.view().error).toBeNull();
		const renew = state.claim("three", now + 12 * 86400000);
		if (renew.status !== "claimed") throw new Error(renew.status);
		expect(
			state.begin(
				renew,
				snapshot,
				"https://reports.example.com",
				now + 12 * 86400000,
			),
		).toMatchObject({ status: "building", manifest: { reason: "renewal" } });
		db.prepare(
			"UPDATE ship_judgment_project_state SET history_dirty=1 WHERE project_name='flywheel'",
		).run();
		state.fail(renew, "verification_failed", now + 12 * 86400000 + 1);
		expect(state.view()).toMatchObject({
			url: page.url,
			asOf: NOW,
			error: "verification_failed",
			dirty: true,
		});
	} finally {
		store.close();
	}
});

it("preserves staged tokens and the thirty-minute deadline through a real database close and reopen", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { StateStore } = await import("../../StateStore.js");
	const dir = mkdtempSync(join(tmpdir(), "history-state-")),
		path = join(dir, "fixture.db");
	let store = await StateStore.create(path);
	try {
		const now = Date.parse(NOW),
			state = store.getShipJudgmentHistoryState();
		const claim = state.claim("before", now);
		if (claim.status !== "claimed") throw new Error(claim.status);
		const snapshot = store.getShipJudgmentHistory().read(NOW);
		state.begin(claim, snapshot, "https://reports.example.com", now);
		const page = {
			token: "c".repeat(32),
			url: "https://reports.example.com/r/" + "c".repeat(32),
			html: "<html></html>",
			createdAt: NOW,
		};
		state.stagePage(claim, 1, page, now);
		store.close();
		store = await StateStore.create(path);
		const reopened = store.getShipJudgmentHistoryState();
		expect(reopened.claim("early", now + 121000).status).toBe("deferred");
		const next = reopened.claim("after", now + 1800000);
		if (next.status !== "claimed") throw new Error(next.status);
		expect(
			reopened.begin(
				next,
				snapshot,
				"https://reports.example.com",
				now + 1800000,
			),
		).toMatchObject({
			status: "building",
			manifest: { pages: [page], asOf: NOW },
		});
		expect(() => reopened.finish(next, now + 1800000)).toThrow(
			"history_manifest_incomplete",
		);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("requires backward verified order, unique page tokens and a live lease", async () => {
	const { store } = await bindingFixture();
	try {
		const state = store.getShipJudgmentHistoryState(),
			now = Date.parse(NOW);
		const snapshot = store.getShipJudgmentHistory().read(NOW);
		const rows = Array.from({ length: 21 }, (_, n) => ({
			...snapshot.rows[0]!,
			questionId: "q" + n,
		}));
		const claim = state.claim("worker", now);
		if (claim.status !== "claimed") throw new Error(claim.status);
		state.begin(
			claim,
			{ ...snapshot, rows, digest: historyContentDigest(rows) },
			"https://reports.example.com",
			now,
		);
		const page = {
			token: "d".repeat(32),
			url: "https://reports.example.com/r/" + "d".repeat(32),
			html: "<html></html>",
			createdAt: NOW,
		};
		expect(() => state.stagePage(claim, 1, page, now)).toThrow(
			"history_next_not_verified",
		);
		state.stagePage(claim, 2, page, now);
		state.verifyPage(claim, 2, now);
		expect(() => state.stagePage(claim, 1, page, now)).toThrow(
			"history_page_token_reused",
		);
		expect(state.verifyPage(claim, 2, now + 120000)).toBe(false);
		expect(state.finish(claim, now + 120000)).toBe(false);
	} finally {
		store.close();
	}
});
