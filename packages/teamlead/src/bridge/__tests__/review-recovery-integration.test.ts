import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { CommDB } from "flywheel-comm/db";
import {
	markGateMarkerAnswered,
	readGateMarker,
	writeGateMarker,
} from "flywheel-comm/gate-marker";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { wakeRunnerMailbox } from "flywheel-comm/wake";
import { afterEach, expect, it, vi } from "vitest";
import {
	CodexDaemonClient,
	type DaemonTransport,
	runGoalToTerminal,
} from "../../../../claude-runner/src/codex-daemon-client.js";
import { checkWithReviewRecovery } from "../../../../flywheel-comm/src/commands/check.js";
import { StateStore } from "../../StateStore.js";
import type { ClaudeReviewOutcome } from "../claude-review-runner.js";
import { DEFAULT_MAILBOX_QUEUE_CONFIG } from "../mailbox-queue-config.js";
import { createReviewRecoveryNoticeSink } from "../review-recovery-notice-sink.js";
import {
	type ReviewCoordinatorDeps,
	ReviewRequestCoordinator,
} from "../review-request-coordinator.js";
import {
	ProductionRunnerMailboxDeliveryAdapter,
	RunnerMailboxLane,
} from "../runner-mailbox-lane.js";

// Only the physical transport is isolated. The sink, outbox, queue, lane,
// production adapter, author hold runtime, HTTP protocol and databases are real.
vi.mock("flywheel-comm/wake", () => ({ wakeRunnerMailbox: vi.fn() }));
const HEAD = "a".repeat(40);
const RETIRED = "review-recovery:R:1:retired";
const READY = "review-recovery:R:1:ready";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.restoreAllMocks();
});

/** Same JSON request/response and owned-turn notification seam as the daemon tests. */
class AuthorDaemon implements DaemonTransport {
	private receive: (frame: unknown) => void = () => {};
	private closed: (reason: string) => void = () => {};
	frames: Array<{ method?: string; params?: unknown }> = [];
	turns = 0;
	working = false;
	finished = false;
	error: unknown;
	constructor(
		private readonly act?: () => Promise<void>,
		private readonly crash = false,
	) {}
	onMessage(receive: (frame: unknown) => void) {
		this.receive = receive;
	}
	onClose(closed: (reason: string) => void) {
		this.closed = closed;
	}
	close() {
		this.closed("isolated daemon restart");
	}
	send(frame: unknown) {
		const request = frame as { id: number; method: string; params: unknown };
		this.frames.push(request);
		let result: unknown = {};
		if (request.method === "thread/goal/get")
			result = {
				goal: { status: "paused", objective: "recover original review" },
			};
		if (request.method === "turn/start") {
			const id = `author-turn-${++this.turns}`;
			result = { turn: { id } };
			this.working = true;
			setImmediate(async () => {
				try {
					if (this.crash) {
						this.close();
						return;
					}
					await this.act?.();
				} catch (error) {
					this.error = error;
				} finally {
					this.working = false;
					this.finished = true;
					this.receive({
						method: "turn/completed",
						params: {
							threadId: "author-thread",
							turn: { id, status: "completed" },
						},
					});
				}
			});
		}
		queueMicrotask(() => this.receive({ id: request.id, result }));
	}
}

async function eventually(assertion: () => void) {
	await vi.waitFor(assertion, { timeout: 2_000, interval: 5 });
}

