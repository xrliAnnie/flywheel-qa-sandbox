import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import express from "express";
import { CommDB } from "flywheel-comm/db";
import { afterEach, expect, it } from "vitest";
import {
	checkWithReviewRecovery,
	formatReviewRetryCommand,
} from "../../../../flywheel-comm/src/commands/check.js";
import { requestReview } from "../../../../flywheel-comm/src/commands/request-review.js";
import { StateStore } from "../../StateStore.js";
import { ReviewRequestCoordinator } from "../review-request-coordinator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

async function fixture(reviewType: "code" | "design") {
	const dir = realpathSync(
		mkdtempSync(join(tmpdir(), "review-recovery-nested-")),
	);
	const store = await StateStore.create(join(dir, "state.db"));
	const dbPath = join(dir, "comm.db");
	const db = new CommDB(dbPath);
	const authors = [
		{
			executionId: "source",
			requestId: "-R",
			selector: ".flywheel/review-targets/source nested",
			root: join(dir, "source"),
			questionId: "",
		},
		{
			executionId: "follower",
			requestId: "-F",
			selector: "-repo's checkout",
			root: join(dir, "follower"),
			questionId: "",
		},
	];
	const sourceTarget = join(authors[0]!.root, authors[0]!.selector);
	mkdirSync(sourceTarget, { recursive: true });
	git(sourceTarget, "init", "--quiet", "--initial-branch=main");
	git(
		sourceTarget,
		"remote",
		"add",
		"origin",
		"https://github.com/acme/nested.git",
	);
	writeFileSync(join(sourceTarget, "-plan.md"), "# Original reviewed plan\n");
	git(sourceTarget, "add", "--", "-plan.md");
	git(
		sourceTarget,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"--quiet",
		"-m",
		"plan",
	);
	const head = git(sourceTarget, "rev-parse", "HEAD");
	const blob = git(sourceTarget, "rev-parse", "HEAD:-plan.md");
	const followerTarget = join(authors[1]!.root, authors[1]!.selector);
	mkdirSync(authors[1]!.root, { recursive: true });
	git(dir, "clone", "--quiet", "--no-hardlinks", sourceTarget, followerTarget);
	git(
		followerTarget,
		"remote",
		"set-url",
		"origin",
		"https://github.com/acme/nested.git",
	);
	for (const author of authors) {
		git(author.root, "init", "--quiet", "--initial-branch=main");
		git(
			author.root,
			"remote",
			"add",
			"origin",
			"https://github.com/acme/main.git",
		);
		store.upsertSession({
			execution_id: author.executionId,
			issue_id: "FLY-2920",
			project_name: "p",
			status: "running",
			adapter_type: "codex-tmux",
		});
		// A noncanonical authority root must still produce its own relative selector.
		const rootAlias = `${author.root}-alias`;
		symlinkSync(author.root, rootAlias);
		store.bindWorktreeOnce(author.executionId, {
			path: rootAlias,
			branch: "test",
			generation: "1",
		});
		db.registerSession(author.executionId, "window", "p");
		author.questionId = db.insertQuestion(
			author.executionId,
			"lead",
			"review",
			{ checkpoint: `review_${reviewType}` },
		);
	}
	store.insertCodexReviewJob({
		requestId: "-R",
		executionId: "source",
		issueId: "FLY-2920",
		projectName: "p",
		questionId: authors[0]!.questionId,
		reviewType,
		targetRepoPath: sourceTarget,
		targetRepoIdentity: "acme/nested",
		reuseRepoIdentity: "acme/nested",
		...(reviewType === "code"
			? { frozenHeadSha: head }
			: {
					targetPath: "-plan.md",
					designPlanProof: {
						planPath: "-plan.md",
						reviewedCommitSha: head,
						expectedBlobSha: blob,
						capturedAt: new Date().toISOString(),
					},
				}),
	});
	store.claimCodexReviewJobRunning("-R");
	store.recordCodexReviewAttemptIntent({
		requestId: "-R",
		attemptGeneration: 1,
		reviewerSessionUuid: "reviewer",
		ownerBootId: "old",
		reviewerStartedAt: new Date().toISOString(),
		configuredTimeoutMs: 60_000,
	});
	store.insertCodexReviewReuseBinding({
		requestId: "-F",
		sourceRequestId: "-R",
		executionId: "follower",
		questionId: authors[1]!.questionId,
		targetRepoPath: followerTarget,
		targetRepoIdentity: "acme/nested",
		reuseRepoIdentity: "acme/nested",
		...(reviewType === "code" ? { frozenHeadSha: head } : {}),
	});
	const coordinator = new ReviewRequestCoordinator({
		store,
		commDbPathFor: () => dbPath,
		openCommDb: (path) => new CommDB(path, false),
		probeRetiredAttempt: async () => ({ state: "alive" }),
	});
	const app = express();
	app.use(express.json());
	app.post("/review-requests/status", (request, response) =>
		response.json(coordinator.reviewStatus(request.body)),
	);
	app.post("/review-requests", async (request, response) => {
		const result = await coordinator.accept(request.body);
		response.status(result.accepted ? 200 : result.httpStatus).json(result);
	});
	const server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("missing test server address");
	cleanups.push(async () => {
		coordinator.stop();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		db.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		dir,
		store,
		db,
		dbPath,
		authors,
		sourceTarget,
		coordinator,
		env: { FLYWHEEL_BRIDGE_URL: `http://127.0.0.1:${address.port}` },
	};
}

it.each(["code", "design"] as const)(
	"reissues source and follower %s recovery against each persisted nested repository over real HTTP",
	async (reviewType) => {
		const h = await fixture(reviewType);
		h.store.retireCodexReviewJob({ requestId: "-R", expectedGeneration: 1 });
		const notices = h.store.listPendingReviewRecoveryNotices();
		for (const author of h.authors) {
			const original = {
				requestId: author.requestId,
				executionId: author.executionId,
				questionId: author.questionId,
				reviewType,
				...(reviewType === "design" ? { planPath: "-plan.md" } : {}),
			};
			// The old emitted command really falls back to __main__ and is rejected.
			await expect(h.coordinator.accept(original)).resolves.toMatchObject({
				accepted: false,
				httpStatus: 409,
			});
			const notice = notices.find(
				(row) => row.request_id === author.requestId,
			)!;
			expect(notice.text).toContain(` --target-repo=${quote(author.selector)}`);
			const status = await checkWithReviewRecovery({
				dbPath: h.dbPath,
				executionId: author.executionId,
				questionId: author.questionId,
				env: h.env,
			});
			expect(status.reviewRetry).toMatchObject({
				requestId: author.requestId,
				questionId: author.questionId,
				targetRepoPath: author.selector,
			});
			const hint = status.reviewRetry!;
			expect(formatReviewRetryCommand(hint)).toContain(
				` --target-repo=${quote(author.selector)}`,
			);
			for (const invalid of ["../escape", h.sourceTarget]) {
				await expect(
					h.coordinator.accept({ ...original, targetRepoPath: invalid }),
				).resolves.toMatchObject({ accepted: false, httpStatus: 400 });
			}
			for (const command of [
				notice.text.split("\n").at(-1)!,
				formatReviewRetryCommand(hint),
			]) {
				const argv = execFileSync(
					"/bin/sh",
					["-c", `set -- ${command}; printf '%s\\0' "$@"`],
					{ encoding: "utf8", env: { FLYWHEEL_COMM_CLI: "test-cli" } },
				)
					.split("\0")
					.slice(0, -1);
				const { values } = parseArgs({
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
				expect(values["target-repo"]).toBe(author.selector);
				await expect(
					requestReview({
						execId: author.executionId,
						type: values.type,
						requestId: values["request-id"],
						questionId: values["question-id"],
						planPath: values.plan,
						targetRepoPath: values["target-repo"],
						env: h.env,
						stateDir: join(h.dir, "intents"),
						attemptCount: 1,
					}),
				).resolves.toBe(0);
			}
			expect(h.db.getResponse(author.questionId)).toBeUndefined();
		}
		expect(h.store.getCodexReviewJob("-R")).toMatchObject({
			status: "failed",
			attempt_generation: 1,
		});
		expect(h.store.getCodexReviewAttempt("-R", 1)?.recovery_state).toBe("held");
	},
	30000,
);

it("does not emit a root-defaulting retry when the persisted nested target escapes through a replaced symlink", async () => {
	const h = await fixture("code");
	const outside = join(h.dir, "outside");
	renameSync(h.sourceTarget, outside);
	symlinkSync(outside, h.sourceTarget);
	h.store.retireCodexReviewJob({ requestId: "-R", expectedGeneration: 1 });
	const notice = h.store
		.listPendingReviewRecoveryNotices()
		.find((row) => row.request_id === "-R")!;
	expect(notice.text).not.toContain("request-review");
	expect(notice.text).toContain("operator evidence");
	const status = h.coordinator.reviewStatus({
		executionId: "source",
		questionId: h.authors[0]!.questionId,
	});
	expect(status).toEqual({ status: "pending" });
	await expect(
		h.coordinator.accept({
			executionId: "source",
			requestId: "-R",
			questionId: h.authors[0]!.questionId,
			reviewType: "code",
			targetRepoPath: h.authors[0]!.selector,
		}),
	).resolves.toMatchObject({ accepted: false, httpStatus: 422 });
}, 30000);
