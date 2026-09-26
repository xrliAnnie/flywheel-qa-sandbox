/**
 * FLY-2891: the review gate binds an APPROVED result to the exact Codex turn,
 * verifies the model that turn really ran, and requires the Bridge to confirm
 * the model matches the route's required reviewer model.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitCodexGate } from "../commands/await-codex-gate.js";
import { buildCodexReviewResultBody } from "../commands/codex-review-result.js";
import { countReviewRoundSpool } from "../review-round-spool.js";

const EXEC = "11111111-2222-4333-8444-555555555555";
const THREAD = "01a0daf6-1f50-7522-b7dc-f0b3812a5dab";
const TURN = "01a0daf6-2634-7a23-a8e9-c1669023f458";
const LATER_TURN = "01a0db01-8aa3-7cf1-8ec1-05aaa7a94307";
const BLOB = "a".repeat(40);

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("FLY-2891 await-codex-gate reviewer model", () => {
	let root: string;
	let codexDir: string;
	let codexHome: string;
	let stateDir: string;
	let errors: string[];

	function writeRollout(
		turns: Array<{
			id: string;
			model: string;
			effort?: string;
			done?: boolean;
		}>,
	) {
		const dir = join(codexHome, "sessions", "2026", "09", "25");
		mkdirSync(dir, { recursive: true });
		const lines: unknown[] = [
			{
				timestamp: "2026-09-25T10:00:00.000Z",
				type: "session_meta",
				payload: { id: THREAD },
			},
		];
		for (const turn of turns) {
			lines.push({
				timestamp: "2026-09-25T10:00:01.000Z",
				type: "event_msg",
				payload: { type: "task_started", turn_id: turn.id },
			});
			lines.push({
				timestamp: "2026-09-25T10:00:02.000Z",
				type: "turn_context",
				payload: {
					turn_id: turn.id,
					model: turn.model,
					effort: turn.effort ?? "xhigh",
				},
			});
			if (turn.done !== false)
				lines.push({
					timestamp: "2026-09-25T10:05:00.000Z",
					type: "event_msg",
					payload: { type: "task_complete", turn_id: turn.id },
				});
		}
		writeFileSync(
			join(dir, `rollout-2026-09-25T10-00-00-${THREAD}.jsonl`),
			`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
		);
	}

	function writeResult(
		reviewType: "design" | "code",
		overrides: Record<string, unknown> = {},
	) {
		const head =
			reviewType === "code"
				? execFileSync("git", ["rev-parse", "HEAD"], {
						cwd: root,
						encoding: "utf8",
					}).trim()
				: undefined;
		const result: Record<string, unknown> = {
			executionId: EXEC,
			reviewType,
			status: "APPROVED",
			reviewedTarget:
				reviewType === "design"
					? "doc/plan.md"
					: "https://github.com/o/r/pull/7",
			timestamp: new Date().toISOString(),
			reviewerModel: reviewType === "design" ? "gpt-6-astra" : "gpt-5.6-sol",
			reviewerEffort: "xhigh",
			codexThreadId: THREAD,
			codexTurnId: TURN,
			finalRound: 2,
			rounds: 2,
			...(reviewType === "design"
				? { requestId: "req-1", reviewedPlanBlobSha: BLOB }
				: { reviewedHeadSha: head }),
			...overrides,
		};
		for (const [key, value] of Object.entries(overrides))
			if (value === undefined) delete result[key];
		writeFileSync(
			join(codexDir, `${reviewType}-review.json`),
			JSON.stringify(result),
		);
	}

	function env(extra: Record<string, string> = {}) {
		return {
			FLYWHEEL_BRIDGE_URL: "http://bridge.test",
			FLYWHEEL_INGEST_TOKEN: "tok",
			CODEX_HOME: codexHome,
			FLYWHEEL_STATE_DIR: stateDir,
			...extra,
		};
	}

	async function gate(
		reviewType: "design" | "code",
		fetchImpl: typeof fetch,
		extraEnv: Record<string, string> = {},
	): Promise<number> {
		try {
			await awaitCodexGate({
				reviewType,
				execId: EXEC,
				worktreePath: root,
				timeoutMs: 2_000,
				pollIntervalMs: 20,
				env: env(extraEnv),
				fetchImpl,
			});
		} catch (error) {
			const match = /process\.exit\((\d+)\)/.exec(String(error));
			if (match) return Number(match[1]);
			throw error;
		}
		throw new Error("gate returned without exiting");
	}

	/** Bridge fake: validation answer + records every call. */
	function bridge(
		validation: Response | (() => Response),
		roundsStatus = 200,
	): ReturnType<typeof vi.fn> & typeof fetch {
		return vi.fn(async (url: string | URL | Request) => {
			if (String(url).endsWith("/review-rounds"))
				return json(
					roundsStatus,
					roundsStatus === 200 ? { recorded: true } : {},
				);
			return typeof validation === "function"
				? validation()
				: validation.clone();
		}) as never;
	}

	beforeEach(() => {
		root = join(tmpdir(), `fly2891-gate-${Date.now()}-${Math.random()}`);
		codexDir = join(root, ".flywheel", "runs", EXEC, "codex");
		codexHome = join(root, "codex-home");
		stateDir = join(root, "state-root");
		mkdirSync(codexDir, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: root });
		execFileSync("git", ["config", "user.name", "t"], { cwd: root });
		execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
			cwd: root,
		});
		writeRollout([{ id: TURN, model: "gpt-6-astra" }]);
		errors = [];
		vi.spyOn(process, "exit").mockImplementation((code?: number) => {
			throw new Error(`process.exit(${code})`);
		});
		vi.spyOn(console, "error").mockImplementation((line: unknown) => {
			errors.push(String(line));
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it.each([
		["reviewerModel"],
		["reviewerEffort"],
		["codexThreadId"],
		["codexTurnId"],
		["finalRound"],
		["rounds"],
	])("rejects a result missing %s with a schema hint", async (field) => {
		writeResult("design", { [field]: undefined });
		const fetchImpl = bridge(
			json(200, { allowed: true, reviewerModelChecked: true }),
		);
		expect(await gate("design", fetchImpl)).toBe(1);
		expect(errors.join("\n")).toContain(field);
		expect(errors.join("\n")).toMatch(/Bridge instruction schema/);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects finalRound greater than rounds", async () => {
		writeResult("design", { finalRound: 3, rounds: 2 });
		expect(await gate("design", bridge(json(200, {})))).toBe(1);
		expect(errors.join("\n")).toMatch(/finalRound/);
	});

	it("rejects a result whose declared model differs from what the turn ran", async () => {
		writeRollout([{ id: TURN, model: "gpt-5.6-sol" }]);
		writeResult("design");
		const fetchImpl = bridge(
			json(200, { allowed: true, reviewerModelChecked: true }),
		);
		expect(await gate("design", fetchImpl)).toBe(1);
		expect(errors.join("\n")).toContain(
			`result declares gpt-6-astra/xhigh but Codex turn ${TURN} ran gpt-5.6-sol/xhigh`,
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects when the turn is missing or unfinished, naming the lookup roots", async () => {
		writeRollout([{ id: TURN, model: "gpt-6-astra", done: false }]);
		writeResult("design");
		expect(await gate("design", bridge(json(200, {})))).toBe(1);
		expect(errors.join("\n")).toContain(
			`cannot verify reviewer model for Codex turn ${TURN} (thread ${THREAD}) under ${codexHome}/{sessions,archived_sessions}`,
		);
		rmSync(codexHome, { recursive: true, force: true });
		errors = [];
		expect(await gate("design", bridge(json(200, {})))).toBe(1);
		expect(errors.join("\n")).toMatch(/cannot verify reviewer model/);
	});

	it("binds to the named turn even when a later follow-up ran another model", async () => {
		writeRollout([
			{ id: TURN, model: "gpt-6-astra" },
			{ id: LATER_TURN, model: "gpt-5.6-sol", effort: "medium" },
		]);
		writeResult("design");
		const fetchImpl = bridge(
			json(200, { allowed: true, reviewerModelChecked: true }),
		);
		expect(await gate("design", fetchImpl)).toBe(0);
		const validation = JSON.parse(
			String(fetchImpl.mock.calls[0]![1]?.body),
		) as Record<string, unknown>;
		expect(validation).toMatchObject({
			reviewerModel: "gpt-6-astra",
			codexTurnId: TURN,
		});
	});

	it("surfaces the Bridge's wrong-model denial verbatim", async () => {
		writeResult("design");
		const fetchImpl = bridge(
			json(409, {
				allowed: false,
				reason:
					"reviewer model mismatch: request requires gpt-6-astra/xhigh, review ran gpt-5.6-sol/xhigh",
			}),
		);
		expect(await gate("design", fetchImpl)).toBe(1);
		expect(errors.join("\n")).toContain(
			"request requires gpt-6-astra/xhigh, review ran gpt-5.6-sol/xhigh",
		);
	});

	it("fails closed when the Bridge does not confirm model validation (old Bridge)", async () => {
		writeResult("design");
		expect(await gate("design", bridge(json(200, { allowed: true })))).toBe(1);
		expect(errors.join("\n")).toMatch(
			/Bridge did not confirm reviewer-model validation/,
		);
	});

	it("validates code reviews through /code-review-validation", async () => {
		writeRollout([{ id: TURN, model: "gpt-5.6-sol" }]);
		writeResult("code");
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		const allow = bridge(
			json(200, { allowed: true, reviewerModelChecked: true }),
		);
		expect(await gate("code", allow)).toBe(0);
		expect(String(allow.mock.calls[0]![0])).toBe(
			"http://bridge.test/code-review-validation",
		);
		expect(JSON.parse(String(allow.mock.calls[0]![1]?.body))).toEqual({
			executionId: EXEC,
			reviewType: "code",
			reviewedHeadSha: head,
			reviewerModel: "gpt-5.6-sol",
			reviewerEffort: "xhigh",
			codexThreadId: THREAD,
			codexTurnId: TURN,
		});
		const deny = bridge(
			json(409, { allowed: false, reason: "reviewer model mismatch" }),
		);
		expect(await gate("code", deny)).toBe(1);
		expect(await gate("code", bridge(json(200, { allowed: true })))).toBe(1);
	});

	it("code gate fails closed without Bridge credentials", async () => {
		writeRollout([{ id: TURN, model: "gpt-5.6-sol" }]);
		writeResult("code");
		expect(
			await gate("code", bridge(json(200, {})), { FLYWHEEL_BRIDGE_URL: "" }),
		).toBe(1);
		expect(errors.join("\n")).toMatch(/FLYWHEEL_BRIDGE_URL/);
	});

	it("writes a gate acceptance from the validated result, not the current worktree", async () => {
		writeResult("design");
		writeFileSync(join(root, "doc-plan-edited-after.md"), "changed\n");
		const fetchImpl = bridge(
			json(200, { allowed: true, reviewerModelChecked: true }),
		);
		expect(await gate("design", fetchImpl)).toBe(0);
		const acceptance = fetchImpl.mock.calls.find(([url]) =>
			String(url).endsWith("/review-rounds"),
		);
		expect(JSON.parse(String(acceptance![1]?.body))).toEqual({
			kind: "gate_acceptance",
			executionId: EXEC,
			reviewType: "design",
			codexThreadId: THREAD,
			codexTurnId: TURN,
			finalRound: 2,
			roundsTotal: 2,
			observedModel: "gpt-6-astra",
			observedEffort: "xhigh",
			requestId: "req-1",
			reviewedTarget: "doc/plan.md",
			reviewedPlanBlobSha: BLOB,
			acceptedAt: expect.any(String),
		});
	});

	it("still passes and spools the acceptance when its write-back fails", async () => {
		writeResult("design");
		const fetchImpl = bridge(
			json(200, { allowed: true, reviewerModelChecked: true }),
			503,
		);
		expect(await gate("design", fetchImpl)).toBe(0);
		expect(
			countReviewRoundSpool(join(stateDir, "state", "review-round-spool")),
		).toEqual({ pending: 1, quarantined: 0 });
	});

	it("carries the reviewer model in the FLY-827 codex_review_result payload", () => {
		expect(
			buildCodexReviewResultBody({
				execId: EXEC,
				issueId: "FLY-2891",
				projectName: "flywheel",
				prHeadSha: "B".repeat(40),
				rounds: 2,
				codexThreadId: THREAD,
				codexTurnId: TURN,
				reviewerModel: "gpt-5.6-sol",
				reviewerEffort: "xhigh",
				eventId: "evt-1",
			}).payload,
		).toEqual({
			reviewType: "code",
			status: "APPROVED",
			targetExecutionId: EXEC,
			prHeadSha: "b".repeat(40),
			rounds: 2,
			codexThreadId: THREAD,
			codexTurnId: TURN,
			reviewerModel: "gpt-5.6-sol",
			reviewerEffort: "xhigh",
		});
	});
});
