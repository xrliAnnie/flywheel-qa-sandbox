import type {
	CodexQuotaContinueDecision,
	CodexQuotaContinueReconciliation,
	CodexQuotaResumeLifecycle,
} from "flywheel-core";
import { describe, expect, it, vi } from "vitest";
import {
	CodexDaemonClient,
	type DaemonTransport,
	GoalRunError,
	runGoalToTerminal,
} from "../src/codex-daemon-client.js";
import {
	quotaContinueMarker,
	quotaContinueText,
	reconcileQuotaContinue,
} from "../src/codex-quota-resume.js";

class FakeDaemon implements DaemonTransport {
	private msgHandler: ((f: unknown) => void) | null = null;
	sent: Array<Record<string, unknown>> = [];
	responders = new Map<
		string,
		(params: unknown, id: number, push: (n: unknown) => void) => unknown
	>();
	send(frame: unknown): void {
		const f = frame as { id?: number; method?: string; params?: unknown };
		this.sent.push(f as Record<string, unknown>);
		if (typeof f.id === "number" && f.method) {
			const r = this.responders.get(f.method);
			const result = r ? r(f.params, f.id, (n) => this.push(n)) : {};
			queueMicrotask(() => this.msgHandler?.({ id: f.id, result }));
		}
	}
	onMessage(h: (f: unknown) => void): void {
		this.msgHandler = h;
	}
	onClose(): void {}
	close(): void {}
	push(notification: unknown): void {
		this.msgHandler?.(notification);
	}
	sentMethods(): string[] {
		return this.sent.map((s) => s.method as string).filter(Boolean);
	}
}

const OBJECTIVE = "[FLY-2900] implement pointer";
const CONTINUE_ID = "11111111-2222-4333-8444-555555555555";

function lifecycle(
	overrides: Partial<CodexQuotaResumeLifecycle> = {},
): CodexQuotaResumeLifecycle & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		authorization: {
			executionId: "exec-1",
			claimId: "bridge:1:boot:c1",
			entrySeq: 1,
			resumeAttempt: 1,
		},
		continueAttemptId: CONTINUE_ID,
		continueAttemptFresh: true,
		onContinueReconciled: vi.fn(
			(
				outcome: CodexQuotaContinueReconciliation,
			): CodexQuotaContinueDecision => {
				calls.push(`reconciled:${outcome.kind}`);
				return outcome.kind === "absent"
					? { action: "send", continueAttemptId: CONTINUE_ID, settled: false }
					: { action: "abort", reason: "test" };
			},
		),
		onContinueStarted: vi.fn(({ turnId }: { turnId: string }) => {
			calls.push(`started:${turnId}`);
			return true;
		}),
		onContinueProgress: vi.fn(
			({ turnId, itemType }: { turnId: string; itemType: string }) => {
				calls.push(`progress:${turnId}:${itemType}`);
			},
		),
		onContinueFailed: vi.fn(
			(input: { turnId: string | null; usageLimited: boolean }) => {
				calls.push(`failed:${input.turnId}:${input.usageLimited}`);
			},
		),
		...overrides,
	};
}

function readResult(turns: unknown[]) {
	return { thread: { id: "t", turns } };
}
const userTurn = (
	id: string,
	status: string,
	items: unknown[],
	extra: Record<string, unknown> = {},
) => ({ id, status, items, ...extra });
const userMessage = (clientId: string | null, text = "hello") => ({
	type: "userMessage",
	id: `u-${clientId}`,
	clientId,
	content: [{ type: "text", text }],
});

