import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { describe, expect, it, vi } from "vitest";
import { createAttentionGateStore } from "../../__tests__/fixtures/attention-gate-store.js";
import {
	readAttentionSources,
	readChildThreads,
} from "../attention-sources.js";
import { generateAttentionEpicPage } from "../generate.js";
import { renderEpicPageHtml } from "../render-html.js";

const now = new Date("2026-09-09T12:00:00Z");
function setup() {
	const close = vi.fn();
	const stateStore = {
		getSessionByIssue: () => undefined,
		getActiveWorkflowRunForIssue: () => undefined,
		getLatestPhaseSessionsForIssue: () => [],
		hasFinalizationCompletedForIssue: () => false,
		hasMergeConfirmedForIssue: () => false,
		listOpenFounderAsks: () => [],
		hasFounderAttentionReplyAfter: () => false,
		readDiscordConfig: () => ({
			guild_id: "123",
			state: "configured",
			source_updated_at: now.toISOString(),
		}),
		classifyAttentionMailboxGate: () => "legacy",
		listAttentionGateFacts: () => ({
			facts: [
				{
					holder_id: "gate",
					question_id: "gate",
					issue_id: "uuid-a",
					execution_id: "exec-a",
					run_id: "run-a",
					node_id: "founder_gate",
					attempt: 1,
					state: "awaiting_review",
					authority_mode: "engine_terminal",
					kind: "founder_gate",
					since: "2026-09-09T10:00:00Z",
				},
			],
			truncated: false,
			rawCount: 1,
		}),
		resolveAttentionQuestionIdentity: (
			_project: string,
			_question: string,
			exec: string,
		) => ({
			status: "resolved",
			issue_id: exec === "exec-a" ? "uuid-a" : "uuid-b",
			identifier: null,
			aliases: [],
			run_id: null,
			channel_id: null,
		}),
		resolveAttentionThreadBinding: () => ({
			status: "resolved",
			thread_id: "456",
			channel_id: "789",
		}),
	};
	const issue = (id: string, identifier: string) => ({
		id,
		identifier,
		title: "任务",
		url: "https://linear.app/example",
		stateType: "started",
		labels: [],
	});
	const deps = {
		stateStore,
		openCommReadonly: () => ({
			close,
			listAttentionQuestions: () => ({
				questions: [
					{
						id: "question-b",
						execution_id: "exec-b",
						since: "2026-09-09T09:00:00Z",
						kind: "question",
						recipient_role: "lead",
						state: "pending" as const,
						checkpoint: null,
					},
				],
				rawCount: 1,
				nextCursor: null,
			}),
		}),
		fetchFounderReview: vi.fn().mockResolvedValue({
			items: [issue("uuid-c", "EPX-3")],
			rawCount: 1,
			missing: null,
			fetchedAt: now.toISOString(),
		}),
		fetchIssueMetadata: vi.fn().mockResolvedValue({
			items: [issue("uuid-a", "EPX-1"), issue("uuid-b", "EPX-2")],
			rawCount: 2,
			missing: null,
			fetchedAt: now.toISOString(),
		}),
	};
	return { deps, close };
}
describe("independent attention sources", () => {
	it.each(["getSessionByIssue", "getLatestPhaseSessionsForIssue"] as const)(
		"marks unavailable visibility from %s incomplete rather than empty",
		async (method) => {
			const { deps } = setup();
			deps.stateStore[method] = () => {
				throw new Error("PRIVATE_FAILURE");
			};
			const attention = await readAttentionSources(deps as never, {
				projectName: "example",
				binding: { team: "EPX" },
				apiKey: "test",
				channelIds: ["789"],
				now,
			});
			expect(attention.reads.gates.value).toBeNull();
			expect(attention.reads.gates.missing?.reason).toBe("source_unavailable");
			const page = generateAttentionEpicPage({
				snapshot: null,
				scopeBinding: { team: "EPX" },
				itemFacts: [],
				attention,
				projectName: "example",
				trigger: "manual",
				now,
			});
			const html = renderEpicPageHtml(page, now);
			expect(html).toContain("清单不完整");
			expect(html).not.toContain("现在没有等你的事");
			expect(html).not.toContain("PRIVATE_FAILURE");
		},
	);

	it("keeps the page renderable when an explicit ask cannot resolve Linear metadata", async () => {
		const { deps } = setup();
		deps.stateStore.listOpenFounderAsks = () =>
			[
				{
					ask_id: "orphan",
					project_name: "example",
					issue_id: "missing",
					channel_id: "789",
					thread_id: "456",
					lead_id: "lead",
					message_id: "999",
					question_id: null,
					excerpt: "audit only",
					asked_at: now.toISOString(),
					settled_at: null,
				},
			] as never;
		deps.fetchIssueMetadata.mockResolvedValue({
			items: [],
			rawCount: 0,
			missing: { reason: "source_unavailable" },
			fetchedAt: now.toISOString(),
		});
		const attention = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789"],
			now,
		});
		const page = generateAttentionEpicPage({
			snapshot: null,
			scopeBinding: { team: "EPX" },
			itemFacts: [],
			attention,
			projectName: "example",
			trigger: "manual",
			now,
		});
		expect(
			page.attention.find((item) => item.key === "ask:orphan")?.issue_id.value,
		).toBeNull();
		expect(renderEpicPageHtml(page, now)).not.toContain("audit only");
	});

	it("counts holder plus explicit ask as two StateStore facts and validates the rendered page", async () => {
		const { deps } = setup();
		deps.stateStore.listOpenFounderAsks = () =>
			[
				{
					ask_id: "ask",
					project_name: "example",
					issue_id: "uuid-b",
					channel_id: "789",
					thread_id: "456",
					lead_id: "lead",
					message_id: "999",
					question_id: null,
					excerpt: "<script>pick</script>",
					asked_at: now.toISOString(),
					settled_at: null,
				},
			] as never;
		const attention = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789"],
			now,
		});
		expect(attention.reads.gates.value).toEqual({ count: 2 });
		const page = generateAttentionEpicPage({
			snapshot: null,
			scopeBinding: { team: "EPX" },
			itemFacts: [],
			attention,
			projectName: "example",
			trigger: "manual",
			now,
		});
		const html = renderEpicPageHtml(page, now);
		expect(html).toContain("要你答");
		expect(html).not.toContain("<script>pick</script>");
	});

	it("marks failed SQL timestamp normalization invalid while label start remains unknown", async () => {
		const { deps } = setup();
		const gates = deps.stateStore.listAttentionGateFacts;
		deps.stateStore.listAttentionGateFacts = () =>
			({
				...gates(),
				facts: gates().facts.map((fact) => ({ ...fact, since: null })),
			}) as never;
		const open = deps.openCommReadonly;
		deps.openCommReadonly = () => {
			const db = open();
			const questions = db.listAttentionQuestions;
			db.listAttentionQuestions = () =>
				({
					...questions(),
					questions: questions().questions.map((q) => ({ ...q, since: null })),
				}) as never;
			return db;
		};
		const result = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789"],
			now,
		});
		for (const key of ["holder:gate", "question:question-b"]) {
			expect(
				result.candidates.find((candidate) => candidate.key === key)?.sources[0]
					.since,
			).toMatchObject({ value: null, missing: { reason: "invalid_since" } });
		}
		expect(
			result.candidates.find((candidate) => candidate.key === "issue:uuid-c")
				?.sources[0].since,
		).toMatchObject({ value: null, missing: { reason: "since_unknown" } });
	});
	it("reads three sources independently of Epic and closes the project database", async () => {
		const { deps, close } = setup();
		const result = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789"],
			now,
		});
		expect(result.candidates.map((x) => x.issue_id.value).sort()).toEqual([
			"uuid-a",
			"uuid-b",
			"uuid-c",
		]);
		expect(result.reads.questions.value).toEqual({ count: 1 });
		expect(result.guildId.value).toBe("123");
		expect(close).toHaveBeenCalledOnce();
		expect(
			result.candidates.find((x) => x.issue_id.value === "uuid-b")?.sources[0]
				.recipient_role?.value,
		).toBe("lead");
	});
	it("disables missing guild and keeps known rows when one source fails", async () => {
		const { deps } = setup();
		deps.stateStore.readDiscordConfig = () => null as never;
		deps.fetchFounderReview.mockRejectedValue(new Error("SECRET_ERROR"));
		const result = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789"],
			now,
		});
		expect(result.guildId).toMatchObject({
			value: null,
			missing: { reason: "no_guild_configured" },
		});
		expect(result.reads.founder_review).toMatchObject({
			value: null,
			missing: { reason: "source_unavailable" },
		});
		expect(result.candidates).toHaveLength(2);
		expect(JSON.stringify(result)).not.toContain("SECRET_ERROR");
	});
	it("uses an authoritative gate channel to resolve a thread", async () => {
		const { deps } = setup();
		deps.stateStore.resolveAttentionQuestionIdentity = () =>
			({
				status: "resolved",
				issue_id: "uuid-a",
				identifier: null,
				aliases: [],
				run_id: "run-a",
				channel_id: "789",
			}) as never;
		const resolve = vi.spyOn(deps.stateStore, "resolveAttentionThreadBinding");
		await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789", "987"],
			now,
		});
		expect(resolve.mock.calls[0][0]).toMatchObject({
			authoritativeChannelId: "789",
		});
	});
	it("does not resurrect an obsolete engine holder as a legacy mailbox gate", async () => {
		const { deps } = setup();
		deps.stateStore.classifyAttentionMailboxGate = () => "excluded";
		const open = deps.openCommReadonly;
		deps.openCommReadonly = () => {
			const db = open();
			const read = db.listAttentionQuestions;
			db.listAttentionQuestions = () => ({
				...read(),
				questions: read().questions.map((q) => ({
					...q,
					kind: "founder_gate",
				})),
			});
			return db;
		};
		const result = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789"],
			now,
		});
		expect(result.candidates.some((x) => x.key === "question:question-b")).toBe(
			false,
		);
	});
	it("preserves every known gate/question on resolver failures and marks identity read unavailable", async () => {
		const { deps, close } = setup();
		deps.stateStore.resolveAttentionQuestionIdentity = () => {
			throw new Error("secret resolver failure");
		};
		const result = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789"],
			now,
		});
		expect(result.candidates.map((c) => c.key)).toEqual([
			"holder:gate",
			"question:question-b",
			"issue:uuid-c",
		]);
		expect(result.candidates[0].issue_id.value).toBeNull();
		expect(result.candidates[1].issue_id.value).toBeNull();
		expect(result.identityReads.statestore).toMatchObject({
			value: null,
			missing: { reason: "source_unavailable" },
		});
		expect(close).toHaveBeenCalledOnce();
		expect(JSON.stringify(result)).not.toContain("secret resolver failure");
	});
	it("preserves an identity conflict as unknown instead of resolving via the raw holder issue", async () => {
		const { deps } = setup();
		const resolve = deps.stateStore.resolveAttentionQuestionIdentity;
		deps.stateStore.resolveAttentionQuestionIdentity = (p, q, e) =>
			q === "gate" ? ({ status: "conflict" } as never) : resolve(p, q, e);
		const result = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789"],
			now,
		});
		const gate = result.candidates.find((c) => c.key === "holder:gate")!;
		expect(gate.issue_id.value).toBeNull();
		expect(gate.thread).toMatchObject({
			value: null,
			missing: { reason: "issue_identity_unknown" },
		});
		expect(result.identityReads.statestore.value).not.toBeNull();
	});
	it("shares the selected gate channel with other sources of the same canonical issue", async () => {
		const { deps } = setup();
		const identity = deps.stateStore.resolveAttentionQuestionIdentity;
		deps.stateStore.resolveAttentionQuestionIdentity = (p, q, e) => ({
			...identity(p, q, e),
			channel_id: q === "gate" ? "789" : null,
		});
		deps.fetchFounderReview.mockResolvedValue({
			items: [
				{
					id: "uuid-a",
					identifier: "EPX-1",
					title: "任务",
					url: "https://linear.app/example",
					stateType: "started",
					labels: [],
				},
			],
			rawCount: 1,
			missing: null,
			fetchedAt: now.toISOString(),
		});
		const thread = vi.fn((input: { authoritativeChannelId?: string }) =>
			input.authoritativeChannelId === "789"
				? { status: "resolved", thread_id: "456", channel_id: "789" }
				: { status: "thread_binding_conflict" },
		);
		deps.stateStore.resolveAttentionThreadBinding = thread as never;
		const result = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789", "987"],
			now,
		});
		const sameIssue = result.candidates.filter(
			(c) => c.issue_id.value === "uuid-a",
		);
		expect(sameIssue).toHaveLength(2);
		expect(sameIssue.map((c) => c.thread.value)).toEqual([
			{ thread_id: "456", channel_id: "789" },
			{ thread_id: "456", channel_id: "789" },
		]);
		expect(
			thread.mock.calls.filter(([arg]) => arg.authoritativeChannelId === "789"),
		).toHaveLength(1);
	});
	it("marks successful orphan identity reads separately from real metadata failure", async () => {
		const { deps } = setup();
		deps.stateStore.resolveAttentionQuestionIdentity = () =>
			({ status: "unknown" }) as never;
		let result = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789"],
			now,
		});
		expect(result.identityReads.statestore.value).not.toBeNull();
		deps.fetchIssueMetadata.mockRejectedValue(new Error("no connection"));
		const { generateAttentionEpicPage } = await import("../generate.js");
		const page = generateAttentionEpicPage({
			snapshot: null,
			itemFacts: [],
			now,
			projectName: "example",
			trigger: "manual",
			scopeBinding: { team: "EPX" },
			attention: result,
		});
		expect(page.attention_sources.identity.value).toEqual({
			resolved: 1,
			unresolved: 2,
		});
		result = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789"],
			now,
		});
		expect(result.identityReads.linear).toMatchObject({
			value: null,
			missing: { reason: "source_unavailable" },
		});
	});
	it("starts the independent named query before local database reads", async () => {
		const { deps } = setup();
		const read = deps.stateStore.listAttentionGateFacts;
		deps.stateStore.listAttentionGateFacts = () => {
			expect(deps.fetchFounderReview).toHaveBeenCalledOnce();
			return read();
		};
		const result = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789"],
			now,
		});
		expect(result.candidates).toHaveLength(3);
	});

	it("disables all same-issue rows when two current gates have conflicting authoritative channels", async () => {
		const { deps } = setup();
		const gates = deps.stateStore.listAttentionGateFacts().facts;
		deps.stateStore.listAttentionGateFacts = () => ({
			facts: [
				gates[0],
				{ ...gates[0], question_id: "gate2", holder_id: "gate2" },
			],
			rawCount: 2,
			truncated: false,
		});
		const identity = deps.stateStore.resolveAttentionQuestionIdentity;
		deps.stateStore.resolveAttentionQuestionIdentity = (p, q, e) => ({
			...identity(p, q, e),
			channel_id: q === "gate" ? "789" : q === "gate2" ? "987" : null,
		});
		const result = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789", "987"],
			now,
		});
		expect(
			result.candidates
				.filter((c) => c.issue_id.value === "uuid-a")
				.map((c) => c.thread.missing?.reason),
		).toEqual(["thread_binding_conflict", "thread_binding_conflict"]);
	});
	it("keeps metadata partial results and propagates actual truncated read health", async () => {
		const { deps } = setup();
		const items = (await deps.fetchIssueMetadata()).items;
		deps.fetchIssueMetadata.mockResolvedValue({
			items,
			rawCount: 1000,
			fetchedAt: now.toISOString(),
			missing: { reason: "source_truncated", detail: "record_limit" },
		});
		const result = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789"],
			now,
		});
		expect(result.candidates).toHaveLength(3);
		expect(result.identityReads.linear).toMatchObject({
			value: null,
			missing: { reason: "source_truncated" },
		});
	});
	it("reports unreadable mailbox authority without promoting it and closes its DB", async () => {
		const { deps, close } = setup();
		deps.stateStore.classifyAttentionMailboxGate = () => {
			throw new Error("read failure");
		};
		const open = deps.openCommReadonly;
		deps.openCommReadonly = () => {
			const db = open();
			const read = db.listAttentionQuestions;
			db.listAttentionQuestions = () => ({
				...read(),
				questions: read().questions.map((q) => ({
					...q,
					kind: "founder_gate",
				})),
			});
			return db;
		};
		const result = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789"],
			now,
		});
		expect(
			result.candidates.find((c) => c.key === "question:question-b"),
		).toBeUndefined();
		expect(result.reads.questions.missing?.reason).toBe("source_unavailable");
		expect(result.identityReads.statestore.missing?.reason).toBe(
			"source_unavailable",
		);
		expect(close).toHaveBeenCalledOnce();
	});
});

