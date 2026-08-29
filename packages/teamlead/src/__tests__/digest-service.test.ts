/**
 * FLY-727: daily deployment digest — aggregation + render + StateStore tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AggregateContext,
	aggregateDeploymentDigest,
	cleanSummary,
	dateStringInZone,
	MAX_DIGEST_HTML_BYTES,
	parseSqliteUtc,
	renderDigestHtml,
} from "../bridge/digest-service.js";
import type {
	CompletionEventRow,
	DeploymentEventRow,
	SessionInfo,
} from "../StateStore.js";
import { StateStore } from "../StateStore.js";

function dep(over: Partial<DeploymentEventRow>): DeploymentEventRow {
	return {
		id: Math.floor(Math.random() * 1e9),
		project_name: "flywheel",
		issue_identifier: "FLY-1",
		pr_number: null,
		merge_sha: null,
		deployed_sha: null,
		deploy_batch_id: null,
		environment: "production",
		source: "self-ship",
		source_event_id: null,
		deployed_at: "2026-06-30 20:00:00",
		recorded_at: "2026-06-30 20:00:01",
		metadata_json: null,
		...over,
	};
}

function ctx(over: Partial<AggregateContext>): AggregateContext {
	return {
		deployments: [],
		sessionByKey: new Map(),
		completions: [],
		day: "2026-06-30",
		tz: "America/Los_Angeles",
		...over,
	};
}

// ─── time helpers (DST) ──────────────────────────────────────────────

describe("dateStringInZone / parseSqliteUtc (DST-safe PT day)", () => {
	it("maps a UTC instant to its Pacific civil date", () => {
		expect(
			dateStringInZone(
				parseSqliteUtc("2026-07-01 05:00:00"),
				"America/Los_Angeles",
			),
		).toBe("2026-06-30");
	});
	it("spring-forward day (2026-03-08) resolves correctly", () => {
		expect(
			dateStringInZone(
				parseSqliteUtc("2026-03-08 09:59:00"),
				"America/Los_Angeles",
			),
		).toBe("2026-03-08");
	});
	it("fall-back day (2026-11-01) resolves correctly", () => {
		expect(
			dateStringInZone(
				parseSqliteUtc("2026-11-01 08:00:00"),
				"America/Los_Angeles",
			),
		).toBe("2026-11-01");
	});
});

// ─── aggregateDeploymentDigest ───────────────────────────────────────

// FLY-727 (QA FLY-739): the real staging E2E found session.summary is often a raw
// diff / merge-commit body, which must never reach the digest as the "what they did".
describe("cleanSummary", () => {
	it("keeps a clean commit-subject first line", () => {
		expect(
			cleanSummary(
				"fix(FLY-694): harden re-exec guard per Codex review (LOW-1)",
			),
		).toBe("fix(FLY-694): harden re-exec guard per Codex review (LOW-1)");
	});
	it("drops a raw diff (starts with `diff --git`)", () => {
		expect(
			cleanSummary(
				"diff --git a/.flywheel/config.yaml b/.flywheel/config.yaml\nindex ec46b..\n@@ -1 +1 @@",
			),
		).toBeUndefined();
	});
	it("drops a merge-commit body", () => {
		expect(
			cleanSummary(
				"Merge remote-tracking branch 'origin/main' into flywheel-FLY-637",
			),
		).toBeUndefined();
	});
	it("drops git plumbing (`index`, `+++`, `@@`)", () => {
		expect(cleanSummary("index 1234abc..def5678 100644")).toBeUndefined();
		expect(cleanSummary("@@ -10,7 +10,9 @@ function foo()")).toBeUndefined();
	});
	it("skips leading blank lines to the first prose line", () => {
		expect(cleanSummary("\n\n  token report — add $ cost estimate  \n")).toBe(
			"token report — add $ cost estimate",
		);
	});
	it("returns undefined for null / empty / whitespace-only", () => {
		expect(cleanSummary(null)).toBeUndefined();
		expect(cleanSummary(undefined)).toBeUndefined();
		expect(cleanSummary("")).toBeUndefined();
		expect(cleanSummary("   \n  ")).toBeUndefined();
	});
});

describe("aggregateDeploymentDigest", () => {
	it("empty → empty report", () => {
		const r = aggregateDeploymentDigest(ctx({}));
		expect(r.projects).toEqual([]);
		expect(r.shippedCount).toBe(0);
	});

	it("groups by project (flywheel first), counts shipped", () => {
		const deployments = [
			dep({ project_name: "geoforge3d", issue_identifier: "GEO-2" }),
			dep({ project_name: "flywheel", issue_identifier: "FLY-1" }),
		];
		const r = aggregateDeploymentDigest(ctx({ deployments }));
		expect(r.projects.map((p) => p.projectName)).toEqual([
			"flywheel",
			"geoforge3d",
		]);
		expect(r.shippedCount).toBe(2);
	});

	it("filters deployments outside the PT target day", () => {
		const deployments = [
			// 2026-07-02 07:00 UTC = 2026-07-02 00:00 PDT → not June 30
			dep({ issue_identifier: "FLY-9", deployed_at: "2026-07-02 07:00:00" }),
		];
		const r = aggregateDeploymentDigest(ctx({ deployments }));
		expect(r.projects).toEqual([]);
	});

	it("dedups same issue to the latest deploy of the day", () => {
		const deployments = [
			dep({
				issue_identifier: "FLY-5",
				deployed_at: "2026-06-30 10:00:00",
				source: "self-ship",
			}),
			dep({
				issue_identifier: "FLY-5",
				deployed_at: "2026-06-30 20:00:00",
				source: "manual",
			}),
		];
		const r = aggregateDeploymentDigest(ctx({ deployments }));
		const items = r.projects.flatMap((p) => p.items);
		expect(items).toHaveLength(1);
		expect(items[0]!.source).toBe("manual"); // latest wins
	});

	it("enriches from sessions by issue; no-session row still renders", () => {
		const deployments = [
			dep({ issue_identifier: "FLY-7", pr_number: 7 }),
			dep({ issue_identifier: "FLY-8" }), // no session
		];
		const sessionByKey = new Map<string, SessionInfo>([
			[
				"i:FLY-7",
				{ issue_title: "Enriched", summary: "did the thing", pr_number: 7 },
			],
		]);
		const r = aggregateDeploymentDigest(ctx({ deployments, sessionByKey }));
		const items = r.projects[0]!.items;
		const f7 = items.find((i) => i.identifier === "FLY-7")!;
		const f8 = items.find((i) => i.identifier === "FLY-8")!;
		expect(f7.title).toBe("Enriched");
		expect(f7.summary).toBe("did the thing");
		expect(f8.title).toBeUndefined();
		expect(f8.summary).toBeUndefined(); // renders "摘要暂缺"
	});

	it("marks source=fallback-git-log as inferred", () => {
		const deployments = [
			dep({ issue_identifier: "FLY-6", source: "fallback-git-log" }),
		];
		const r = aggregateDeploymentDigest(ctx({ deployments }));
		expect(r.projects[0]!.items[0]!.inferred).toBe(true);
	});

	it("counts completed-today-not-live (secondary context)", () => {
		const deployments = [
			dep({ project_name: "flywheel", issue_identifier: "FLY-1" }),
		];
		const completions: CompletionEventRow[] = [
			// FLY-1 both completed + deployed → not counted
			{
				id: 1,
				ts: "2026-06-30 19:00:00",
				execution_id: "e1",
				issue_id: "FLY-1",
				project_name: "flywheel",
			},
			// FLY-99 completed today, NOT deployed → counted
			{
				id: 2,
				ts: "2026-06-30 19:00:00",
				execution_id: "e2",
				issue_id: "FLY-99",
				project_name: "flywheel",
			},
		];
		const r = aggregateDeploymentDigest(ctx({ deployments, completions }));
		expect(r.completedNotLiveCount).toBe(1);
	});
});

// ─── renderDigestHtml ────────────────────────────────────────────────

describe("renderDigestHtml", () => {
	it("empty fleet renders the no-deploy state (Apple-light)", () => {
		const html = renderDigestHtml({
			date: "2026-06-30",
			projects: [],
			shippedCount: 0,
			completedNotLiveCount: 0,
		});
		expect(html).toContain("今日无上线");
		expect(html).toContain("-apple-system");
		expect(html).toContain("#f5f5f7");
	});

	it("renders deployed rows + PR + summary/摘要暂缺 + footer + inferred note; escapes HTML", () => {
		const html = renderDigestHtml(
			{
				date: "2026-06-30",
				projects: [
					{
						projectName: "flywheel",
						items: [
							{
								identifier: "FLY-1",
								prNumber: 7,
								title: "Title <script>",
								summary: "did & shipped",
								source: "self-ship",
								inferred: false,
								deployedAt: "2026-06-30 20:00:00",
							},
							{
								identifier: "FLY-2",
								source: "fallback-git-log",
								inferred: true,
								deployedAt: "2026-06-30 19:00:00",
							},
						],
					},
				],
				shippedCount: 2,
				completedNotLiveCount: 3,
			},
			{ linearBaseUrl: "https://linear.app/x/issue" },
		);
		expect(html).toContain("🚀 今日上线 2");
		expect(html).toContain("PR #7");
		expect(html).toContain("did &amp; shipped");
		expect(html).toContain("摘要暂缺"); // FLY-2 has no summary
		expect(html).toContain("另有 3 个今日完成但尚未上线");
		expect(html).toContain("&lt;script&gt;"); // escaped once
		expect(html).toContain("https://linear.app/x/issue/FLY-1");
		expect(html).toContain("已上线*"); // inferred badge
	});

	it("stays within the 512 KiB budget with many long-summary rows", () => {
		const items = Array.from({ length: 500 }, (_, i) => ({
			identifier: `FLY-${i}`,
			title: "T".repeat(200),
			summary: "S".repeat(5000),
			source: "self-ship",
			inferred: false,
			deployedAt: `2026-06-30 ${String(i % 24).padStart(2, "0")}:00:00`,
		}));
		const html = renderDigestHtml({
			date: "2026-06-30",
			projects: [{ projectName: "flywheel", items }],
			shippedCount: 500,
			completedNotLiveCount: 0,
		});
		expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(
			MAX_DIGEST_HTML_BYTES,
		);
		expect(html).toContain("more");
	});
});

// ─── StateStore.insertDeploymentEvent / getDeploymentEventsInRange ────

describe("StateStore deployment_events", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});
	afterEach(() => store.close());

	it("inserts + reads back in range; excludes out-of-range", () => {
		const r1 = store.insertDeploymentEvent({
			projectName: "flywheel",
			issueIdentifier: "fly-1",
			prNumber: 10,
			mergeSha: "A".repeat(40),
			deployedSha: "B".repeat(40),
			source: "self-ship",
			deployedAt: "2026-06-30 20:00:00",
		});
		expect(r1.inserted).toBe(true);
		const rows = store.getDeploymentEventsInRange(
			"2026-06-30 00:00:00",
			"2026-07-01 00:00:00",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.issue_identifier).toBe("FLY-1"); // normalized uppercase
		expect(rows[0]!.merge_sha).toBe("a".repeat(40)); // normalized lowercase
		const none = store.getDeploymentEventsInRange(
			"2026-07-01 00:00:00",
			"2026-07-02 00:00:00",
		);
		expect(none).toHaveLength(0);
	});

	it("dedups identical identity (INSERT OR IGNORE) → one row", () => {
		const input = {
			projectName: "flywheel",
			issueIdentifier: "FLY-1",
			mergeSha: "c".repeat(40),
			source: "self-ship",
			deployedAt: "2026-06-30 20:00:00",
		};
		expect(store.insertDeploymentEvent(input).inserted).toBe(true);
		expect(store.insertDeploymentEvent(input).inserted).toBe(false); // dedup hit
		const rows = store.getDeploymentEventsInRange(
			"2026-06-30 00:00:00",
			"2026-07-01 00:00:00",
		);
		expect(rows).toHaveLength(1);
	});

	it("distinct source_event_id (no SHA) → two rows (not collapsed)", () => {
		const base = {
			projectName: "geoforge3d",
			prNumber: 5,
			source: "vercel",
			deployedAt: "2026-06-30 20:00:00",
		};
		expect(
			store.insertDeploymentEvent({ ...base, sourceEventId: "dpl_a" }).inserted,
		).toBe(true);
		expect(
			store.insertDeploymentEvent({ ...base, sourceEventId: "dpl_b" }).inserted,
		).toBe(true);
		const rows = store.getDeploymentEventsInRange(
			"2026-06-30 00:00:00",
			"2026-07-01 00:00:00",
		);
		expect(rows).toHaveLength(2);
	});

	// Codex code-review R5 #2: a fallback-git-log row (written first at deployed-sha
	// advance) must be UPGRADED to the authoritative marker-backed self-ship source
	// when it reports the same commit identity — not shadowed by INSERT OR IGNORE.
	it("authoritative source upgrades a prior fallback-git-log row (same identity)", () => {
		// Real scenario: the fallback extracts FLY-42 from the commit subject, so
		// both rows share the dedup identity (project|issue|pr|merge_sha|env).
		const sha = "f".repeat(40);
		const identity = {
			projectName: "flywheel",
			issueIdentifier: "FLY-42",
			prNumber: 42,
			mergeSha: sha,
			deployedAt: "2026-06-30 20:00:00",
		};
		store.insertDeploymentEvent({ ...identity, source: "fallback-git-log" });
		const r = store.insertDeploymentEvent({ ...identity, source: "self-ship" });
		expect(r.inserted).toBe(false); // same dedup_key
		const rows = store.getDeploymentEventsInRange(
			"2026-06-30 00:00:00",
			"2026-07-01 00:00:00",
		);
		expect(rows).toHaveLength(1); // still ONE row
		expect(rows[0]!.source).toBe("self-ship"); // upgraded, not inferred
	});

	it("a fallback report does NOT downgrade an existing authoritative row", () => {
		const identity = {
			projectName: "flywheel",
			issueIdentifier: "FLY-9",
			mergeSha: "b".repeat(40),
			deployedAt: "2026-06-30 20:00:00",
		};
		store.insertDeploymentEvent({ ...identity, source: "self-ship" });
		store.insertDeploymentEvent({ ...identity, source: "fallback-git-log" });
		const rows = store.getDeploymentEventsInRange(
			"2026-06-30 00:00:00",
			"2026-07-01 00:00:00",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.source).toBe("self-ship"); // NOT downgraded to fallback
	});

	// Codex code-review R6 (HIGH): the fallback's commit subject may yield a PR but
	// NO issue (e.g. a `chore:` commit); the authoritative marker report carries the
	// issue. With merge_sha as the sole identity these still collapse to ONE row, so
	// the digest cannot double-count the same physical deploy as `p:<pr>` + `i:<issue>`.
	it("merge_sha collapses a PR-only fallback with an issue-attributed authoritative report", () => {
		const sha = "a".repeat(40);
		store.insertDeploymentEvent({
			projectName: "flywheel",
			prNumber: 407, // fallback parsed the PR but NOT the issue
			mergeSha: sha,
			source: "fallback-git-log",
			deployedAt: "2026-06-30 20:00:00",
		});
		store.insertDeploymentEvent({
			projectName: "flywheel",
			issueIdentifier: "FLY-727", // marker report adds the issue
			prNumber: 407,
			mergeSha: sha,
			source: "self-ship",
			deployedAt: "2026-06-30 20:00:00",
		});
		const rows = store.getDeploymentEventsInRange(
			"2026-06-30 00:00:00",
			"2026-07-01 00:00:00",
		);
		expect(rows).toHaveLength(1); // NOT two — merge_sha is the identity
		expect(rows[0]!.source).toBe("self-ship"); // upgraded
		expect(rows[0]!.issue_identifier).toBe("FLY-727"); // enriched from authoritative
	});
});