async function harness(
	failure: "none" | "before-enqueue" | "after-enqueue" = "none",
) {
	const dir = mkdtempSync(join(tmpdir(), "review-recovery-integration-"));
	const statePath = join(dir, "state.db");
	const dbPath = join(dir, "comm.db");
	const markers = join(dir, "markers");
	const latchPath = join(dir, "author.json");
	let store = await StateStore.create(statePath);
	const db = new CommDB(dbPath);
	const queue = new MailboxQueue(dbPath);
	const adapter = new ProductionRunnerMailboxDeliveryAdapter(dbPath);
	let now = Date.now();
	let absent = false;
	let fail = failure;
	let spawn = 0;
	let finishReview: ((outcome: ClaudeReviewOutcome) => void) | undefined;
	const coordinators: ReviewRequestCoordinator[] = [];
	const answers: string[] = [];
	const timers = new Set<object>();
	writeFileSync(latchPath, JSON.stringify({ gateHold: true }));
	store.upsertSession({
		execution_id: "author",
		issue_id: "FLY-2920",
		project_name: "p",
		status: "running",
		adapter_type: "codex-tmux",
		worktree_path: dir,
	});
	store.bindWorktreeOnce("author", {
		path: dir,
		branch: "integration",
		generation: "binding-1",
	});
	db.registerSession(
		"author",
		"isolated:author",
		"p",
		"FLY-2920",
		"engineering-lead",
		"codex",
	);
	const q = db.insertQuestion(
		"author",
		"engineering-lead",
		"review original head",
		{ checkpoint: "review_code" },
	);
	const other = db.insertQuestion(
		"author",
		"engineering-lead",
		"ship approval remains closed",
		{ checkpoint: "approve" },
	);
	for (const [questionId, checkpoint] of [
		[q, "review_code"],
		[other, "approve"],
	])
		writeGateMarker(markers, {
			questionId,
			checkpoint,
			executionId: "author",
			vendor: "codex",
			backend: "codex-tmux",
		});
	const request = {
		executionId: "author",
		requestId: "R",
		questionId: q,
		reviewType: "code",
	};
	store.insertCodexReviewJob({
		...request,
		reviewType: "code",
		projectName: "p",
		targetRepoPath: dir,
		frozenHeadSha: HEAD,
		authorFamily: "codex",
	});
	store.claimCodexReviewJobRunning("R");
	store.recordCodexReviewAttemptIntent({
		requestId: "R",
		attemptGeneration: 1,
		reviewerSessionUuid: "original-reviewer",
		ownerBootId: "old-bridge",
		reviewerStartedAt: new Date(now).toISOString(),
		configuredTimeoutMs: 300_000,
	});
	function newCoordinator(overrides: Partial<ReviewCoordinatorDeps> = {}) {
		const sink = createReviewRecoveryNoticeSink({
			store,
			commDbPathFor: () => dbPath,
			resolveOwningLead: () => "engineering-lead",
			provenance: () => ({ writerPid: 123, writerStart: "isolated-bridge" }),
			markerDir: markers,
		});
		const value = new ReviewRequestCoordinator({
			store,
			commDbPathFor: () => dbPath,
			openCommDb: (path) => new CommDB(path, false),
			deriveHead: async () => HEAD,
			deriveRepoIdentity: async () => "example/repo",
			now: () => now,
			logger: () => {},
			setTimer: () => {
				const token = {};
				timers.add(token);
				return token;
			},
			clearTimer: (token) => {
				timers.delete(token as object);
			},
			probeRetiredAttempt: async () => ({ state: absent ? "absent" : "alive" }),
			deliverRecoveryNotice: async (notice, signal) => {
				if (fail === "before-enqueue") {
					fail = "none";
					throw new Error("transport unavailable before enqueue");
				}
				const result = await sink.deliver(notice, signal);
				if (fail === "after-enqueue") {
					fail = "none";
					throw new Error("crash after enqueue before outbox receipt");
				}
				return result;
			},
			markRecoveryNoticeActed: sink.markActed,
			markGateAnswered: (questionId) => {
				answers.push(questionId);
				markGateMarkerAnswered(markers, questionId);
			},
			reviewRound: async () => {
				spawn++;
				return new Promise<ClaudeReviewOutcome>((resolve) => {
					finishReview = resolve;
				});
			},
			...overrides,
		});
		coordinators.push(value);
		return value;
	}
	let coordinator = newCoordinator();
	const paths: string[] = [];
	const app = express();
	app.use(express.json());
	app.use((req, res, next) => {
		paths.push(req.path);
		if (req.headers.authorization !== "Bearer integration-token") {
			res.sendStatus(401);
			return;
		}
		next();
	});
	app.post("/review-requests", async (req, res) => {
		const result = await coordinator.accept(req.body);
		res.status(result.accepted ? 200 : result.httpStatus).json(result);
	});
	app.post("/review-requests/status", (req, res) => {
		res.json(coordinator.reviewStatus(req.body));
	});
	const server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("missing test HTTP port");
	const url = `http://127.0.0.1:${address.port}`;
	const env = {
		FLYWHEEL_BRIDGE_URL: url,
		FLYWHEEL_INGEST_TOKEN: "integration-token",
	};
	const lane = new RunnerMailboxLane({
		queue,
		ownerEpoch: "mailbox-owner",
		now: () => new Date(now),
		recipientState: () => "alive",
		deliver: (envelope) => adapter.deliver(envelope),
		resolveQuestion: (id) => adapter.resolveQuestion(id),
		queueConfig: () => ({ ...DEFAULT_MAILBOX_QUEUE_CONFIG, batchWindowMs: 0 }),
	});
	vi.mocked(wakeRunnerMailbox).mockReset().mockResolvedValue({
		ok: true,
		backend: "codex",
		settlement: "on_consume",
	});
	cleanup.push(async () => {
		for (const value of coordinators) value.stop();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		adapter.close();
		queue.close();
		db.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		db,
		queue,
		q,
		other,
		request,
		answers,
		paths,
		statePath,
		markers,
		timers,
		get store() {
			return store;
		},
		get coordinator() {
			return coordinator;
		},
		get spawn() {
			return spawn;
		},
		async restart(overrides: Partial<ReviewCoordinatorDeps> = {}) {
			coordinator.stop();
			store.close();
			store = await StateStore.create(statePath);
			coordinator = newCoordinator(overrides);
		},
		advance() {
			now += 30_001;
		},
		absent() {
			absent = true;
		},
		async reissue() {
			const response = await fetch(`${url}/review-requests`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer integration-token",
				},
				body: JSON.stringify(request),
			});
			return response.json();
		},
		check() {
			return checkWithReviewRecovery({
				questionId: q,
				executionId: "author",
				dbPath,
				env,
			});
		},
		approve() {
			if (!finishReview) throw new Error("no spawned reviewer");
			finishReview({
				kind: "verdict",
				verdict: "APPROVED",
				findings: [],
				reviewedHeadSha: HEAD,
				repairedTrailingBrace: false,
				raw: "",
			});
		},
		async deliver(id: string) {
			queue.acquireOrRenewOwner({
				ownerEpoch: "mailbox-owner",
				now: new Date(now).toISOString(),
				leaseTtlMs: 120_000,
			});
			expect(queue.getById(id)).toBeDefined();
			expect((await lane.tick()).delivered).toBeGreaterThan(0);
			const row = queue.getById(id)!;
			expect(row.state).toBe("LEASED");
			expect(wakeRunnerMailbox).toHaveBeenCalledWith(
				expect.objectContaining({
					execId: "author",
					backend: "codex",
					content: expect.stringContaining(id),
				}),
			);
			expect(
				queue.ackBatchByRecipient({
					batchId: row.batch_id!,
					fromAgent: "author",
					now: new Date(now).toISOString(),
				}),
			).toBe("applied");
			db.markInstructionRead(id);
			expect(db.readActionableReviewRecovery("author", "p")).toMatchObject({
				id,
			});
		},
		async author(
			mode: "commdb" | "marker",
			act?: () => Promise<void>,
			crash = false,
		) {
			const notice = db.readActionableReviewRecovery("author", "p");
			const daemon = new AuthorDaemon(act, crash);
			let ticks = 0;
			await expect(
				runGoalToTerminal(
					new CodexDaemonClient({ transport: daemon, logger: () => {} }),
					{
						threadId: "author-thread",
						objective: "recover original review",
						isWaiting: () =>
							mode === "commdb"
								? db.hasPendingBlockingGateFrom("author")
								: [q, other].some(
										(id) => !readGateMarker(markers, id)?.answeredAt,
									),
						readGateHoldLatch: () =>
							JSON.parse(readFileSync(latchPath, "utf8")).gateHold,
						writeGateHoldLatch: (gateHold) => {
							writeFileSync(latchPath, JSON.stringify({ gateHold }));
						},
						readActionableReviewRecovery: () => {
							const durable = new CommDB(dbPath, false);
							try {
								return durable.readActionableReviewRecovery("author", "p");
							} finally {
								durable.close();
							}
						},
						now: () => ticks,
						overallTimeoutMs: 10,
						waitingTimeoutMs: 10,
						pollIntervalMs: 1,
						sleep: async () => {
							await new Promise((resolve) => setTimeout(resolve, 1));
							if (!daemon.working) ticks++;
						},
					},
				),
			).rejects.toMatchObject({
				name: "GoalRunError",
				kind: crash ? "transport_closed" : "timeout",
			});
			if (daemon.error) throw daemon.error;
			if (notice) {
				expect(
					daemon.frames.filter((frame) => frame.method === "turn/start"),
				).toEqual([
					{
						jsonrpc: "2.0",
						id: expect.any(Number),
						method: "turn/start",
						params: {
							threadId: "author-thread",
							input: [{ type: "text", text: notice.text }],
						},
					},
				]);
			}
			expect(JSON.parse(readFileSync(latchPath, "utf8"))).toEqual({
				gateHold: true,
			});
			expect(
				daemon.frames.filter(
					(frame) =>
						frame.method === "thread/goal/set" &&
						(frame.params as { status?: string })?.status === "active",
				),
			).toHaveLength(0);
			expect(db.getResponse(other)).toBeUndefined();
			expect(readGateMarker(markers, other)?.answeredAt).toBeUndefined();
			return daemon;
		},
	};
}

