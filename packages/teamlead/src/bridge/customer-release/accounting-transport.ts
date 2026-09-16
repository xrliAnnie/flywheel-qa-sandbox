import { createHash } from "node:crypto";
import type {
	ReleaseAccountingEvent,
	ReleaseAccountingTransport,
} from "./accounting.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function valid(v: unknown): asserts v {
	if (!v) throw new Error("release accounting transport unavailable");
}
function object(v: unknown): Record<string, unknown> {
	valid(v && typeof v === "object" && !Array.isArray(v));
	return v as Record<string, unknown>;
}
function positive(v: unknown): asserts v is number {
	valid(Number.isSafeInteger(v) && (v as number) > 0);
}
export function releaseAccountingBody(
	marker: string,
	event: ReleaseAccountingEvent,
	digest: string,
): string {
	const content = JSON.stringify(event);
	valid(
		marker === `release-event:${event.eventId}` &&
			/^[a-f0-9]{64}$/.test(digest) &&
			hash(content) === digest,
	);
	const escaped = content.replace(
		/[<>&`]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	const body = `Customer release audit\n${marker}\nsha256:${digest}\n\`\`\`json\n${escaped}\n\`\`\``;
	valid(Buffer.byteLength(body) <= 60000);
	return body;
}
export function readReleaseAccountingBody(body: string): {
	marker: string;
	digest: string;
} {
	valid(typeof body === "string" && Buffer.byteLength(body) <= 60000);
	const markers =
		body.match(/^release-event:[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/gm) ?? [];
	valid(markers.length === 1);
	const marker = markers[0]!;
	const lines = body.split("\n");
	if (
		lines.length !== 6 ||
		lines[0] !== "Customer release audit" ||
		lines[1] !== marker ||
		lines[3] !== "```json" ||
		lines[5] !== "```"
	)
		return { marker, digest: "" };
	try {
		const event = object(JSON.parse(lines[4]!));
		const digest = hash(JSON.stringify(event));
		return {
			marker,
			digest:
				lines[2] === `sha256:${digest}` &&
				marker === `release-event:${event.eventId}`
					? digest
					: "",
		};
	} catch {
		return { marker, digest: "" };
	}
}
export async function request(
	fetcher: typeof fetch,
	url: string,
	token: string,
	method = "GET",
	body?: unknown,
): Promise<{ value: unknown; headers: Headers }> {
	const response = await fetcher(url, {
		method,
		redirect: "error",
		signal: AbortSignal.timeout(15000),
		headers: {
			authorization: token,
			"content-type": "application/json",
			accept: "application/json",
			"x-github-api-version": "2026-03-10",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (!response.ok || response.redirected || !response.body) {
		await response.body?.cancel();
		throw new Error("release accounting request failed");
	}
	const reader = response.body.getReader(),
		chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > 2 * 1024 * 1024) {
				await reader.cancel();
				throw new Error("release accounting response too large");
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	return {
		value: JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
		),
		headers: response.headers,
	};
}
interface GitHubOptions {
	repository: string;
	repositoryId: number;
	issueNumber: number;
	writerId: number;
	token: string;
	fetch?: typeof fetch;
}
/** An issue-scoped projection transport. It has no release, workflow or PR
 * approval endpoint and performs no automatic mutation retry. */
export class GitHubReleaseAccounting implements ReleaseAccountingTransport {
	private readonly options: GitHubOptions;
	private readonly fetcher: typeof fetch;
	private readonly prefix: string;
	constructor(options: GitHubOptions) {
		valid(
			/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(
				options.repository,
			),
		);
		positive(options.repositoryId);
		positive(options.issueNumber);
		positive(options.writerId);
		valid(options.token && !/[\r\n]/.test(options.token));
		this.options = { ...options };
		this.fetcher = options.fetch ?? fetch;
		this.prefix = `https://api.github.com/repos/${options.repository}`;
	}
	private async get(path: string) {
		return object(
			(
				await request(
					this.fetcher,
					`${this.prefix}${path}`,
					`Bearer ${this.options.token}`,
				)
			).value,
		);
	}
	private async target() {
		const repo = await this.get("");
		valid(repo.id === this.options.repositoryId);
		const issue = await this.get(`/issues/${this.options.issueNumber}`);
		valid(
			issue.number === this.options.issueNumber &&
				!Object.hasOwn(issue, "pull_request"),
		);
	}
	private async writer() {
		const who = object(
			(
				await request(
					this.fetcher,
					"https://api.github.com/user",
					`Bearer ${this.options.token}`,
				)
			).value,
		);
		valid(who.id === this.options.writerId);
	}
	private async comment(id: string) {
		valid(/^[1-9][0-9]*$/.test(id));
		const c = await this.get(`/issues/comments/${id}`);
		valid(
			String(c.id) === id &&
				c.issue_url === `${this.prefix}/issues/${this.options.issueNumber}` &&
				object(c.user).id === this.options.writerId &&
				typeof c.body === "string",
		);
		return c.body as string;
	}
	async find(marker: string): Promise<{ id: string }[]> {
		await this.target();
		const found: { id: string }[] = [];
		for (let page = 1; page <= 10; page++) {
			const { value, headers } = await request(
				this.fetcher,
				`${this.prefix}/issues/${this.options.issueNumber}/comments?per_page=100&page=${page}`,
				`Bearer ${this.options.token}`,
			);
			valid(Array.isArray(value) && value.length <= 100);
			for (const item of value) {
				const c = object(item);
				valid(typeof c.body === "string");
				if (c.body.split("\n").includes(marker)) {
					positive(c.id);
					found.push({ id: String(c.id) });
				}
			}
			if (value.length < 100 && !/rel="next"/.test(headers.get("link") ?? ""))
				return found;
		}
		throw new Error("release accounting lookup incomplete");
	}
	async create(
		marker: string,
		event: ReleaseAccountingEvent,
		digest: string,
	): Promise<string> {
		const body = releaseAccountingBody(marker, event, digest);
		await this.target();
		await this.writer();
		const result = object(
			(
				await request(
					this.fetcher,
					`${this.prefix}/issues/${this.options.issueNumber}/comments`,
					`Bearer ${this.options.token}`,
					"POST",
					{ body },
				)
			).value,
		);
		positive(result.id);
		return String(result.id);
	}
	async read(id: string) {
		await this.target();
		return readReleaseAccountingBody(await this.comment(id));
	}
	async update(
		id: string,
		marker: string,
		event: ReleaseAccountingEvent,
		digest: string,
	): Promise<void> {
		const body = releaseAccountingBody(marker, event, digest);
		await this.target();
		await this.writer();
		valid(readReleaseAccountingBody(await this.comment(id)).marker === marker);
		await request(
			this.fetcher,
			`${this.prefix}/issues/comments/${id}`,
			`Bearer ${this.options.token}`,
			"PATCH",
			{ body },
		);
	}
}

interface LinearOptions {
	issueId: string;
	writerId: string;
	token: string;
	fetch?: typeof fetch;
}
const uuid = (v: unknown) =>
	typeof v === "string" &&
	/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export class LinearReleaseAccounting implements ReleaseAccountingTransport {
	private readonly options: LinearOptions;
	private readonly fetcher: typeof fetch;
	constructor(options: LinearOptions) {
		valid(
			uuid(options.issueId) &&
				uuid(options.writerId) &&
				options.token &&
				!/[\r\n]/.test(options.token),
		);
		this.options = { ...options };
		this.fetcher = options.fetch ?? fetch;
	}
	private async query(query: string, variables: Record<string, unknown> = {}) {
		const result = object(
			(
				await request(
					this.fetcher,
					"https://api.linear.app/graphql",
					this.options.token,
					"POST",
					{ query, variables },
				)
			).value,
		);
		valid(!Object.hasOwn(result, "errors"));
		return object(result.data);
	}
	private async target() {
		const data = await this.query(
			"query ReleaseAuditIssue($id:String!){issue(id:$id){id}}",
			{ id: this.options.issueId },
		);
		valid(object(data.issue).id === this.options.issueId);
	}
	private async writer() {
		const data = await this.query("query ReleaseAuditWriter{viewer{id}}");
		valid(object(data.viewer).id === this.options.writerId);
	}
	private async comment(id: string) {
		valid(uuid(id));
		const data = await this.query(
			"query ReleaseAuditComment($id:String!){comment(id:$id){id body issue{id} user{id}}}",
			{ id },
		);
		const c = object(data.comment);
		valid(
			c.id === id &&
				object(c.issue).id === this.options.issueId &&
				object(c.user).id === this.options.writerId &&
				typeof c.body === "string",
		);
		return c.body as string;
	}
	async find(marker: string): Promise<{ id: string }[]> {
		const found: { id: string }[] = [];
		let after: string | null = null;
		const cursors = new Set<string>();
		for (let page = 0; page < 10; page++) {
			const data = await this.query(
				"query ReleaseAuditComments($id:String!,$after:String){issue(id:$id){id comments(first:100,after:$after){nodes{id body} pageInfo{hasNextPage endCursor}}}}",
				{ id: this.options.issueId, after },
			);
			const issue = object(data.issue);
			valid(issue.id === this.options.issueId);
			const comments = object(issue.comments);
			valid(Array.isArray(comments.nodes) && comments.nodes.length <= 100);
			for (const item of comments.nodes) {
				const c = object(item);
				valid(uuid(c.id) && typeof c.body === "string");
				if (c.body.split("\n").includes(marker))
					found.push({ id: c.id as string });
			}
			const info = object(comments.pageInfo);
			valid(typeof info.hasNextPage === "boolean");
			if (!info.hasNextPage) return found;
			valid(
				typeof info.endCursor === "string" &&
					info.endCursor.length > 0 &&
					!cursors.has(info.endCursor),
			);
			after = info.endCursor;
			cursors.add(after);
		}
		throw new Error("release accounting lookup incomplete");
	}
	async create(
		marker: string,
		event: ReleaseAccountingEvent,
		digest: string,
	): Promise<string> {
		const body = releaseAccountingBody(marker, event, digest);
		await this.target();
		await this.writer();
		const data = await this.query(
			"mutation ReleaseAuditCreate($input:CommentCreateInput!){commentCreate(input:$input){success comment{id}}}",
			{ input: { issueId: this.options.issueId, body } },
		);
		const payload = object(data.commentCreate);
		valid(payload.success === true);
		const id = object(payload.comment).id;
		valid(uuid(id));
		return id as string;
	}
	async read(id: string) {
		return readReleaseAccountingBody(await this.comment(id));
	}
	async update(
		id: string,
		marker: string,
		event: ReleaseAccountingEvent,
		digest: string,
	): Promise<void> {
		const body = releaseAccountingBody(marker, event, digest);
		await this.writer();
		valid(readReleaseAccountingBody(await this.comment(id)).marker === marker);
		const data = await this.query(
			"mutation ReleaseAuditUpdate($id:String!,$input:CommentUpdateInput!){commentUpdate(id:$id,input:$input){success comment{id}}}",
			{ id, input: { body } },
		);
		const payload = object(data.commentUpdate);
		valid(payload.success === true && object(payload.comment).id === id);
	}
}
