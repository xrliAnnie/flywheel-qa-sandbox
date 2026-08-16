/**
 * FLY-945 Fix B — ship-gate head rebind on a drifted PASS qa_result.
 *
 * FLY-921: a QA-evidence commit moved the PR head after `complete
 * --route needs_review`; the qa_result carried the new sha, the coordinator
 * dropped it ("stale/unbound"), the founder's approval later bound the OLD
 * sha, verify-approval mismatched, the Lead executor-merged around the
 * runner. The rebind re-aims the gate at the QA-proven head under strict
 * fail-closed conditions; ANY miss reproduces the exact pre-FLY-945 drop.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { REVIEW_BINDING_UNBOUND, StateStore } from "../../StateStore.js";
import { readCurrentGateMessageBinding } from "../approval-signal/gate-message-binding-store.js";
import {
	AutoQaCoordinator,
	type AutoQaCoordinatorDeps,
	type AutoQaSideEffects,
	type QaResultEvent,
} from "../auto-qa-coordinator.js";
import { defaultIsAncestor } from "../ship-gate-rebind.js";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const QID = "q-main-1";

interface Fx {
	store: StateStore;
	coord: AutoQaCoordinator;
	shipReady: () => number;
	rebindNotifies: { oldSha: string; newSha: string }[];
	hasGateResponse: ReturnType<typeof vi.fn>;
	isAncestor: ReturnType<typeof vi.fn>;
	notifyImpl: {
		current: () => Promise<{
			ok: boolean;
			messageId?: string;
			threadId?: string;
		}>;
	};
}

async function setup(opts?: {
	env?: Record<string, string | undefined>;
	noSeams?: boolean;
	hasResponse?: boolean;
	ancestor?: boolean;
}): Promise<Fx> {
	const store = await StateStore.create(":memory:");
	const rebindNotifies: { oldSha: string; newSha: string }[] = [];
	const counters = { shipReady: 0 };
	const notifyImpl = {
		current: async () => ({
			ok: true,
			messageId: "M-REBOUND",
			threadId: "T-1",
		}),
	};
	const effects: AutoQaSideEffects = {
		postThread: () => {},
		createQaIssue: () => ({ issueId: "qa-issue-uuid" }),
		notifyShipReady: () => {
			counters.shipReady += 1;
		},
		feedbackWakeMain: () => {},
		alertLeadPipelineError: () => {},
		stampIssueStage: () => {},
		retestWakeQa: () => ({ ok: true }),
		closeQaRunner: () => {},
		queueCodexInstruction: () => {},
		alertCodexGateBlocked: () => {},
		notifyShipGateRebound: async (args) => {
			rebindNotifies.push({ oldSha: args.oldSha, newSha: args.newSha });
			return notifyImpl.current();
		},
	};
	const hasGateResponse = vi.fn(() => opts?.hasResponse ?? false);
	const isAncestor = vi.fn(() => opts?.ancestor ?? true);
	const deps: AutoQaCoordinatorDeps = {
		store,
		startDispatcher: {
			start: async () => ({ executionId: "qa-1", issueId: "qa-issue-uuid" }),
		},
		resolveQaPolicy: () => ({ enabled: true }),
		effects,
		env: { FLYWHEEL_CODEX_HARD_GATE: "0", ...(opts?.env ?? {}) },
		...(opts?.noSeams
			? {}
			: { shipGateRebind: { hasGateResponse, isAncestor } }),
	};
	return {
		store,
		coord: new AutoQaCoordinator(deps),
		shipReady: () => counters.shipReady,
		rebindNotifies,
		hasGateResponse,
		isAncestor,
		notifyImpl,
	};
}

/** awaiting_review main with a real review binding @ OLD + a running record + QA session. */
function seed(
	store: StateStore,
	o: { binding?: "qid" | "unbound"; worktree?: string | null } = {},
) {
	store.upsertSession({
		execution_id: "main-1",
		issue_id: "FLY-1",
		project_name: "proj",
		status: "awaiting_review",
		session_role: "main",
		issue_identifier: "FLY-1",
		issue_labels: JSON.stringify(["engineer"]),
		branch: "fly-1",
		pr_number: 42,
		...(o.worktree === null ? {} : { worktree_path: o.worktree ?? "/tmp/wt" }),
	});
	store.setReviewBinding("main-1", {
		questionId: o.binding === "unbound" ? null : QID,
		prHeadSha: OLD,
	});
	store.claimAutoQaRecord({
		parentExecutionId: "main-1",
		targetPrHeadSha: OLD,
		issueId: "FLY-1",
		projectName: "proj",
	});
	store.setAutoQaQaExecutionId("main-1", OLD, "qa-1");
	store.upsertSession({
		execution_id: "qa-1",
		issue_id: "qa-issue-uuid",
		project_name: "proj",
		status: "running",
		session_role: "qa",
	});
}