it.each(["commdb", "marker"] as const)(
	"D6: parked author resumes through %s hold, retries the original request once and reads its verdict",
	async (mode) => {
		const h = await harness();
		expect((await h.author(mode)).turns).toBe(0);
		await h.restart(); // Close and reopen StateStore; the old running row survives.
		expect(h.coordinator.redriveOnBoot()).toBe(0);
		await h.coordinator.runRecoveryPass();
		expect(h.coordinator.redriveOnBoot()).toBe(0);
		await h.coordinator.runRecoveryPass();
		expect(h.store.getCodexReviewJob("R")).toMatchObject({
			status: "failed",
			failure_reason: "bridge_restart_retired",
			attempt_generation: 1,
		});
		expect(h.spawn).toBe(0);
		expect(h.db.getResponse(h.q)).toBeUndefined();
		expect(h.answers).toEqual([]);
		expect(readGateMarker(h.markers, h.q)?.answeredAt).toBeUndefined();
		await h.deliver(RETIRED);
		// Transport ACK survived, but no model consumed it before this daemon died.
		expect((await h.author(mode, undefined, true)).turns).toBe(1);
		expect(h.paths).toEqual([]);
		expect(h.db.readActionableReviewRecovery("author", "p")).toMatchObject({
			id: RETIRED,
		});
		const first = await h.author(mode, async () => {
			expect(await h.check()).toMatchObject({
				status: "pending",
				reviewRetry: { requestId: "R", questionId: h.q, attemptGeneration: 1 },
			});
			expect(await h.reissue()).toMatchObject({
				accepted: true,
				retryHeld: true,
			});
		});
		expect(first.turns).toBe(1);
		expect(h.paths).toEqual(["/review-requests/status", "/review-requests"]);
		expect(h.spawn).toBe(0);
		expect(h.store.getCodexReviewAttempt("R", 1)?.recovery_state).toBe("held");
		expect(h.db.readActionableReviewRecovery("author", "p")).toBeNull();
		expect(h.db.getResponse(h.q)).toBeUndefined();
		h.absent();
		h.advance();
		await h.coordinator.runRecoveryPass();
		expect(h.spawn).toBe(0);
		await h.deliver(READY);
		const second = await h.author(mode, async () => {
			const retries = await Promise.all([h.reissue(), h.reissue()]);
			expect(retries).toEqual([
				expect.objectContaining({ accepted: true }),
				expect.objectContaining({ accepted: true }),
			]);
			await eventually(() => expect(h.spawn).toBe(1));
			h.approve();
			await eventually(() => expect(h.db.getResponse(h.q)).toBeDefined());
			const result = await h.check();
			expect(result.status).toBe("answered");
			if (result.status === "answered")
				expect(JSON.parse(result.content)).toMatchObject({
					reviewVerdict: "APPROVED",
					requestId: "R",
					reviewedHeadSha: HEAD,
				});
		});
		expect(second.turns).toBe(1);
		expect(h.spawn).toBe(1);
		expect(h.store.getCodexReviewJob("R")).toMatchObject({
			status: "done",
			attempt_generation: 2,
		});
		expect(h.answers).toEqual([h.q]);
		expect(h.db.readActionableReviewRecovery("author", "p")).toBeNull();
	},
	20_000,
);

