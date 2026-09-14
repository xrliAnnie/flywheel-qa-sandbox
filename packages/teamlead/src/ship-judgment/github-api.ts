import { z } from "zod";
import { repositorySlugSchema as slugSchema } from "./contract.js";
import {
	type ProjectFetchApi,
	ProjectFetchFailure,
} from "./project-refresh.js";

const PAGE_SIZE = 20;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const prSchema = z.object({
	number: z.number().int().positive(),
	head: z.object({ sha }),
	base: z.object({ ref: z.string().min(1), sha }),
	state: z.enum(["open", "closed"]),
	draft: z.boolean(),
});
const fileSchema = z.object({
	filename: z.string().min(1),
	previous_filename: z.string().min(1).optional(),
});
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Each public method performs exactly one HTTP request; the shared coordinator reserves that call first. */
export class GithubProjectApi implements ProjectFetchApi {
	private readonly repositories: Set<string>;
	constructor(
		repositories: string[],
		private readonly token: (signal: AbortSignal) => string | Promise<string>,
		private readonly fetcher: Fetcher = fetch,
		private readonly now: () => number = Date.now,
	) {
		this.repositories = new Set(
			z.array(slugSchema).min(1).max(200).parse(repositories),
		);
	}

	async main(repo: string, signal: AbortSignal): Promise<string> {
		const { body } = await this.get(repo, "/git/ref/heads/main", signal);
		return z.object({ object: z.object({ sha }) }).parse(body).object.sha;
	}

	async pr(repo: string, pr: number, signal: AbortSignal) {
		z.number().int().positive().safe().parse(pr);
		const { body } = await this.get(repo, `/pulls/${pr}`, signal);
		const value = prSchema
			.extend({ changed_files: z.number().int().nonnegative() })
			.parse(body);
		return {
			head_sha: value.head.sha,
			base_ref: value.base.ref,
			base_sha: value.base.sha,
			draft: value.draft,
			state: value.state,
			changed_files: value.changed_files,
		};
	}

	async prs(repo: string, page: number, signal: AbortSignal) {
		z.number().int().positive().safe().parse(page);
		const { body, link, url } = await this.get(
			repo,
			`/pulls?state=open&per_page=${PAGE_SIZE}&page=${page}`,
			signal,
		);
		const items = z
			.array(prSchema)
			.max(PAGE_SIZE)
			.parse(body)
			.map((pr) => ({
				pr_number: pr.number,
				head_sha: pr.head.sha,
				base_ref: pr.base.ref,
				base_sha: pr.base.sha,
				draft: pr.draft,
				state: pr.state,
			}));
		return { items, nextPage: this.nextPage(link, url, page, items.length) };
	}

	async files(repo: string, pr: number, page: number, signal: AbortSignal) {
		z.number().int().positive().safe().parse(pr);
		z.number().int().positive().safe().parse(page);
		const { body, link, url } = await this.get(
			repo,
			`/pulls/${pr}/files?per_page=${PAGE_SIZE}&page=${page}`,
			signal,
		);
		const items = z
			.array(fileSchema)
			.max(PAGE_SIZE)
			.parse(body)
			.map((file) => ({
				path: file.filename,
				...(file.previous_filename
					? { previous_path: file.previous_filename }
					: {}),
			}));
		return { items, nextPage: this.nextPage(link, url, page, items.length) };
	}

	private nextPage(
		link: string | null,
		requestUrl: string,
		page: number,
		count: number,
	): number | null {
		const links = [
			...(link ?? "").matchAll(/<([^>]+)>;\s*rel="([^"]+)"/g),
		].filter((match) => match[2] === "next");
		if (links.length > 1) throw new ProjectFetchFailure("invalid_pagination");
		if (!links.length) {
			if (link?.includes("next"))
				throw new ProjectFetchFailure("invalid_pagination");
			return count === PAGE_SIZE && !link ? page + 1 : null;
		}
		const next = new URL(links[0]![1]!);
		const current = new URL(requestUrl);
		// GitHub emits numeric repository URLs in Link headers. Only consume the
		// page number: subsequent requests still use our allowlisted repo slug.
		const repositoryPath = next.pathname.match(
			/^\/repositories\/[1-9]\d*(\/.*)$/,
		)?.[1];
		const currentResource = current.pathname.replace(
			/^\/repos\/[^/]+\/[^/]+/,
			"",
		);
		if (
			next.origin !== current.origin ||
			(next.pathname !== current.pathname &&
				repositoryPath !== currentResource) ||
			next.username ||
			next.password ||
			next.hash ||
			next.searchParams.get("page") !== String(page + 1) ||
			next.searchParams.get("per_page") !== String(PAGE_SIZE)
		)
			throw new ProjectFetchFailure("invalid_pagination");
		return page + 1;
	}

	private async get(
		repo: string,
		path: string,
		signal: AbortSignal,
	): Promise<{ body: unknown; link: string | null; url: string }> {
		slugSchema.parse(repo);
		if (!this.repositories.has(repo))
			throw new ProjectFetchFailure("repository_not_allowed");
		signal.throwIfAborted();
		const token = await this.token(signal);
		if (!token || /[\r\n]/.test(token))
			throw new ProjectFetchFailure("github_auth_unavailable");
		const url = `https://api.github.com/repos/${repo}${path}`;
		signal.throwIfAborted();
		const response = await this.fetcher(url, {
			method: "GET",
			redirect: "error",
			signal,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (!response.ok) {
			await response.body?.cancel();
			if (
				response.status === 429 ||
				(response.status === 403 &&
					response.headers.get("x-ratelimit-remaining") === "0")
			) {
				const retry = response.headers.get("retry-after");
				const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
				const until = retry
					? /^\d+(\.\d+)?$/.test(retry)
						? this.now() + Number(retry) * 1000
						: Date.parse(retry)
					: reset;
				throw new ProjectFetchFailure(
					"github_rate_limit",
					Number.isFinite(until) && until > this.now()
						? until
						: this.now() + 60_000,
				);
			}
			throw new ProjectFetchFailure(`github_http_${response.status}`);
		}
		const reader = response.body?.getReader();
		if (!reader) throw new ProjectFetchFailure("github_empty_body");
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.byteLength;
				if (size > MAX_RESPONSE_BYTES) {
					await reader.cancel();
					throw new ProjectFetchFailure("github_body_budget");
				}
				chunks.push(part.value);
			}
		} finally {
			reader.releaseLock();
		}
		let body: unknown;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			throw new ProjectFetchFailure("github_invalid_json");
		}
		return { body, link: response.headers.get("link"), url };
	}
}
