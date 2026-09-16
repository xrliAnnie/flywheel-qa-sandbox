import type { LinearClient } from "@linear/sdk";
import { describe, expect, it, vi } from "vitest";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { LeadCapabilityBroker, type LeadOperationContext } from "../broker.js";
import { createLinearHandlers } from "../handlers/linear.js";

function fixture() {
	const issue = {
		id: "issue-1",
		identifier: "FLY-1",
		url: "https://linear.app/i/1",
		title: "Title",
		team: Promise.resolve({ id: "team-1" }),
		project: Promise.resolve({ id: "project-1" }),
		state: Promise.resolve({ id: "state-1" }),
		assignee: Promise.resolve(null),
		labels: async () => ({
			nodes: [{ name: "Product" }],
			pageInfo: { hasNextPage: false },
		}),
	};
	const client = {
		issue: vi.fn(async (id: string) =>
			id === "FLY-2" ? { ...issue, id: "issue-2", identifier: "FLY-2" } : issue,
		),
		issues: vi.fn(async () => ({
			nodes: [issue],
			pageInfo: { hasNextPage: false, endCursor: "cursor" },
		})),
		createComment: vi.fn(async () => ({
			success: true,
			comment: Promise.resolve({
				id: "comment-1",
				url: "https://linear.app/c/1",
			}),
		})),
		createIssue: vi.fn(async () => ({
			success: true,
			issue: Promise.resolve(issue),
		})),
		updateIssue: vi.fn(async () => ({
			success: true,
			issue: Promise.resolve(issue),
		})),
		createIssueRelation: vi.fn(async () => ({
			success: true,
			issueRelation: Promise.resolve({ id: "relation-1" }),
		})),
	};
	const policy = {
		teamId: "team-1",
		projectId: "project-1",
		createLabelIds: ["product-label"],
		assignableUserIds: new Set(["user-1"]),
		mutableStateIds: new Set(["state-1"]),
		mutableLabelIds: new Set(["product-label"]),
	};
	const authorizeLabels = vi.fn(async (labels: string[]) => {
		if (!labels.includes("Product") || labels.includes("Excluded"))
			throw new Error("out_of_scope");
	});
	const handlers = createLinearHandlers({
		client: client as unknown as LinearClient,
		policy: () => policy,
		authorizeLabels,
	});
	const context: LeadOperationContext = {
		requestId: "123e4567-e89b-42d3-a456-426614174000",
		projectName: "flywheel",
		leadId: "product",
		activationId: "a1",
		signal: new AbortController().signal,
		assertCurrent: vi.fn(async () => {}),
	};
	return { issue, client, policy, authorizeLabels, handlers, context };
}
describe("Linear broker handlers", () => {
	it("creates a comment only on a scoped issue and returns exact provider evidence", async () => {
		const f = fixture(),
			handler = f.handlers.get("linear.comment.create")!;
		const result = await handler.execute(
			{ issueId: "FLY-1", body: "review" },
			f.context,
		);
		expect(f.client.createComment).toHaveBeenCalledWith({
			issueId: "issue-1",
			body: "review",
		});
		expect(result).toMatchObject({
			status: "succeeded",
			providerRef: "comment-1",
			data: { commentId: "comment-1", url: "https://linear.app/c/1" },
		});
	});
	it("foreign team/project or excluded department produces zero writes", async () => {
		for (const change of ["team", "project", "labels"]) {
			const f = fixture();
			if (change === "team") f.issue.team = Promise.resolve({ id: "foreign" });
			if (change === "project")
				f.issue.project = Promise.resolve({ id: "foreign" });
			if (change === "labels")
				f.issue.labels = async () => ({
					nodes: [{ name: "Excluded" }],
					pageInfo: { hasNextPage: false },
				});
			await expect(
				f.handlers
					.get("linear.comment.create")!
					.execute({ issueId: "FLY-1", body: "review" }, f.context),
			).rejects.toThrow();
			expect(f.client.createComment).not.toHaveBeenCalled();
		}
	});
	it("rechecks changed policy after asynchronous issue lookup", async () => {
		const f = fixture();
		f.client.issue.mockImplementation(async () => {
			f.policy.projectId = "revoked";
			return f.issue;
		});
		await expect(
			f.handlers
				.get("linear.comment.create")!
				.execute({ issueId: "FLY-1", body: "review" }, f.context),
		).rejects.toThrow();
		expect(f.client.createComment).not.toHaveBeenCalled();
	});
	it("supports create/update/assign/relations with fixed field and scope checks", async () => {
		const f = fixture();
		await f.handlers
			.get("linear.issue.create")!
			.execute(
				{ teamId: "team-1", projectId: "project-1", title: "New" },
				f.context,
			);
		expect(f.client.createIssue).toHaveBeenCalledWith({
			teamId: "team-1",
			projectId: "project-1",
			title: "New",
			labelIds: ["product-label"],
		});
		await f.handlers
			.get("linear.issue.assign")!
			.execute({ issueId: "FLY-1", assigneeId: "user-1" }, f.context);
		expect(f.client.updateIssue).toHaveBeenCalledWith("issue-1", {
			assigneeId: "user-1",
		});
		await expect(
			f.handlers
				.get("linear.issue.update")!
				.execute({ issueId: "FLY-1", stateId: "ship" }, f.context),
		).rejects.toThrow();
		await f.handlers
			.get("linear.issue.relations.set")!
			.execute(
				{ issueId: "FLY-1", relatedIssueId: "FLY-2", type: "blocked_by" },
				f.context,
			);
		expect(f.client.createIssueRelation).toHaveBeenCalledWith({
			issueId: "issue-2",
			relatedIssueId: "issue-1",
			type: "blocks",
		});
	});
	it("filters bounded search results through the same live scope checks", async () => {
		const f = fixture();
		const result = await f.handlers
			.get("linear.issue.search")!
			.execute({ query: "Title", limit: 10 }, f.context);
		expect(f.client.issues).toHaveBeenCalledWith({
			first: 10,
			filter: {
				project: { id: { eq: "project-1" } },
				team: { id: { eq: "team-1" } },
				title: { containsIgnoreCase: "Title" },
			},
		});
		expect(result).toMatchObject({
			status: "succeeded",
			data: { issues: [{ id: "issue-1" }] },
		});
	});
});