describe("FLY-2900 — reconciling a carried continue from thread/read", () => {
	it("proves a continue whose turn produced model output", () => {
		expect(
			reconcileQuotaContinue(
				readResult([
					userTurn("turn-0", "completed", [userMessage(null, "kick")]),
					userTurn("turn-1", "interrupted", [
						userMessage(CONTINUE_ID),
						{ type: "reasoning", id: "r1", summary: [], content: [] },
					]),
				]),
				"t",
				CONTINUE_ID,
			),
		).toEqual({ kind: "proven" });
	});

	it("matches the text marker when the client id was not echoed", () => {
		expect(
			reconcileQuotaContinue(
				readResult([
					userTurn("turn-1", "completed", [
						userMessage(null, `${quotaContinueMarker(CONTINUE_ID)} continue`),
						{ type: "agentMessage", id: "a1", text: "ok" },
					]),
				]),
				"t",
				CONTINUE_ID,
			),
		).toEqual({ kind: "proven" });
	});

	it("reports a continue that ended before any model output, flagging a usage wall", () => {
		expect(
			reconcileQuotaContinue(
				readResult([
					userTurn("turn-1", "failed", [userMessage(CONTINUE_ID)], {
						error: {
							message: "You've hit your usage limit",
							codexErrorInfo: "usageLimitExceeded",
						},
					}),
				]),
				"t",
				CONTINUE_ID,
			),
		).toEqual({ kind: "failed_before_output", usageLimited: true });
		expect(
			reconcileQuotaContinue(
				readResult([userTurn("turn-1", "failed", [userMessage(CONTINUE_ID)])]),
				"t",
				CONTINUE_ID,
			),
		).toEqual({ kind: "failed_before_output", usageLimited: false });
	});

	it("keeps an in-progress continue without output pending (never a determined failure)", () => {
		// turn/start was accepted and the transport died before its response:
		// the turn may still produce output, so a second continue must not be sent.
		expect(
			reconcileQuotaContinue(
				readResult([
					userTurn("turn-1", "inProgress", [userMessage(CONTINUE_ID)]),
				]),
				"t",
				CONTINUE_ID,
			),
		).toEqual({ kind: "unavailable" });
		expect(
			reconcileQuotaContinue(
				readResult([
					userTurn("turn-1", "inProgress", [
						userMessage(CONTINUE_ID),
						{ type: "reasoning", id: "r1", summary: [], content: [] },
					]),
				]),
				"t",
				CONTINUE_ID,
			),
		).toEqual({ kind: "proven" });
	});

	it("says absent only when every turn's items are fully loaded", () => {
		expect(
			reconcileQuotaContinue(
				readResult([
					userTurn("turn-0", "completed", [userMessage("other-id")]),
				]),
				"t",
				CONTINUE_ID,
			),
		).toEqual({ kind: "absent" });
		expect(
			reconcileQuotaContinue(
				readResult([
					userTurn("turn-0", "completed", [], { itemsView: "notLoaded" }),
				]),
				"t",
				CONTINUE_ID,
			),
		).toEqual({ kind: "unavailable" });
	});

	it("is unavailable for a malformed or foreign result", () => {
		for (const result of [
			null,
			{},
			{ thread: { id: "other", turns: [] } },
			{ thread: { id: "t", turns: [{ id: "x", status: "weird", items: [] }] } },
		])
			expect(reconcileQuotaContinue(result, "t", CONTINUE_ID)).toEqual({
				kind: "unavailable",
			});
	});
});

function usageLimitedDaemon(options: {
	continueEvents?: (push: (n: unknown) => void, turnId: string) => void;
	afterContinue?: (push: (n: unknown) => void, turnId: string) => void;
	threadRead?: unknown;
	autoContinueOnActivate?: boolean;
}) {
	const d = new FakeDaemon();
	let goalStatus = "usageLimited";
	let activeTurnId: string | null = null;
	let pendingAfterContinue:
		| { push: (n: unknown) => void; turnId: string }
		| undefined;
	const flushAfterContinue = () => {
		if (goalStatus !== "active" || !pendingAfterContinue) return;
		const pending = pendingAfterContinue;
		pendingAfterContinue = undefined;
		options.afterContinue?.(pending.push, pending.turnId);
	};
	d.responders.set("thread/goal/get", () => ({
		goal: { status: goalStatus, objective: OBJECTIVE, tokensUsed: 5 },
	}));
	d.responders.set("thread/goal/set", (params) => {
		goalStatus = (params as { status: string }).status;
		if (
			goalStatus === "active" &&
			options.autoContinueOnActivate &&
			activeTurnId === null
		)
			activeTurnId = "turn-auto";
		return {};
	});
	d.responders.set("thread/read", () => options.threadRead ?? readResult([]));
	d.responders.set("turn/start", (_p, _id, push) => {
		const steeredIntoExistingTurn = activeTurnId !== null;
		const eventTurnId = activeTurnId ?? "turn-c";
		activeTurnId = eventTurnId;
		options.continueEvents?.(push, eventTurnId);
		pendingAfterContinue = { push, turnId: eventTurnId };
		if (goalStatus === "active") queueMicrotask(flushAfterContinue);
		return {
			turn: { id: steeredIntoExistingTurn ? "submission-c" : eventTurnId },
		};
	});
	return Object.assign(d, { flushAfterContinue });
}

const pushItem = (
	push: (n: unknown) => void,
	type: string,
	turnId = "turn-c",
) =>
	push({
		method: "item/completed",
		params: {
			threadId: "t",
			turnId,
			completedAtMs: 1,
			item: { type, id: `${type}-1` },
		},
	});
const pushGoal = (
	push: (n: unknown) => void,
	status: string,
	turnId = "turn-c",
) =>
	push({
		method: "thread/goal/updated",
		params: {
			threadId: "t",
			turnId,
			goal: { status, objective: OBJECTIVE, tokensUsed: 9 },
		},
	});