function verdict(over: Record<string, unknown> = {}): QaResultEvent {
	return {
		event_id: `evt-${Math.random().toString(36).slice(2)}`,
		execution_id: "qa-1",
		issue_id: "FLY-1",
		project_name: "proj",
		event_type: "qa_result",
		payload: {
			status: "pass",
			targetExecutionId: "main-1",
			qaExecutionId: "qa-1",
			prHeadSha: NEW,
			summary: "pass on evidence commit",
			...over,
		},
	};
}

describe("FLY-945 Fix B: ship-gate rebind on drifted PASS qa_result", () => {
	it("① all conditions → session head + record retarget + notify + binding + audit + SAME verdict releases", async () => {
		const s = await setup();
		seed(s.store);
		await s.coord.onQaResult(verdict());

		// session head follows (text-approval path is closed-loop from here)
		expect(s.store.getSession("main-1")?.pr_head_sha).toBe(NEW);
		// the review question does NOT rotate
		expect(s.store.getSession("main-1")?.review_question_id).toBe(QID);
		// record retargeted + this same verdict released the founder notify
		expect(s.store.getAutoQaRecord("main-1", NEW)?.status).toBe("passed");
		expect(s.store.getAutoQaRecord("main-1", OLD)).toBeUndefined();
		expect(s.shipReady()).toBe(1);
		// thread follow-up + reaction anchor on the FOLLOW-UP message id @ NEW head
		expect(s.rebindNotifies).toEqual([{ oldSha: OLD, newSha: NEW }]);
		expect(
			readCurrentGateMessageBinding(s.store, "main-1", QID, NEW)?.gateMessageId,
		).toBe("M-REBOUND");
		// audit trail
		const audit = s.store
			.getEventsByExecution("main-1")
			.find((e) => e.event_type === "ship_gate_rebound");
		expect(audit?.payload).toMatchObject({
			questionId: QID,
			oldSha: OLD,
			newSha: NEW,
			gateMessageId: "M-REBOUND",
		});
		// no spurious retest wake marker left behind
		expect(
			s.store.getAutoQaRecord("main-1", NEW)?.retest_wake_pending_at,
		).toBeUndefined();
	});

	it("② FAIL verdict with drifted head → drop, no rebind (only a QA-proven head deserves the gate)", async () => {
		const s = await setup();
		seed(s.store);
		await s.coord.onQaResult(verdict({ status: "fail" }));
		expect(s.store.getSession("main-1")?.pr_head_sha).toBe(OLD);
		expect(s.rebindNotifies).toHaveLength(0);
	});

	it("② seams not wired → byte-compatible drop", async () => {
		const s = await setup({ noSeams: true });
		seed(s.store);
		await s.coord.onQaResult(verdict());
		expect(s.store.getSession("main-1")?.pr_head_sha).toBe(OLD);
		expect(s.shipReady()).toBe(0);
	});

	it("② unbound review question → drop", async () => {
		const s = await setup();
		seed(s.store, { binding: "unbound" });
		expect(s.store.getSession("main-1")?.review_question_id).toBe(
			REVIEW_BINDING_UNBOUND,
		);
		await s.coord.onQaResult(verdict());
		expect(s.store.getSession("main-1")?.pr_head_sha).toBe(OLD);
		expect(s.rebindNotifies).toHaveLength(0);
	});

	it("② reporter mismatch (record expects another QA runner) → drop", async () => {
		const s = await setup();
		seed(s.store);
		s.store.setAutoQaQaExecutionId("main-1", OLD, "qa-other");
		// the reporting session must still BE a qa session to reach the branch
		await s.coord.onQaResult(verdict());
		expect(s.store.getSession("main-1")?.pr_head_sha).toBe(OLD);
		expect(s.rebindNotifies).toHaveLength(0);
	});

	it("② record not running (already passed) → drop", async () => {
		const s = await setup();
		seed(s.store);
		s.store.setAutoQaStatus("main-1", OLD, "passed", {});
		await s.coord.onQaResult(verdict());
		expect(s.store.getSession("main-1")?.pr_head_sha).toBe(OLD);
		expect(s.rebindNotifies).toHaveLength(0);
	});

	it("④ gate already answered → NEVER rebind (approval frozen on the sha the founder saw)", async () => {
		const s = await setup({ hasResponse: true });
		seed(s.store);
		await s.coord.onQaResult(verdict());
		expect(s.hasGateResponse).toHaveBeenCalledWith({
			projectName: "proj",
			questionId: QID,
		});
		expect(s.store.getSession("main-1")?.pr_head_sha).toBe(OLD);
		expect(s.rebindNotifies).toHaveLength(0);
	});

	it("③ ancestry check fails (stranger sha / head swap) → drop", async () => {
		const s = await setup({ ancestor: false });
		seed(s.store);
		await s.coord.onQaResult(verdict());
		expect(s.isAncestor).toHaveBeenCalledWith({
			worktreePath: "/tmp/wt",
			oldSha: OLD,
			newSha: NEW,
		});
		expect(s.store.getSession("main-1")?.pr_head_sha).toBe(OLD);
	});

	it("③ missing worktree → fail-closed drop (ancestry unprovable)", async () => {
		const s = await setup();
		seed(s.store, { worktree: null });
		await s.coord.onQaResult(verdict());
		expect(s.isAncestor).not.toHaveBeenCalled();
		expect(s.store.getSession("main-1")?.pr_head_sha).toBe(OLD);
	});

	it("⑦ follow-up post fails → session head STILL rebound (text path fixed), NO binding, durable retry marker; next PASS re-send anchors it", async () => {
		const s = await setup();
		seed(s.store);
		s.notifyImpl.current = async () => ({ ok: false });
		await s.coord.onQaResult(verdict());

		expect(s.store.getSession("main-1")?.pr_head_sha).toBe(NEW);
		expect(
			readCurrentGateMessageBinding(s.store, "main-1", QID, NEW),
		).toBeNull();
		const failed = s.store
			.getEventsByExecution("main-1")
			.find((e) => e.event_type === "ship_gate_rebind_notify_failed");
		expect(failed?.payload).toMatchObject({ oldSha: OLD, newSha: NEW });

		// runner re-sends the PASS verdict (now sha == session head) → retry hook
		// redoes notify+binding only.
		s.notifyImpl.current = async () => ({
			ok: true,
			messageId: "M-RETRY",
			threadId: "T-1",
		});
		await s.coord.onQaResult(verdict({ prHeadSha: NEW }));
		expect(
			readCurrentGateMessageBinding(s.store, "main-1", QID, NEW)?.gateMessageId,
		).toBe("M-RETRY");
	});

	it("retry hook never fires for a normal session (no failed marker)", async () => {
		const s = await setup();
		seed(s.store);
		// matched-sha verdict on a session that never drifted
		await s.coord.onQaResult(verdict({ prHeadSha: OLD }));
		// no rebind follow-up; normal release happened
		expect(s.rebindNotifies).toHaveLength(0);
		expect(s.shipReady()).toBe(1);
	});
});

