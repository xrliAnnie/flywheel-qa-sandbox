/**
 * FLY-108: Tests for `flywheel-comm complete` subcommand.
 *
 * Covers:
 * - Payload shape (evidence nested fields, top-level fields, filesChangedCount not filesChanged)
 * - Flag validation (route enum, --merged requires --pr)
 * - Env validation
 * - Retry + exponential backoff + marker file (fail-close)
 * - Git field derivation (branch parse, commit count, diff numstat)
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process so we can control git output
vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
	complete,
	founderReviewCompletionBlockReason,
	gitObjectExists,
} from "../commands/complete.js";
import { CommDB } from "../db.js";
import { removeGateMarker, writeGateMarker } from "../gate-marker.js";

const execFileSyncMock = vi.mocked(execFileSync);

describe("complete command", () => {
	const originalEnv = { ...process.env };
	let mockFetch: ReturnType<typeof vi.fn>;
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let _logSpy: ReturnType<typeof vi.spyOn>;
	let tmpHome: string;

	function activateCompletion(
		input: {
			activationId?: string;
			attempt?: number;
			epochSource?: string;
		} = {},
	): void {
		const dbPath = join(tmpHome, "comm.db");
		process.env.FLYWHEEL_COMM_DB = dbPath;
		const db = new CommDB(dbPath);
		try {
			db.registerSession(
				"exec-108",
				"win:1",
				"geoforge3d",
				"issue-108",
				"lead",
			);
			db.grantTurn("issue-108", "exec-108", "implement", 1_700_000_000_000, {
				project: "geoforge3d",
				sourceEventId: input.epochSource ?? "rework:req-1:activation-2",
				targetRunId: "run-1",
				activation: {
					activationId: input.activationId ?? "activation-2",
					runId: "run-1",
					nodeId: "implement",
					attempt: input.attempt ?? 2,
					context: { authority: "qa" },
				},
			});
		} finally {
			db.close();
		}
	}

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "fly-108-home-"));

		process.env.FLYWHEEL_EXEC_ID = "exec-108";
		process.env.FLYWHEEL_ISSUE_ID = "issue-108";
		process.env.FLYWHEEL_PROJECT_NAME = "geoforge3d";
		process.env.FLYWHEEL_BRIDGE_URL = "http://localhost:9292";
		process.env.HOME = tmpHome;
		delete process.env.FLYWHEEL_INGEST_TOKEN;
		delete process.env.FLYWHEEL_GATE_MARKER_DIR;
		delete process.env.FLYWHEEL_COMPLETE_MARKER_DIR;
		delete process.env.FLYWHEEL_RUNNER_STATE_DIR;
		delete process.env.FLYWHEEL_COMM_DB;
		delete process.env.FLYWHEEL_DESIGN_HTML_GATE;

		mockFetch = vi
			.fn()
			.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
		vi.stubGlobal("fetch", mockFetch);

		exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((code?: number | string | null) => {
				throw new Error(`process.exit(${code})`);
			});

		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		_logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		execFileSyncMock.mockImplementation((cmd, args) => {
			if (cmd !== "git") throw new Error(`unexpected cmd ${cmd}`);
			const a = (args ?? []) as string[];
			if (a[0] === "rev-parse" && a[1] === "--abbrev-ref" && a[2] === "HEAD") {
				return "feat/v1.23.0-FLY-108-session-status-flip\n";
			}
			// FLY-191: bare HEAD sha for evidence.headSha
			if (a[0] === "rev-parse" && a[1] === "HEAD" && a.length === 2) {
				return `${"c".repeat(40)}\n`;
			}
			if (a[0] === "merge-base") {
				return "abc123base\n";
			}
			if (a[0] === "rev-list" && a.includes("--count")) {
				return "3\n";
			}
			if (a[0] === "diff" && a.includes("--numstat")) {
				return "60\t20\tfile-a.ts\n40\t15\tfile-b.ts\n20\t10\tfile-c.ts\n";
			}
			if (a[0] === "diff" && a.includes("--name-only")) {
				return "file-a.ts\nfile-b.ts\nfile-c.ts\n";
			}
			if (a[0] === "diff" && a.includes("--stat")) {
				return " 3 files changed, 120 insertions(+), 45 deletions(-)\n";
			}
			if (a[0] === "log" && a.includes("--format=%s")) {
				return "feat: complete cmd\ntest: add tests\nrefactor: cleanup\n";
			}
			return "";
		});
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		execFileSyncMock.mockReset();
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("valid flags → POST body with correct shape (evidence nested, filesChangedCount not filesChanged)", async () => {
		await complete({
			route: "auto_approve",
			pr: 123,
			merged: true,
		});

		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, opts] = mockFetch.mock.calls[0]!;
		expect(url).toBe("http://localhost:9292/events");
		expect(opts.method).toBe("POST");

		const body = JSON.parse(opts.body);
		expect(body.event_type).toBe("session_completed");
		expect(body.source).toBe("flywheel-comm");
		expect(body.execution_id).toBe("exec-108");
		expect(body.issue_id).toBe("issue-108");
		expect(body.project_name).toBe("geoforge3d");

		// Top-level payload fields
		expect(body.payload.decision).toEqual({ route: "auto_approve" });
		expect(body.payload.sessionRole).toBe("main");
		expect(body.payload.exitReason).toBe("completed");
		expect(body.payload.issueIdentifier).toBe("FLY-108");

		// labels / projectId / consecutiveFailures are intentionally omitted
		expect(body.payload.labels).toBeUndefined();
		expect(body.payload.projectId).toBeUndefined();
		expect(body.payload.consecutiveFailures).toBeUndefined();

		// Evidence-nested fields
		expect(body.payload.evidence.landingStatus).toEqual({
			status: "merged",
			prNumber: 123,
		});
		expect(body.payload.evidence.commitCount).toBe(3);
		expect(body.payload.evidence.filesChangedCount).toBe(3); // NOT filesChanged
		expect(body.payload.evidence.filesChanged).toBeUndefined();
		expect(body.payload.evidence.linesAdded).toBe(120);
		expect(body.payload.evidence.linesRemoved).toBe(45);
		expect(body.payload.evidence.diffSummary).toContain("3 files changed");
		expect(body.payload.evidence.changedFilePaths).toEqual([
			"file-a.ts",
			"file-b.ts",
			"file-c.ts",
		]);
		expect(body.payload.evidence.commitMessages).toEqual([
			"feat: complete cmd",
			"test: add tests",
			"refactor: cleanup",
		]);

		// FLY-191 Phase 2 (§5.5.2): completion binds the exact worktree HEAD —
		// the Bridge persists it as pr_head_sha for verify-approval.
		expect(body.payload.evidence.headSha).toBe("c".repeat(40));
	});

	it("blocks product completion for missing/pending/rejected review and allows only pass", () => {
		const required = (
			verdict: Parameters<
				typeof founderReviewCompletionBlockReason
			>[0]["verdict"],
		) =>
			founderReviewCompletionBlockReason({
				required: true,
				route: "needs_review",
				verdict,
			});
		expect(
			required({ status: "missing", reason: "no_round_for_run" }),
		).toContain("founder_review missing");
		expect(
			required({
				status: "not_passed",
				questionId: "pending",
				reason: "response_missing",
			}),
		).toContain("response_missing");
		expect(
			required({
				status: "not_passed",
				questionId: "rejected",
				reason: "revisions_requested",
			}),
		).toContain("revisions_requested");
		expect(
			required({
				status: "passed",
				questionId: "passed",
				artifactDigest: "a".repeat(64),
			}),
		).toBeUndefined();
	});

	it("keeps blocked and ship_attempt_failed available while review is pending", () => {
		for (const route of ["blocked", "ship_attempt_failed"]) {
			expect(
				founderReviewCompletionBlockReason({
					required: true,
					route,
					verdict: { status: "missing", reason: "no_round_for_run" },
				}),
			).toBeUndefined();
		}
	});

	it.each([
		[
			"engine_gate_handoff",
			"run 已进入 engine-owned gate;本节点已终结,不会有 approve/ship 环节找你;不要等待、不要跑 verify-approval,立即收尾退出。",
		],
		["runner_ship_park", "已 park 等待 ship gate;等 wake,勿自行轮询。"],
	] as const)(
		"prints %s completion guidance",
		async (disposition, guidance) => {
			mockFetch.mockResolvedValue({
				ok: true,
				status: 200,
				text: async () =>
					JSON.stringify({ completionDisposition: disposition }),
			});

			await complete({ route: "needs_review", merged: false });

			expect(_logSpy).toHaveBeenCalledWith(guidance);
		},
	);

	it("keeps successful legacy and terminal responses output-compatible", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			text: async () =>
				JSON.stringify({ completionDisposition: "terminal_no_gate" }),
		});

		await complete({ route: "no_code", merged: false });

		expect(_logSpy).toHaveBeenCalledTimes(1);
		expect(_logSpy).toHaveBeenCalledWith(
			"[complete] session_completed delivered (attempt 1/4)",
		);
	});

	it("does not retry a 2xx when reading its completion receipt fails", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => {
				throw new Error("body unavailable");
			},
		});

		await expect(
			complete({ route: "needs_review", merged: false }),
		).resolves.toBeUndefined();
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("bounds a stalled 2xx completion receipt body", async () => {
		vi.useFakeTimers();
		try {
			mockFetch.mockImplementation(async (_url, init) => ({
				ok: true,
				status: 200,
				text: () =>
					new Promise<string>((_resolve, reject) =>
						init.signal.addEventListener("abort", () =>
							reject(new Error("body read aborted")),
						),
					),
			}));

			const completion = complete({ route: "needs_review", merged: false });
			await vi.advanceTimersByTimeAsync(5_000);
			await expect(completion).resolves.toBeUndefined();
			expect(mockFetch).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("writes an atomic runner-stop breadcrumb before delivering completion", async () => {
		const stateDir = join(tmpHome, "runner-state", "exec-108");
		process.env.FLYWHEEL_RUNNER_STATE_DIR = stateDir;
		mockFetch.mockImplementation(async (_url, init) => {
			const breadcrumb = JSON.parse(
				readFileSync(join(stateDir, "last-complete.json"), "utf8"),
			);
			const body = JSON.parse(String(init?.body));
			expect(breadcrumb).toMatchObject({
				v: 1,
				completionEventId: body.event_id,
				executionId: "exec-108",
				issueId: "issue-108",
				route: "needs_review",
				pr: 91,
			});
			expect(breadcrumb.sanitizedSummary.length).toBeLessThanOrEqual(200);
			expect(new Date(breadcrumb.createdAt).toISOString()).toBe(
				breadcrumb.createdAt,
			);
			return { ok: true, status: 200, text: async () => "" };
		});

		await complete({
			route: "needs_review",
			pr: 91,
			merged: false,
			summary: "ready\nfor\u0000 review",
		});
	});

	it("derives the same state directory for Codex when no explicit dir is set", async () => {
		delete process.env.FLYWHEEL_RUNNER_STATE_DIR;
		await complete({ route: "no_code", merged: false });
		expect(
			existsSync(
				join(
					tmpHome,
					".flywheel",
					"runner-state",
					"exec-108",
					"last-complete.json",
				),
			),
		).toBe(true);
	});

	it("fails open when the breadcrumb cannot be written", async () => {
		const notDirectory = join(tmpHome, "not-a-directory");
		writeFileSync(notDirectory, "occupied");
		process.env.FLYWHEEL_RUNNER_STATE_DIR = notDirectory;

		await expect(
			complete({ route: "no_code", merged: false }),
		).resolves.toBeUndefined();
		expect(mockFetch).toHaveBeenCalledOnce();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("runner-stop breadcrumb"),
		);
	});

	it("attaches the exact current activation and TURN epoch to completion", async () => {
		activateCompletion();

		await complete({ route: "needs_review", merged: false });

		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.payload.workflowActivation).toEqual({
			activationId: "activation-2",
			runId: "run-1",
			nodeId: "implement",
			attempt: 2,
			turnEpoch: 1,
		});
	});

	it("refuses a stale generic activation with a typed error before delivery", async () => {
		activateCompletion();
		const db = new CommDB(process.env.FLYWHEEL_COMM_DB!);
		try {
			db.registerSession(
				"exec-new",
				"win:2",
				"geoforge3d",
				"issue-108",
				"lead",
			);
			db.grantTurn("issue-108", "exec-new", "produce", 1_700_000_001_000, {
				project: "geoforge3d",
				sourceEventId: "turn:spawn:exec-new",
				targetRunId: "run-1",
				activation: {
					activationId: "activation-new",
					runId: "run-1",
					nodeId: "produce",
					attempt: 3,
					context: {},
				},
			});
		} finally {
			db.close();
		}

		await expect(
			complete({ route: "needs_review", merged: false }),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				"workflow activation authority is unavailable; refusing route=needs_review",
			),
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("does not attach a ship-carrier activation to the runner completion", async () => {
		activateCompletion();
		const db = new CommDB(process.env.FLYWHEEL_COMM_DB!);
		try {
			db.grantTurn("issue-108", "exec-108", "implement", 1_700_000_001_000, {
				project: "geoforge3d",
				sourceEventId: "runner_ship_approved:approve-1",
				targetRunId: "run-1",
				activation: {
					activationId: "carrier:run-1:approve-1",
					runId: "run-1",
					nodeId: "founder_gate",
					attempt: 1,
					context: { kind: "runner_ship_carrier" },
				},
			});
		} finally {
			db.close();
		}

		await complete({ route: "needs_review", merged: false });

		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.payload.workflowActivation).toBeUndefined();
	});

	it("FLY-191: --question-id travels as payload.reviewQuestionId (review binding)", async () => {
		await complete({
			route: "needs_review",
			merged: false,
			questionId: "55555555-5555-5555-5555-555555555555",
		});
		const [, opts] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(opts.body);
		expect(body.payload.reviewQuestionId).toBe(
			"55555555-5555-5555-5555-555555555555",
		);
	});

	it("FLY-191: no --question-id → payload.reviewQuestionId absent", async () => {
		await complete({ route: "needs_review", merged: false });
		const [, opts] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(opts.body);
		expect(body.payload.reviewQuestionId).toBeUndefined();
	});

	it("FLY-191: malformed/unavailable git HEAD → evidence.headSha ABSENT (fail-closed downstream)", async () => {
		execFileSyncMock.mockImplementation((cmd, args) => {
			if (cmd !== "git") throw new Error(`unexpected cmd ${cmd}`);
			const a = (args ?? []) as string[];
			if (a[0] === "rev-parse" && a[1] === "HEAD" && a.length === 2) {
				return "fatal: not a git repository\n"; // garbage, not a sha
			}
			return "";
		});

		await complete({ route: "needs_review", merged: false });

		const [, opts] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(opts.body);
		// Never guess: absent field → verify-approval fail-closes on the
		// missing persisted sha rather than matching garbage.
		expect(body.payload.evidence.headSha).toBeUndefined();
	});

	it("missing --route → exit 1", async () => {
		await expect(
			complete({ route: "", merged: false } as unknown as Parameters<
				typeof complete
			>[0]),
		).rejects.toThrow("process.exit(1)");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("invalid --route (rejected) → exit 1", async () => {
		await expect(
			complete({ route: "rejected", merged: false }),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Invalid --route"),
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	describe("FLY-1257 M1-c: blocked completion guard for Codex runners", () => {
		function enableCodex(): { dbPath: string; markerDir: string } {
			const dbPath = join(tmpHome, "comm.db");
			const markerDir = join(tmpHome, "codex-gates");
			process.env.FLYWHEEL_GATE_MARKER_DIR = markerDir;
			process.env.FLYWHEEL_COMM_DB = dbPath;
			const db = new CommDB(dbPath);
			db.close();
			return { dbPath, markerDir };
		}

		function insertGate(dbPath: string, runnerId = "exec-108"): string {
			const db = new CommDB(dbPath, false);
			try {
				return db.insertQuestion(runnerId, "lead-1", "review", {
					checkpoint: "review_code",
				});
			} finally {
				db.close();
			}
		}

		it("refuses route=blocked from CommDB even when the marker mirror is absent", async () => {
			const { dbPath } = enableCodex();
			const questionId = insertGate(dbPath);

			await expect(
				complete({ route: "blocked", merged: false }),
			).rejects.toThrow("process.exit(1)");
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining(questionId),
			);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("a runner-deleted marker cannot hide a pending CommDB gate", async () => {
			const { dbPath, markerDir } = enableCodex();
			const questionId = insertGate(dbPath);
			writeGateMarker(markerDir, {
				questionId,
				executionId: "exec-108",
				backend: "codex-tmux",
				vendor: "codex",
				checkpoint: "review_code",
			});
			removeGateMarker(markerDir, questionId);

			await expect(
				complete({ route: "blocked", merged: false }),
			).rejects.toThrow("process.exit(1)");
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("allows route=blocked after the authoritative gate is answered", async () => {
			const { dbPath } = enableCodex();
			const questionId = insertGate(dbPath);
			const db = new CommDB(dbPath, false);
			db.insertResponse(questionId, "lead-1", "answered");
			db.close();

			await complete({ route: "blocked", merged: false });
			expect(mockFetch).toHaveBeenCalledOnce();
		});

		it("ignores another execution's pending CommDB gate", async () => {
			const { dbPath } = enableCodex();
			insertGate(dbPath, "other-exec");
			await complete({ route: "blocked", merged: false });
			expect(mockFetch).toHaveBeenCalledOnce();
		});

		it("fails closed when CommDB authority is missing", async () => {
			process.env.FLYWHEEL_GATE_MARKER_DIR = join(tmpHome, "codex-gates");
			delete process.env.FLYWHEEL_COMM_DB;

			await expect(
				complete({ route: "blocked", merged: false }),
			).rejects.toThrow("process.exit(1)");
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("FLYWHEEL_COMM_DB"),
			);
		});
	});

	it("keeps Claude/non-marker executions byte-compatible without consulting CommDB", async () => {
		delete process.env.FLYWHEEL_GATE_MARKER_DIR;
		process.env.FLYWHEEL_COMM_DB = join(tmpHome, "missing", "comm.db");
		await complete({ route: "blocked", merged: false });
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("--merged without --pr → exit 1", async () => {
		await expect(
			complete({ route: "auto_approve", merged: true }),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("--merged requires --pr"),
		);
	});

	// FLY-222 #1: no_code terminal route
	it("FLY-222: route=no_code is accepted and posts decision.route=no_code", async () => {
		await complete({ route: "no_code", merged: false, summary: "2 issues" });
		expect(mockFetch).toHaveBeenCalled();
		const [, opts] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(opts.body);
		expect(body.payload.decision).toEqual({ route: "no_code" });
		expect(body.payload.summary).toBe("2 issues");
	});

	it("FLY-222: route=no_code with --merged → exit 1 (contradictory)", async () => {
		await expect(
			complete({ route: "no_code", pr: 7, merged: true }),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("no_code is for no-code/no-merge"),
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("FLY-222: route=no_code with --pr → exit 1 (contradictory)", async () => {
		await expect(
			complete({ route: "no_code", pr: 7, merged: false }),
		).rejects.toThrow("process.exit(1)");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("FLY-1404: phase design completion fails closed without committed issue HTML", async () => {
		await expect(
			complete({ route: "phase_design_complete", merged: false }),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("founder design HTML"),
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("FLY-1404: committed issue HTML emits a head-bound attestation", async () => {
		execFileSyncMock.mockImplementation((cmd, args) => {
			if (cmd !== "git") throw new Error(`unexpected cmd ${cmd}`);
			const a = (args ?? []) as string[];
			if (a[0] === "rev-parse" && a[1] === "--abbrev-ref") {
				return "flywheel-FLY-1404\n";
			}
			if (a[0] === "rev-parse" && a[1] === "HEAD") return `${"d".repeat(40)}\n`;
			if (a[0] === "merge-base") return "base1404\n";
			if (a[0] === "rev-list") return "1\n";
			if (a[0] === "diff" && a.includes("--numstat")) {
				return "10\t0\tengineering/doc/FLY-1404-design-html/design.html\n";
			}
			if (a[0] === "diff" && a.includes("--name-only")) {
				return "engineering/doc/FLY-1404-design-html/design.html\n";
			}
			if (a[0] === "diff" && a.includes("--stat")) {
				return "1 file changed, 10 insertions(+)\n";
			}
			if (a[0] === "log") return "docs: founder design HTML\n";
			if (a[0] === "cat-file") return "";
			return "";
		});

		await complete({ route: "phase_design_complete", merged: false });

		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.payload.designHtmlEvidence).toEqual({
			version: 1,
			issueIdentifier: "FLY-1404",
			paths: ["engineering/doc/FLY-1404-design-html/design.html"],
			headSha: "d".repeat(40),
		});
	});

	it("FLY-1404: refuses to attest HTML from a HEAD that moved after evidence capture", async () => {
		const capturedHead = "1".repeat(40);
		const htmlPath = "engineering/doc/FLY-1404-design-html/design.html";
		execFileSyncMock.mockImplementation((cmd, args) => {
			if (cmd !== "git") throw new Error(`unexpected cmd ${cmd}`);
			const a = (args ?? []) as string[];
			if (a[0] === "rev-parse" && a[1] === "--abbrev-ref") {
				return "flywheel-FLY-1404\n";
			}
			if (a[0] === "rev-parse" && a[1] === "HEAD") {
				return `${capturedHead}\n`;
			}
			if (a[0] === "merge-base") return "base1404\n";
			if (a[0] === "rev-list") return "1\n";
			if (a[0] === "diff" && a.includes("--numstat")) return "";
			if (a[0] === "diff" && a.includes("--stat")) return "";
			if (a[0] === "log") return "docs: founder design HTML\n";
			if (a[0] === "diff" && a.includes("--name-only")) {
				if (a.includes("--diff-filter=ACMR")) {
					// The captured commit has no HTML. A later, moving HEAD does.
					return a.at(-1) === "base1404..HEAD" ? `${htmlPath}\n` : "";
				}
				return "";
			}
			if (a[0] === "cat-file") {
				if (a[2] === `HEAD:${htmlPath}`) return "";
				throw new Error("HTML does not exist at the captured head");
			}
			return "";
		});

		await expect(
			complete({ route: "phase_design_complete", merged: false }),
		).rejects.toThrow("process.exit(1)");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("FLY-1404: a deleted HTML cannot satisfy the committed artifact gate", async () => {
		execFileSyncMock.mockImplementation((cmd, args) => {
			if (cmd !== "git") throw new Error(`unexpected cmd ${cmd}`);
			const a = (args ?? []) as string[];
			if (a[0] === "rev-parse" && a[1] === "--abbrev-ref") {
				return "flywheel-FLY-1404\n";
			}
			if (a[0] === "rev-parse" && a[1] === "HEAD") return `${"d".repeat(40)}\n`;
			if (a[0] === "merge-base") return "base1404\n";
			if (a[0] === "diff" && a.includes("--name-only")) {
				return a.includes("--diff-filter=ACMR")
					? ""
					: "engineering/doc/FLY-1404-design-html/deleted.html\n";
			}
			return "";
		});

		await expect(
			complete({ route: "phase_design_complete", merged: false }),
		).rejects.toThrow("process.exit(1)");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("FLY-1404: operator escape skips validation loudly and emits no attestation", async () => {
		process.env.FLYWHEEL_DESIGN_HTML_GATE = "0";
		await complete({ route: "phase_design_complete", merged: false });

		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.payload.designHtmlEvidence).toBeUndefined();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("design-HTML gate DISABLED"),
		);
	});

	it("FLY-1404: git object existence distinguishes empty-success from failure", () => {
		execFileSyncMock.mockReturnValueOnce("");
		expect(gitObjectExists("HEAD", "doc/FLY-1404-x/design.html")).toBe(true);
		execFileSyncMock.mockImplementationOnce(() => {
			throw new Error("missing");
		});
		expect(gitObjectExists("HEAD", "doc/FLY-1404-x/missing.html")).toBe(false);
	});

	// FLY-493: pr_handoff terminal route (no-transport antigravity build+PR).
	it("FLY-493: route=pr_handoff posts decision.route=pr_handoff with ready_to_merge landing evidence", async () => {
		await complete({ route: "pr_handoff", pr: 42, merged: false });
		expect(mockFetch).toHaveBeenCalled();
		const [, opts] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(opts.body);
		expect(body.payload.decision).toEqual({ route: "pr_handoff" });
		// Fail-closed PR evidence: landingStatus carries ready_to_merge + prNumber.
		expect(body.payload.evidence.landingStatus).toEqual({
			status: "ready_to_merge",
			prNumber: 42,
		});
		// headSha still bound (so downstream has the PR head).
		expect(body.payload.evidence.headSha).toBe("c".repeat(40));
	});

	it("FLY-1505: route=ship_attempt_failed posts a replayable head-bound attempt without merged landing evidence", async () => {
		await complete({
			route: "ship_attempt_failed",
			pr: 42,
			merged: false,
			questionId: "11111111-1111-1111-1111-111111111111",
			summary: "SHIP-STALLED run 123",
		});
		const [, opts] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(opts.body);
		expect(body.payload.decision).toEqual({ route: "ship_attempt_failed" });
		expect(body.payload.reviewQuestionId).toBe(
			"11111111-1111-1111-1111-111111111111",
		);
		expect(body.payload.summary).toBe("SHIP-STALLED run 123");
		expect(body.payload.evidence.headSha).toBe("c".repeat(40));
		expect(body.payload.evidence.prNumber).toBe(42);
		expect(body.payload.evidence.landingStatus).toBeUndefined();
	});

	it("FLY-1505: route=ship_attempt_failed requires an unmerged PR", async () => {
		await expect(
			complete({ route: "ship_attempt_failed", merged: false }),
		).rejects.toThrow("process.exit(1)");
		expect(mockFetch).not.toHaveBeenCalled();

		await expect(
			complete({ route: "ship_attempt_failed", pr: 42, merged: true }),
		).rejects.toThrow("process.exit(1)");
		expect(mockFetch).not.toHaveBeenCalled();

		await expect(
			complete({ route: "ship_attempt_failed", pr: 42, merged: false }),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("requires --question-id"),
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("FLY-1434: route=needs_review with --pr carries authoritative ready_to_merge evidence", async () => {
		await complete({ route: "needs_review", pr: 42, merged: false });
		expect(mockFetch).toHaveBeenCalledOnce();
		const [, opts] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(opts.body);
		expect(body.payload.decision).toEqual({ route: "needs_review" });
		expect(body.payload.evidence.landingStatus).toEqual({
			status: "ready_to_merge",
			prNumber: 42,
		});
		expect(body.payload.evidence.headSha).toBe("c".repeat(40));
	});

	it("FLY-1434: --target-repo is only valid with a positive --pr", async () => {
		await expect(
			complete({
				route: "needs_review",
				targetRepo: "packages/example",
				merged: false,
			}),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("--target-repo requires --pr"),
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("FLY-493: route=pr_handoff WITHOUT --pr → exit 1 (PR evidence mandatory)", async () => {
		await expect(
			complete({ route: "pr_handoff", merged: false }),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("pr_handoff requires --pr"),
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	// Codex code review R1: --pr parses via parseInt, so NaN / non-positive must
	// NOT pass (NaN → JSON null, which the sinks would still terminalize).
	it.each([Number.NaN, 0, -3, 1.5])(
		"FLY-493: route=pr_handoff with non-positive-integer --pr (%s) → exit 1",
		async (badPr) => {
			await expect(
				complete({ route: "pr_handoff", pr: badPr as number, merged: false }),
			).rejects.toThrow("process.exit(1)");
			expect(mockFetch).not.toHaveBeenCalled();
		},
	);

	it("FLY-493: route=pr_handoff with --merged → exit 1 (contradictory)", async () => {
		await expect(
			complete({ route: "pr_handoff", pr: 42, merged: true }),
		).rejects.toThrow("process.exit(1)");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("FLY-493: pr_handoff validates FLYWHEEL_LAND_STATUS_PATH prNumber against --pr (mismatch → exit 1)", async () => {
		const landPath = join(tmpHome, "land-status.json");
		writeFileSync(
			landPath,
			JSON.stringify({ status: "ready_to_merge", prNumber: 999 }),
		);
		process.env.FLYWHEEL_LAND_STATUS_PATH = landPath;
		await expect(
			complete({ route: "pr_handoff", pr: 42, merged: false }),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("land-status"),
		);
		expect(mockFetch).not.toHaveBeenCalled();
		delete process.env.FLYWHEEL_LAND_STATUS_PATH;
	});

	it("missing FLYWHEEL_EXEC_ID → exit 1 with explicit env name", async () => {
		delete process.env.FLYWHEEL_EXEC_ID;
		await expect(
			complete({ route: "auto_approve", pr: 1, merged: true }),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("FLYWHEEL_EXEC_ID"),
		);
	});

	it("missing FLYWHEEL_BRIDGE_URL → exit 1", async () => {
		delete process.env.FLYWHEEL_BRIDGE_URL;
		await expect(
			complete({ route: "auto_approve", pr: 1, merged: true }),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("FLYWHEEL_BRIDGE_URL"),
		);
	});

	it("Bridge 5xx x4 → marker file written + exit 1 (fail-close)", async () => {
		vi.useFakeTimers();
		try {
			activateCompletion();
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => "server error",
			});

			const promise = complete({
				route: "auto_approve",
				pr: 42,
				merged: true,
			});

			const expectation = expect(promise).rejects.toThrow("process.exit(1)");
			// Advance through all retries (1s + 2s + 4s backoff)
			await vi.advanceTimersByTimeAsync(8000);
			await expectation;

			expect(mockFetch).toHaveBeenCalledTimes(4);

			const markerPath = join(
				tmpHome,
				".flywheel",
				"state",
				"complete-failed",
				"exec-108.json",
			);
			const marker = JSON.parse(readFileSync(markerPath, "utf8"));
			expect(marker.execution_id).toBe("exec-108");
			expect(marker.attempts).toBe(4);
			expect(marker.payload.decision.route).toBe("auto_approve");
			expect(marker.payload.workflowActivation).toEqual({
				activationId: "activation-2",
				runId: "run-1",
				nodeId: "implement",
				attempt: 2,
				turnEpoch: 1,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("Bridge 5xx writes the fail-close marker only to the slot override", async () => {
		vi.useFakeTimers();
		try {
			activateCompletion();
			const slotMarkerDir = join(tmpHome, "slot-state", "complete-failed");
			process.env.FLYWHEEL_COMPLETE_MARKER_DIR = `  ${slotMarkerDir}  `;
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => "server error",
			});

			const completion = complete({
				route: "auto_approve",
				pr: 42,
				merged: true,
			});
			const expectation = expect(completion).rejects.toThrow("process.exit(1)");
			await vi.advanceTimersByTimeAsync(8000);
			await expectation;

			expect(
				readFileSync(join(slotMarkerDir, "exec-108.json"), "utf8"),
			).toContain('"execution_id": "exec-108"');
			expect(
				existsSync(
					join(
						tmpHome,
						".flywheel",
						"state",
						"complete-failed",
						"exec-108.json",
					),
				),
			).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("deterministic Bridge 409 stops after one attempt and preserves the response reason", async () => {
		vi.useFakeTimers();
		try {
			mockFetch.mockResolvedValue(
				new Response(
					JSON.stringify({
						error: "workflow_completion_rejected",
						reason: "completion_conflict",
					}),
					{
						status: 409,
						headers: { "content-type": "application/json" },
					},
				),
			);
			const completion = complete({
				route: "auto_approve",
				pr: 42,
				merged: true,
			});
			const expectation = expect(completion).rejects.toThrow("process.exit(1)");
			await vi.advanceTimersByTimeAsync(8000);
			await expectation;

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const markerPath = join(
				tmpHome,
				".flywheel",
				"state",
				"complete-failed",
				"exec-108.json",
			);
			const marker = JSON.parse(readFileSync(markerPath, "utf8"));
			expect(marker.attempts).toBe(1);
			expect(marker.error).toContain("completion_conflict");
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("completion_conflict"),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retryable Bridge 409 still retries and succeeds", async () => {
		vi.useFakeTimers();
		try {
			mockFetch
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							reason: "missing_output",
							retryable: true,
						}),
						{
							status: 409,
							headers: { "content-type": "application/json" },
						},
					),
				)
				.mockResolvedValueOnce(new Response("{}", { status: 200 }));
			const completion = complete({
				route: "auto_approve",
				pr: 42,
				merged: true,
			});
			await vi.advanceTimersByTimeAsync(2000);
			await completion;
			expect(mockFetch).toHaveBeenCalledTimes(2);
			expect(exitSpy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("Bridge timeout → 200 on 2nd attempt → exit 0, no marker", async () => {
		vi.useFakeTimers();
		try {
			let attempt = 0;
			mockFetch.mockImplementation(() => {
				attempt += 1;
				if (attempt === 1) return Promise.reject(new Error("ETIMEDOUT"));
				return Promise.resolve({ ok: true, status: 200, text: async () => "" });
			});

			const p = complete({ route: "auto_approve", pr: 1, merged: true });
			await vi.advanceTimersByTimeAsync(2000);
			await p;

			expect(mockFetch).toHaveBeenCalledTimes(2);
			expect(exitSpy).not.toHaveBeenCalled();

			const markerDir = join(tmpHome, ".flywheel", "state", "complete-failed");
			// Marker should NOT exist
			expect(() => readFileSync(join(markerDir, "exec-108.json"))).toThrow();
		} finally {
			vi.useRealTimers();
		}
	});

	it("git branch not matching regex → issueIdentifier omitted", async () => {
		execFileSyncMock.mockImplementation((_cmd, args) => {
			const a = (args ?? []) as string[];
			if (a[0] === "rev-parse" && a[1] === "--abbrev-ref") return "main\n";
			if (a[0] === "merge-base") return "base123\n";
			if (a[0] === "rev-list") return "1\n";
			if (a[0] === "diff" && a.includes("--numstat")) return "10\t5\tfoo.ts\n";
			if (a[0] === "diff" && a.includes("--name-only")) return "foo.ts\n";
			if (a[0] === "diff") return " 1 file changed\n";
			if (a[0] === "log") return "fix: thing\n";
			return "";
		});

		await complete({ route: "auto_approve", pr: 9, merged: true });

		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.payload.issueIdentifier).toBeUndefined();
	});

	it("non-merged needs_review path → landingStatus omitted, route needs_review", async () => {
		await complete({ route: "needs_review", merged: false });

		expect(mockFetch).toHaveBeenCalledOnce();
		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.payload.decision.route).toBe("needs_review");
		expect(body.payload.evidence.landingStatus).toBeUndefined();
	});

	it("includes Authorization header when FLYWHEEL_INGEST_TOKEN present", async () => {
		process.env.FLYWHEEL_INGEST_TOKEN = "  token-xyz  ";
		await complete({ route: "auto_approve", pr: 1, merged: true });

		const opts = mockFetch.mock.calls[0]![1];
		expect(opts.headers.Authorization).toBe("Bearer token-xyz");
	});

	it("--exit-reason override is honored", async () => {
		await complete({
			route: "auto_approve",
			pr: 1,
			merged: true,
			exitReason: "crashed",
		});
		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.payload.exitReason).toBe("crashed");
	});

	it("--summary override is honored", async () => {
		await complete({
			route: "auto_approve",
			pr: 1,
			merged: true,
			summary: "explicit summary",
		});
		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.payload.summary).toBe("explicit summary");
	});

	it("default summary comes from HEAD commit subject when --summary absent", async () => {
		await complete({ route: "auto_approve", pr: 1, merged: true });
		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.payload.summary).toBe("feat: complete cmd");
	});
});