describe("FLY-2900 — runGoalToTerminal resumes a usage-limited goal with one continue turn", () => {
	it("starts the marked continue before goal activation can create a different turn", async () => {
		const d = usageLimitedDaemon({
			autoContinueOnActivate: true,
			continueEvents: (push, turnId) => {
				pushItem(push, "userMessage", turnId);
				pushItem(push, "agentMessage", turnId);
			},
			afterContinue: (push, turnId) => pushGoal(push, "complete", turnId),
		});
		const quotaResume = lifecycle();
		const client = new CodexDaemonClient({ transport: d, logger: () => {} });

		const result = await runGoalToTerminal(client, {
			threadId: "t",
			objective: OBJECTIVE,
			quotaResume,
			onGoalActive: d.flushAfterContinue,
			sleep: () => Promise.resolve(),
			now: () => 0,
		});

		expect(result.status).toBe("complete");
		expect(d.sentMethods().slice(0, 3)).toEqual([
			"thread/goal/get",
			"turn/start",
			"thread/goal/set",
		]);
		expect(quotaResume.calls).toEqual([
			"started:turn-c",
			"progress:turn-c:agentMessage",
		]);
	});

	it("reactivates the goal and sends the marked continue instead of replaying the kick", async () => {
		const d = usageLimitedDaemon({
			// The first model item arrives before the turn/start response.
			continueEvents: (push) => {
				pushItem(push, "userMessage");
				pushItem(push, "agentMessage");
			},
			afterContinue: (push) => pushGoal(push, "complete"),
		});
		const quotaResume = lifecycle();
		const client = new CodexDaemonClient({ transport: d, logger: () => {} });
		const result = await runGoalToTerminal(client, {
			threadId: "t",
			objective: OBJECTIVE,
			kickText: "FULL KICK TEXT",
			quotaResume,
			onGoalActive: d.flushAfterContinue,
			sleep: () => Promise.resolve(),
			now: () => 0,
		});
		expect(result.status).toBe("complete");
		expect(d.sentMethods().slice(0, 3)).toEqual([
			"thread/goal/get",
			"turn/start",
			"thread/goal/set",
		]);
		const turnStart = d.sent.find((s) => s.method === "turn/start")!.params as {
			input: { text: string }[];
			clientUserMessageId: string;
		};
		expect(turnStart.clientUserMessageId).toBe(CONTINUE_ID);
		expect(turnStart.input[0]!.text).toBe(quotaContinueText(CONTINUE_ID));
		expect(
			turnStart.input[0]!.text.startsWith(quotaContinueMarker(CONTINUE_ID)),
		).toBe(true);
		expect(JSON.stringify(d.sent)).not.toContain("FULL KICK TEXT");
		expect(quotaResume.calls).toEqual([
			"started:turn-c",
			"progress:turn-c:agentMessage",
		]);
		expect(d.sentMethods()).not.toContain("thread/read");
	});

	it("reconciles a carried id first and resends the same id when it never landed", async () => {
		const d = usageLimitedDaemon({
			threadRead: readResult([
				userTurn("turn-0", "completed", [userMessage(null, "kick")]),
			]),
			afterContinue: (push) => {
				pushItem(push, "reasoning");
				pushGoal(push, "complete");
			},
		});
		const quotaResume = lifecycle({ continueAttemptFresh: false });
		const client = new CodexDaemonClient({ transport: d, logger: () => {} });
		await runGoalToTerminal(client, {
			threadId: "t",
			objective: OBJECTIVE,
			quotaResume,
			onGoalActive: d.flushAfterContinue,
			sleep: () => Promise.resolve(),
			now: () => 0,
		});
		expect(d.sentMethods().slice(0, 4)).toEqual([
			"thread/goal/get",
			"thread/read",
			"turn/start",
			"thread/goal/set",
		]);
		expect(quotaResume.calls[0]).toBe("reconciled:absent");
		const turnStart = d.sent.find((s) => s.method === "turn/start")!.params as {
			clientUserMessageId: string;
		};
		expect(turnStart.clientUserMessageId).toBe(CONTINUE_ID);
	});

	it("sends nothing when the Bridge aborts after reconciliation", async () => {
		const d = usageLimitedDaemon({
			threadRead: readResult([
				userTurn("turn-1", "failed", [userMessage(CONTINUE_ID)]),
			]),
		});
		const quotaResume = lifecycle({ continueAttemptFresh: false });
		const client = new CodexDaemonClient({ transport: d, logger: () => {} });
		await expect(
			runGoalToTerminal(client, {
				threadId: "t",
				objective: OBJECTIVE,
				quotaResume,
				onGoalActive: d.flushAfterContinue,
				sleep: () => Promise.resolve(),
				now: () => 0,
			}),
		).rejects.toBeInstanceOf(GoalRunError);
		expect(quotaResume.calls).toEqual(["reconciled:failed_before_output"]);
		expect(d.sentMethods()).not.toContain("thread/goal/set");
		expect(d.sentMethods()).not.toContain("turn/start");
	});

	it("never blind-sends when thread/read cannot be parsed", async () => {
		const d = usageLimitedDaemon({ threadRead: { nonsense: true } });
		const quotaResume = lifecycle({ continueAttemptFresh: false });
		const client = new CodexDaemonClient({ transport: d, logger: () => {} });
		await expect(
			runGoalToTerminal(client, {
				threadId: "t",
				objective: OBJECTIVE,
				quotaResume,
				onGoalActive: d.flushAfterContinue,
				sleep: () => Promise.resolve(),
				now: () => 0,
			}),
		).rejects.toBeInstanceOf(GoalRunError);
		expect(quotaResume.calls).toEqual(["reconciled:unavailable"]);
		expect(d.sentMethods()).not.toContain("turn/start");
	});

	it("fails the run when the continue turn ends before any model output", async () => {
		const d = usageLimitedDaemon({
			afterContinue: (push) =>
				push({
					method: "turn/completed",
					params: {
						threadId: "t",
						turn: {
							id: "turn-c",
							status: "failed",
							error: { message: "invalid encrypted content" },
						},
					},
				}),
		});
		const quotaResume = lifecycle();
		const client = new CodexDaemonClient({ transport: d, logger: () => {} });
		await expect(
			runGoalToTerminal(client, {
				threadId: "t",
				objective: OBJECTIVE,
				quotaResume,
				onGoalActive: d.flushAfterContinue,
				sleep: () => Promise.resolve(),
				now: () => 0,
			}),
		).rejects.toThrow(/quota_continue_failed_before_output/);
		expect(quotaResume.calls).toEqual([
			"started:turn-c",
			"failed:turn-c:false",
		]);
	});

	it("lets a usage wall on the continue end as an ordinary usage-limited terminal", async () => {
		const d = usageLimitedDaemon({
			afterContinue: (push) => {
				push({
					method: "turn/completed",
					params: {
						threadId: "t",
						turn: {
							id: "turn-c",
							status: "failed",
							error: {
								message: "usage limit",
								codexErrorInfo: "usageLimitExceeded",
							},
						},
					},
				});
				pushGoal(push, "usageLimited");
			},
		});
		const quotaResume = lifecycle();
		const client = new CodexDaemonClient({ transport: d, logger: () => {} });
		const result = await runGoalToTerminal(client, {
			threadId: "t",
			objective: OBJECTIVE,
			quotaResume,
			onGoalActive: d.flushAfterContinue,
			sleep: () => Promise.resolve(),
			now: () => 0,
		});
		expect(result.status).toBe("usageLimited");
		expect(quotaResume.calls).toEqual(["started:turn-c", "failed:turn-c:true"]);
	});

	it("keeps the historical usage-limited preflight when no quota resume is present", async () => {
		const d = usageLimitedDaemon({
			afterContinue: (push) => pushGoal(push, "complete"),
		});
		const client = new CodexDaemonClient({ transport: d, logger: () => {} });
		await runGoalToTerminal(client, {
			threadId: "t",
			objective: OBJECTIVE,
			kickText: "FULL KICK TEXT",
			onGoalActive: d.flushAfterContinue,
			sleep: () => Promise.resolve(),
			now: () => 0,
		});
		const turnStart = d.sent.find((s) => s.method === "turn/start")!.params as {
			input: { text: string }[];
			clientUserMessageId?: string;
		};
		expect(turnStart.input[0]!.text).toBe("FULL KICK TEXT");
		expect(turnStart.clientUserMessageId).toBeUndefined();
	});
});