it("does not promote an intermediate review holder to a founder card", async () => {
	const store = await createAttentionGateStore();
	try {
		const raw = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		// Real authority filtering must reject this despite its current review row.
		raw.exec(
			"UPDATE workflow_run SET current_node_id='code_review'; UPDATE workflow_run_node SET node_id='code_review'; UPDATE workflow_gate_holder SET gate_node_id='code_review'",
		);
		expect(store.listAttentionGateFacts("flywheel")).toMatchObject({
			rawCount: 1,
			facts: [],
		});
		const { deps } = setup();
		const result = await readAttentionSources(
			{ ...deps, stateStore: store } as never,
			{
				projectName: "flywheel",
				binding: { team: "EPX" },
				apiKey: "test",
				channelIds: ["789"],
				now,
			},
		);
		expect(
			result.candidates.some((c) =>
				c.sources.some(
					(source) => source.fact.value?.id === "full-question-123456789",
				),
			),
		).toBe(false);
		expect(result.reads.gates.value).toEqual({ count: 0 });
	} finally {
		store.close();
	}
});

describe("child Discord links", () => {
	it("uses UUID and identifier aliases within the configured project channels", () => {
		const { deps } = setup();
		const resolve = vi.spyOn(deps.stateStore, "resolveAttentionThreadBinding");
		const links = readChildThreads(
			deps.stateStore as never,
			"example",
			[{ id: "uuid-a", identifier: "EPX-1" }],
			["789"],
			now,
		);
		expect(resolve).toHaveBeenCalledWith({
			projectName: "example",
			aliases: ["uuid-a", "EPX-1"],
			channelIds: ["789"],
		});
		expect(links.get("uuid-a")?.value).toBe(
			"https://discord.com/channels/123/456",
		);
	});
	it("rejects malformed IDs even when the store reports configured/resolved", () => {
		const { deps } = setup();
		deps.stateStore.readDiscordConfig = () => ({
			guild_id: "123/evil",
			state: "configured",
			source_updated_at: now.toISOString(),
		});
		const links = readChildThreads(
			deps.stateStore as never,
			"example",
			[{ id: "uuid-a", identifier: "EPX-1" }],
			["789"],
			now,
		);
		expect(links.get("uuid-a")?.value).toBeNull();
		expect(links.get("uuid-a")?.missing?.reason).toBe("invalid_guild_config");
	});
});

