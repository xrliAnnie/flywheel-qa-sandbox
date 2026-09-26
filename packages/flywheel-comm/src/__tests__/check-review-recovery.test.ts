import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
	checkWithReviewRecovery,
	formatReviewRetryCommand,
} from "../commands/check.js";
import { CommDB } from "../db.js";

let directory: string;
let server: Server | undefined;
let openDb: CommDB | undefined;
afterEach(async () => {
	openDb?.close();
	openDb = undefined;
	if (server) await new Promise<void>((done) => server!.close(() => done()));
	server = undefined;
	if (directory) rmSync(directory, { recursive: true, force: true });
});
it("queries only the owner's pending review gate and preserves pending without answering", async () => {
	directory = mkdtempSync(join(tmpdir(), "review-check-"));
	const dbPath = join(directory, "comm.db");
	const db = new CommDB(dbPath);
	openDb = db;
	const questionId = db.insertQuestion("execution", "lead", "review", {
		checkpoint: "review_code",
	});
	const normal = db.insertQuestion("execution", "lead", "question", {
		checkpoint: "question",
	});
	const requests: Array<{
		url: string | undefined;
		authorization: string | undefined;
		body: string;
	}> = [];
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (part) => {
			body += part;
		});
		request.on("end", () => {
			requests.push({
				url: request.url,
				authorization: request.headers.authorization,
				body,
			});
			response.setHeader("Content-Type", "application/json");
			response.end(
				JSON.stringify({
					status: "pending",
					reviewRetry: {
						requestId: "request",
						questionId,
						reviewType: "code",
						attemptGeneration: 2,
						reason: "bridge_restart_retired",
					},
				}),
			);
		});
	});
	await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing port");
	const env = {
		FLYWHEEL_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
		FLYWHEEL_INGEST_TOKEN: "isolated-test-token",
	};
	expect(
		await checkWithReviewRecovery({
			dbPath,
			questionId: normal,
			executionId: "execution",
			env,
		}),
	).toEqual({ status: "pending" });
	expect(
		await checkWithReviewRecovery({
			dbPath,
			questionId,
			executionId: "foreign",
			env,
		}),
	).toEqual({ status: "pending" });
	expect(requests).toHaveLength(0);
	expect(
		await checkWithReviewRecovery({
			dbPath,
			questionId,
			executionId: "execution",
			env,
		}),
	).toMatchObject({
		status: "pending",
		reviewRetry: { requestId: "request", questionId, attemptGeneration: 2 },
	});
	expect(requests).toEqual([
		{
			url: "/review-requests/status",
			authorization: "Bearer isolated-test-token",
			body: JSON.stringify({ executionId: "execution", questionId }),
		},
	]);
	expect(db.getResponse(questionId)).toBeUndefined();
});

it.each([
	null,
	{ questionId: "foreign" },
	{ reviewType: "design" },
	{ attemptGeneration: -1 },
	{ planPath: "../secret" },
	{ targetRepoPath: "../secret" },
	{ targetRepoPath: "/absolute/repo" },
	{ targetRepoPath: "~/repo" },
	{ targetRepoPath: "repo/../escape" },
	{ targetRepoPath: "repo\\..\\escape" },
	{ targetRepoPath: "repo\ncommand" },
	{ targetRepoPath: "" },
	{ targetRepoPath: "." },
	{ targetRepoPath: 42 },
	{ targetRepoPath: "x".repeat(513) },
])("ignores invalid recovery hints without answering: %j", async (patch) => {
	directory = mkdtempSync(join(tmpdir(), "review-check-negative-"));
	const dbPath = join(directory, "comm.db");
	openDb = new CommDB(dbPath);
	const questionId = openDb.insertQuestion("execution", "lead", "review", {
		checkpoint: "review_code",
	});
	const hint =
		patch === null
			? null
			: {
					requestId: "request",
					questionId,
					reviewType: "code",
					attemptGeneration: 2,
					reason: "bridge_restart_retired",
					...patch,
				};
	const result = await checkWithReviewRecovery({
		dbPath,
		questionId,
		executionId: "execution",
		env: { FLYWHEEL_BRIDGE_URL: "http://unused.invalid" },
		fetchImpl: async () =>
			new Response(JSON.stringify({ status: "pending", reviewRetry: hint })),
	});
	expect(result).toEqual({ status: "pending" });
	expect(openDb.getResponse(questionId)).toBeUndefined();
});

