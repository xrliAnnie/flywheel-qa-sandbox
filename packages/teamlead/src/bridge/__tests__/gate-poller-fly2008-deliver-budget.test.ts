import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Lease = { db: CommDB; release(): void };
const delivered: string[] = [];
const observedLeases: Lease[] = [];
const emitSpy = vi.fn(
	async (
		ctx: { threadId: string; commDbPath: string },
		_questions: unknown[],
		deps: { commDbLeaseFactory?: (path: string) => Lease },
	) => {
		delivered.push(ctx.threadId);
		const lease = deps.commDbLeaseFactory?.(ctx.commDbPath);
		if (lease) {
			observedLeases.push(lease);
			lease.release();
		}
		return { threadId: ctx.threadId, result: "noop" as const };
	},
);

vi.mock("../founder-reply-deliverer.js", async () => {
	const actual = await vi.importActual<
		typeof import("../founder-reply-deliverer.js")
	>("../founder-reply-deliverer.js");
	return {
		...actual,
		emitFounderReplyDeliveryForThread: (...args: unknown[]) =>
			emitSpy(...(args as Parameters<typeof emitSpy>)),
	};
});

import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

const OWNER = "123456789012345678";
type PrivatePoller = { founderReplyDeliverPass(): Promise<void> };

function session(index: number) {
	const suffix = String(index).padStart(2, "0");
	return {
		execution_id: `exec-${suffix}`,
		issue_id: `issue-${suffix}`,
		issue_identifier: `FLY-${suffix}`,
		project_name: "flywheel",
		issue_labels: "[]",
	};
}

describe("FLY-2008 founder-reply scan budget", () => {
	let root: string;
	let sessions: ReturnType<typeof session>[];
	let store: GatePollerConfig["store"];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly2008-founder-budget-"));
		process.env.FLYWHEEL_COMM_DIR = root;
		delivered.length = 0;
		observedLeases.length = 0;
		emitSpy.mockClear();
		sessions = Array.from({ length: 40 }, (_, index) => session(index));
		store = {
			listNonTerminalSessions: vi.fn(() => sessions),
			getSession: vi.fn((executionId: string) =>
				sessions.find((item) => item.execution_id === executionId),
			),
			getChatThreadByIssue: vi.fn((issueId: string) => ({
				thread_id: `T-${issueId.slice(-2)}`,
			})),
		} as unknown as GatePollerConfig["store"];
	});

	afterEach(() => {
		delete process.env.FLYWHEEL_COMM_DIR;
		rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function seedQuestions(count: number): void {
		const db = new CommDB(join(root, "flywheel", "comm.db"));
		for (let index = 0; index < count; index++) {
			db.insertQuestion(
				sessions[index]!.execution_id,
				"test-lead",
				`question-${index}`,
			);
		}
		db.close();
	}

	function poller(scanBudget: number): PrivatePoller {
		return new GatePoller({
			pollIntervalMs: 3_000,
			projects: [
				{
					projectName: "flywheel",
					leads: [
						{
							agentId: "test-lead",
							botToken: "bot",
							chatChannel: "C1",
							match: { labels: [] },
						},
					],
				},
			] as unknown as GatePollerConfig["projects"],
			store,
			runtimeRegistry: {} as GatePollerConfig["runtimeRegistry"],
			chatThreadsEnabled: true,
			discordOwnerUserId: OWNER,
			founderReplyDeliverGraceMs: 0,
			founderReplyScanBudget: scanBudget,
		} as GatePollerConfig) as unknown as PrivatePoller;
	}

	it("processes every questioned thread plus an independent rotating scan budget", async () => {
		seedQuestions(3);
		const value = poller(10);
		const openReadonly = vi.spyOn(CommDB, "openReadonly");

		await value.founderReplyDeliverPass();
		expect(delivered).toEqual([
			"T-00",
			"T-01",
			"T-02",
			...Array.from(
				{ length: 10 },
				(_, index) => `T-${String(index + 3).padStart(2, "0")}`,
			),
		]);
		expect(store.listNonTerminalSessions).toHaveBeenCalledTimes(1);
		expect(openReadonly).toHaveBeenCalledTimes(1);
		expect(new Set(observedLeases.map(({ db }) => db)).size).toBe(1);

		delivered.length = 0;
		await value.founderReplyDeliverPass();
		expect(delivered.slice(0, 3)).toEqual(["T-00", "T-01", "T-02"]);
		expect(delivered.slice(3)).toEqual(
			Array.from(
				{ length: 10 },
				(_, index) => `T-${String(index + 13).padStart(2, "0")}`,
			),
		);
	});

	it("never lets a large question lane consume the scan lane budget", async () => {
		seedQuestions(30);
		await poller(10).founderReplyDeliverPass();
		expect(delivered).toHaveLength(40);
		expect(new Set(delivered).size).toBe(40);
	});

	it("uses strict upper-bound cursor semantics through deletion, insertion, and restart", async () => {
		seedQuestions(0);
		sessions = [session(10), session(20), session(30), session(40)];
		const value = poller(2);
		await value.founderReplyDeliverPass();
		expect(delivered).toEqual(["T-10", "T-20"]);

		delivered.length = 0;
		sessions = [session(5), session(10), session(30), session(40)];
		await value.founderReplyDeliverPass();
		expect(delivered).toEqual(["T-30", "T-40"]);

		delivered.length = 0;
		await value.founderReplyDeliverPass();
		expect(delivered).toEqual(["T-05", "T-10"]);

		delivered.length = 0;
		await poller(2).founderReplyDeliverPass();
		expect(delivered).toEqual(["T-05", "T-10"]);
	});

	it("uses one deterministic order across scan pages", async () => {
		seedQuestions(0);
		sessions = [session(1), session(2), session(3)];
		const threadByIssue = new Map([
			["issue-01", "B"],
			["issue-02", "a"],
			["issue-03", "c"],
		]);
		vi.mocked(store.getChatThreadByIssue).mockImplementation((issueId) => ({
			thread_id: threadByIssue.get(issueId)!,
		}));
		const value = poller(1);

		await value.founderReplyDeliverPass();
		await value.founderReplyDeliverPass();
		await value.founderReplyDeliverPass();

		expect(delivered).toEqual(["B", "a", "c"]);
	});

	it("closes both project connections when pass assembly throws", async () => {
		seedQuestions(0);
		sessions = [session(1)];
		vi.mocked(store.getChatThreadByIssue).mockImplementation(() => {
			throw new Error("state store failed mid-pass");
		});
		const close = vi.spyOn(CommDB.prototype, "close");

		await expect(poller(1).founderReplyDeliverPass()).rejects.toThrow(
			"state store failed mid-pass",
		);
		expect(close).toHaveBeenCalledTimes(2);
	});
});
