/**
 * FLY-643: AutoQaEffects.createQaIssue — creates the separate QA·FLY-XX Linear
 * issue mirroring the parent's team / project / labels, fail-closed on any error.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import type { Session } from "../../StateStore.js";
import { StateStore } from "../../StateStore.js";
import {
	AutoQaEffects,
	buildQaIssueContent,
	type LinearClientLike,
} from "../auto-qa-effects.js";
import type { ChatThreadCreator } from "../ChatThreadCreator.js";

const SHA = "a".repeat(40);

function parentSession(over: Partial<Session> = {}): Session {
	return {
		execution_id: "main-1",
		issue_id: "parent-uuid",
		project_name: "proj",
		issue_identifier: "FLY-643",
		issue_title: "Auto-QA separate issue",
		issue_url: "https://linear.app/x/issue/FLY-643",
		pr_number: 42,
		...over,
	} as Session;
}

function makeEffects(opts: {
	apiKey?: string;
	clientFactory?: (apiKey: string) => LinearClientLike;
}) {
	return new AutoQaEffects({
		store: {} as never,
		projects: [],
		config: { linearApiKey: opts.apiKey } as never,
		...(opts.clientFactory && { linearClientFactory: opts.clientFactory }),
	});
}

/** A fake Linear client that records the createIssue input. */
function fakeClient(over?: {
	team?: { id: string };
	project?: { id: string };
	labels?: { id: string }[];
	createdIssue?: { id?: string; identifier?: string; url?: string };
}) {
	const calls: {
		teamId: string;
		title: string;
		description?: string;
		labelIds?: string[];
		projectId?: string;
	}[] = [];
	const client: LinearClientLike = {
		issue: () => ({
			identifier: "FLY-643",
			title: "Auto-QA separate issue",
			url: "https://linear.app/x/issue/FLY-643",
			team: over?.team ?? { id: "team-FLY" },
			project: over?.project,
			labels: () => ({ nodes: over?.labels ?? [] }),
		}),
		createIssue: (input) => {
			calls.push(input);
			return {
				issue: over?.createdIssue ?? {
					id: "qa-issue-uuid",
					identifier: "FLY-700",
					url: "https://linear.app/x/issue/FLY-700",
				},
			};
		},
	};
	return { client, calls };
}

describe("AutoQaEffects.alertShipAttemptFailed (FLY-1505)", () => {
	it("emits a severe, approval-bound ship-attempt alert", async () => {
		const alert = vi.fn(async () => ({ sent: true }));
		const effects = new AutoQaEffects({
			store: {} as never,
			projects: [
				{
					projectName: "proj",
					projectRoot: "/x",
					leads: [
						{
							agentId: "lead-1",
							match: { labels: ["engineer"] },
						},
					],
				} as ProjectEntry,
			],
			config: {} as never,
			leadAlertNotifier: { alert: alert as never },
		});
		await effects.alertShipAttemptFailed({
			session: parentSession({
				issue_labels: JSON.stringify(["engineer"]),
				review_question_id: "q-1",
				pr_head_sha: SHA,
			}),
			reason: "SHIP-STALLED",
		});
		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: `ship-attempt-failed:main-1:q-1:${SHA}`,
				eventType: "ship_attempt_failed",
				severity: "severe",
				body: "SHIP-STALLED",
			}),
		);
	});

	it("rejects when no durable alert sink is available", async () => {
		const effects = new AutoQaEffects({
			store: {} as never,
			projects: [],
			config: {} as never,
		});
		await expect(
			effects.alertShipAttemptFailed({
				session: parentSession(),
				reason: "SHIP-STALLED",
			}),
		).rejects.toThrow("no alert sink");
	});

	it("rejects when the Lead cannot be resolved", async () => {
		const effects = new AutoQaEffects({
			store: {} as never,
			projects: [],
			config: {} as never,
			leadAlertNotifier: {
				alert: vi.fn(async () => ({ sent: true })),
			},
		});
		await expect(
			effects.alertShipAttemptFailed({
				session: parentSession(),
				reason: "SHIP-STALLED",
			}),
		).rejects.toThrow("no lead");
	});

	it.each([
		{ result: { skipped: "no-channel" as const }, label: "no channel" },
		{ result: { deadLettered: true }, label: "dead letter" },
	])("rejects a non-accepted notifier result: $label", async ({ result }) => {
		const effects = new AutoQaEffects({
			store: {} as never,
			projects: [
				{
					projectName: "proj",
					projectRoot: "/x",
					leads: [{ agentId: "lead-1", match: { labels: [] } }],
				} as ProjectEntry,
			],
			config: {} as never,
			leadAlertNotifier: {
				alert: vi.fn(async () => result),
			},
		});
		await expect(
			effects.alertShipAttemptFailed({
				session: parentSession(),
				reason: "SHIP-STALLED",
			}),
		).rejects.toThrow("not accepted");
	});

	it("accepts notifier dedup as durable delivery", async () => {
		const effects = new AutoQaEffects({
			store: {} as never,
			projects: [
				{
					projectName: "proj",
					projectRoot: "/x",
					leads: [{ agentId: "lead-1", match: { labels: [] } }],
				} as ProjectEntry,
			],
			config: {} as never,
			leadAlertNotifier: {
				alert: vi.fn(async () => ({ skipped: "duplicate" })),
			},
		});
		await expect(
			effects.alertShipAttemptFailed({
				session: parentSession(),
				reason: "SHIP-STALLED",
			}),
		).resolves.toBeUndefined();
	});
});