it.each(["before-enqueue", "after-enqueue"] as const)(
	"recovery pass retries %s failure without restart and preserves one queue identity",
	async (failure) => {
		const h = await harness(failure);
		h.coordinator.redriveOnBoot();
		await h.coordinator.runRecoveryPass();
		expect(h.store.listPendingReviewRecoveryNotices()).toHaveLength(1);
		expect(
			h.db
				.listRunnerDeliveryProjectionRows()
				.filter((row) => row.id === RETIRED),
		).toHaveLength(failure === "after-enqueue" ? 1 : 0);
		h.advance();
		await h.coordinator.runRecoveryPass();
		expect(h.store.listPendingReviewRecoveryNotices()).toHaveLength(0);
		expect(
			h.db
				.listRunnerDeliveryProjectionRows()
				.filter((row) => row.id === RETIRED),
		).toHaveLength(1);
		await h.deliver(RETIRED);
		expect(
			(
				await h.author("commdb", async () => {
					expect(await h.reissue()).toMatchObject({ retryHeld: true });
				})
			).turns,
		).toBe(1);
		expect(h.spawn).toBe(0);
		expect(h.db.getResponse(h.q)).toBeUndefined();
	},
	20_000,
);

it.each(["stored-verdict", "committed-authority"] as const)(
	"reopens real databases after %s crash and delivers the original result without spawning",
	async (window) => {
		const h = await harness();
		if (window === "stored-verdict")
			h.store.completeCodexReviewJob("R", "APPROVED", "[]", undefined, 1);
		else
			h.store.recordCodexReviewApproved({
				executionId: "author",
				targetPrHeadSha: HEAD,
				issueId: "FLY-2920",
				projectName: "p",
				authorFamily: "codex",
				reviewerFamily: "claude",
				requestId: "R",
			});
		expect(h.db.getResponse(h.q)).toBeUndefined();
		await h.restart();
		h.coordinator.redriveOnBoot();
		await h.coordinator.runRecoveryPass();
		await eventually(() => expect(h.db.getResponse(h.q)).toBeDefined());
		h.coordinator.redriveOnBoot();
		await h.coordinator.runRecoveryPass();
		expect(h.spawn).toBe(0);
		expect(h.store.getCodexReviewJob("R")).toMatchObject({
			status: "done",
			verdict: "APPROVED",
		});
		expect(JSON.parse(h.db.getResponse(h.q)!.content)).toMatchObject({
			reviewVerdict: "APPROVED",
			requestId: "R",
			reviewedHeadSha: HEAD,
		});
		expect(h.db.getResponse(h.other)).toBeUndefined();
		expect(h.queue.getById(RETIRED)).toBeUndefined();
	},
	20_000,
);

