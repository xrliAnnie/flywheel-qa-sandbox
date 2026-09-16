import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
	customerReleaseReport,
	renderCustomerReleaseSummary,
} from "../customer-release/report.js";
import { CustomerReleaseStore } from "../customer-release/store.js";
import { renderDigestHtml } from "../digest-service.js";

const dbs: Database.Database[] = [];
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
});
it("reports uncaptured and partially delivered audit honestly without changing source facts", () => {
	const db = new Database(":memory:");
	dbs.push(db);
	const store = new CustomerReleaseStore(db);
	store.migrate();
	db.prepare(
		"INSERT INTO customer_release_activation_events VALUES (?,?,?,?,?,?)",
	).run(
		"slot:flywheel:2026-09-14",
		"flywheel",
		1,
		"cycle_slot_missed",
		JSON.stringify({ weekStart: "2026-09-14", reason: "no_candidate" }),
		100,
	);
	expect(customerReleaseReport(db, 200).accounting).toEqual({
		sourceEvents: 1,
		linear: { delivered: 0, pending: 1 },
		github: { delivered: 0, pending: 1 },
		consistent: false,
	});
	store.accounting.capture(200);
	db.prepare(
		"UPDATE customer_release_projections SET state='delivered' WHERE target='linear'",
	).run();
	const before = db.prepare("SELECT total_changes() AS n").get();
	const report = customerReleaseReport(db, 300);
	expect(report.accounting).toMatchObject({
		linear: { delivered: 1, pending: 0 },
		github: { delivered: 0, pending: 1 },
		consistent: false,
	});
	expect(report.cycles).toEqual([]);
	expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
	db.prepare(
		"UPDATE customer_release_projections SET state='delivered' WHERE target='github'",
	).run();
	expect(customerReleaseReport(db, 400).accounting.consistent).toBe(true);
});

it("renders pending ledgers and escapes labels without claiming a publication or consistency", () => {
	const html = renderCustomerReleaseSummary({
		observedAt: 300,
		missedSlots: [],
		accounting: {
			sourceEvents: 1,
			linear: { delivered: 1, pending: 0 },
			github: { delivered: 0, pending: 1 },
			consistent: false,
		},
		cyclesTruncated: false,
		cycles: [
			{
				cycleId: "c",
				releaseId: "<script>alert(1)</script>",
				version: null,
				slotDate: "2026-09-15",
				state: "commit_unknown",
				cancelReason: null,
				windowOpenedAt: null,
				deadlineAt: null,
				origin: "manual_intake",
				results: [],
			},
		],
	});
	expect(html).toContain("GitHub 待补 1");
	expect(html).toContain("发布结果未确认");
	expect(html).toContain("&lt;script&gt;");
	expect(html).not.toContain("<script>");
	expect(html).not.toContain("三本账一致");
});

it("adds the current audit snapshot to the daily digest without counting it as a deployment", () => {
	const html = renderDigestHtml(
		{
			date: "2026-09-15",
			projects: [],
			shippedCount: 0,
			completedNotLiveCount: 0,
		},
		{
			customerRelease: {
				observedAt: 300,
				missedSlots: [],
				accounting: {
					sourceEvents: 1,
					linear: { delivered: 0, pending: 1 },
					github: { delivered: 0, pending: 1 },
					consistent: false,
				},
				cycles: [],
				cyclesTruncated: false,
			},
		},
	);
	expect(html).toContain("客户发布审计");
	expect(html).toContain("今日上线 0");
	expect(html).toContain("Linear 待补 1");
});

it("shows why an activation slot did not publish even when no candidate cycle exists", () => {
	const db = new Database(":memory:");
	dbs.push(db);
	const store = new CustomerReleaseStore(db);
	store.migrate();
	db.prepare(
		"INSERT INTO customer_release_activation_events VALUES (?,?,?,?,?,?)",
	).run(
		"slot:flywheel:2026-09-14",
		"flywheel",
		1,
		"cycle_slot_missed",
		JSON.stringify({ weekStart: "2026-09-14", reason: "unknown" }),
		100,
	);
	const html = renderCustomerReleaseSummary(customerReleaseReport(db, 200));
	expect(html).toContain("2026-09-14");
	expect(html).toContain("信号未知，本周未自动发布");
});