describe("buildQaIssueContent (FLY-643)", () => {
	it("titles QA · <parent> — <title> and embeds parent link / PR / commit", () => {
		const { title, description } = buildQaIssueContent({
			parentIdentifier: "FLY-643",
			parentTitle: "Auto-QA separate issue",
			parentUrl: "https://linear.app/x/issue/FLY-643",
			prNumber: 42,
			prHeadSha: SHA,
		});
		expect(title).toBe("QA · FLY-643 — Auto-QA separate issue");
		expect(description).toContain("FLY-643");
		expect(description).toContain("https://linear.app/x/issue/FLY-643");
		expect(description).toContain("#42");
		expect(description).toContain(SHA);
		expect(description).toContain("qa-result");
		// FLY-752 (Codex code R1 #1): the QA issue description must carry the
		// fix-loop contract, NOT the old terminal `complete --route no_code`.
		expect(description).not.toContain("complete --route no_code");
		expect(description).toContain("declare-state park");
	});

	it("omits the PR line when no PR number", () => {
		const { description } = buildQaIssueContent({
			parentIdentifier: "FLY-1",
			prHeadSha: SHA,
		});
		expect(description).not.toContain("- PR:");
	});
});

describe("AutoQaEffects.notifyShipGateRebound — FLY-1238 merged guard", () => {
	function reboundEffects(guarded: Record<string, unknown>) {
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ id: "message-1" }),
		})) as unknown as typeof fetch;
		const mergedGateGuard = vi.fn().mockResolvedValue(guarded);
		const effects = new AutoQaEffects({
			store: {
				getChatThreadByIssue: () => ({ thread_id: "thread-1" }),
			} as never,
			projects: [
				{
					projectName: "proj",
					projectRoot: "/repo",
					leads: [
						{
							agentId: "lead",
							chatChannel: "channel-1",
							botToken: "bot-token",
							match: { labels: [] },
						},
					],
				},
			],
			config: {} as never,
			fetchImpl,
			mergedGateGuard,
		});
		return { effects, fetchImpl, mergedGateGuard };
	}

	it.each([
		{ kind: "suppress_merged", cleanupComplete: true },
		{ kind: "retry_later", reason: "unknown" },
		{ kind: "terminal_unavailable", reason: "unknown_exhausted" },
	])("$kind creates no new rebound anchor", async (guarded) => {
		const { effects, fetchImpl, mergedGateGuard } = reboundEffects(guarded);
		const result = await effects.notifyShipGateRebound({
			session: parentSession({
				issue_labels: "[]",
				review_question_id: "Q-1",
				pr_number: 42,
			}),
			oldSha: "a".repeat(40),
			newSha: "b".repeat(40),
		});
		expect(result).toEqual({ ok: false });
		expect(mergedGateGuard).toHaveBeenCalledWith(
			expect.objectContaining({ questionId: "Q-1", source: "rebound" }),
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("AutoQaEffects.createQaIssue (FLY-643)", () => {
	it("creates the QA issue mirroring parent team / project / labels", async () => {
		const { client, calls } = fakeClient({
			team: { id: "team-FLY" },
			project: { id: "proj-flywheel" },
			labels: [{ id: "label-flywheel" }, { id: "label-engineer" }],
		});
		const effects = makeEffects({ apiKey: "k", clientFactory: () => client });
		const ref = await effects.createQaIssue({
			parent: parentSession(),
			prHeadSha: SHA,
		});
		expect(ref).toEqual({
			issueId: "qa-issue-uuid",
			issueIdentifier: "FLY-700",
			issueTitle: "QA · FLY-643 — Auto-QA separate issue",
			issueUrl: "https://linear.app/x/issue/FLY-700",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			teamId: "team-FLY",
			projectId: "proj-flywheel",
			labelIds: ["label-flywheel", "label-engineer"],
			title: "QA · FLY-643 — Auto-QA separate issue",
		});
	});

	it("works without a project (label-only scoped) — omits projectId", async () => {
		const { client, calls } = fakeClient({ team: { id: "team-FLY" } });
		const effects = makeEffects({ apiKey: "k", clientFactory: () => client });
		const ref = await effects.createQaIssue({
			parent: parentSession(),
			prHeadSha: SHA,
		});
		expect(ref?.issueId).toBe("qa-issue-uuid");
		expect(calls[0]?.projectId).toBeUndefined();
		expect(calls[0]?.labelIds).toBeUndefined();
	});

	it("fail-closed: no LINEAR_API_KEY → undefined (no client call)", async () => {
		const factory = vi.fn();
		const effects = makeEffects({ apiKey: undefined, clientFactory: factory });
		const ref = await effects.createQaIssue({
			parent: parentSession(),
			prHeadSha: SHA,
		});
		expect(ref).toBeUndefined();
		expect(factory).not.toHaveBeenCalled();
	});

	it("fail-closed: parent issue has no team → undefined", async () => {
		const client: LinearClientLike = {
			issue: () => ({
				team: undefined,
				labels: () => ({ nodes: [] }),
			}),
			createIssue: () => ({ issue: { id: "should-not-happen" } }),
		};
		const effects = makeEffects({ apiKey: "k", clientFactory: () => client });
		const ref = await effects.createQaIssue({
			parent: parentSession(),
			prHeadSha: SHA,
		});
		expect(ref).toBeUndefined();
	});

	it("fail-closed: Linear throws → undefined (never throws to the coordinator)", async () => {
		const client: LinearClientLike = {
			issue: () => {
				throw new Error("Linear API error");
			},
			createIssue: () => ({ issue: { id: "x" } }),
		};
		const effects = makeEffects({ apiKey: "k", clientFactory: () => client });
		const ref = await effects.createQaIssue({
			parent: parentSession(),
			prHeadSha: SHA,
		});
		expect(ref).toBeUndefined();
	});

	it("fail-closed: createIssue returns no issue → undefined", async () => {
		const client: LinearClientLike = {
			issue: () => ({
				team: { id: "team-FLY" },
				labels: () => ({ nodes: [] }),
			}),
			createIssue: () => ({ issue: undefined }),
		};
		const effects = makeEffects({ apiKey: "k", clientFactory: () => client });
		const ref = await effects.createQaIssue({
			parent: parentSession(),
			prHeadSha: SHA,
		});
		expect(ref).toBeUndefined();
	});
});

describe("AutoQaEffects.stampIssueStage (FLY-630 ②)", () => {
	const projects: ProjectEntry[] = [
		{
			projectName: "proj",
			projectRoot: "/x",
			leads: [
				{
					agentId: "lead-1",
					chatChannel: "chan-1",
					botToken: "bot-token",
					match: { labels: ["engineer"] },
				},
			],
		} as ProjectEntry,
	];

	function fakeCreator() {
		const markers: Array<string | null | undefined> = [];
		const calls: {
			threadId: string;
			stage: string;
			withWord: boolean;
			channel: string;
		}[] = [];
		const creator = {
			stampStageEmoji: vi.fn(
				async (
					ctx: { chatChannelId: string; modelMarker?: string | null },
					threadId: string,
					stage: string,
					withWord: boolean,
				) => {
					markers.push(ctx.modelMarker);
					calls.push({
						threadId,
						stage,
						withWord,
						channel: ctx.chatChannelId,
					});
				},
			),
		} as unknown as ChatThreadCreator;
		return { creator, calls, markers };
	}

	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});
	afterEach(() => {
		store.close();
	});

	const session = (over: Partial<Session> = {}): Session =>
		({
			execution_id: "main-1",
			issue_id: "FLY-1",
			project_name: "proj",
			issue_identifier: "FLY-1",
			issue_title: "Test issue",
			issue_labels: JSON.stringify(["engineer"]),
			...over,
		}) as Session;

	it("stamps the parent thread's badge via ChatThreadCreator (resolves lead → channel → thread)", async () => {
		store.upsertChatThread("thread-1", "chan-1", "FLY-1");
		const { creator, calls } = fakeCreator();
		const effects = new AutoQaEffects({
			store,
			projects,
			config: {} as never,
			chatThreadCreator: creator,
		});

		await effects.stampIssueStage({ session: session(), stage: "test" });

		expect(calls).toEqual([
			{
				threadId: "thread-1",
				stage: "test",
				withWord: true,
				channel: "chan-1",
			},
		]);
	});

	it("keeps a Claude parent model marker authoritative during auto-QA stamps", async () => {
		store.upsertChatThread("thread-1", "chan-1", "FLY-1");
		const { creator, markers } = fakeCreator();
		const effects = new AutoQaEffects({
			store,
			projects,
			config: {} as never,
			chatThreadCreator: creator,
		});

		await effects.stampIssueStage({
			session: session({
				adapter_type: "claude-tmux",
				runner_model: "claude-opus-4-8",
			}),
			stage: "test",
		});

		expect(markers[0]).toBe("O");
	});

	it("no-ops (no throw) when the parent thread does not exist yet", () => {
		const { creator, calls } = fakeCreator();
		const effects = new AutoQaEffects({
			store,
			projects,
			config: {} as never,
			chatThreadCreator: creator,
		});

		// FLY-630 (Codex R1): stampIssueStage is fire-and-forget (returns void) — it
		// must not throw when there is nothing to stamp.
		expect(() =>
			effects.stampIssueStage({ session: session(), stage: "test" }),
		).not.toThrow();
		expect(calls).toEqual([]);
	});

	it("no-ops when chatThreadCreator is not wired (feature off)", () => {
		store.upsertChatThread("thread-1", "chan-1", "FLY-1");
		const effects = new AutoQaEffects({
			store,
			projects,
			config: {} as never,
		});
		expect(() =>
			effects.stampIssueStage({ session: session(), stage: "test" }),
		).not.toThrow();
	});
});

describe("AutoQaEffects.retestWakeQa (FLY-752 fail-loud wake)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly752-comm-"));
		process.env.FLYWHEEL_COMM_DIR = tmpDir;
	});
	afterEach(() => {
		process.env.FLYWHEEL_COMM_DIR = undefined;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function qa(adapter?: string): Session {
		return {
			execution_id: "qa-1",
			issue_id: "qa-uuid",
			project_name: "proj",
			adapter_type: adapter,
		} as Session;
	}
	const parent = () =>
		({
			execution_id: "main-1",
			issue_id: "parent-uuid",
			issue_identifier: "FLY-643",
			project_name: "proj",
		}) as Session;

	it("clears the QA park marker + wakes with the CLAUDE backend for a claude-tmux QA", async () => {
		const calls: { backend?: string; content: string }[] = [];
		const effects = new AutoQaEffects({
			store: {} as never,
			projects: [],
			config: {} as never,
			wakeImpl: async (args) => {
				calls.push({ backend: args.backend, content: args.content });
				return { ok: true };
			},
		});
		const res = await effects.retestWakeQa({
			qaSession: qa("claude-tmux"),
			parentSession: parent(),
			newSha: SHA,
		});
		expect(res.ok).toBe(true);
		expect(calls[0]?.backend).toBe("claude-code");
		expect(calls[0]?.content).toContain(SHA);
		expect(calls[0]?.content).toContain("--target-exec main-1");
	});

	it("routes to the CODEX backend for a codex-tmux QA", async () => {
		const calls: { backend?: string }[] = [];
		const effects = new AutoQaEffects({
			store: {} as never,
			projects: [],
			config: {} as never,
			wakeImpl: async (args) => {
				calls.push({ backend: args.backend });
				return { ok: true };
			},
		});
		await effects.retestWakeQa({
			qaSession: qa("codex-tmux"),
			parentSession: parent(),
			newSha: SHA,
		});
		expect(calls[0]?.backend).toBe("codex");
	});

	it("FAIL-CLOSED for a no-transport QA backend (never a silent success)", async () => {
		let waked = false;
		const effects = new AutoQaEffects({
			store: {} as never,
			projects: [],
			config: {} as never,
			wakeImpl: async () => {
				waked = true;
				return { ok: true };
			},
		});
		const res = await effects.retestWakeQa({
			qaSession: qa("antigravity-tmux"),
			parentSession: parent(),
			newSha: SHA,
		});
		expect(res.ok).toBe(false);
		expect(res.error).toContain("no-transport");
		expect(waked).toBe(false);
	});

	it("returns ok:false when the mailbox wake fails", async () => {
		const effects = new AutoQaEffects({
			store: {} as never,
			projects: [],
			config: {} as never,
			wakeImpl: async () => ({ ok: false, error: "mailbox down" }),
		});
		const res = await effects.retestWakeQa({
			qaSession: qa("claude-tmux"),
			parentSession: parent(),
			newSha: SHA,
		});
		expect(res.ok).toBe(false);
		expect(res.error).toContain("mailbox down");
	});

	it("FAIL-LOUD on a backend_commdb SKIP — this primitive delivers the wake itself, so a skip is NOT a success (Codex code R1 #2)", async () => {
		// In FLYWHEEL_COMM_BACKEND=commdb rollback mode wakeRunnerMailbox skips
		// without delivering. retestWakeQa has no PostToolUse hook to inject the row
		// (unlike sendRunnerWake), so a skip must fail-loud → coordinator keeps the
		// durable retest marker + alerts, never clears it on a wake that went nowhere.
		const effects = new AutoQaEffects({
			store: {} as never,
			projects: [],
			config: {} as never,
			wakeImpl: async () => ({ ok: false, skippedReason: "backend_commdb" }),
		});
		const res = await effects.retestWakeQa({
			qaSession: qa("claude-tmux"),
			parentSession: parent(),
			newSha: SHA,
		});
		expect(res.ok).toBe(false);
	});
});