it("rejects self relations, forbidden labels/users and extra fields without mutation", async () => {
	const f = fixture();
	for (const [op, input] of [
		[
			"linear.issue.relations.set",
			{ issueId: "FLY-1", relatedIssueId: "FLY-1", type: "related" },
		],
		["linear.issue.update", { issueId: "FLY-1", labelIds: ["foreign"] }],
		["linear.issue.assign", { issueId: "FLY-1", assigneeId: "foreign" }],
		["linear.comment.create", { issueId: "FLY-1", body: "x", token: "secret" }],
	] as const)
		await expect(
			f.handlers.get(op)!.execute(input, f.context),
		).rejects.toThrow();
	expect(f.client.createIssueRelation).not.toHaveBeenCalled();
	expect(f.client.updateIssue).not.toHaveBeenCalled();
	expect(f.client.createComment).not.toHaveBeenCalled();
});
it("rechecks live policy after department authorization awaits", async () => {
	const f = fixture();
	f.authorizeLabels.mockImplementation(async () => {
		f.policy.projectId = "revoked";
	});
	await expect(
		f.handlers
			.get("linear.comment.create")!
			.execute({ issueId: "FLY-1", body: "x" }, f.context),
	).rejects.toThrow();
	expect(f.client.createComment).not.toHaveBeenCalled();
});
it("excludes foreign search nodes and fails closed on missing pagination evidence", async () => {
	const f = fixture();
	f.client.issues.mockResolvedValue({
		nodes: [
			f.issue,
			{
				...f.issue,
				id: "foreign",
				project: Promise.resolve({ id: "foreign" }),
			},
		],
		pageInfo: { hasNextPage: false, endCursor: "cursor" },
	});
	const result = await f.handlers
		.get("linear.issue.search")!
		.execute({ query: "Title", limit: 10 }, f.context);
	expect(result).toMatchObject({
		data: { issues: [{ id: "issue-1" }], nextCursor: null },
	});
	f.client.issues.mockResolvedValue({
		nodes: [f.issue],
		pageInfo: { hasNextPage: true, endCursor: "" },
	});
	await expect(
		f.handlers
			.get("linear.issue.search")!
			.execute({ query: "Title", limit: 10 }, f.context),
	).rejects.toThrow();
	f.issue.labels = async () => ({
		nodes: [{ name: "Product" }],
		pageInfo: { hasNextPage: true },
	});
	await expect(
		f.handlers
			.get("linear.issue.get")!
			.execute({ issueId: "FLY-1" }, f.context),
	).rejects.toThrow();
});