it("does not create a founder card from an unbound legacy mailbox gate", async () => {
	const { deps } = setup();
	const open = deps.openCommReadonly;
	deps.openCommReadonly = () => {
		const db = open();
		const read = db.listAttentionQuestions;
		db.listAttentionQuestions = () => ({
			...read(),
			questions: read().questions.map((q) => ({ ...q, kind: "ship" })),
		});
		return db;
	};
	const result = await readAttentionSources(deps as never, {
		projectName: "example",
		binding: { team: "EPX" },
		apiKey: "test",
		channelIds: ["789"],
		now,
	});
	expect(result.candidates.some((c) => c.key === "question:question-b")).toBe(
		false,
	);
	expect(result.candidates.some((c) => c.key === "holder:gate")).toBe(true);
});

it.each([
	"no_thread_binding",
	"thread_binding_conflict",
	"thread_missing",
	"statestore_error",
] as const)(
	"does not invent a child URL when thread resolution reports %s",
	(status) => {
		const { deps } = setup();
		deps.stateStore.resolveAttentionThreadBinding = (() => {
			if (status === "statestore_error")
				throw new Error("private database error");
			return { status };
		}) as never;
		const cell = readChildThreads(
			deps.stateStore as never,
			"example",
			[{ id: "uuid-a", identifier: "EPX-1" }],
			["789"],
			now,
		).get("uuid-a")!;
		expect(cell.value).toBeNull();
		expect(cell.missing?.reason).toBe(status);
		expect(JSON.stringify(cell)).not.toContain("private database error");
	},
);