describe("AutoQaEffects.closeQaRunner (FLY-752 cleanup)", () => {
	it("closeRunner is invoked with finalizeDone + executorType=qa + archive", async () => {
		const calls: Parameters<
			typeof import("../close-runner.js").closeRunner
		>[0][] = [];
		const effects = new AutoQaEffects({
			store: {} as never,
			projects: [{ projectName: "proj" } as ProjectEntry],
			config: { discordOwnerUserId: "owner-1" } as never,
			transitionOpts: { some: "opts" } as never,
			globalBotToken: "bot-tok",
			closeRunnerImpl: async (opts) => {
				calls.push(opts);
				return { closed: true };
			},
		});
		await effects.closeQaRunner({
			qaSession: {
				execution_id: "qa-1",
				issue_id: "qa-uuid",
				project_name: "proj",
			} as Session,
			reason: "auto-QA passed",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].executionId).toBe("qa-1");
		expect(calls[0].executorType).toBe("qa");
		expect(calls[0].finalizeDone).toBe(true);
		expect(calls[0].transitionOpts).toEqual({ some: "opts" });
		expect(calls[0].archive?.globalBotToken).toBe("bot-tok");
		expect(calls[0].archive?.discordOwnerUserId).toBe("owner-1");
	});

	it("never throws when closeRunner reports not-closed (reconcile retries)", async () => {
		const effects = new AutoQaEffects({
			store: {} as never,
			projects: [],
			config: {} as never,
			closeRunnerImpl: async () => ({
				closed: false,
				error: "status_not_eligible:running",
			}),
		});
		await expect(
			effects.closeQaRunner({
				qaSession: {
					execution_id: "qa-1",
					issue_id: "qa-uuid",
					project_name: "proj",
				} as Session,
			}),
		).resolves.toBeUndefined();
	});
});

