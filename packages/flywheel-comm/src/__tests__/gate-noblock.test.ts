/**
 * FLY-191 Phase 2 — `gate --no-block` contract (plan §3.1, Codex R2 HIGH-1).
 *
 * The non-blocking mode must:
 *  - insert the question with IDENTICAL checkpoint/TTL metadata to the
 *    blocking path,
 *  - return immediately with the questionId (status "pending", exit 0),
 *  - NEVER poll, resolve, or expire the question — it stays visible to
 *    GatePoller (`getPendingQuestions`) and the founder-consent wrapper
 *    (`getPendingGateByRunner`) after the process exits.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GateArgs, gate } from "../commands/gate.js";
import { CommDB } from "../db.js";

describe("gate --no-block (FLY-191 Phase 2)", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly191-noblock-"));
		dbPath = join(tmpDir, "comm.db");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function args(overrides?: Partial<GateArgs>): GateArgs {
		return {
			checkpoint: "approve_to_ship",
			lead: "product-lead",
			execId: "runner-191",
			message: "PR created: https://example/pr/1. Ready for review.",
			dbPath,
			timeoutMs: 48 * 3_600_000,
			timeoutBehavior: "fail-close",
			cleanupTtlHours: 24,
			pollIntervalMs: 50,
			noBlock: true,
			shipCiProbe: () => ({ green: true, reason: "ci_green" }),
			...overrides,
		};
	}

	it("returns immediately with status=pending, exit 0 and the questionId", async () => {
		const started = Date.now();
		const result = await gate(args());
		// Must not have waited for the 48h timeout or even one poll tick
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(result.status).toBe("pending");
		expect(result.exitCode).toBe(0);
		expect(result.questionId).toBeTruthy();
	});

	it("creates the question with identical checkpoint + TTL metadata to the blocking path", async () => {
		const result = await gate(args());
		const db = new CommDB(dbPath);
		try {
			const q = db.getMessageById(result.questionId as string);
			expect(q).toBeTruthy();
			expect(q?.checkpoint).toBe("approve_to_ship");
			expect(q?.type).toBe("question");
			// TTL untouched: expires_at is the schema default (+72h), NOT
			// shortened by a resolveGate cleanup.
			const expires = new Date(q?.expires_at as string).getTime();
			expect(expires - Date.now()).toBeGreaterThan(70 * 3_600_000);
		} finally {
			db.close();
		}
	});

	it("does NOT resolve or expire the question — still pending for GatePoller + founder-consent wrapper", async () => {
		const result = await gate(args());
		const db = new CommDB(dbPath);
		try {
			const q = db.getMessageById(result.questionId as string);
			expect(q?.resolved_at).toBeNull();

			// GatePoller surface: visible in the Lead's pending list
			const pending = db.getPendingQuestions("product-lead");
			expect(pending.map((p) => p.id)).toContain(result.questionId);

			// founder-consent / approve surface: visible by runner+checkpoint
			const gateQ = db.getPendingGateByRunner("runner-191", "approve_to_ship");
			expect(gateQ?.id).toBe(result.questionId);
		} finally {
			db.close();
		}
	});

	it("an answered no-block question is later resolvable through the normal response path", async () => {
		const result = await gate(args());
		const db = new CommDB(dbPath);
		try {
			db.insertResponse(
				result.questionId as string,
				"bridge",
				JSON.stringify({ approved: true }),
			);
			const resp = db.getResponse(result.questionId as string);
			expect(resp?.content).toBe(JSON.stringify({ approved: true }));
		} finally {
			db.close();
		}
	});

	it("blocking mode still polls (regression: noBlock default off)", async () => {
		const result = await gate(
			args({ noBlock: false, timeoutMs: 300, timeoutBehavior: "fail-open" }),
		);
		expect(result.status).toBe("timeout");
		expect(result.exitCode).toBe(0);
	});

	it("opens founder_review only with founder, run, hosted URL, and committed blob evidence", async () => {
		const result = await gate(
			args({
				checkpoint: "founder_review",
				message: "PRD-HTML ready",
				founderReviewEvidence: {
					runId: "run-1758",
					founderId: "123456789012345678",
					hostedUrl: "https://reports.example/FLY-1758/prd-v1",
					artifacts: [
						{
							path: "product/doc/FLY-1758/prd-v1.html",
							blobSha: "a".repeat(40),
						},
					],
				},
			}),
		);
		const db = new CommDB(dbPath);
		try {
			const question = db.getMessageById(result.questionId as string);
			expect(JSON.parse(question?.content ?? "{}")).toEqual({
				version: 1,
				round: 1,
				runId: "run-1758",
				artifactDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
				hostedUrl: "https://reports.example/FLY-1758/prd-v1",
				paths: ["product/doc/FLY-1758/prd-v1.html"],
			});
		} finally {
			db.close();
		}
	});

	it("keeps a founder_review round open for seven days", async () => {
		const result = await gate(
			args({
				checkpoint: "founder_review",
				founderReviewEvidence: {
					runId: "run-1758",
					founderId: "123456789012345678",
					hostedUrl: "https://reports.example/FLY-1758/prd-v1",
					artifacts: [{ path: "review.html", blobSha: "a".repeat(40) }],
				},
			}),
		);
		const db = new CommDB(dbPath);
		try {
			const question = db.getMessageById(result.questionId as string);
			const lifetimeMs =
				Date.parse(question?.expires_at ?? "") -
				Date.parse(question?.created_at ?? "");
			expect(lifetimeMs).toBe(7 * 24 * 60 * 60 * 1000);
		} finally {
			db.close();
		}
	});

	it.each([
		["missing all evidence", undefined],
		[
			"missing founder",
			{
				runId: "run-1758",
				founderId: undefined,
				hostedUrl: "https://reports.example/review",
				artifacts: [{ path: "review.html", blobSha: "a".repeat(40) }],
			},
		],
		[
			"non-HTTPS delivery",
			{
				runId: "run-1758",
				founderId: "123456789012345678",
				hostedUrl: "http://localhost/review",
				artifacts: [{ path: "review.html", blobSha: "a".repeat(40) }],
			},
		],
	] as const)(
		"rejects founder_review with %s before writing",
		async (_name, evidence) => {
			await expect(
				gate(
					args({
						checkpoint: "founder_review",
						founderReviewEvidence: evidence,
					}),
				),
			).rejects.toThrow(/founder_review/i);
			const db = new CommDB(dbPath);
			try {
				expect(db.getPendingQuestions("product-lead")).toHaveLength(0);
			} finally {
				db.close();
			}
		},
	);

	it("numbers repeated founder_review rounds for the same run", async () => {
		const evidence = {
			runId: "run-1758",
			founderId: "123456789012345678",
			hostedUrl: "https://reports.example/review",
			artifacts: [{ path: "review.html", blobSha: "a".repeat(40) }],
		};
		await gate(
			args({ checkpoint: "founder_review", founderReviewEvidence: evidence }),
		);
		await gate(
			args({ checkpoint: "founder_review", founderReviewEvidence: evidence }),
		);
		const db = new CommDB(dbPath);
		try {
			const questions = db.getQuestionsByCheckpoint("founder_review");
			expect(
				questions.map((question) => JSON.parse(question.content).round),
			).toEqual([1, 2]);
			expect(questions[0]?.superseded_at).toBeTruthy();
			expect(questions[0]?.superseded_by).toBe(questions[1]?.id);
			expect(
				db
					.getPendingQuestions("product-lead")
					.filter((question) => question.checkpoint === "founder_review")
					.map((question) => question.id),
			).toEqual([questions[1]?.id]);
		} finally {
			db.close();
		}
	});
});
