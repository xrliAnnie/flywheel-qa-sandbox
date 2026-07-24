import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DetectionEscalationInput } from "../bridge/detection-escalation.js";
import {
	LEAD_ONLY_PARK_KINDS,
	parkFounderGraceMs,
	reviewHoldParkNotice,
	runParkWatch,
} from "../bridge/park-watch.js";
import { StateStore } from "../StateStore.js";

describe("runParkWatch (FLY-1279 D2)", () => {
	let store: StateStore;
	let dir: string;
	let dbPath: string;
	let priorSwitch: string | undefined;
	let priorHardGate: string | undefined;
	const nowMs = Date.now() + 3 * 60 * 60_000;

	beforeEach(async () => {
		priorSwitch = process.env.FLYWHEEL_PARK_WATCH;
		priorHardGate = process.env.FLYWHEEL_CODEX_HARD_GATE;
		delete process.env.FLYWHEEL_PARK_WATCH;
		process.env.FLYWHEEL_CODEX_HARD_GATE = "1";
		store = await StateStore.create(":memory:");
		dir = mkdtempSync(join(tmpdir(), "fly1279-park-watch-"));
		dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
		if (priorSwitch === undefined) delete process.env.FLYWHEEL_PARK_WATCH;
		else process.env.FLYWHEEL_PARK_WATCH = priorSwitch;
		if (priorHardGate === undefined)
			delete process.env.FLYWHEEL_CODEX_HARD_GATE;
		else process.env.FLYWHEEL_CODEX_HARD_GATE = priorHardGate;
	});

	it("uses the retired flag's 10-minute N2 default unconditionally", () => {
		const previous = process.env.FLYWHEEL_PARK_N2_MS;
		process.env.FLYWHEEL_PARK_N2_MS = "12345";
		try {
			expect(parkFounderGraceMs()).toBe(10 * 60_000);
		} finally {
			if (previous === undefined) delete process.env.FLYWHEEL_PARK_N2_MS;
			else process.env.FLYWHEEL_PARK_N2_MS = previous;
		}
	});

	it.each([
		"merge_block",
		"codex_pending",
		"qa_not_green",
		"qa_evidence_missing",
		"qa_evidence_unknown",
		"no_qualified_reviewer",
	] as const)(
		"keeps review hold %s Lead-owned and founder-suppressed",
		(reason) => {
			const notice = reviewHoldParkNotice(reason);
			expect(notice.kind).toBe("park:review_hold");
			expect(LEAD_ONLY_PARK_KINDS.has(notice.kind)).toBe(true);
			expect(notice.reason).toContain(reason);
			expect(notice.nextStep).toContain("Lead");
			expect(notice.nextStep).toContain("不呈 founder");
		},
	);

	function session(
		executionId: string,
		status: "running" | "awaiting_review" | "blocked" | "completed",
		extra: Record<string, unknown> = {},
	): void {
		store.upsertSession({
			execution_id: executionId,
			issue_id: `issue-${executionId}`,
			issue_identifier: `FLY-${executionId}`,
			project_name: "flywheel",
			status,
			last_activity_at: new Date(nowMs - 20 * 60_000).toISOString(),
			...extra,
		});
	}

	async function scan(seen: DetectionEscalationInput[], n1Ms?: number) {
		await runParkWatch({
			store,
			commDbPathForProject: () => dbPath,
			notify: async (input) => {
				seen.push(input);
				store.markDetectionEscalationLeadNotified(
					input.targetKey,
					input.kind,
					input.episodeFingerprint,
					nowMs,
				);
			},
			now: () => nowMs,
			n1Ms,
			qaHealthyMs: 60_000,
			qaRegistrationGraceMs: 60_000,
		});
	}

	it("uses the retired flag's 10-minute N1 default unconditionally", async () => {
		const previous = process.env.FLYWHEEL_PARK_N1_MS;
		process.env.FLYWHEEL_PARK_N1_MS = String(10 * 60 * 60_000);
		try {
			session("review-default-n1", "awaiting_review", {
				session_role: "implement",
				pr_number: 999,
			});
			store.setReviewBinding("review-default-n1", {
				questionId: null,
				prHeadSha: "f".repeat(40),
			});
			const seen: DetectionEscalationInput[] = [];
			await scan(seen);
			expect(seen.map((input) => input.kind)).toEqual(["park:review_hold"]);
		} finally {
			if (previous === undefined) delete process.env.FLYWHEEL_PARK_N1_MS;
			else process.env.FLYWHEEL_PARK_N1_MS = previous;
		}
	});

	it("notifies blocked once and keeps the durable episode active", async () => {
		session("blocked", "blocked", { last_error: "goal blocked: no progress" });
		const seen: DetectionEscalationInput[] = [];
		await scan(seen);
		await scan(seen);

		expect(seen.map((input) => input.kind)).toEqual(["park:blocked"]);
		expect(store.getDetectionEscalationsForReconcile()[0]).toMatchObject({
			status: "LEAD_NOTIFIED",
			attempts: 1,
		});
	});

	it("requires two durable observations before reporting a missing gate row", async () => {
		session("missing", "awaiting_review", {
			awaiting_review_entered_at: new Date(nowMs).toISOString(),
		});
		store.setReviewBinding("missing", {
			questionId: "qid-does-not-exist",
			prHeadSha: "abc",
		});
		const seen: DetectionEscalationInput[] = [];
		await scan(seen, 10 * 60 * 60_000);
		expect(seen).toEqual([]);
		await scan(seen, 10 * 60 * 60_000);
		expect(seen.map((input) => input.kind)).toEqual(["park:gate_row_missing"]);
	});

	it("classifies a superseded gate as an honest terminal state, not unreachable", async () => {
		session("superseded", "awaiting_review", {
			awaiting_review_entered_at: new Date(nowMs).toISOString(),
		});
		const db = new CommDB(dbPath);
		const oldGate = db.insertQuestion("superseded", "lead", "old", {
			checkpoint: "approve_to_ship",
		});
		const newGate = db.insertQuestion("new-exec", "lead", "new", {
			checkpoint: "approve_to_ship",
		});
		expect(db.retireShipGate(oldGate, { supersededBy: newGate })).toBe(true);
		db.close();
		store.setReviewBinding("superseded", {
			questionId: oldGate,
			prHeadSha: "abc",
		});
		const seen: DetectionEscalationInput[] = [];

		await scan(seen);
		await scan(seen);

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			kind: "park:gate_superseded",
		});
		expect(seen[0]!.reason).toContain(newGate);
		expect(seen[0]!.nextStep).toContain("不要重建");
		expect(seen[0]!.nextStep).not.toContain("重新建立");
	});

	it("does not resolve a superseded episode while CommDB evidence is unavailable", async () => {
		session("superseded-db-down", "awaiting_review");
		const db = new CommDB(dbPath);
		const oldGate = db.insertQuestion("superseded-db-down", "lead", "old", {
			checkpoint: "approve_to_ship",
		});
		const newGate = db.insertQuestion("new-exec", "lead", "new", {
			checkpoint: "approve_to_ship",
		});
		db.retireShipGate(oldGate, { supersededBy: newGate });
		db.close();
		store.setReviewBinding("superseded-db-down", {
			questionId: oldGate,
			prHeadSha: "abc",
		});
		const seen: DetectionEscalationInput[] = [];
		await scan(seen);
		await scan(seen);
		expect(
			store
				.getDetectionEscalationsForReconcile()
				.some((row) => row.kind === "park:gate_superseded"),
		).toBe(true);

		rmSync(dbPath, { force: true });
		await scan(seen);
		expect(
			store
				.getDetectionEscalationsForReconcile()
				.some((row) => row.kind === "park:gate_superseded"),
		).toBe(true);
	});

	it("gives a stuck QA hold priority over the generic approval wait", async () => {
		session("parent", "awaiting_review", {
			pr_number: 12,
		});
		store.setReviewBinding("parent", {
			questionId: "q-parent",
			prHeadSha: "head-1",
		});
		store.claimAutoQaRecord({
			parentExecutionId: "parent",
			targetPrHeadSha: "head-1",
			issueId: "issue-parent",
			projectName: "flywheel",
		});
		store.setAutoQaStatus("parent", "head-1", "stuck", {});
		const seen: DetectionEscalationInput[] = [];
		await scan(seen);

		expect(seen.map((input) => input.kind)).toEqual([
			"park:qa_recovery_exhausted",
		]);
	});

	it("surfaces merge_block as a Lead-only hold episode, never a generic founder gate", async () => {
		session("merge-blocked", "awaiting_review", {
			session_role: "main",
			pr_number: 606,
			merge_block_reason: "merged_without_verified_approval",
		});
		store.setReviewBinding("merge-blocked", {
			questionId: null,
			prHeadSha: "a".repeat(40),
		});
		store.setMergeBlock({
			executionId: "merge-blocked",
			reason: "merged_without_verified_approval",
			head: "a".repeat(40),
		});
		const db = new CommDB(dbPath);
		db.upsertDeclaredState(
			"merge-blocked",
			"parked",
			"awaiting founder review",
			nowMs - 20 * 60_000,
			null,
		);
		db.close();
		const seen: DetectionEscalationInput[] = [];
		await scan(seen);

		expect(seen.map((input) => input.kind)).toEqual(["park:review_hold"]);
		expect(LEAD_ONLY_PARK_KINDS.has(seen[0]!.kind)).toBe(true);
		expect(seen[0]!.reason).toContain("merge_block");
		expect(store.getDetectionEscalationsForReconcile()[0]).toMatchObject({
			kind: "park:review_hold",
			status: "LEAD_NOTIFIED",
		});
	});

	it("notifies Lead when codex_pending has no durable review row", async () => {
		session("codex-no-row", "awaiting_review", {
			session_role: "implement",
			pr_number: 999,
		});
		store.setReviewBinding("codex-no-row", {
			questionId: null,
			prHeadSha: "e".repeat(40),
		});
		const seen: DetectionEscalationInput[] = [];
		await scan(seen);

		expect(seen.map((input) => input.kind)).toEqual(["park:review_hold"]);
		expect(LEAD_ONLY_PARK_KINDS.has(seen[0]!.kind)).toBe(true);
		expect(seen[0]!.reason).toContain("codex_pending");
	});

	it("machine-resolves a park episode after the condition clears", async () => {
		session("review", "awaiting_review", {
			session_role: "implement",
			codex_skip: true,
		});
		store.setReviewBinding("review", {
			questionId: null,
			prHeadSha: "b".repeat(40),
		});
		const seen: DetectionEscalationInput[] = [];
		await scan(seen);
		expect(seen).toHaveLength(1);

		session("review", "completed");
		await scan(seen);
		expect(store.getDetectionEscalationsForReconcile()).toEqual([]);
	});

	it("ignores the retired park-watch switch", async () => {
		process.env.FLYWHEEL_PARK_WATCH = "0";
		session("blocked-off", "blocked");
		const seen: DetectionEscalationInput[] = [];
		await scan(seen);
		expect(seen.map((input) => input.kind)).toEqual(["park:blocked"]);
		expect(store.getDetectionEscalationsForReconcile()).toHaveLength(1);
	});
});
