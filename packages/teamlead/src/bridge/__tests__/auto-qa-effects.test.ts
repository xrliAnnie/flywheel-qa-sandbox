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
	const ORIG_EMOJI = process.env.FLYWHEEL_ISSUE_STATUS_EMOJI;
	const ORIG_WORD = process.env.FLYWHEEL_ISSUE_STATUS_WORD;

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
		const calls: {
			threadId: string;
			stage: string;
			withWord: boolean;
			channel: string;
		}[] = [];
		const creator = {
			stampStageEmoji: vi.fn(
				async (
					ctx: { chatChannelId: string },
					threadId: string,
					stage: string,
					withWord: boolean,
				) => {
					calls.push({
						threadId,
						stage,
						withWord,
						channel: ctx.chatChannelId,
					});
				},
			),
		} as unknown as ChatThreadCreator;
		return { creator, calls };
	}

	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		delete process.env.FLYWHEEL_ISSUE_STATUS_EMOJI;
		delete process.env.FLYWHEEL_ISSUE_STATUS_WORD;
	});
	afterEach(() => {
		store.close();
		if (ORIG_EMOJI === undefined)
			delete process.env.FLYWHEEL_ISSUE_STATUS_EMOJI;
		else process.env.FLYWHEEL_ISSUE_STATUS_EMOJI = ORIG_EMOJI;
		if (ORIG_WORD === undefined) delete process.env.FLYWHEEL_ISSUE_STATUS_WORD;
		else process.env.FLYWHEEL_ISSUE_STATUS_WORD = ORIG_WORD;
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

	it("no-ops when the feature flag is off (FLYWHEEL_ISSUE_STATUS_EMOJI=0)", async () => {
		process.env.FLYWHEEL_ISSUE_STATUS_EMOJI = "0";
		store.upsertChatThread("thread-1", "chan-1", "FLY-1");
		const { creator, calls } = fakeCreator();
		const effects = new AutoQaEffects({
			store,
			projects,
			config: {} as never,
			chatThreadCreator: creator,
		});

		await effects.stampIssueStage({ session: session(), stage: "approve" });

		expect(calls).toEqual([]);
	});

	it("respects FLYWHEEL_ISSUE_STATUS_WORD=0 (emoji-only)", async () => {
		process.env.FLYWHEEL_ISSUE_STATUS_WORD = "0";
		store.upsertChatThread("thread-1", "chan-1", "FLY-1");
		const { creator, calls } = fakeCreator();
		const effects = new AutoQaEffects({
			store,
			projects,
			config: {} as never,
			chatThreadCreator: creator,
		});

		await effects.stampIssueStage({ session: session(), stage: "implement" });

		expect(calls[0]?.withWord).toBe(false);
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