describe("FLY-2900 — a quota resume across daemon restarts", () => {
	it("reconciles on every session after the first and stops once settled", async () => {
		const { trackQuotaResumeAcrossRestarts } = await import(
			"../src/codex-quota-resume.js"
		);
		const base = lifecycle();
		const tracker = trackQuotaResumeAcrossRestarts(base);
		const first = tracker.current()!;
		expect(first.continueAttemptFresh).toBe(true);
		const second = tracker.current()!;
		expect(second.continueAttemptFresh).toBe(false);
		second.onContinueProgress({ turnId: "turn-c", itemType: "agentMessage" });
		expect(tracker.current()).toBeUndefined();
	});

	it("follows a proven reconciliation's new id and then goes quiet", async () => {
		const { trackQuotaResumeAcrossRestarts } = await import(
			"../src/codex-quota-resume.js"
		);
		const tracker = trackQuotaResumeAcrossRestarts(
			lifecycle({
				continueAttemptFresh: false,
				onContinueReconciled: () => ({
					action: "send",
					continueAttemptId: "new-id",
					settled: true,
				}),
			}),
		);
		const view = tracker.current()!;
		view.onContinueReconciled({ kind: "proven" });
		expect(view.continueAttemptId).toBe("new-id");
		expect(tracker.current()).toBeUndefined();
	});
});