describe("FLY-945 Fix B ⑥: defaultIsAncestor against a REAL git repo (no mock git)", () => {
	const tmp = mkdtempSync(join(tmpdir(), "fly945-git-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: tmp, encoding: "utf8" }).trim();

	afterAll(() => rmSync(tmp, { recursive: true, force: true }));

	// Real git subprocesses — generous timeout so machine load can't flake it.
	it(
		"ancestor → true; reversed / unrelated → false; missing worktree → false",
		{ timeout: 30_000 },
		() => {
			git("init", "-q");
			git(
				"-c",
				"user.email=t@t",
				"-c",
				"user.name=t",
				"commit",
				"--allow-empty",
				"-q",
				"-m",
				"c1",
			);
			const c1 = git("rev-parse", "HEAD");
			git(
				"-c",
				"user.email=t@t",
				"-c",
				"user.name=t",
				"commit",
				"--allow-empty",
				"-q",
				"-m",
				"c2",
			);
			const c2 = git("rev-parse", "HEAD");

			expect(
				defaultIsAncestor({ worktreePath: tmp, oldSha: c1, newSha: c2 }),
			).toBe(true);
			expect(
				defaultIsAncestor({ worktreePath: tmp, oldSha: c2, newSha: c1 }),
			).toBe(false);
			expect(
				defaultIsAncestor({
					worktreePath: tmp,
					oldSha: "f".repeat(40),
					newSha: c2,
				}),
			).toBe(false);
			expect(
				defaultIsAncestor({
					worktreePath: join(tmp, "does-not-exist"),
					oldSha: c1,
					newSha: c2,
				}),
			).toBe(false);
		},
	);
});
