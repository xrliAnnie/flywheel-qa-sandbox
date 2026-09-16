import { randomUUID } from "node:crypto";
import type { Issue, LinearSdk } from "@linear/sdk";
import type {
	HandlerOutcome,
	LeadOperationContext,
	LeadOperationHandler,
} from "../broker.js";
import { getLeadCapability } from "../catalog.js";
export interface LinearCapabilityPolicy {
	teamId: string;
	projectId: string;
	createLabelIds: readonly string[];
	assignableUserIds: ReadonlySet<string>;
	mutableStateIds: ReadonlySet<string>;
	mutableLabelIds: ReadonlySet<string>;
}
export interface LinearHandlerOptions {
	client: LinearSdk;
	policy(): LinearCapabilityPolicy;
	authorizeLabels(labels: string[]): Promise<void>;
}
class ScopeDenied extends Error {
	constructor() {
		super("linear_scope_denied");
	}
}
function fingerprint(policy: LinearCapabilityPolicy): string {
	return JSON.stringify([
		policy.teamId,
		policy.projectId,
		[...policy.createLabelIds].sort(),
		[...policy.assignableUserIds].sort(),
		[...policy.mutableStateIds].sort(),
		[...policy.mutableLabelIds].sort(),
	]);
}
const evidence = () => ({
	receiptId: randomUUID(),
	observedAt: new Date().toISOString(),
});
/** Typed SDK adapters. Credentials remain captured by the trusted LinearSdk, never in requests/context/results. */
export function createLinearHandlers(
	options: LinearHandlerOptions,
): ReadonlyMap<string, LeadOperationHandler> {
	const { client } = options;
	const handlers = new Map<string, LeadOperationHandler>();
	function current(expected: string) {
		const policy = options.policy();
		if (fingerprint(policy) !== expected) throw new ScopeDenied();
		return policy;
	}
	function policyStart() {
		const policy = options.policy();
		if (!policy.teamId || !policy.projectId) throw new ScopeDenied();
		return fingerprint(policy);
	}
	async function scoped(issue: Issue, expected: string) {
		const [team, project, labels] = await Promise.all([
			issue.team,
			issue.project,
			issue.labels({ first: 100 }),
		]);
		const policy = current(expected);
		if (team?.id !== policy.teamId || project?.id !== policy.projectId)
			throw new ScopeDenied();
		if (labels.pageInfo.hasNextPage !== false || labels.nodes.length > 100)
			throw new Error("linear_labels_incomplete");
		try {
			await options.authorizeLabels(labels.nodes.map((label) => label.name));
		} catch {
			throw new ScopeDenied();
		}
		current(expected);
		return issue;
	}
	async function getIssue(id: string, expected: string) {
		return scoped(await client.issue(id), expected);
	}
	async function projection(issue: Issue, expected: string) {
		const [state, assignee] = await Promise.all([issue.state, issue.assignee]);
		current(expected);
		if (!state?.id) throw new Error("linear_state_unknown");
		return {
			id: issue.id,
			identifier: issue.identifier,
			url: issue.url,
			title: issue.title,
			state: state.id,
			assigneeId: assignee?.id ?? null,
		};
	}
	async function beforeWrite(context: LeadOperationContext, expected: string) {
		await context.assertCurrent();
		if (context.signal.aborted) throw new Error("linear_operation_aborted");
		return current(expected);
	}
	function validateFields(
		operationId: string,
		input: Record<string, unknown>,
		expected: string,
	) {
		const policy = current(expected);
		if (
			operationId === "linear.issue.create" &&
			(input.teamId !== policy.teamId ||
				input.projectId !== policy.projectId ||
				policy.createLabelIds.length === 0 ||
				policy.createLabelIds.some((id) => !policy.mutableLabelIds.has(id)))
		)
			throw new ScopeDenied();
		if (
			operationId === "linear.issue.assign" &&
			input.assigneeId !== null &&
			!policy.assignableUserIds.has(input.assigneeId as string)
		)
			throw new ScopeDenied();
		if (operationId === "linear.issue.update") {
			if (
				input.stateId !== undefined &&
				!policy.mutableStateIds.has(input.stateId as string)
			)
				throw new ScopeDenied();
			if (input.labelIds !== undefined) {
				const labels = input.labelIds as string[];
				if (
					labels.some((id) => !policy.mutableLabelIds.has(id)) ||
					policy.createLabelIds.some((id) => !labels.includes(id))
				)
					throw new ScopeDenied();
			}
			if (
				!["title", "description", "stateId", "labelIds"].some(
					(field) => input[field] !== undefined,
				)
			)
				throw new Error("linear_empty_update");
		}
	}
	async function authorizeTarget(
		operationId: string,
		input: Record<string, unknown>,
		expected: string,
	) {
		validateFields(operationId, input, expected);
		if (
			operationId === "linear.issue.create" ||
			operationId === "linear.issue.search"
		)
			return;
		const issue = await getIssue(input.issueId as string, expected);
		if (operationId === "linear.issue.relations.set") {
			const related = await getIssue(input.relatedIssueId as string, expected);
			if (issue.id === related.id) throw new ScopeDenied();
		}
		validateFields(operationId, input, expected);
	}
	function add(
		operationId: string,
		execute: (
			input: Record<string, unknown>,
			context: LeadOperationContext,
			expected: string,
		) => Promise<HandlerOutcome>,
	) {
		const definition = getLeadCapability(operationId)!;
		handlers.set(operationId, {
			authorize: async (raw, context) => {
				const input = definition.inputSchema.parse(raw);
				const expected = policyStart();
				await context.assertCurrent();
				await authorizeTarget(operationId, input, expected);
				await context.assertCurrent();
				current(expected);
			},
			execute: async (raw, context) => {
				const input = definition.inputSchema.parse(raw);
				const expected = policyStart();
				await context.assertCurrent();
				current(expected);
				validateFields(operationId, input, expected);
				const outcome = await execute(input, context, expected);
				if (outcome.status === "succeeded")
					definition.outputSchema.parse(outcome.data);
				return outcome;
			},
		});
	}
	add("linear.issue.get", async (input, _context, expected) => {
		const issue = await getIssue(input.issueId as string, expected);
		return {
			status: "succeeded",
			providerRef: issue.id,
			data: { issue: await projection(issue, expected), ...evidence() },
		};
	});
	add("linear.issue.search", async (input, context, expected) => {
		const policy = current(expected),
			limit = (input.limit as number | undefined) ?? 50;
		const page = await client.issues({
			first: limit,
			...(input.cursor ? { after: input.cursor as string } : {}),
			filter: {
				project: { id: { eq: policy.projectId } },
				team: { id: { eq: policy.teamId } },
				title: { containsIgnoreCase: input.query as string },
			},
		});
		current(expected);
		if (
			typeof page.pageInfo.hasNextPage !== "boolean" ||
			page.nodes.length > limit ||
			(page.pageInfo.hasNextPage && !page.pageInfo.endCursor)
		)
			throw new Error("linear_pagination_incomplete");
		const issues = [];
		for (const issue of page.nodes) {
			try {
				await scoped(issue, expected);
			} catch (error) {
				current(expected);
				if (error instanceof ScopeDenied) continue;
				throw error;
			}
			issues.push(await projection(issue, expected));
		}
		await context.assertCurrent();
		current(expected);
		return {
			status: "succeeded",
			data: {
				issues,
				nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
				...evidence(),
			},
		};
	});
	add("linear.issue.create", async (input, context, expected) => {
		const policy = await beforeWrite(context, expected);
		if (input.teamId !== policy.teamId || input.projectId !== policy.projectId)
			throw new ScopeDenied();
		current(expected);
		if (context.signal.aborted) throw new Error("linear_operation_aborted");
		const payload = await client.createIssue({
			teamId: policy.teamId,
			projectId: policy.projectId,
			title: input.title as string,
			...(input.description !== undefined
				? { description: input.description as string }
				: {}),
			labelIds: [...policy.createLabelIds],
		});
		if (!payload.success) return { status: "rejected" };
		const issue = await payload.issue;
		if (!issue) throw new Error("linear_provider_result_missing");
		await scoped(issue, expected);
		return {
			status: "succeeded",
			providerRef: issue.id,
			data: { issue: await projection(issue, expected), ...evidence() },
		};
	});
	for (const operationId of ["linear.issue.update", "linear.issue.assign"])
		add(operationId, async (input, context, expected) => {
			const issue = await getIssue(input.issueId as string, expected);
			const policy = await beforeWrite(context, expected);
			const patch: Parameters<LinearSdk["updateIssue"]>[1] = {};
			if (operationId === "linear.issue.assign") {
				if (
					input.assigneeId !== null &&
					!policy.assignableUserIds.has(input.assigneeId as string)
				)
					throw new ScopeDenied();
				patch.assigneeId = input.assigneeId as string | null;
			} else {
				if (
					input.stateId !== undefined &&
					!policy.mutableStateIds.has(input.stateId as string)
				)
					throw new ScopeDenied();
				if (input.labelIds !== undefined) {
					const ids = input.labelIds as string[];
					if (
						ids.some((id) => !policy.mutableLabelIds.has(id)) ||
						policy.createLabelIds.some((id) => !ids.includes(id))
					)
						throw new ScopeDenied();
					patch.labelIds = ids;
				}
				if (input.title !== undefined) patch.title = input.title as string;
				if (input.description !== undefined)
					patch.description = input.description as string;
				if (input.stateId !== undefined)
					patch.stateId = input.stateId as string;
				if (Object.keys(patch).length === 0)
					throw new Error("linear_empty_update");
			}
			current(expected);
			if (context.signal.aborted) throw new Error("linear_operation_aborted");
			const payload = await client.updateIssue(issue.id, patch);
			if (!payload.success) return { status: "rejected" };
			const updated = await payload.issue;
			if (!updated) throw new Error("linear_provider_result_missing");
			await scoped(updated, expected);
			return {
				status: "succeeded",
				providerRef: updated.id,
				data: { issue: await projection(updated, expected), ...evidence() },
			};
		});
	add("linear.issue.relations.set", async (input, context, expected) => {
		const issue = await getIssue(input.issueId as string, expected),
			related = await getIssue(input.relatedIssueId as string, expected);
		if (issue.id === related.id) throw new ScopeDenied();
		await beforeWrite(context, expected);
		const blockedBy = input.type === "blocked_by";
		current(expected);
		if (context.signal.aborted) throw new Error("linear_operation_aborted");
		const payload = await client.createIssueRelation({
			issueId: blockedBy ? related.id : issue.id,
			relatedIssueId: blockedBy ? issue.id : related.id,
			type: (blockedBy ? "blocks" : input.type) as Parameters<
				LinearSdk["createIssueRelation"]
			>[0]["type"],
		});
		if (!payload.success) return { status: "rejected" };
		const relation = await payload.issueRelation;
		if (!relation) throw new Error("linear_provider_result_missing");
		return {
			status: "succeeded",
			providerRef: relation.id,
			data: { relationId: relation.id, ...evidence() },
		};
	});
	add("linear.comment.create", async (input, context, expected) => {
		const issue = await getIssue(input.issueId as string, expected);
		await beforeWrite(context, expected);
		current(expected);
		if (context.signal.aborted) throw new Error("linear_operation_aborted");
		const payload = await client.createComment({
			issueId: issue.id,
			body: input.body as string,
		});
		if (!payload.success) return { status: "rejected" };
		const comment = await payload.comment;
		if (!comment) throw new Error("linear_provider_result_missing");
		return {
			status: "succeeded",
			providerRef: comment.id,
			data: { commentId: comment.id, url: comment.url, ...evidence() },
		};
	});
	return handlers;
}