it.each([true, false])(
	"reuses child metadata only from the same proven scope (matching=%s)",
	async (matching) => {
		const { deps } = setup();
		deps.fetchIssueMetadata.mockResolvedValue({
			items: [],
			rawCount: 0,
			missing: null,
			fetchedAt: now.toISOString(),
		});
		const { epicShapeSnapshot } = await import("./fixtures/epic-shape.js");
		const scope = epicShapeSnapshot();
		scope.items[0]!.id = "uuid-a";
		if (!matching) scope.boundary.project = "Another project";
		const result = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX", project: "Example", label: "Example" },
			apiKey: "test",
			channelIds: ["789"],
			now,
			scopeSnapshot: Promise.resolve(scope),
		});
		const gate = result.candidates.find((c) => c.key === "holder:gate")!;
		expect(gate.identifier.value).toBe(matching ? "EPX-1" : null);
		expect(gate.issue_id.value).toBe(matching ? "uuid-a" : null);
		expect(gate.thread.value).toEqual(
			matching ? { thread_id: "456", channel_id: "789" } : null,
		);
	},
);

it.each(["founder_review", "brainstorm"] as const)(
	"shows an open %s round from real CommDB without a gate holder",
	async (checkpoint) => {
		const { deps } = setup();
		deps.stateStore.listAttentionGateFacts = () => ({
			facts: [],
			rawCount: 0,
			truncated: false,
		});
		deps.fetchFounderReview.mockResolvedValue({
			items: [],
			rawCount: 0,
			missing: null,
			fetchedAt: now.toISOString(),
		});
		const db = new CommDB(":memory:");
		const questionId = db.insertQuestion(
			"exec-b",
			"lead",
			"Please review this round",
			{ checkpoint },
		);
		deps.openCommReadonly = (() => db) as never;
		const attention = await readAttentionSources(deps as never, {
			projectName: "example",
			binding: { team: "EPX" },
			apiKey: "test",
			channelIds: ["789"],
			now,
		});
		expect(attention.candidates.map((c) => c.key)).toEqual([
			`question:${questionId}`,
		]);
		expect(attention.reads.questions.value).toEqual({ count: 1 });
		const page = generateAttentionEpicPage({
			snapshot: null,
			scopeBinding: { team: "EPX" },
			itemFacts: [],
			attention,
			projectName: "example",
			trigger: "manual",
			now,
		});
		const html = renderEpicPageHtml(page, now);
		const top =
			html.match(
				/<section\b[^>]*data-attention-section[^>]*>[\s\S]*?<\/section>/,
			)?.[0] ?? "";
		expect(top).toContain("EPX-2");
		expect(top).toContain("https://discord.com/channels/123/456");
		expect(top).not.toContain("现在没有等你的事");
	},
);
