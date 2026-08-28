import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepOrphanFounderReviewGates } from "../orphan-founder-review-monitor.js";

const NOW = "2026-08-21T12:00:00.000Z";
const OLD = "2026-08-20T11:59:59.000Z";

function content(runId: string): string {
	return JSON.stringify({
		version: 1,
		round: 1,
		runId,
		artifactDigest: "a".repeat(64),
		hostedUrl: "https://example.test/review",
		paths: ["report.html"],
	});
}

describe("FLY-1940 orphan founder review monitor", () => {
	let root: string;
	let db: CommDB;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly1940-founder-monitor-"));
		db = new CommDB(join(root, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	function harness(input: {
		status?: string | ((runId: string) => string);
		bound?: boolean;
		env?: Record<string, string | undefined>;
	}) {
		const alerts: Array<{
			escalationUid: string;
			runId: string;
			payload: { title: string; body: string };
		}> = [];
		const result = sweepOrphanFounderReviewGates({
			projectName: "flywheel",
			db,
			store: {
				getWorkflowRun: (runId: string) => ({
					run_id: runId,
					issue_id: "FLY-1940",
					project_name: "flywheel",
					status:
						typeof input.status === "function"
							? input.status(runId)
							: (input.status ?? "active"),
				}),
				getFounderReviewCardBindingByQuestion: () =>
					input.bound === false ? undefined : { question_id: "bound" },
				enqueueWorkflowEngineAlert: (alert) => alerts.push(alert),
			},
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "fallback",
			}),
			env: input.env ?? {},
			now: () => Date.parse(NOW),
		});
		return { alerts, result };
	}

	it("surfaces an aged unanswered gate for active and held runs", () => {
		for (const status of ["active", "held"]) {
			const questionId = db.insertQuestion(
				`exec-${status}`,
				"lead",
				content(`run-${status}`),
				{ checkpoint: "founder_review" },
			);
			(db as unknown as { db: import("better-sqlite3").Database }).db
				.prepare(
					"UPDATE mailbox SET created_at = ?, expires_at = ? WHERE id = ?",
				)
				.run(OLD, "2026-08-20T12:00:00.000Z", questionId);
		}

		const { alerts, result } = harness({
			status: (runId) => (runId === "run-held" ? "held" : "active"),
		});
		expect(result).toMatchObject({ scanned: 2, alerted: 2 });
		expect(alerts.map((alert) => alert.escalationUid)).toEqual([
			expect.stringMatching(/^founder-review-unanswered:.*:24h$/),
			expect.stringMatching(/^founder-review-unanswered:.*:24h$/),
		]);
	});

	it("gives a newly opened gate ten minutes for its founder card to arrive", () => {
		db.insertQuestion(
			"exec-undelivered-young",
			"lead",
			content("run-undelivered-young"),
			{ checkpoint: "founder_review" },
		);
		const { alerts, result } = harness({ bound: false });
		expect(result).toMatchObject({
			scanned: 1,
			live: 1,
			deliveryMissing: 0,
			alerted: 0,
		});
		expect(alerts).toEqual([]);
	});

	it("reports a founder card still missing at the ten-minute boundary", () => {
		const questionId = db.insertQuestion(
			"exec-undelivered",
			"lead",
			content("run-undelivered"),
			{ checkpoint: "founder_review" },
		);
		(db as unknown as { db: import("better-sqlite3").Database }).db
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-08-21T11:50:00.000Z", questionId);
		const { alerts, result } = harness({ bound: false });
		expect(result).toMatchObject({
			scanned: 1,
			deliveryMissing: 1,
			alerted: 1,
		});
		expect(alerts[0]?.escalationUid).toBe(
			`founder-review-delivery-missing:${questionId}`,
		);
		expect(alerts[0]?.payload.title).toContain("never reached founder");
	});

	it("does not allow an override to shrink delivery grace below ten minutes", () => {
		const questionId = db.insertQuestion(
			"exec-undelivered-clamped",
			"lead",
			content("run-undelivered-clamped"),
			{ checkpoint: "founder_review" },
		);
		(db as unknown as { db: import("better-sqlite3").Database }).db
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-08-21T11:51:00.000Z", questionId);
		const { alerts, result } = harness({
			bound: false,
			env: {
				FLYWHEEL_FOUNDER_REVIEW_ORPHAN_DELIVERY_GRACE_MINUTES: "1",
			},
		});
		expect(result).toMatchObject({ deliveryMissing: 0, alerted: 0 });
		expect(alerts).toEqual([]);
	});

	it("does not alert a delivered gate before the age threshold", () => {
		db.insertQuestion("exec-young", "lead", content("run-young"), {
			checkpoint: "founder_review",
		});
		const { alerts, result } = harness({});
		expect(result).toMatchObject({ scanned: 1, live: 1, aged: 0, alerted: 0 });
		expect(alerts).toEqual([]);
	});

	it("excludes answered, superseded, and non-live run shapes", () => {
		const answered = db.insertQuestion(
			"exec-answered",
			"lead",
			content("run-answered"),
			{ checkpoint: "founder_review" },
		);
		db.insertResponse(answered, "founder", "revisions requested");
		const superseded = db.insertQuestion(
			"exec-superseded",
			"lead",
			content("run-superseded"),
			{ checkpoint: "founder_review" },
		);
		db.retireQuestionGuarded(superseded, {
			expectedFromAgent: "exec-superseded",
			requireUnanswered: true,
			supersededBy: "new-round",
		});
		db.insertQuestion("exec-completed", "lead", content("run-completed"), {
			checkpoint: "founder_review",
		});

		const { alerts, result } = harness({ status: "completed", bound: false });
		expect(result).toMatchObject({ scanned: 1, live: 0, alerted: 0 });
		expect(alerts).toEqual([]);
	});

	it("ignores the retired monitor kill switch", () => {
		db.insertQuestion("exec-off", "lead", content("run-off"), {
			checkpoint: "founder_review",
		});
		const retiredKey = [
			"FLYWHEEL",
			"FOUNDER",
			"REVIEW",
			"ORPHAN",
			"MONITOR",
		].join("_");
		const env: Record<string, string | undefined> = {
			[retiredKey]: "0",
		};
		const { alerts, result } = harness({
			bound: false,
			env,
		});
		expect(result).toEqual({
			scanned: 1,
			live: 1,
			deliveryMissing: 0,
			aged: 0,
			alerted: 0,
			invalid: 0,
		});
		expect(alerts).toEqual([]);

		delete env[retiredKey];
		expect(harness({ bound: false, env }).result).toMatchObject({
			scanned: 1,
			deliveryMissing: 0,
			alerted: 0,
		});
	});
});
