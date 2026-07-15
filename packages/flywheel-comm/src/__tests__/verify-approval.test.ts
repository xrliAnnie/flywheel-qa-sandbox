/**
 * FLY-191 Phase 2 — `verify-approval` security matrix (plan §3.2(i),
 * Codex design R2 HIGH-2 + R3 HIGH-1/2; question binding per Codex PR R1
 * CRITICAL).
 *
 * The runner's ship authority. EVERY ambiguous/missing/forged input must
 * fail-closed (approved:false, exit 1). The ONLY approving combination:
 *   session.review_question_id BOUND to an approve_to_ship question of this
 *   runner  +  structured {"approved": true} response on THAT exact question
 *   +  StateStore status approved_to_ship  +  pr_head_sha exactly matching
 *   --pr-head.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resolveCodexHardGateOn,
	verifyApproval,
	verifyApprovalWithBridgeHead,
} from "../commands/verify-approval.js";
import { CommDB } from "../db.js";

const EXEC = "exec-fly191";
const LEAD = "product-lead";
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);

describe("verify-approval (FLY-191 Phase 2)", () => {
	let tmpDir: string;
	let commDbPath: string;
	let stateDbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly191-verify-"));
		commDbPath = join(tmpDir, "comm.db");
		stateDbPath = join(tmpDir, "teamlead.db");
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	/** Minimal StateStore-shaped sessions table (sql.js writes standard SQLite).
	 * FLY-1188: mirrors the production adapter_type column (family rule input). */
	function writeStateSession(row: {
		execution_id: string;
		status: string;
		pr_head_sha?: string | null;
		review_question_id?: string | null;
		codex_skip?: number;
		adapter_type?: string | null;
	}): void {
		const db = new Database(stateDbPath);
		db.exec(
			`CREATE TABLE IF NOT EXISTS sessions (
				execution_id TEXT PRIMARY KEY,
				status TEXT,
				pr_head_sha TEXT,
				review_question_id TEXT,
				codex_skip INTEGER NOT NULL DEFAULT 0,
				adapter_type TEXT
			)`,
		);
		db.prepare(
			"INSERT OR REPLACE INTO sessions (execution_id, status, pr_head_sha, review_question_id, codex_skip, adapter_type) VALUES (?, ?, ?, ?, ?, ?)",
		).run(
			row.execution_id,
			row.status,
			row.pr_head_sha ?? null,
			row.review_question_id ?? null,
			row.codex_skip ?? 0,
			row.adapter_type ?? null,
		);
		db.close();
	}

	/** FLY-827: write a codex_review_record row for (exec, head).
	 * FLY-1188: optional family stamps (NULL = legacy pre-FLY-1188 row). */
	function writeCodexRecord(
		execution_id: string,
		targetPrHeadSha: string,
		status: "approved" | "skipped" | "pending",
		families?: { author?: string; reviewer?: string },
	): void {
		const db = new Database(stateDbPath);
		db.exec(
			`CREATE TABLE IF NOT EXISTS codex_review_record (
				execution_id TEXT NOT NULL,
				target_pr_head_sha TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				author_family TEXT,
				reviewer_family TEXT,
				PRIMARY KEY (execution_id, target_pr_head_sha)
			)`,
		);
		db.prepare(
			"INSERT OR REPLACE INTO codex_review_record (execution_id, target_pr_head_sha, status, author_family, reviewer_family) VALUES (?, ?, ?, ?, ?)",
		).run(
			execution_id,
			targetPrHeadSha.toLowerCase(),
			status,
			families?.author ?? null,
			families?.reviewer ?? null,
		);
		db.close();
	}

	function createGateQuestion(content = "PR ready", fromAgent = EXEC): string {
		const db = new CommDB(commDbPath);
		try {
			return db.insertQuestion(fromAgent, LEAD, content, {
				checkpoint: "approve_to_ship",
			});
		} finally {
			db.close();
		}
	}

	function answer(questionId: string, content: string, from = "bridge"): void {
		const db = new CommDB(commDbPath);
		try {
			db.insertResponse(questionId, from, content);
		} finally {
			db.close();
		}
	}

	function run(prHead = HEAD) {
		return verifyApproval({
			execId: EXEC,
			prHead,
			dbPath: commDbPath,
			stateDbPath,
			// FLY-827: these FLY-191 tests predate the codex hard gate + verify the
			// founder-approval semantics. Run gate-OFF (byte-compat) so they don't
			// require a codex_review_record. Codex-gate behavior has its own block.
			env: { FLYWHEEL_CODEX_HARD_GATE: "0" } as NodeJS.ProcessEnv,
			codexDotenvPath: join(tmpDir, "nonexistent.env"),
		});
	}

	/** FLY-827: run with the codex hard gate ON (env has no key → resolver reads .env → absent path → process.env). */
	function runGateOn(opts?: {
		prHead?: string;
		env?: NodeJS.ProcessEnv;
		dotenvPath?: string;
	}) {
		return verifyApproval({
			execId: EXEC,
			prHead: opts?.prHead ?? HEAD,
			dbPath: commDbPath,
			stateDbPath,
			env: opts?.env ?? ({} as NodeJS.ProcessEnv),
			codexDotenvPath: opts?.dotenvPath ?? join(tmpDir, "nonexistent.env"),
		});
	}

	/** Bound + answered + approved + status + head — the one passing setup. */
	function setupFullyApproved(): string {
		const qid = createGateQuestion();
		answer(qid, JSON.stringify({ approved: true }));
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: qid,
		});
		return qid;
	}

	// ── The one approving path ──

	it("approves ONLY when binding + response + status + pr_head_sha all agree", () => {
		const qid = setupFullyApproved();
		const r = run();
		expect(r.approved).toBe(true);
		expect(r.reason).toBe("approved");
		expect(r.questionId).toBe(qid);
		expect(r.exitCode).toBe(0);
	});

	describe("FLY-1244 Bridge head authority", () => {
		it("uses the Bridge-derived head for the final local approval check", async () => {
			setupFullyApproved();
			const result = await verifyApprovalWithBridgeHead({
				execId: EXEC,
				prHead: HEAD,
				dbPath: commDbPath,
				stateDbPath,
				bridgeUrl: "http://127.0.0.1:9876",
				fetchImpl: vi.fn().mockResolvedValue({
					ok: true,
					json: async () => ({ ok: true, prHeadSha: HEAD }),
				}) as never,
				env: {
					FLYWHEEL_CODEX_HARD_GATE: "0",
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
				} as NodeJS.ProcessEnv,
				codexDotenvPath: join(tmpDir, "nonexistent.env"),
			});
			expect(result).toMatchObject({ approved: true, reason: "approved" });
		});

		it("refuses when caller HEAD differs from Bridge worktree authority", async () => {
			const result = await verifyApprovalWithBridgeHead({
				execId: EXEC,
				prHead: OTHER_HEAD,
				dbPath: commDbPath,
				stateDbPath,
				bridgeUrl: "http://127.0.0.1:9876",
				fetchImpl: vi.fn().mockResolvedValue({
					ok: true,
					json: async () => ({ ok: true, prHeadSha: HEAD }),
				}) as never,
				env: { FLYWHEEL_WORKFLOW_CLAIMS_READ: "1" } as NodeJS.ProcessEnv,
			});
			expect(result).toMatchObject({
				approved: false,
				reason: "head_authority_mismatch",
				expectedPrHeadSha: HEAD,
				exitCode: 1,
			});
		});

		it("fails closed when the Bridge authority cannot be read", async () => {
			const result = await verifyApprovalWithBridgeHead({
				execId: EXEC,
				prHead: HEAD,
				dbPath: commDbPath,
				stateDbPath,
				bridgeUrl: "http://127.0.0.1:9876",
				fetchImpl: vi.fn().mockRejectedValue(new Error("offline")) as never,
				env: { FLYWHEEL_WORKFLOW_CLAIMS_READ: "1" } as NodeJS.ProcessEnv,
			});
			expect(result).toMatchObject({
				approved: false,
				reason: "head_authority_unavailable",
				exitCode: 1,
			});
		});
	});

	// ── FLY-945 Fix E: founder attribution matrix ──

	describe("FLY-945 Fix E: response attribution must be founder-side", () => {
		const FOUNDER = "123456789012345678";

		/** .env with founder id (codex gate kept OFF — same file feeds all flags). */
		function founderEnv(extra = ""): string {
			const p = join(tmpDir, "founder.env");
			writeFileSync(
				p,
				`DISCORD_OWNER_USER_ID=${FOUNDER}\nFLYWHEEL_CODEX_HARD_GATE=0\n${extra}`,
			);
			return p;
		}

		function setupApprovedBy(from: string): void {
			const qid = createGateQuestion();
			answer(qid, JSON.stringify({ approved: true }), from);
			writeStateSession({
				execution_id: EXEC,
				status: "approved_to_ship",
				pr_head_sha: HEAD,
				review_question_id: qid,
			});
		}

		function runWithDotenv(dotenvPath: string) {
			return verifyApproval({
				execId: EXEC,
				prHead: HEAD,
				dbPath: commDbPath,
				stateDbPath,
				env: {} as NodeJS.ProcessEnv,
				codexDotenvPath: dotenvPath,
			});
		}

		it.each([["bridge"], ["bridge-founder-consent"]])(
			"trusted bridge writer %s → approved",
			(from) => {
				setupApprovedBy(from);
				const r = runWithDotenv(founderEnv());
				expect(r.approved).toBe(true);
			},
		);

		it("the canonical founder Discord id → approved", () => {
			setupApprovedBy(FOUNDER);
			expect(runWithDotenv(founderEnv()).approved).toBe(true);
		});

		it("🔴 a Lead id (respond self-approval — the FLY-921 door) → response_not_founder_attributed", () => {
			setupApprovedBy(LEAD);
			const r = runWithDotenv(founderEnv());
			expect(r.approved).toBe(false);
			expect(r.reason).toBe("response_not_founder_attributed");
			expect(r.responseFrom).toBe(LEAD);
		});

		it("🔴 FOUNDER_AGENT 'founder-bridge-auto' on a ship gate is anomalous → refused", () => {
			// The FLY-605 relay agent only ever writes NON-gated answers; its name on
			// an approve_to_ship response means something forged the WAKE-only lane.
			setupApprovedBy("founder-bridge-auto");
			expect(runWithDotenv(founderEnv()).reason).toBe(
				"response_not_founder_attributed",
			);
		});

		it("honest boundary: founder id UNRESOLVABLE → attribution step skipped (feature-off)", () => {
			setupApprovedBy(LEAD);
			const p = join(tmpDir, "no-founder.env");
			writeFileSync(p, "FLYWHEEL_CODEX_HARD_GATE=0\n");
			expect(runWithDotenv(p).approved).toBe(true);
		});

		it("kill-switch FLYWHEEL_FOUNDER_ATTRIBUTION_GATE=0 (live .env) → byte-compat pass for a lead write", () => {
			setupApprovedBy(LEAD);
			const p = founderEnv("FLYWHEEL_FOUNDER_ATTRIBUTION_GATE=0\n");
			expect(runWithDotenv(p).approved).toBe(true);
		});

		it("🔴 spoof guard (Codex code R1 HIGH): reserved attributions cannot be caller-supplied via respond --lead", async () => {
			const { isReservedApprovalAttribution } = await import(
				"../founder-attribution.js"
			);
			// the exact bridge names + anything Discord-snowflake-shaped (founder id)
			expect(isReservedApprovalAttribution("bridge")).toBe(true);
			expect(isReservedApprovalAttribution("bridge-founder-consent")).toBe(
				true,
			);
			expect(isReservedApprovalAttribution(FOUNDER)).toBe(true);
			// real Lead agent ids are names, never bare snowflakes → allowed
			expect(isReservedApprovalAttribution("flywheel-eng-lead")).toBe(false);
			expect(isReservedApprovalAttribution("founder-bridge-auto")).toBe(false);
		});

		it("🔴 spoof guard e2e: respond bypass path REFUSES a reserved --lead on an approve_to_ship gate", async () => {
			const { respond } = await import("../commands/respond.js");
			const qid = createGateQuestion();
			for (const forged of ["bridge", "bridge-founder-consent", FOUNDER]) {
				await expect(
					respond({
						questionId: qid,
						fromAgent: forged,
						answer: JSON.stringify({ approved: true }),
						dbPath: commDbPath,
						env: {
							FLYWHEEL_COMM_BYPASS_BRIDGE: "1",
						} as NodeJS.ProcessEnv,
					}),
				).rejects.toThrow(/RESERVED approval attribution/);
			}
			// nothing was written
			const db = new CommDB(commDbPath, false);
			expect(db.getResponse(qid)).toBeUndefined();
			db.close();
		});

		it("QA-room bypass: a PROCESS-env =0 wins over a readable .env (slots share the production .env)", async () => {
			const { resolveFounderAttributionGateOn } = await import(
				"../founder-attribution.js"
			);
			const envPath = founderEnv(); // readable .env, key absent → would be ON
			expect(
				resolveFounderAttributionGateOn({
					argsEnv: undefined,
					processEnv: {
						FLYWHEEL_FOUNDER_ATTRIBUTION_GATE: "0",
					} as NodeJS.ProcessEnv,
					dotenvPath: envPath,
				}),
			).toBe(false);
			// and without the process key, the same .env resolves ON
			expect(
				resolveFounderAttributionGateOn({
					argsEnv: undefined,
					processEnv: {} as NodeJS.ProcessEnv,
					dotenvPath: envPath,
				}),
			).toBe(true);
		});
	});

	// ── Input validation ──

	it("rejects a short/invalid --pr-head (no prefix-match games)", () => {
		setupFullyApproved();
		expect(run("abc123").reason).toBe("invalid_pr_head_format");
		expect(run("abc123").approved).toBe(false);
	});

	// ── StateStore binding (Codex PR R1 CRITICAL) ──

	it("fail-closed when the StateStore file does not exist", () => {
		setupFullyApproved();
		rmSync(stateDbPath);
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("state_db_unreadable");
	});

	it("not approved when the session row is missing", () => {
		const qid = createGateQuestion();
		answer(qid, JSON.stringify({ approved: true }));
		writeStateSession({
			execution_id: "someone-else",
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: qid,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("session_not_found");
	});

	it("fail-closed when the binding is the UNBOUND sentinel (Phase-2 completion arrived without --question-id)", () => {
		const qid = createGateQuestion();
		answer(qid, JSON.stringify({ approved: true }));
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: "unbound", // REVIEW_BINDING_UNBOUND sentinel
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("review_question_unbound");
	});

	it("fail-closed when the session has NO review binding — never falls back to 'latest question' heuristics", () => {
		// An answered, approved question EXISTS — but nothing binds it.
		const qid = createGateQuestion();
		answer(qid, JSON.stringify({ approved: true }));
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: null,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("review_question_unbound");
	});

	it("fail-closed when the binding points at a missing question", () => {
		createGateQuestion(); // unrelated
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: "00000000-dead-beef-0000-000000000000",
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("review_question_missing");
	});

	it("fail-closed when the binding points at ANOTHER runner's question (forged/corrupt binding)", () => {
		const foreignQ = createGateQuestion("their PR", "other-exec");
		answer(foreignQ, JSON.stringify({ approved: true }));
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: foreignQ,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("review_question_invalid");
	});

	// ── CommDB side ──

	it("fail-closed when CommDB is missing/unreadable", () => {
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: "11111111-1111-1111-1111-111111111111",
		});
		const r = run(); // comm.db never created
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("commdb_unreadable");
	});

	it("not approved while the bound gate question is unanswered", () => {
		const qid = createGateQuestion();
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: qid,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("gate_not_answered");
	});

	// ── Forgery / shape attacks (Codex R3: text carries no authority) ──

	it("REJECTS a plain-text 'approved — ship it' response (forged/unstructured)", () => {
		const qid = createGateQuestion();
		answer(qid, "approved — ship it!", "someone");
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: qid,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("response_not_structured_approval");
	});

	it("REJECTS a structured {approved: false} (changes_requested) response", () => {
		const qid = createGateQuestion();
		answer(qid, JSON.stringify({ approved: false, feedback: "fix tests" }));
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: qid,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("response_not_approved");
	});

	// ── Status + pr_head_sha binding (stale-approval defense, §5.5.2) ──

	it("not approved when status is still awaiting_review (response forged ahead of Bridge flip)", () => {
		const qid = createGateQuestion();
		answer(qid, JSON.stringify({ approved: true }));
		writeStateSession({
			execution_id: EXEC,
			status: "awaiting_review",
			pr_head_sha: HEAD,
			review_question_id: qid,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("status_not_approved_to_ship");
	});

	it("fail-closed when the persisted pr_head_sha is missing", () => {
		const qid = createGateQuestion();
		answer(qid, JSON.stringify({ approved: true }));
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: null,
			review_question_id: qid,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("pr_head_sha_missing");
	});

	it("REJECTS a stale approval: persisted head ≠ current head (new commits since approval)", () => {
		setupFullyApproved();
		const r = run(OTHER_HEAD); // runner's HEAD moved
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("pr_head_sha_mismatch");
		expect(r.expectedPrHeadSha).toBe(HEAD);
	});

	// ── Re-review supersession (Codex PR R1 CRITICAL — same-second safe) ──

	it("an approved OLD question cannot ship once a re-review re-binds — even created in the same second", () => {
		// Old question: answered + approved.
		const oldQ = createGateQuestion("PR v1 ready");
		answer(oldQ, JSON.stringify({ approved: true }));
		// Re-review: NEW question created immediately (same wall-clock second
		// is fine — the binding is an exact id, not a timestamp race).
		const newQ = createGateQuestion("PR v2 ready (re-review)");
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: newQ, // binding moved by the re-review completion
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("gate_not_answered");
		expect(r.questionId).toBe(newQ); // verdict bound to the current request
	});

	// ── FLY-827: Codex code-review hard gate (merge chokepoint) ──

	describe("FLY-827 codex hard gate", () => {
		/** Founder side fully approved (bound + answered + status + head). */
		function founderApproved(): void {
			const qid = createGateQuestion();
			answer(qid, JSON.stringify({ approved: true }));
			writeStateSession({
				execution_id: EXEC,
				status: "approved_to_ship",
				pr_head_sha: HEAD,
				review_question_id: qid,
			});
		}

		it("founder approved + codex approved (this head) → approved", () => {
			founderApproved();
			writeCodexRecord(EXEC, HEAD, "approved");
			const r = runGateOn();
			expect(r.approved).toBe(true);
			expect(r.reason).toBe("approved");
		});

		it("founder approved + NO codex record → codex_review_not_approved", () => {
			founderApproved();
			const r = runGateOn();
			expect(r.approved).toBe(false);
			expect(r.reason).toBe("codex_review_not_approved");
		});

		it("codex approved for a DIFFERENT head → codex_review_not_approved", () => {
			founderApproved();
			writeCodexRecord(EXEC, "b".repeat(40), "approved");
			const r = runGateOn();
			expect(r.reason).toBe("codex_review_not_approved");
		});

		it("codex skipped record → approved", () => {
			founderApproved();
			writeCodexRecord(EXEC, HEAD, "skipped");
			expect(runGateOn().approved).toBe(true);
		});

		it("session.codex_skip → approved without a codex record", () => {
			const qid = createGateQuestion();
			answer(qid, JSON.stringify({ approved: true }));
			writeStateSession({
				execution_id: EXEC,
				status: "approved_to_ship",
				pr_head_sha: HEAD,
				review_question_id: qid,
				codex_skip: 1,
			});
			expect(runGateOn().approved).toBe(true);
		});

		it("byte-compat: gate OFF (env FLYWHEEL_CODEX_HARD_GATE=0) → approved without a codex record", () => {
			founderApproved();
			const r = runGateOn({
				env: { FLYWHEEL_CODEX_HARD_GATE: "0" } as NodeJS.ProcessEnv,
			});
			expect(r.approved).toBe(true);
			expect(r.reason).toBe("approved");
		});

		it("R3-HIGH-1 OFF live: inherited env has no key + .env has =0 → gate off → approved", () => {
			founderApproved();
			const envPath = join(tmpDir, "off.env");
			writeFileSync(envPath, "FLYWHEEL_CODEX_HARD_GATE=0\n");
			const r = runGateOn({
				env: {} as NodeJS.ProcessEnv,
				dotenvPath: envPath,
			});
			expect(r.approved).toBe(true);
		});

		it("R3-HIGH-1 re-arm live: stale inherited =0 + readable .env with key ABSENT → gate ON (NOT bypassed by stale env)", () => {
			// The re-arm case: a runner spawned with FLYWHEEL_CODEX_HARD_GATE=0 in its
			// inherited process.env, then the operator toggles the gate back ON (which
			// DELETES the .env line). A readable .env with the key ABSENT must resolve
			// to default-on — never fall back to the stale inherited 0.
			const envPath = join(tmpDir, "rearm.env");
			writeFileSync(envPath, "SOME_OTHER=1\n"); // key absent, file readable
			expect(
				resolveCodexHardGateOn({
					argsEnv: undefined,
					processEnv: { FLYWHEEL_CODEX_HARD_GATE: "0" } as NodeJS.ProcessEnv,
					dotenvPath: envPath,
				}),
			).toBe(true);
		});

		it("legacy: .env unreadable + inherited =0 → gate off (fallback)", () => {
			expect(
				resolveCodexHardGateOn({
					argsEnv: undefined,
					processEnv: { FLYWHEEL_CODEX_HARD_GATE: "0" } as NodeJS.ProcessEnv,
					dotenvPath: join(tmpDir, "does-not-exist.env"),
				}),
			).toBe(false);
		});
	});

	// ── FLY-1188 §7.3: family-aware review authority (reviewer inversion) ──
	// The CLI mirror of StateStore.isCodexCodeReviewApproved must apply the
	// same crossFamilyReviewSatisfied rule: a codex-family author can only
	// satisfy the gate with a record that PROVES a different-family reviewer.
	describe("FLY-1188 family-aware review authority", () => {
		/** Founder side fully approved, with the author's adapter_type set. */
		function founderApprovedAs(adapterType: string | null): void {
			const qid = createGateQuestion();
			answer(qid, JSON.stringify({ approved: true }));
			writeStateSession({
				execution_id: EXEC,
				status: "approved_to_ship",
				pr_head_sha: HEAD,
				review_question_id: qid,
				adapter_type: adapterType,
			});
		}

		it("codex author + UNSTAMPED approved record → fail-close (codex_review_not_approved)", () => {
			founderApprovedAs("codex-tmux");
			writeCodexRecord(EXEC, HEAD, "approved"); // legacy shape: no family stamps
			const r = runGateOn();
			expect(r.approved).toBe(false);
			expect(r.reason).toBe("codex_review_not_approved");
		});

		it("codex author + cross-family stamped record (codex→claude) → approved", () => {
			founderApprovedAs("codex-tmux");
			writeCodexRecord(EXEC, HEAD, "approved", {
				author: "codex",
				reviewer: "claude",
			});
			const r = runGateOn();
			expect(r.approved).toBe(true);
			expect(r.reason).toBe("approved");
		});

		it("SAME-family stamped record (codex→codex) → fail-close", () => {
			founderApprovedAs("codex-tmux");
			writeCodexRecord(EXEC, HEAD, "approved", {
				author: "codex",
				reviewer: "codex",
			});
			const r = runGateOn();
			expect(r.approved).toBe(false);
			expect(r.reason).toBe("codex_review_not_approved");
		});

		it("FLY-1224 (T13 ③, the OTHER direction): SAME-family stamped record (claude→claude) → fail-close", () => {
			// Annie's directive fixes the rule in BOTH directions: a claude author
			// whose record proves a CLAUDE reviewer is a self-review — the stamps
			// win over the grandfather exemption (which only covers UNSTAMPED
			// historical rows).
			founderApprovedAs("claude-tmux");
			writeCodexRecord(EXEC, HEAD, "approved", {
				author: "claude",
				reviewer: "claude",
			});
			const r = runGateOn();
			expect(r.approved).toBe(false);
			expect(r.reason).toBe("codex_review_not_approved");
		});

		it("legacy claude author (adapter_type NULL) + unstamped record → approved (historical lane)", () => {
			founderApprovedAs(null);
			writeCodexRecord(EXEC, HEAD, "approved");
			expect(runGateOn().approved).toBe(true);
		});

		it("explicit claude-tmux author + unstamped record → approved", () => {
			founderApprovedAs("claude-tmux");
			writeCodexRecord(EXEC, HEAD, "approved");
			expect(runGateOn().approved).toBe(true);
		});

		it("codex author + skipped record → approved (governance bypass is family-agnostic)", () => {
			founderApprovedAs("codex-tmux");
			writeCodexRecord(EXEC, HEAD, "skipped");
			expect(runGateOn().approved).toBe(true);
		});
	});
});
