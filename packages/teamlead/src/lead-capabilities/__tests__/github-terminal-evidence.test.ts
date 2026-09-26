import type { Octokit } from "@octokit/rest";
import { expect, it, vi } from "vitest";
import type { LeadOperationContext } from "../broker.js";
import { createGithubHandlers } from "../handlers/github.js";

const sha = "a".repeat(40);
const pr = {
	number: 7,
	html_url: "https://github.com/acme/project/pull/7",
	title: "Change",
	body: "body",
	state: "open",
	node_id: "PR_7",
	draft: true,
	head: { sha, ref: "feature/test", repo: { full_name: "acme/project" } },
	base: { ref: "main", repo: { full_name: "acme/project" } },
};
const cases = [
	{
		operationId: "github.run.rerun",
		input: { number: 7, runId: "101" },
		response: { status: 201 },
		ref: "run:101",
	},
	{
		operationId: "github.pr.ready",
		input: { number: 7 },
		response: {
			markPullRequestReadyForReview: {
				pullRequest: { id: "PR_7", number: 7, isDraft: false },
			},
		},
		ref: "pr:7",
	},
	{
		operationId: "github.pr.comment",
		input: { number: 7, body: "comment" },
		response: { data: { id: 42, html_url: `${pr.html_url}#issuecomment-42` } },
		ref: "42",
	},
	{
		operationId: "github.pr.review",
		input: { number: 7, body: "review", commitId: sha },
		response: {
			data: {
				id: 43,
				html_url: `${pr.html_url}#pullrequestreview-43`,
				commit_id: sha,
				state: "COMMENTED",
			},
		},
		ref: "43",
	},
	{
		operationId: "github.pr.edit",
		input: { number: 7, title: "Change" },
		response: { data: pr },
		ref: "pr:7",
	},
	{
		operationId: "github.pr.edit",
		input: { number: 7, labels: ["bug"], title: "Change" },
		response: { data: { ...pr, labels: [{ name: "bug" }] } },
		ref: "pr:7",
	},
];
it.each(cases)(
	"records validated late $operationId success before refusing output delivery",
	async (test) => {
		let settle!: (response: unknown) => void;
		const mutate = vi.fn(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				}),
		);
		const get = vi.fn(async () => ({ data: pr }));
		const client = {
			graphql: mutate,
			rest: {
				pulls: { get, update: mutate, createReview: mutate },
				issues: { createComment: mutate, update: mutate },
				actions: {
					reRunWorkflow: mutate,
					getWorkflowRun: async () => ({
						data: {
							id: 101,
							repository: { full_name: "acme/project" },
							head_sha: sha,
							html_url: "https://github.com/acme/project/actions/runs/101",
							status: "completed",
							pull_requests: [
								{
									number: 7,
									head: { sha },
									base: {
										repo: {
											name: "project",
											url: "https://api.github.com/repos/acme/project",
										},
									},
								},
							],
						},
					}),
				},
			},
		};
		const abort = new AbortController(),
			proof = vi.fn(async () => {});
		const context: LeadOperationContext = {
			projectName: "flywheel",
			leadId: "eng",
			activationId: "activation",
			requestId: "a0000000-0000-4000-8000-000000000001",
			signal: abort.signal,
			assertCurrent: async () => {
				abort.signal.throwIfAborted();
			},
			recordTerminalEvidence: proof,
		};
		const handler = createGithubHandlers({
			client: client as unknown as Octokit,
			policy: () => ({
				projectName: "flywheel",
				leadId: "eng",
				owner: "acme",
				repo: "project",
				revision: "1",
			}),
			authorizeTarget: async () => {},
			assertWriteTargetCurrent() {},
		}).get(test.operationId)!;
		const pending = handler
			.execute(test.input, context)
			.catch((error) => error);
		await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
		const readCount = get.mock.calls.length;
		abort.abort();
		settle(test.response);
		expect(await pending).toBeInstanceOf(Error);
		expect(proof).toHaveBeenCalledWith({
			status: "succeeded",
			providerRef: test.ref,
		});
		expect(get).toHaveBeenCalledTimes(readCount);
		expect(mutate).toHaveBeenCalledTimes(1);
	},
);

it.each([
	["voice:b0000000-0000-4000-8000-000000000001", "succeeded"],
	// Resident activations keep the pre-voice behavior (plan §2 rollback).
	["resident-activation", "unknown"],
] as const)(
	"settles a Bridge inner broker receipt for %s after cancellation without a target lock client only when voice-originated (%s)",
	async (activationId, settled) => {
		const { SqliteJournalStore } = await import(
			"../../lead-backends/codex/SqliteJournalStore.js"
		);
		const { LeadCapabilityBroker } = await import("../broker.js");
		const journal = new SqliteJournalStore(":memory:");
		let settle!: (value: unknown) => void;
		const mutate = vi.fn(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				}),
		);
		const handlers = createGithubHandlers({
			client: {
				rest: {
					pulls: { get: async () => ({ data: pr }) },
					issues: { createComment: mutate },
				},
			} as unknown as Octokit,
			policy: () => ({
				projectName: "flywheel",
				leadId: "eng",
				owner: "acme",
				repo: "project",
				revision: "1",
			}),
			authorizeTarget: async () => {},
			assertWriteTargetCurrent() {},
		});
		const key = {
			projectName: "flywheel",
			leadId: "eng",
			operationId: "github.pr.comment",
			requestId: "a0000000-0000-4000-8000-000000000001",
		};
		let enabled = true;
		const broker = new LeadCapabilityBroker({
			...key,
			activationId,
			receipts: journal.operationReceipts,
			handlers,
			secrets: [],
			allowedOperationIds: () => new Set([key.operationId]),
			assertCurrent: async () => {
				if (!enabled) throw new Error("revoked");
			},
		});
		try {
			const pending = broker.execute({
				schemaVersion: 1,
				operationId: key.operationId,
				requestId: key.requestId,
				input: { number: 7, body: "comment" },
			});
			await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
			enabled = false;
			await broker.close();
			expect(await pending).toMatchObject({ status: "unknown" });
			expect(journal.operationReceipts.get(key)?.state).toBe("unknown");
			settle({ data: { id: 42, html_url: `${pr.html_url}#issuecomment-42` } });
			if (settled === "succeeded")
				await vi.waitFor(() =>
					expect(journal.operationReceipts.get(key)).toMatchObject({
						state: "succeeded",
						providerRef: "42",
					}),
				);
			else {
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(journal.operationReceipts.get(key)?.state).toBe("unknown");
			}
			expect(mutate).toHaveBeenCalledTimes(1);
		} finally {
			await broker.close();
			journal.close();
		}
	},
);