it("a final answer wins before delayed notice delivery and never wakes the held author", async () => {
	const h = await harness("before-enqueue");
	h.coordinator.redriveOnBoot();
	await h.coordinator.runRecoveryPass();
	h.db.insertResponse(
		h.q,
		"engineering-lead",
		JSON.stringify({ reviewVerdict: "APPROVED" }),
	);
	h.advance();
	await h.coordinator.runRecoveryPass();
	expect(h.queue.getById(RETIRED)).toBeUndefined();
	expect(h.db.readActionableReviewRecovery("author", "p")).toBeNull();
	expect((await h.author("commdb")).turns).toBe(0);
	expect(wakeRunnerMailbox).not.toHaveBeenCalled();
	expect(h.spawn).toBe(0);
}, 20_000);

it("does not start a former holder after its delivered notice survives daemon restart", async () => {
	const h = await harness();
	h.store.createWorkflowRun({
		runId: "run",
		issueId: "FLY-2920",
		projectName: "p",
	});
	h.store.upsertWorkflowRunNode({
		runId: "run",
		nodeId: "implement",
		attempt: 1,
		state: "running",
		executionId: "author",
	});
	const grant = (exec: string, attempt: number) =>
		h.db.grantTurn("FLY-2920", exec, "implement", Date.now(), {
			project: "p",
			sourceEventId: `grant-${exec}`,
			activation: {
				activationId: `activation-${exec}`,
				runId: "run",
				nodeId: "implement",
				attempt,
				context: {},
			},
		});
	grant("author", 1);
	h.coordinator.redriveOnBoot();
	await h.coordinator.runRecoveryPass();
	await h.deliver(RETIRED);
	expect(h.store.listPendingReviewRecoveryNotices()).toHaveLength(0);
	h.store.upsertWorkflowRunNode({
		runId: "run",
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "author",
	});
	h.store.upsertWorkflowRunNode({
		runId: "run",
		nodeId: "implement",
		attempt: 2,
		state: "running",
		executionId: "replacement",
	});
	grant("replacement", 2);
	expect(h.db.readActionableReviewRecovery("author", "p")).toBeNull();
	expect((await h.author("commdb")).turns).toBe(0);
	expect((await h.author("marker")).turns).toBe(0);
	expect(h.db.getResponse(h.q)).toBeUndefined();
	expect(h.spawn).toBe(0);
}, 20_000);