it.each(["code", "design"] as const)(
	"preserves a safe nested target in the %s retry hint and quoted command",
	async (reviewType) => {
		directory = mkdtempSync(join(tmpdir(), "review-check-nested-"));
		const dbPath = join(directory, "comm.db");
		openDb = new CommDB(dbPath);
		const questionId = openDb.insertQuestion("execution", "lead", "review", {
			checkpoint: `review_${reviewType}`,
		});
		const targetRepoPath = ".flywheel/review-targets/repo's checkout";
		const result = await checkWithReviewRecovery({
			dbPath,
			questionId,
			executionId: "execution",
			env: { FLYWHEEL_BRIDGE_URL: "http://unused.invalid" },
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						status: "pending",
						reviewRetry: {
							requestId: "request",
							questionId,
							reviewType,
							targetRepoPath,
							...(reviewType === "design" ? { planPath: "docs/plan.md" } : {}),
							attemptGeneration: 1,
							reason: "bridge_restart_retired",
						},
					}),
				),
		});
		expect(result.reviewRetry).toMatchObject({ targetRepoPath });
		const command = formatReviewRetryCommand(result.reviewRetry!);
		expect(command).toContain(
			" --target-repo='.flywheel/review-targets/repo'\\''s checkout'",
		);
		if (reviewType === "design")
			expect(command).toContain(" --plan='docs/plan.md'");
		expect(openDb.getResponse(questionId)).toBeUndefined();
	},
);

it("keeps database and transport failures pending", async () => {
	directory = mkdtempSync(join(tmpdir(), "review-check-failure-"));
	const dbPath = join(directory, "comm.db");
	expect(
		await checkWithReviewRecovery({
			dbPath,
			questionId: "missing",
			executionId: "execution",
		}),
	).toEqual({ status: "pending" });
	openDb = new CommDB(dbPath);
	const questionId = openDb.insertQuestion("execution", "lead", "review", {
		checkpoint: "review_code",
	});
	expect(
		await checkWithReviewRecovery({
			dbPath,
			questionId,
			executionId: "execution",
			env: { FLYWHEEL_BRIDGE_URL: "http://unused.invalid" },
			fetchImpl: async () => {
				throw new Error("offline");
			},
		}),
	).toEqual({ status: "pending" });
});

it("formats leading-dash selectors and plans as unambiguous CLI string values", () => {
	const command = formatReviewRetryCommand({
		requestId: "-request",
		questionId: "-question",
		reviewType: "design",
		targetRepoPath: "-nested repo",
		planPath: "-plan.md",
		attemptGeneration: 1,
		reason: "bridge_restart_retired",
	});
	// Tokenize with the actual shell without executing the generated request.
	const argv = execFileSync(
		"/bin/sh",
		["-c", `set -- ${command}; printf '%s\\0' "$@"`],
		{ encoding: "utf8", env: { FLYWHEEL_COMM_CLI: "test-cli" } },
	)
		.split("\0")
		.slice(0, -1);
	const parsed = parseArgs({
		args: argv.slice(3),
		options: {
			"request-id": { type: "string" },
			"question-id": { type: "string" },
			type: { type: "string" },
			plan: { type: "string" },
			"target-repo": { type: "string" },
		},
		allowPositionals: false,
	});
	expect(parsed.values).toMatchObject({
		"request-id": "-request",
		"question-id": "-question",
		plan: "-plan.md",
		"target-repo": "-nested repo",
	});
});

import { execFileSync } from "node:child_process";
