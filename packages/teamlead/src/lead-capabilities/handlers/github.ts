import { createHash, randomUUID } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import type {
	HandlerOutcome,
	LeadOperationContext,
	LeadOperationHandler,
} from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import {
	downloadGithubRunLogZip,
	parseGithubRunLogZip,
} from "./github-run-log.js";
export interface GithubReadPolicy {
	projectName: string;
	leadId: string;
	owner: string;
	repo: string;
	revision: string;
	creation?: {
		defaultBranch: string;
		headRefs: ReadonlySet<string>;
		baseRefs: ReadonlySet<string>;
	};
}
export interface GithubBusinessTarget {
	/** Provider-observed PR branch, carried only by write targets. */
	headRef?: string;
	kind: "pull-request" | "issue" | "workflow-run";
	number: number;
	owner: string;
	repo: string;
}
export interface GithubCreateTarget {
	kind: "pull-request-create";
	owner: string;
	repo: string;
	head: string;
	base: string;
}
export interface GithubReadHandlerOptions {
	logDownload?: Parameters<typeof downloadGithubRunLogZip>[2];
	authorizeCreate?(
		target: GithubCreateTarget,
		context: LeadOperationContext,
	): Promise<void>;
	/** Mandatory for writes: synchronous check of the current business binding, after all asynchronous checks. */
	assertWriteTargetCurrent?(
		target: GithubBusinessTarget | GithubCreateTarget,
		context: LeadOperationContext,
	): void;
	client: Octokit;
	policy(): GithubReadPolicy;
	authorizeTarget(
		target: GithubBusinessTarget,
		context: LeadOperationContext,
	): Promise<void>;
}
type PullData = {
	number: number;
	html_url: string;
	title: string;
	draft?: boolean;
	head: { sha: string };
	base: { ref: string; repo: { full_name: string } | null };
};
function fingerprint(policy: GithubReadPolicy) {
	return JSON.stringify([
		policy.projectName,
		policy.leadId,
		policy.owner,
		policy.repo,
		policy.revision,
		policy.creation
			? [
					policy.creation.defaultBranch,
					[...policy.creation.headRefs].sort(),
					[...policy.creation.baseRefs].sort(),
				]
			: null,
	]);
}
/** Reserve half of the broker wire budget for evidence/envelope and JSON escaping. */
function encodedTextPage(text: string, offset: number) {
	if (
		offset > text.length ||
		(offset > 0 &&
			text.charCodeAt(offset) >= 0xdc00 &&
			text.charCodeAt(offset) <= 0xdfff &&
			text.charCodeAt(offset - 1) >= 0xd800 &&
			text.charCodeAt(offset - 1) <= 0xdbff)
	)
		throw new Error("github_invalid_cursor");
	let end = offset,
		bytes = 2;
	while (end < text.length) {
		const codePoint = text.codePointAt(end)!;
		const scalar = String.fromCodePoint(codePoint),
			encoded = Buffer.byteLength(JSON.stringify(scalar)) - 2;
		if (bytes + encoded > 131072) break;
		bytes += encoded;
		end += scalar.length;
	}
	return { text: text.slice(offset, end), end, truncated: end < text.length };
}
const evidence = () => ({
	receiptId: randomUUID(),
	observedAt: new Date().toISOString(),
});
/** Explicit typed REST operations. The parent injects an Octokit client without retry plugins and keeps its credentials private. */
export function createGithubHandlers(
	options: GithubReadHandlerOptions,
): ReadonlyMap<string, LeadOperationHandler> {
	const { client } = options;
	const handlers = new Map<string, LeadOperationHandler>();
	function current(context: LeadOperationContext, expected?: string) {
		const p = options.policy();
		if (
			context.signal.aborted ||
			p.projectName !== context.projectName ||
			p.leadId !== context.leadId ||
			!p.revision ||
			!/^[-a-zA-Z0-9_.]{1,100}$/.test(p.owner) ||
			!/^[-a-zA-Z0-9_.]{1,100}$/.test(p.repo) ||
			(expected !== undefined && fingerprint(p) !== expected)
		)
			throw new Error("github_scope_denied");
		return p;
	}
	async function guard(context: LeadOperationContext, expected: string) {
		await context.assertCurrent();
		current(context, expected);
	}
	async function target(
		kind: GithubBusinessTarget["kind"],
		number: number,
		context: LeadOperationContext,
		expected: string,
	) {
		const p = current(context, expected);
		await options.authorizeTarget(
			{ kind, number, owner: p.owner, repo: p.repo },
			context,
		);
		current(context, expected);
	}
	function checkUrl(raw: string, path: string) {
		const parsed = new URL(raw);
		if (
			parsed.origin !== "https://github.com" ||
			parsed.username ||
			parsed.password ||
			parsed.pathname.toLowerCase() !== path.toLowerCase()
		)
			throw new Error("github_foreign_resource");
	}
	function projectPr(pr: PullData, p: GithubReadPolicy, number?: number) {
		if (
			pr.base.repo?.full_name.toLowerCase() !==
				`${p.owner}/${p.repo}`.toLowerCase() ||
			(number !== undefined && pr.number !== number) ||
			!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(pr.head.sha)
		)
			throw new Error("github_foreign_resource");
		checkUrl(pr.html_url, `/${p.owner}/${p.repo}/pull/${pr.number}`);
		return {
			number: pr.number,
			url: pr.html_url,
			title: pr.title,
			head: pr.head.sha,
			base: pr.base.ref,
			draft: pr.draft ?? false,
		};
	}
	function diffCursor(raw: unknown) {
		if (raw === undefined) return null;
		if (typeof raw !== "string") throw new Error("github_invalid_cursor");
		const match =
			/^([a-f0-9]{40}|[a-f0-9]{64}):([a-f0-9]{40}|[a-f0-9]{64}):([1-9][0-9]{0,7})$/.exec(
				raw,
			);
		if (!match) throw new Error("github_invalid_cursor");
		return { head: match[1], base: match[2], offset: Number(match[3]) };
	}
	function logCursor(raw: unknown) {
		if (raw === undefined) return null;
		if (typeof raw !== "string") throw new Error("github_invalid_cursor");
		const match =
			/^([1-9][0-9]{0,15}):([a-f0-9]{40}|[a-f0-9]{64}):([1-9][0-9]{0,7}):([a-f0-9]{64}):([1-9][0-9]{0,7})$/.exec(
				raw,
			);
		if (!match) throw new Error("github_invalid_cursor");
		return {
			runId: match[1],
			head: match[2],
			attempt: Number(match[3]),
			digest: match[4],
			offset: Number(match[5]),
		};
	}
	function runNumber(raw: unknown) {
		if (
			typeof raw !== "string" ||
			!/^[1-9][0-9]{0,15}$/.test(raw) ||
			!Number.isSafeInteger(Number(raw))
		)
			throw new Error("github_invalid_run_id");
		return Number(raw);
	}
	function pageCursor(raw: unknown) {
		if (raw === undefined) return 1;
		if (typeof raw !== "string" || !/^[1-9][0-9]{0,3}$/.test(raw))
			throw new Error("github_invalid_cursor");
		return Number(raw);
	}
	function nextPage(
		link: string | undefined,
		page: number,
		p: GithubReadPolicy,
	): string | null {
		if (!link) return null;
		if (link.length > 8192) throw new Error("github_pagination_incomplete");
		let next: string | null = null;
		for (const part of link.split(",")) {
			const match = part.trim().match(/^<([^>]+)>;\s*rel="([a-z]+)"$/);
			if (!match) throw new Error("github_pagination_incomplete");
			if (match[2] !== "next") continue;
			const url = new URL(match[1]!);
			const targetPage = pageCursor(url.searchParams.get("page"));
			if (
				next !== null ||
				url.origin !== "https://api.github.com" ||
				url.username ||
				url.password ||
				(url.pathname.toLowerCase() !==
					`/repos/${p.owner}/${p.repo}/pulls`.toLowerCase() &&
					!/^\/repositories\/[0-9]+\/pulls$/.test(url.pathname)) ||
				targetPage !== page + 1
			)
				throw new Error("github_pagination_incomplete");
			next = String(targetPage);
		}
		return next;
	}
	async function pull(
		number: number,
		context: LeadOperationContext,
		expected: string,
	) {
		await target("pull-request", number, context, expected);
		await guard(context, expected);
		const p = current(context, expected);
		const response = await client.rest.pulls.get({
			request: { signal: context.signal },
			owner: p.owner,
			repo: p.repo,
			pull_number: number,
		});
		current(context, expected);
		projectPr(response.data, p, number);
		return response.data;
	}
	function createTarget(
		input: Record<string, unknown>,
		context: LeadOperationContext,
		expected: string,
	): GithubCreateTarget {
		const p = current(context, expected),
			head = input.head as string,
			base = input.base as string;
		const validRef = (ref: string) =>
			/^[A-Za-z0-9_./-]+$/.test(ref) &&
			!ref.startsWith("-") &&
			!ref.startsWith("refs/") &&
			!ref.endsWith("/") &&
			!ref.endsWith(".lock") &&
			!ref.includes("..") &&
			!ref.includes("//") &&
			!ref.startsWith(".") &&
			!ref.endsWith(".") &&
			ref !== "HEAD";
		if (
			!p.creation ||
			!validRef(head) ||
			!validRef(base) ||
			["main", "master", p.creation.defaultBranch].includes(head) ||
			!p.creation.headRefs.has(head) ||
			!p.creation.baseRefs.has(base)
		)
			throw new Error("github_create_scope_denied");
		return {
			kind: "pull-request-create",
			owner: p.owner,
			repo: p.repo,
			head,
			base,
		};
	}
	function assertWrite(
		target: GithubBusinessTarget | GithubCreateTarget,
		context: LeadOperationContext,
		expected: string,
	) {
		current(context, expected);
		if (!options.assertWriteTargetCurrent)
			throw new Error("github_write_guard_required");
		options.assertWriteTargetCurrent(target, context);
		current(context, expected);
	}
	async function issueTarget(
		number: number,
		context: LeadOperationContext,
		expected: string,
	) {
		await target("issue", number, context, expected);
		await guard(context, expected);
		const p = current(context, expected);
		const { data } = await client.rest.issues.get({
			owner: p.owner,
			repo: p.repo,
			issue_number: number,
			request: { signal: context.signal },
		});
		current(context, expected);
		if (
			data.number !== number ||
			data.repository_url.toLowerCase() !==
				`https://api.github.com/repos/${p.owner}/${p.repo}`.toLowerCase()
		)
			throw new Error("github_foreign_resource");
		checkUrl(data.html_url, `/${p.owner}/${p.repo}/issues/${number}`);
		return data;
	}
	async function authorizeWrite(
		operationId: string,
		input: Record<string, unknown>,
		context: LeadOperationContext,
		expected: string,
	): Promise<GithubBusinessTarget | GithubCreateTarget> {
		if (!options.assertWriteTargetCurrent)
			throw new Error("github_write_guard_required");
		if (operationId === "github.pr.create") {
			const created = createTarget(input, context, expected);
			if (!options.authorizeCreate)
				throw new Error("github_create_authorizer_required");
			await options.authorizeCreate(created, context);
			createTarget(input, context, expected);
			return created;
		}
		let headRef: string | undefined;
		const number = input.number as number,
			p = current(context, expected),
			kind = operationId === "github.issue.comment" ? "issue" : "pull-request";
		if (
			operationId === "github.pr.edit" &&
			input.title === undefined &&
			input.body === undefined &&
			input.labels === undefined
		)
			throw new Error("github_empty_edit");
		if (kind === "issue") await issueTarget(number, context, expected);
		else {
			const pr = await pull(number, context, expected);
			headRef = pr.head.ref;
			if (operationId === "github.pr.review" && input.commitId !== pr.head.sha)
				throw new Error("github_head_changed");
		}
		current(context, expected);
		return {
			kind,
			number,
			owner: p.owner,
			repo: p.repo,
			...(headRef ? { headRef } : {}),
		};
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
				const expected = fingerprint(current(context));
				if (definition.classification === "write") {
					const writeTarget = await authorizeWrite(
						operationId,
						input,
						context,
						expected,
					);
					await guard(context, expected);
					assertWrite(writeTarget, context, expected);
					return;
				}
				if (operationId === "github.pr.diff") diffCursor(input.cursor);
				if (operationId === "github.run.log") logCursor(input.cursor);
				if (
					operationId === "github.run.view" ||
					operationId === "github.run.log"
				)
					await target(
						"workflow-run",
						runNumber(input.runId),
						context,
						expected,
					);
				else if (operationId === "github.pr.list") pageCursor(input.cursor);
				else
					await target(
						operationId === "github.issue.view" ? "issue" : "pull-request",
						input.number as number,
						context,
						expected,
					);
				await guard(context, expected);
			},
			execute: async (raw, context) => {
				const input = definition.inputSchema.parse(raw),
					expected = fingerprint(current(context));
				await guard(context, expected);
				const result = await execute(input, context, expected);
				await guard(context, expected);
				if (result.status === "succeeded")
					definition.outputSchema.parse(result.data);
				return result;
			},
		});
	}
	async function workflowRun(
		input: Record<string, unknown>,
		context: LeadOperationContext,
		expected: string,
	) {
		const runId = runNumber(input.runId);
		await target("workflow-run", runId, context, expected);
		await guard(context, expected);
		const p = current(context, expected);
		const { data: run } = await client.rest.actions.getWorkflowRun({
			owner: p.owner,
			repo: p.repo,
			run_id: runId,
			request: { signal: context.signal },
		});
		await guard(context, expected);
		if (
			run.id !== runId ||
			run.repository.full_name.toLowerCase() !==
				`${p.owner}/${p.repo}`.toLowerCase() ||
			!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(run.head_sha)
		)
			throw new Error("github_foreign_resource");
		checkUrl(run.html_url, `/${p.owner}/${p.repo}/actions/runs/${runId}`);
		if (!Array.isArray(run.pull_requests) || run.pull_requests.length > 100)
			throw new Error("github_run_incomplete");
		for (const linked of run.pull_requests) {
			if (
				linked.base.repo.name.toLowerCase() !== p.repo.toLowerCase() ||
				linked.base.repo.url.toLowerCase() !==
					`https://api.github.com/repos/${p.owner}/${p.repo}`.toLowerCase()
			)
				throw new Error("github_foreign_resource");
			if (
				!Number.isSafeInteger(linked.number) ||
				linked.number <= 0 ||
				linked.head.sha !== run.head_sha
			)
				throw new Error("github_head_changed");
			const pr = await pull(linked.number, context, expected);
			if (pr.head.sha !== run.head_sha) throw new Error("github_head_changed");
		}
		return run;
	}
	add("github.run.view", async (input, context, expected) => {
		const run = await workflowRun(input, context, expected),
			runId = run.id;
		return {
			status: "succeeded",
			providerRef: `run:${runId}:${run.head_sha}`,
			data: {
				runId: String(run.id),
				status: run.status,
				conclusion: run.conclusion,
				url: run.html_url,
				...evidence(),
			},
		};
	});
	add("github.run.log", async (input, context, expected) => {
		const cursor = logCursor(input.cursor);
		const run = await workflowRun(input, context, expected);
		if (
			cursor &&
			(cursor.runId !== String(run.id) ||
				cursor.head !== run.head_sha ||
				cursor.attempt !== run.run_attempt)
		)
			throw new Error("github_head_changed");
		if (
			run.status !== "completed" ||
			!Number.isSafeInteger(run.run_attempt) ||
			!run.run_attempt ||
			run.run_attempt < 1
		)
			throw new Error("github_run_log_pending");
		await guard(context, expected);
		const p = current(context, expected);
		let text: string;
		try {
			const redirect = await client.rest.actions.downloadWorkflowRunLogs({
				owner: p.owner,
				repo: p.repo,
				run_id: run.id,
				request: {
					signal: context.signal,
					redirect: "manual",
					parseSuccessResponseBody: false,
				},
			});
			const body = redirect.data as unknown as {
				cancel?: () => Promise<void>;
			} | null;
			await body?.cancel?.();
			await guard(context, expected);
			if (
				redirect.status !== 302 ||
				typeof redirect.headers.location !== "string"
			)
				throw new Error("github_log_unavailable");
			const zip = await downloadGithubRunLogZip(
				redirect.headers.location,
				context.signal,
				options.logDownload,
			);
			await guard(context, expected);
			text = await parseGithubRunLogZip(zip, context.signal);
			await guard(context, expected);
		} catch {
			throw new Error("github_log_unavailable");
		}
		const latest = await workflowRun(input, context, expected);
		if (
			latest.head_sha !== run.head_sha ||
			latest.run_attempt !== run.run_attempt ||
			latest.status !== "completed"
		)
			throw new Error("github_head_changed");
		const digest = createHash("sha256").update(text).digest("hex");
		if (cursor && cursor.digest !== digest)
			throw new Error("github_log_changed");
		const offset = cursor?.offset ?? 0;
		if (offset > text.length) throw new Error("github_invalid_cursor");
		const page = encodedTextPage(text, offset);
		const truncated = page.truncated,
			nextCursor = truncated
				? `${run.id}:${run.head_sha}:${run.run_attempt}:${digest}:${page.end}`
				: null;
		return {
			status: "succeeded",
			providerRef: `run:${run.id}:${run.head_sha}:${run.run_attempt}`,
			data: {
				log: page.text,
				truncated,
				nextCursor,
				...evidence(),
			},
		};
	});
	add("github.pr.view", async (input, context, expected) => {
		const pr = await pull(input.number as number, context, expected);
		return {
			status: "succeeded",
			providerRef: `pr:${pr.number}`,
			data: {
				pullRequest: projectPr(pr, current(context, expected)),
				...evidence(),
			},
		};
	});

	add("github.pr.diff", async (input, context, expected) => {
		const cursor = diffCursor(input.cursor);
		const pr = await pull(input.number as number, context, expected);
		if (
			!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(pr.base.sha) ||
			(cursor && (cursor.head !== pr.head.sha || cursor.base !== pr.base.sha))
		)
			throw new Error("github_head_changed");
		await guard(context, expected);
		const p = current(context, expected);
		const response = await client.rest.pulls.get({
			owner: p.owner,
			repo: p.repo,
			pull_number: pr.number,
			mediaType: { format: "diff" },
			request: { signal: context.signal },
		});
		await guard(context, expected);
		const diff: unknown = response.data;
		if (typeof diff !== "string" || diff.length > 8388608)
			throw new Error("github_diff_incomplete");
		const offset = cursor?.offset ?? 0;
		if (offset > diff.length) throw new Error("github_invalid_cursor");
		const page = encodedTextPage(diff, offset);
		const truncated = page.truncated;
		const nextCursor = truncated
			? `${pr.head.sha}:${pr.base.sha}:${page.end}`
			: null;
		const latest = await pull(pr.number, context, expected);
		if (latest.head.sha !== pr.head.sha || latest.base.sha !== pr.base.sha)
			throw new Error("github_head_changed");
		return {
			status: "succeeded",
			providerRef: `pr:${pr.number}:${pr.head.sha}`,
			data: {
				diff: page.text,
				truncated,
				nextCursor,
				...evidence(),
			},
		};
	});
	add("github.pr.list", async (input, context, expected) => {
		const page = pageCursor(input.cursor),
			limit = (input.limit as number | undefined) ?? 30;
		await guard(context, expected);
		const p = current(context, expected);
		const response = await client.rest.pulls.list({
			request: { signal: context.signal },
			owner: p.owner,
			repo: p.repo,
			page,
			per_page: limit,
			state: (input.state as "open" | "closed" | "all" | undefined) ?? "open",
		});
		current(context, expected);
		if (response.data.length > limit)
			throw new Error("github_pagination_incomplete");
		const nextCursor = nextPage(response.headers.link, page, p);
		const pullRequests = [];
		for (const pr of response.data) {
			projectPr(pr, current(context, expected));
			await target("pull-request", pr.number, context, expected);
			pullRequests.push(projectPr(pr, current(context, expected)));
		}
		return {
			status: "succeeded",
			data: { pullRequests, nextCursor, ...evidence() },
		};
	});
	add("github.issue.view", async (input, context, expected) => {
		const number = input.number as number;
		await target("issue", number, context, expected);
		await guard(context, expected);
		const p = current(context, expected);
		const { data } = await client.rest.issues.get({
			request: { signal: context.signal },
			owner: p.owner,
			repo: p.repo,
			issue_number: number,
		});
		current(context, expected);
		if (
			data.number !== number ||
			data.repository_url.toLowerCase() !==
				`https://api.github.com/repos/${p.owner}/${p.repo}`.toLowerCase()
		)
			throw new Error("github_foreign_resource");
		checkUrl(data.html_url, `/${p.owner}/${p.repo}/issues/${number}`);
		return {
			status: "succeeded",
			providerRef: `issue:${number}`,
			data: {
				number,
				title: data.title,
				body: data.body ?? "",
				url: data.html_url,
				...evidence(),
			},
		};
	});
	add("github.pr.checks", async (input, context, expected) => {
		const pr = await pull(input.number as number, context, expected);
		await guard(context, expected);
		let p = current(context, expected);
		const runs = await client.rest.checks.listForRef({
			request: { signal: context.signal },
			owner: p.owner,
			repo: p.repo,
			ref: pr.head.sha,
			per_page: 100,
			page: 1,
		});
		current(context, expected);
		if (
			runs.data.total_count > 100 ||
			runs.data.total_count !== runs.data.check_runs.length ||
			runs.headers.link?.includes('rel="next"')
		)
			throw new Error("github_checks_incomplete");
		if (runs.data.check_runs.some((run) => run.head_sha !== pr.head.sha))
			throw new Error("github_checks_head_mismatch");
		await guard(context, expected);
		p = current(context, expected);
		const statuses = await client.rest.repos.getCombinedStatusForRef({
			request: { signal: context.signal },
			owner: p.owner,
			repo: p.repo,
			ref: pr.head.sha,
			per_page: 100,
			page: 1,
		});
		current(context, expected);
		if (
			statuses.data.total_count > 100 ||
			statuses.data.total_count !== statuses.data.statuses.length ||
			statuses.headers.link?.includes('rel="next"') ||
			runs.data.check_runs.length + statuses.data.statuses.length > 100
		)
			throw new Error("github_checks_incomplete");
		if (
			statuses.data.statuses.some(
				(status) =>
					!["pending", "success", "failure", "error"].includes(status.state),
			)
		)
			throw new Error("github_checks_incomplete");
		if (statuses.data.sha !== pr.head.sha)
			throw new Error("github_checks_head_mismatch");
		const latest = await pull(pr.number, context, expected);
		if (latest.head.sha !== pr.head.sha) throw new Error("github_head_changed");
		const checks = [
			...runs.data.check_runs.map((run) => ({
				name: `check:${run.name}`,
				status: run.status,
				conclusion: run.conclusion,
				url: run.html_url ?? pr.html_url,
			})),
			...statuses.data.statuses.map((status) => ({
				name: `status:${status.context}`,
				status: status.state === "pending" ? "pending" : "completed",
				conclusion: status.state === "pending" ? null : status.state,
				url: status.target_url ?? pr.html_url,
			})),
		];
		return {
			status: "succeeded",
			providerRef: `pr:${pr.number}:${pr.head.sha}`,
			data: { checks, ...evidence() },
		};
	});
	add("github.pr.create", async (input, context, expected) => {
		const binding = await authorizeWrite(
			"github.pr.create",
			input,
			context,
			expected,
		);
		await guard(context, expected);
		const p = current(context, expected);
		assertWrite(binding, context, expected);
		const { data } = await client.rest.pulls.create({
			owner: p.owner,
			repo: p.repo,
			head: input.head as string,
			base: input.base as string,
			title: input.title as string,
			body: input.body as string,
			draft: input.draft as boolean,
			request: { signal: context.signal },
		});
		current(context, expected);
		if (
			data.head.ref !== input.head ||
			data.base.ref !== input.base ||
			data.head.repo?.full_name.toLowerCase() !==
				`${p.owner}/${p.repo}`.toLowerCase() ||
			data.draft !== input.draft
		)
			throw new Error("github_create_evidence_mismatch");
		return {
			status: "succeeded",
			providerRef: `pr:${data.number}`,
			data: { pullRequest: projectPr(data, p), ...evidence() },
		};
	});
	add("github.pr.ready", async (input, context, expected) => {
		const binding = await authorizeWrite(
			"github.pr.ready",
			input,
			context,
			expected,
		);
		const pr = await pull(input.number as number, context, expected);
		if (pr.state !== "open" || !pr.node_id || pr.node_id.length > 256)
			throw new Error("github_ready_unavailable");
		if (pr.draft) {
			await guard(context, expected);
			assertWrite(binding, context, expected);
			const result = await client.graphql<{
				markPullRequestReadyForReview: {
					pullRequest: { id: string; number: number; isDraft: boolean };
				};
			}>(
				"mutation Ready($id:ID!,$requestId:String!){markPullRequestReadyForReview(input:{pullRequestId:$id,clientMutationId:$requestId}){pullRequest{id number isDraft}}}",
				{
					id: pr.node_id,
					requestId: context.requestId,
					request: { signal: context.signal },
				},
			);
			await guard(context, expected);
			assertWrite(binding, context, expected);
			const ready = result.markPullRequestReadyForReview.pullRequest;
			if (
				ready.id !== pr.node_id ||
				ready.number !== input.number ||
				ready.isDraft !== false
			)
				throw new Error("github_ready_evidence_mismatch");
		}
		return {
			status: "succeeded",
			providerRef: `pr:${pr.number}`,
			data: { number: pr.number, ready: true, ...evidence() },
		};
	});
	add("github.run.rerun", async (input, context, expected) => {
		const binding = await authorizeWrite(
			"github.run.rerun",
			input,
			context,
			expected,
		);
		const run = await workflowRun(input, context, expected);
		if (
			run.status !== "completed" ||
			!run.pull_requests?.some((pr) => pr.number === input.number)
		)
			throw new Error("github_rerun_unbound");
		await guard(context, expected);
		const p = current(context, expected);
		assertWrite(binding, context, expected);
		const response = await client.rest.actions.reRunWorkflow({
			owner: p.owner,
			repo: p.repo,
			run_id: run.id,
			request: { signal: context.signal },
		});
		await guard(context, expected);
		assertWrite(binding, context, expected);
		if (response.status !== 201)
			throw new Error("github_rerun_evidence_mismatch");
		return {
			status: "succeeded",
			providerRef: `run:${run.id}`,
			data: { runId: String(run.id), requested: true, ...evidence() },
		};
	});

	add("github.pr.edit", async (input, context, expected) => {
		const binding = await authorizeWrite(
			"github.pr.edit",
			input,
			context,
			expected,
		);
		await guard(context, expected);
		const p = current(context, expected);
		assertWrite(binding, context, expected);
		let data: PullData;
		if (input.labels !== undefined) {
			const updated = await client.rest.issues.update({
				owner: p.owner,
				repo: p.repo,
				issue_number: input.number as number,
				labels: input.labels as string[],
				...(input.title !== undefined ? { title: input.title as string } : {}),
				...(input.body !== undefined ? { body: input.body as string } : {}),
				request: { signal: context.signal },
			});

			const names = updated.data.labels.map((label) =>
				typeof label === "string" ? label : label.name,
			);
			if (names.length > 100 || names.some((name) => typeof name !== "string"))
				throw new Error("github_labels_evidence_mismatch");
			const normalize = (values: string[]) =>
				JSON.stringify(
					[...new Set(values.map((value) => value.toLowerCase()))].sort(),
				);
			if (normalize(names as string[]) !== normalize(input.labels as string[]))
				throw new Error("github_labels_evidence_mismatch");
			await guard(context, expected);
			assertWrite(binding, context, expected);
			data = await pull(input.number as number, context, expected);
		} else {
			const response = await client.rest.pulls.update({
				owner: p.owner,
				repo: p.repo,
				pull_number: input.number as number,
				...(input.title !== undefined ? { title: input.title as string } : {}),
				...(input.body !== undefined ? { body: input.body as string } : {}),
				request: { signal: context.signal },
			});
			data = response.data;
		}

		current(context, expected);
		return {
			status: "succeeded",
			providerRef: `pr:${data.number}`,
			data: {
				pullRequest: projectPr(data, p, input.number as number),
				...evidence(),
			},
		};
	});
	for (const operationId of ["github.pr.comment", "github.issue.comment"])
		add(operationId, async (input, context, expected) => {
			const binding = await authorizeWrite(
				operationId,
				input,
				context,
				expected,
			);
			await guard(context, expected);
			const p = current(context, expected);
			assertWrite(binding, context, expected);
			const { data } = await client.rest.issues.createComment({
				owner: p.owner,
				repo: p.repo,
				issue_number: input.number as number,
				body: input.body as string,
				request: { signal: context.signal },
			});
			current(context, expected);
			const path = new URL(data.html_url).pathname;
			const allowed = [
				`/${p.owner}/${p.repo}/issues/${input.number}`,
				`/${p.owner}/${p.repo}/pull/${input.number}`,
			];
			if (!allowed.some((value) => value.toLowerCase() === path.toLowerCase()))
				throw new Error("github_foreign_resource");
			checkUrl(data.html_url, path);
			if (!Number.isSafeInteger(data.id) || data.id <= 0)
				throw new Error("github_invalid_provider_id");
			return {
				status: "succeeded",
				providerRef: String(data.id),
				data: { commentId: String(data.id), url: data.html_url, ...evidence() },
			};
		});
	add("github.pr.review", async (input, context, expected) => {
		const binding = await authorizeWrite(
			"github.pr.review",
			input,
			context,
			expected,
		);
		const latest = await pull(input.number as number, context, expected);
		if (latest.head.sha !== input.commitId)
			throw new Error("github_head_changed");
		await guard(context, expected);
		const p = current(context, expected);
		assertWrite(binding, context, expected);
		const { data } = await client.rest.pulls.createReview({
			owner: p.owner,
			repo: p.repo,
			pull_number: input.number as number,
			body: input.body as string,
			commit_id: input.commitId as string,
			event: "COMMENT",
			request: { signal: context.signal },
		});
		current(context, expected);
		if (
			data.commit_id !== input.commitId ||
			data.state !== "COMMENTED" ||
			!Number.isSafeInteger(data.id) ||
			data.id <= 0
		)
			throw new Error("github_invalid_review_evidence");
		checkUrl(data.html_url, `/${p.owner}/${p.repo}/pull/${input.number}`);
		return {
			status: "succeeded",
			providerRef: String(data.id),
			data: { reviewId: String(data.id), url: data.html_url, ...evidence() },
		};
	});
	return handlers;
}