it("rechecks policy in the same continuation immediately before the SDK mutation", async () => {
	const f = fixture();
	let checks = 0;
	f.context.assertCurrent = async () => {
		checks++;
		if (checks === 2)
			queueMicrotask(() =>
				queueMicrotask(() => {
					f.policy.projectId = "revoked";
				}),
			);
	};
	await expect(
		f.handlers
			.get("linear.comment.create")!
			.execute({ issueId: "FLY-1", body: "x" }, f.context),
	).rejects.toThrow();
	expect(f.client.createComment).not.toHaveBeenCalled();
});

it("returns scoped reads and permits configured updates and unassignment", async () => {
	const f = fixture();
	expect(
		await f.handlers
			.get("linear.issue.get")!
			.execute({ issueId: "FLY-1" }, f.context),
	).toMatchObject({
		status: "succeeded",
		providerRef: "issue-1",
		data: { issue: { id: "issue-1", state: "state-1", assigneeId: null } },
	});
	await f.handlers.get("linear.issue.update")!.execute(
		{
			issueId: "FLY-1",
			title: "Updated",
			stateId: "state-1",
			labelIds: ["product-label"],
		},
		f.context,
	);
	expect(f.client.updateIssue).toHaveBeenCalledWith("issue-1", {
		title: "Updated",
		stateId: "state-1",
		labelIds: ["product-label"],
	});
	await f.handlers
		.get("linear.issue.assign")!
		.execute({ issueId: "FLY-1", assigneeId: null }, f.context);
	expect(f.client.updateIssue).toHaveBeenCalledWith("issue-1", {
		assigneeId: null,
	});
});
it("does not retry provider rejection or an ambiguous thrown mutation", async () => {
	const f = fixture();
	f.client.createComment.mockResolvedValue({
		...(await f.client.createComment()),
		success: false,
	});
	f.client.createComment.mockClear();
	expect(
		await f.handlers
			.get("linear.comment.create")!
			.execute({ issueId: "FLY-1", body: "x" }, f.context),
	).toEqual({ status: "rejected" });
	expect(f.client.createComment).toHaveBeenCalledTimes(1);
	f.client.createComment
		.mockReset()
		.mockRejectedValue(new Error("provider_429"));
	await expect(
		f.handlers
			.get("linear.comment.create")!
			.execute({ issueId: "FLY-1", body: "x" }, f.context),
	).rejects.toThrow("provider_429");
	expect(f.client.createComment).toHaveBeenCalledTimes(1);
});

it("broker rejects foreign target before preparing or dispatching a receipt", async () => {
	const f = fixture();
	f.issue.project = Promise.resolve({ id: "foreign" });
	const store = new SqliteJournalStore(":memory:");
	try {
		const operationId = "linear.comment.create",
			requestId = "123e4567-e89b-42d3-a456-426614174000";
		const broker = new LeadCapabilityBroker({
			projectName: "flywheel",
			leadId: "product",
			activationId: "a1",
			receipts: store.operationReceipts,
			allowedOperationIds: () => new Set([operationId]),
			assertCurrent: async () => {},
			handlers: f.handlers,
			secrets: [],
		});
		const result = await broker.execute({
			schemaVersion: 1,
			operationId,
			requestId,
			input: { issueId: "FLY-1", body: "x" },
		});
		expect(result.status).toBe("rejected");
		expect(result.errorCode).toBe("target_not_authorized");
		expect(f.client.createComment).not.toHaveBeenCalled();
		expect(
			store.operationReceipts.get({
				projectName: "flywheel",
				leadId: "product",
				operationId,
				requestId,
			}),
		).toBeUndefined();
	} finally {
		store.close();
	}
});
it("read capability remains scoped when creation labels are not adopted", async () => {
	const f = fixture();
	f.policy.createLabelIds = [];
	expect(
		(
			await f.handlers
				.get("linear.issue.get")!
				.execute({ issueId: "FLY-1" }, f.context)
		).status,
	).toBe("succeeded");
	await expect(
		f.handlers
			.get("linear.issue.create")!
			.authorize(
				{ teamId: "team-1", projectId: "project-1", title: "x" },
				f.context,
			),
	).rejects.toThrow();
});