describe("AutoQaEffects.refreshPhaseStatusLine (FLY-887 founder-visibility)", () => {
	const projects: ProjectEntry[] = [
		{
			projectName: "proj",
			projectRoot: "/x",
			leads: [
				{
					agentId: "lead-1",
					chatChannel: "chan-1",
					botToken: "bot-token",
					match: { labels: ["engineer"] },
				},
			],
		} as ProjectEntry,
	];

	const session = (over: Partial<Session> = {}): Session =>
		({
			execution_id: "design-1",
			issue_id: "FLY-887",
			project_name: "proj",
			issue_labels: JSON.stringify(["engineer"]),
			...over,
		}) as Session;

	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertChatThread("thread-1", "chan-1", "FLY-887");
	});
	afterEach(() => {
		store.close();
	});

	/** Records every fetch call by method; POST → {id: msg id}, PATCH → configurable. */
	function fakeFetch(opts: { postId?: string; patchStatus?: number } = {}) {
		const calls: { method: string; url: string; body: string }[] = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			const method = (init?.method ?? "GET") as string;
			calls.push({ method, url, body: String(init?.body ?? "") });
			if (method === "POST") {
				return {
					ok: true,
					json: async () => ({ id: opts.postId ?? "msg-1" }),
				} as Response;
			}
			// PATCH
			const status = opts.patchStatus ?? 200;
			return {
				ok: status >= 200 && status < 300,
				status,
				text: async () => "",
			} as Response;
		}) as typeof fetch;
		return { fetchImpl, calls };
	}

	it("no-ops when there is no chat thread for the issue", async () => {
		const { fetchImpl, calls } = fakeFetch();
		const effects = new AutoQaEffects({
			store,
			projects,
			config: {} as never,
			fetchImpl,
		});
		await effects.refreshPhaseStatusLine({
			session: session({ issue_id: "FLY-no-thread" }),
			text: "🎨design(active)",
		});
		expect(calls).toHaveLength(0);
	});

	it("FLY-1709: archived thread is a hard zero-write gate", async () => {
		store.markChatThreadArchived("thread-1");
		store.setPhaseStatusLine("FLY-887", "chan-1", "old", "stale");
		const { fetchImpl, calls } = fakeFetch({ patchStatus: 404 });
		const effects = new AutoQaEffects({
			store,
			projects,
			config: {} as never,
			fetchImpl,
		});

		await effects.refreshPhaseStatusLine({
			session: session(),
			text: "🎨设计✅·🔨实现✅·🧪QA🔴",
		});

		expect(calls).toHaveLength(0);
	});

	it("first refresh: no prior record → POSTs fresh and records the message id", async () => {
		const { fetchImpl, calls } = fakeFetch({ postId: "msg-42" });
		const effects = new AutoQaEffects({
			store,
			projects,
			config: {} as never,
			fetchImpl,
		});

		await effects.refreshPhaseStatusLine({
			session: session(),
			text: "🎨design(active)·🔨implement(pending)·🧪qa(pending)",
		});

		expect(calls).toEqual([
			expect.objectContaining({
				method: "POST",
				url: "https://discord.com/api/v10/channels/thread-1/messages",
			}),
		]);
		expect(JSON.parse(calls[0].body).content).toMatch(/^🤖\[自动\] /);
		expect(store.getPhaseStatusLine("FLY-887", "chan-1")).toEqual({
			messageId: "msg-42",
			text: "🎨design(active)·🔨implement(pending)·🧪qa(pending)",
		});
	});

	it("same text as last refresh → zero churn (no fetch at all)", async () => {
		store.setPhaseStatusLine(
			"FLY-887",
			"chan-1",
			"msg-1",
			"🎨design(parked)·🔨implement(active)·🧪qa(pending)",
		);
		const { fetchImpl, calls } = fakeFetch();
		const effects = new AutoQaEffects({
			store,
			projects,
			config: {} as never,
			fetchImpl,
		});

		await effects.refreshPhaseStatusLine({
			session: session(),
			text: "🎨design(parked)·🔨implement(active)·🧪qa(pending)",
		});

		expect(calls).toHaveLength(0);
	});

	it("changed text + existing message → PATCH edit in place (never a fresh POST)", async () => {
		store.setPhaseStatusLine(
			"FLY-887",
			"chan-1",
			"msg-1",
			"🎨design(active)·🔨implement(pending)·🧪qa(pending)",
		);
		const { fetchImpl, calls } = fakeFetch();
		const effects = new AutoQaEffects({
			store,
			projects,
			config: {} as never,
			fetchImpl,
		});

		await effects.refreshPhaseStatusLine({
			session: session(),
			text: "🎨design(parked)·🔨implement(active)·🧪qa(pending)",
		});

		expect(calls).toEqual([
			expect.objectContaining({
				method: "PATCH",
				url: "https://discord.com/api/v10/channels/thread-1/messages/msg-1",
			}),
		]);
		expect(JSON.parse(calls[0].body).content).toMatch(/^🤖\[自动\] /);
		expect(store.getPhaseStatusLine("FLY-887", "chan-1")).toEqual({
			messageId: "msg-1",
			text: "🎨design(parked)·🔨implement(active)·🧪qa(pending)",
		});
	});

	it("edit 404 (message deleted) → clears the stale record and reposts fresh", async () => {
		store.setPhaseStatusLine(
			"FLY-887",
			"chan-1",
			"msg-gone",
			"🎨design(active)·🔨implement(pending)·🧪qa(pending)",
		);
		const { fetchImpl, calls } = fakeFetch({
			patchStatus: 404,
			postId: "msg-new",
		});
		const effects = new AutoQaEffects({
			store,
			projects,
			config: {} as never,
			fetchImpl,
		});

		await effects.refreshPhaseStatusLine({
			session: session(),
			text: "🎨design(parked)·🔨implement(active)·🧪qa(pending)",
		});

		expect(calls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
		expect(store.getPhaseStatusLine("FLY-887", "chan-1")).toEqual({
			messageId: "msg-new",
			text: "🎨design(parked)·🔨implement(active)·🧪qa(pending)",
		});
	});

	it("edit transient error (not 404) → leaves the stale record for the next refresh to retry", async () => {
		store.setPhaseStatusLine(
			"FLY-887",
			"chan-1",
			"msg-1",
			"🎨design(active)·🔨implement(pending)·🧪qa(pending)",
		);
		const { fetchImpl, calls } = fakeFetch({ patchStatus: 500 });
		const effects = new AutoQaEffects({
			store,
			projects,
			config: {} as never,
			fetchImpl,
		});

		await effects.refreshPhaseStatusLine({
			session: session(),
			text: "🎨design(parked)·🔨implement(active)·🧪qa(pending)",
		});

		expect(calls.map((c) => c.method)).toEqual(["PATCH"]); // no repost — not a 404
		expect(store.getPhaseStatusLine("FLY-887", "chan-1")).toEqual({
			messageId: "msg-1",
			text: "🎨design(active)·🔨implement(pending)·🧪qa(pending)", // unchanged
		});
	});
});
