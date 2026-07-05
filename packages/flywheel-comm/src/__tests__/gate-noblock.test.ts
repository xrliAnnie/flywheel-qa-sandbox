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
			const expires = new Date(
				`${(q?.expires_at as string).replace(" ", "T")}Z`,
			).getTime();
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
});
