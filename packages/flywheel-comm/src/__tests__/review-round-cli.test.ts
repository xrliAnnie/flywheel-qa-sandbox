import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewRound } from "../commands/review-round.js";
import {
	countReviewRoundSpool,
	writeReviewRoundSpoolRecord,
} from "../review-round-spool.js";

const EXEC = "11111111-2222-4333-8444-555555555555";
const THREAD = "01a0daf6-1f50-7522-b7dc-f0b3812a5dab";
const TURN_1 = "01a0daf6-2634-7a23-a8e9-c1669023f451";
const TURN_2 = "01a0daf6-2634-7a23-a8e9-c1669023f452";
const PLAN = "engineering/doc/FLY-1-x/plan.md";

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("FLY-2891 flywheel-comm review-round", () => {
	let root: string;
	let repo: string;
	let codexHome: string;
	let spoolDir: string;
	let calls: FetchCall[];
	let out: string[];
	let err: string[];

	function writeRollout(
		turns: Array<{ id: string; model: string; done?: boolean }>,
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
		turns.forEach((turn, index) => {
			lines.push({
				timestamp: `2026-09-25T10:0${index}:01.000Z`,
				type: "event_msg",
				payload: { type: "task_started", turn_id: turn.id },
			});
			lines.push({
				timestamp: `2026-09-25T10:0${index}:02.000Z`,
				type: "turn_context",
				payload: { turn_id: turn.id, model: turn.model, effort: "xhigh" },
			});
			if (turn.done !== false)
				lines.push({
					timestamp: `2026-09-25T10:0${index}:30.000Z`,
					type: "event_msg",
					payload: { type: "task_complete", turn_id: turn.id },
				});
		});
		writeFileSync(
			join(dir, `rollout-2026-09-25T10-00-00-${THREAD}.jsonl`),
			`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
		);
	}

	function env(extra: Record<string, string | undefined> = {}) {
		return {
			FLYWHEEL_BRIDGE_URL: "http://bridge.test",
			FLYWHEEL_INGEST_TOKEN: "tok",
			FLYWHEEL_PROJECT_NAME: "flywheel",
			CODEX_HOME: codexHome,
			...extra,
		} as NodeJS.ProcessEnv;
	}

	function fetchReturning(
		status: number | "network",
		body: unknown = {},
	): typeof fetch {
		return (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init: init ?? {} });
			if (status === "network") throw new TypeError("fetch failed");
			return jsonResponse(status, body);
		}) as typeof fetch;
	}

	async function run(
		args: Partial<Parameters<typeof reviewRound>[0]> = {},
		fetchImpl: typeof fetch = fetchReturning(200, {
			recorded: true,
			kind: "round",
			requiredModel: "gpt-6-astra",
			requiredEffort: "xhigh",
			modelMatch: true,
		}),
	) {
		return reviewRound({
			reviewType: "design",
			execId: EXEC,
			round: "1",
			verdict: "CHANGES_REQUESTED",
			thread: THREAD,
			findings: "critical=0,high=2,medium=1,low=0",
			cwd: repo,
			env: env(),
			fetchImpl,
			spoolDir,
			log: (line) => out.push(line),
			error: (line) => err.push(line),
			...args,
		});
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly2891-cli-"));
		repo = join(root, "repo");
		codexHome = join(root, "codex");
		spoolDir = join(root, "state", "review-round-spool");
		mkdirSync(join(repo, "engineering/doc/FLY-1-x"), { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "t@example.com"], {
			cwd: repo,
		});
		execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
		writeFileSync(join(repo, PLAN), "# plan\n");
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync("git", ["commit", "-q", "-m", "plan"], { cwd: repo });
		mkdirSync(join(repo, ".flywheel", "runs", EXEC, "codex"), {
			recursive: true,
		});
		writeFileSync(
			join(repo, ".flywheel", "runs", EXEC, "codex", "design-request.json"),
			JSON.stringify({
				requestId: "req-1",
				planPath: PLAN,
				reviewedPlanBlobSha: "0".repeat(40),
			}),
		);
		writeRollout([{ id: TURN_1, model: "gpt-6-astra" }]);
		calls = [];
		out = [];
		err = [];
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("posts one round with rollout-proven model and prints the receipt", async () => {
		expect(await run()).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("http://bridge.test/review-rounds");
		expect(
			(calls[0]!.init.headers as Record<string, string>).Authorization,
		).toBe("Bearer tok");
		const posted = JSON.parse(String(calls[0]!.init.body));
		const blob = execFileSync(
			"git",
			["hash-object", "--no-filters", "--", PLAN],
			{
				cwd: repo,
				encoding: "utf8",
			},
		).trim();
		expect(posted).toEqual({
			kind: "round",
			executionId: EXEC,
			reviewType: "design",
			round: 1,
			verdict: "CHANGES_REQUESTED",
			codexThreadId: THREAD,
			codexTurnId: TURN_1,
			findings: { critical: 0, high: 2, medium: 1, low: 0 },
			modelEvidence: "rollout_turn",
			observedModel: "gpt-6-astra",
			observedEffort: "xhigh",
			requestId: "req-1",
			reviewedTarget: PLAN,
			reviewedPlanBlobSha: blob,
			reviewedAt: "2026-09-25T10:00:30.000Z",
			projectName: "flywheel",
		});
		expect(out.join("\n")).toContain(
			"review round recorded: design r1 CHANGES_REQUESTED model=gpt-6-astra/xhigh required=gpt-6-astra/xhigh match=yes",
		);
		expect(out.join("\n")).toContain(`turn=${TURN_1} thread=${THREAD} round=1`);
		expect(countReviewRoundSpool(spoolDir)).toEqual({
			pending: 0,
			quarantined: 0,
		});
	});

	it("warns loudly when the round ran on a different model than required", async () => {
		expect(
			await run(
				{},
				fetchReturning(200, {
					recorded: true,
					requiredModel: "gpt-6-astra",
					requiredEffort: "xhigh",
					modelMatch: false,
				}),
			),
		).toBe(0);
		const text = [...out, ...err].join("\n");
		expect(text).toContain("match=no");
		expect(text).toMatch(/will be rejected by the review gate/);
		expect(text).toContain("--fresh --model gpt-6-astra --effort xhigh");
	});

	it.each([
		["network", "network" as const],
		["5xx", 503],
		["auth", 401],
		["forbidden", 403],
		["old Bridge without the route", 404],
	])(
		"spools a recoverable %s failure and still exits 0",
		async (_label, status) => {
			expect(await run({}, fetchReturning(status, { error: "x" }))).toBe(0);
			expect(countReviewRoundSpool(spoolDir)).toEqual({
				pending: 1,
				quarantined: 0,
			});
			expect(out.join("\n")).toContain(
				"WARN review round not delivered — queued for Bridge pickup",
			);
			expect(out.join("\n")).toContain(`turn=${TURN_1}`);
		},
	);

	it("quarantines a permanent invalid_payload or conflict refusal", async () => {
		expect(
			await run(
				{},
				fetchReturning(400, {
					recorded: false,
					errorType: "invalid_payload",
					reason: "round must be an integer from 1 to 200",
				}),
			),
		).toBe(0);
		expect(
			await run(
				{},
				fetchReturning(409, {
					recorded: false,
					errorType: "conflict",
					reason: "already recorded with different verdict",
				}),
			),
		).toBe(0);
		expect(countReviewRoundSpool(spoolDir)).toEqual({
			pending: 0,
			quarantined: 2,
		});
		expect(err.join("\n")).toContain("already recorded with different verdict");
	});

	it("treats a 409 without a declared errorType as recoverable", async () => {
		await run({}, fetchReturning(409, { reason: "?" }));
		expect(countReviewRoundSpool(spoolDir).pending).toBe(1);
	});

	it("spools when the Bridge env is missing", async () => {
		expect(
			await run({
				env: env({ FLYWHEEL_BRIDGE_URL: undefined }),
				fetchImpl: fetchReturning(200),
			}),
		).toBe(0);
		expect(calls).toHaveLength(0);
		expect(countReviewRoundSpool(spoolDir).pending).toBe(1);
	});

	it("records model evidence as unavailable with an explicit --turn when the rollout is missing", async () => {
		rmSync(codexHome, { recursive: true, force: true });
		expect(await run({ turn: TURN_2 })).toBe(0);
		const posted = JSON.parse(String(calls[0]!.init.body));
		expect(posted).toMatchObject({
			codexTurnId: TURN_2,
			modelEvidence: "unavailable",
		});
		expect(posted.observedModel).toBeUndefined();
		expect(err.join("\n")).toMatch(/model evidence unavailable/);
	});

	it("exits 2 without a turn identity or on an ambiguous thread", async () => {
		rmSync(codexHome, { recursive: true, force: true });
		expect(await run()).toBe(2);
		writeRollout([
			{ id: TURN_1, model: "gpt-6-astra" },
			{ id: TURN_2, model: "gpt-6-astra", done: false },
		]);
		expect(await run()).toBe(2);
		expect(err.join("\n")).toMatch(/pass --turn/);
		expect(calls).toHaveLength(0);
		expect(await run({ turn: TURN_1 })).toBe(0);
	});

	it("exits 2 when a design round has no plan path", async () => {
		rmSync(join(repo, ".flywheel"), { recursive: true, force: true });
		expect(await run()).toBe(2);
		expect(err.join("\n")).toMatch(/plan path/);
		expect(await run({ target: PLAN })).toBe(0);
	});

	it("binds a code round to HEAD and passes the PR URL through", async () => {
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repo,
			encoding: "utf8",
		}).trim();
		expect(
			await run({
				reviewType: "code",
				target: "https://github.com/o/r/pull/9",
			}),
		).toBe(0);
		const posted = JSON.parse(String(calls[0]!.init.body));
		expect(posted).toMatchObject({
			reviewType: "code",
			reviewedHeadSha: head,
			reviewedTarget: "https://github.com/o/r/pull/9",
		});
		expect(posted.reviewedPlanBlobSha).toBeUndefined();
	});

	it.each([
		[{ reviewType: "qa" }],
		[{ round: "0" }],
		[{ round: "abc" }],
		[{ verdict: "LGTM" }],
		[{ thread: "../etc" }],
		[{ turn: "a b" }],
		[{ findings: "high=x" }],
		[{ findings: "severe=1" }],
		[{ execId: "not-a-uuid" }],
	])("exits 2 on a malformed argument %j", async (args) => {
		expect(await run(args as never)).toBe(2);
		expect(calls).toHaveLength(0);
	});

	it("accepts CHANGES REQUESTED spelled with a space", async () => {
		expect(await run({ verdict: "changes requested" })).toBe(0);
		expect(JSON.parse(String(calls[0]!.init.body)).verdict).toBe(
			"CHANGES_REQUESTED",
		);
	});

	it("aborts the one hanging POST at the 1.5s timeout, regardless of spool backlog", async () => {
		for (let i = 0; i < 200; i += 1)
			writeReviewRoundSpoolRecord(spoolDir, {
				executionId: EXEC,
				reviewType: "design",
				codexTurnId: TURN_2,
				round: 1,
			});
		let fetches = 0;
		let aborts = 0;
		const hanging = ((_url: string | URL | Request, init?: RequestInit) => {
			fetches += 1;
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					aborts += 1;
					reject(new DOMException("aborted", "AbortError"));
				});
			});
		}) as typeof fetch;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const pending = run({}, hanging);
			expect(fetches).toBe(1);
			await vi.advanceTimersByTimeAsync(1_499);
			expect(aborts).toBe(0);
			await vi.advanceTimersByTimeAsync(1);
			expect(aborts).toBe(1);
			expect(await pending).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
		expect(fetches).toBe(1);
		expect(countReviewRoundSpool(spoolDir).pending).toBe(201);
	});

	it("does not throw when the spool itself cannot be written", async () => {
		writeFileSync(join(root, "state"), "not a directory");
		expect(await run({}, fetchReturning("network"))).toBe(0);
		expect(err.join("\n")).toMatch(/UNRECORDED/);
		expect(existsSync(spoolDir)).toBe(false);
		expect(readdirSync(root)).toContain("state");
		expect(readFileSync(join(root, "state"), "utf8")).toBe("not a directory");
		vi.restoreAllMocks();
	});
});
