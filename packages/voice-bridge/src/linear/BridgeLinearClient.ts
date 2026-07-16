/**
 * BridgeLinearClient (FLY-545 PR-2) — the voice-bridge's Linear face, via the
 * Bridge HTTP proxy (GEO-187 pattern: LINEAR_API_KEY lives ONLY in the
 * Bridge; agents carry a Bearer for the proxy, never the key).
 *
 * Route contracts (must stay byte-aligned with the Bridge handlers — the
 * comment + issue-lookup routes were first landed by FLY-967 per the FLY-545
 * plan P12 contract, first-to-land-builds):
 *   POST  /api/linear/create-issue  { title, description?, projectName? }
 *   POST  /api/linear/comment       { issueId, body, projectName? }
 *   PATCH /api/linear/update-issue  { issueId, status? }
 *   GET   /api/linear/issue?query=&projectName=&limit=
 *
 * Every non-2xx is a thrown BridgeLinearError carrying the server's error
 * text and status — callers (ConclusionPipeline / issue_status tool) decide
 * how to degrade, never this client. The Bearer never appears in errors.
 */

export interface BridgeLinearClientOptions {
	bridgeUrl: string;
	apiToken: string;
	/** Flywheel projectName — the Bridge resolves the Linear binding (FLY-371). */
	projectName: string;
	fetchFn?: typeof fetch;
}

export interface CreatedIssue {
	id?: string;
	identifier: string;
	url: string;
}

export interface IssueLookupResult {
	matchType: "identifier" | "keyword";
	/** identifier hit. */
	issue?: Record<string, unknown>;
	/** keyword hits. */
	issues?: Record<string, unknown>[];
	truncated?: boolean;
}

export class BridgeLinearError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "BridgeLinearError";
	}
}

export class BridgeLinearClient {
	private readonly base: string;

	constructor(private readonly opts: BridgeLinearClientOptions) {
		this.base = opts.bridgeUrl.replace(/\/+$/, "");
	}

	async createIssue(input: {
		title: string;
		description?: string;
	}): Promise<CreatedIssue> {
		const body = await this.request("POST", "/api/linear/create-issue", {
			title: input.title,
			...(input.description !== undefined
				? { description: input.description }
				: {}),
			projectName: this.opts.projectName,
		});
		const issue = (body as { issue?: CreatedIssue }).issue;
		if (!issue?.identifier || !issue.url) {
			throw new BridgeLinearError(
				"create-issue returned no issue identifier/url",
				502,
			);
		}
		return issue;
	}

	async comment(issueId: string, commentBody: string): Promise<void> {
		await this.request("POST", "/api/linear/comment", {
			issueId,
			body: commentBody,
			projectName: this.opts.projectName,
		});
	}

	/** flip the issue's workflow state by NAME (e.g. "Done"). */
	async setStatus(issueId: string, status: string): Promise<void> {
		await this.request("PATCH", "/api/linear/update-issue", {
			issueId,
			status,
		});
	}

	/** precise read-only lookup (identifier exact / keyword best-match). */
	async lookupIssue(query: string, limit = 5): Promise<IssueLookupResult> {
		const qs = new URLSearchParams({
			query,
			projectName: this.opts.projectName,
			limit: String(limit),
		});
		return (await this.request(
			"GET",
			`/api/linear/issue?${qs.toString()}`,
		)) as IssueLookupResult;
	}

	private async request(
		method: string,
		path: string,
		body?: Record<string, unknown>,
	): Promise<unknown> {
		const fetchFn = this.opts.fetchFn ?? fetch;
		let res: Response;
		try {
			res = await fetchFn(`${this.base}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${this.opts.apiToken}`,
					...(body ? { "content-type": "application/json" } : {}),
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			});
		} catch (err) {
			// network-level failure — token must never leak into the message.
			throw new BridgeLinearError(
				`bridge unreachable at ${this.base}: ${err instanceof Error ? err.message : String(err)}`,
				0,
			);
		}
		const text = await res.text();
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : {};
		} catch {
			parsed = { error: text.slice(0, 200) };
		}
		if (!res.ok) {
			const serverError = (parsed as { error?: string }).error;
			throw new BridgeLinearError(
				`${method} ${path} → ${res.status}${serverError ? `: ${serverError}` : ""}`,
				res.status,
			);
		}
		return parsed;
	}
}
