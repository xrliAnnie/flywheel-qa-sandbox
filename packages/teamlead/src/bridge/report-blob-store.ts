import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { del, get, head, list, put } from "@vercel/blob";
import {
	blobStoreIdFromToken,
	type CredentialSnapshot,
} from "./report-hosting-credentials.js";
import { isReportExpired } from "./report-retention.js";

export const REPORT_BLOB_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const REPORT_TOKEN_RE = /^[0-9a-f]{32}$/;
const REPORT_PATH_RE =
	/^r\/([0-9a-f]{32})\/(?:index\.html|[0-9a-f]{64}\/index\.audit\.json)$/;
const AUDIT_PATH_RE = /^r\/([0-9a-f]{32})\/([0-9a-f]{64})\/index\.audit\.json$/;
export class EpicAuditGatewayError extends Error {
	constructor() {
		super("epic_audit_gateway_unavailable");
	}
}
export interface EpicAuditUpload {
	verifyGateway: () => Promise<boolean>;
	json: string;
	sha256: string;
}

export interface ReportBlobUpload {
	/** Deferred Epic audit pruning; invoke only after registry commit succeeds. */
	afterCommit?: () => Promise<void>;
	pathname: string;
	url: string;
}

export interface ReportBlobWriteOptions {
	gzip?: boolean;
}

export class ReportBlobCredentialMissing extends Error {
	constructor() {
		super("report Blob credential missing");
		this.name = "ReportBlobCredentialMissing";
	}
}
export interface BoundReportBlobStore extends ReportBlobStore {
	readonly storeId: string;
}

export interface ReportBlobStore {
	resumeReport?(
		token: string,
		html: string,
		signal: AbortSignal,
		options?: ReportBlobWriteOptions,
	): Promise<void>;
	bind(snapshot: CredentialSnapshot): BoundReportBlobStore;
	putRawObject(pathname: string, body: Buffer): Promise<ReportBlobUpload>;
	headReportSize(token: string): Promise<number>;
	putReport(
		token: string,
		html: string,
		options?: ReportBlobWriteOptions,
	): Promise<ReportBlobUpload>;
	putEpicPage(
		token: string,
		html: string,
		audit?: EpicAuditUpload,
		options?: ReportBlobWriteOptions,
	): Promise<ReportBlobUpload>;
	putMigratedReport(
		token: string,
		html: string,
		options?: ReportBlobWriteOptions,
	): Promise<ReportBlobUpload>;
	deleteReports(tokens: readonly string[]): Promise<void>;
	sweepExpiredReports(
		now?: number,
		createdAtByToken?: Readonly<Record<string, string>>,
	): Promise<number>;
}

export interface ReportBlobClient {
	head?(
		pathname: string,
		options: { token: string },
	): Promise<{ size: number }>;
	get?(
		pathname: string,
		options: {
			access: "private";
			token: string;
			useCache: false;
			abortSignal?: AbortSignal;
		},
	): Promise<{
		statusCode: number;
		stream: ReadableStream<Uint8Array> | null;
	} | null>;
	put(
		pathname: string,
		body: string | Buffer,
		options: {
			access: "private";
			addRandomSuffix: false;
			allowOverwrite: boolean;
			cacheControlMaxAge: number;
			contentType: string;
			token: string;
			abortSignal?: AbortSignal;
		},
	): Promise<ReportBlobUpload>;
	list(options: {
		cursor?: string;
		limit: number;
		mode: "expanded";
		prefix: "r/";
		token: string;
	}): Promise<{
		blobs: Array<{ pathname: string; uploadedAt: Date }>;
		cursor?: string;
		hasMore: boolean;
	}>;
	del(pathname: string | string[], options: { token: string }): Promise<void>;
}

const defaultClient: ReportBlobClient = {
	head: (pathname, options) => head(pathname, options),
	get: (pathname, options) => get(pathname, options),
	put: (pathname, body, options) => put(pathname, body, options),
	list: (options) => list(options as Parameters<typeof list>[0]),
	del: (pathname, options) =>
		del(pathname, options as Parameters<typeof del>[1]),
};

export class VercelBlobReportStore implements ReportBlobStore {
	private readonly token: string;
	private readonly client: ReportBlobClient;
	private readonly warn: (message: string) => void;
	private warnedMissingCreatedAt = false;

	constructor(
		token: string | undefined = undefined,
		client: ReportBlobClient = defaultClient,
		warn: (message: string) => void = console.warn,
	) {
		if (token !== undefined && token.trim().length === 0) {
			throw new Error("BLOB_READ_WRITE_TOKEN must be non-empty");
		}
		this.token = token ?? "";
		this.client = client;
		this.warn = warn;
	}

	get storeId(): string {
		return blobStoreIdFromToken(this.token) ?? "";
	}
	bind(snapshot: CredentialSnapshot): BoundReportBlobStore {
		if (!snapshot.value) throw new ReportBlobCredentialMissing();
		if (
			snapshot.key !== "BLOB_READ_WRITE_TOKEN" ||
			!blobStoreIdFromToken(snapshot.value)
		)
			throw new Error("invalid report Blob credential");
		return new VercelBlobReportStore(snapshot.value, this.client, this.warn);
	}

	async putReport(
		token: string,
		html: string,
		options?: ReportBlobWriteOptions,
	): Promise<ReportBlobUpload> {
		return this.putReportObject(token, html, false, options);
	}

	/** Recover an ordinary upload without replacing an existing object or renewing its TTL. */
	async resumeReport(
		token: string,
		html: string,
		signal: AbortSignal,
		options: ReportBlobWriteOptions = {},
	): Promise<void> {
		signal.throwIfAborted();
		if (!REPORT_TOKEN_RE.test(token) || !this.client.get)
			throw new Error("report_resume_unavailable");
		const pathname = `r/${token}/index.html`;
		const current = await this.client.get(pathname, {
			access: "private",
			token: this.token,
			useCache: false,
			abortSignal: signal,
		});
		signal.throwIfAborted();
		if (!current || current.statusCode === 404) {
			await this.client.put(
				pathname,
				options.gzip ? gzipSync(html, { level: 9 }) : html,
				{
					access: "private",
					addRandomSuffix: false,
					allowOverwrite: false,
					cacheControlMaxAge: 60,
					contentType: "text/html; charset=utf-8",
					token: this.token,
					abortSignal: signal,
				},
			);
			signal.throwIfAborted();
			return;
		}
		if (current.statusCode !== 200 || !current.stream)
			throw new Error("report_resume_read_failed");
		const reader = current.stream.getReader(),
			expected = Buffer.from(html),
			chunks: Uint8Array[] = [];
		let bytes = 0;
		const cancel = () => {
			void reader.cancel().catch(() => {});
		};
		signal.addEventListener("abort", cancel, { once: true });
		try {
			for (;;) {
				signal.throwIfAborted();
				const chunk = await reader.read();
				signal.throwIfAborted();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > expected.length + 1024)
					throw new Error("report_resume_content_conflict");
				chunks.push(chunk.value);
			}
			const raw = Buffer.concat(chunks);
			const decoded =
				raw[0] === 0x1f && raw[1] === 0x8b
					? gunzipSync(raw, { maxOutputLength: expected.length + 1 })
					: raw;
			if (!decoded.equals(expected))
				throw new Error("report_resume_content_conflict");
		} finally {
			signal.removeEventListener("abort", cancel);
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}

	/** Idempotent overwrite for one stable hosted Epic page token. */
	async putEpicPage(
		token: string,
		html: string,
		audit?: EpicAuditUpload,
		options: ReportBlobWriteOptions = {},
	): Promise<ReportBlobUpload> {
		if (!audit) return this.putReportObject(token, html, true, options);
		if (
			!REPORT_TOKEN_RE.test(token) ||
			!/^[0-9a-f]{64}$/.test(audit.sha256) ||
			createHash("sha256").update(audit.json).digest("hex") !== audit.sha256 ||
			!html.includes(`href="${audit.sha256}/index.audit.json"`)
		)
			throw new Error("invalid epic audit binding");
		if (!this.client.get) throw new Error("epic audit remote read unavailable");
		const current = await this.client.get(`r/${token}/index.html`, {
			access: "private",
			token: this.token,
			useCache: false,
		});
		if (
			current &&
			((current.statusCode !== 200 && current.statusCode !== 404) ||
				(current.statusCode === 200 && !current.stream))
		)
			throw new Error("epic audit previous publication unavailable");
		let oldHtml = "";
		if (current?.statusCode === 200 && current.stream) {
			const bytes = Buffer.from(
				await new Response(current.stream).arrayBuffer(),
			);
			oldHtml = (
				bytes[0] === 0x1f && bytes[1] === 0x8b
					? gunzipSync(bytes, { maxOutputLength: 1_048_576 })
					: bytes
			).toString("utf8");
		}
		const oldHash = /href="([0-9a-f]{64})\/index\.audit\.json"/.exec(
			oldHtml,
		)?.[1];
		const previous =
			oldHash === audit.sha256
				? /data-previous-audit="([0-9a-f]{64})"/.exec(oldHtml)?.[1]
				: oldHash;
		await this.putObject(
			`r/${token}/${audit.sha256}/index.audit.json`,
			audit.json,
			true,
			"application/json; charset=utf-8",
		);
		try {
			if (!(await audit.verifyGateway())) throw new EpicAuditGatewayError();
		} catch {
			throw new EpicAuditGatewayError();
		}
		const boundHtml = previous
			? html.replace("<footer", `<footer data-previous-audit="${previous}"`)
			: html;
		const result = await this.putReportObject(token, boundHtml, true, options);
		return {
			...result,
			afterCommit: async () => {
				// Keep the stable HTML and both audit versions untouched until the caller commits.
				try {
					const stale = (await this.auditPaths(token)).filter((path) => {
						const hash = AUDIT_PATH_RE.exec(path)![2];
						return hash !== audit.sha256 && hash !== previous;
					});
					if (stale.length) await this.client.del(stale, { token: this.token });
				} catch {
					this.warn("[reports] epic audit cleanup failed");
				}
			},
		};
	}

	private async auditPaths(token: string): Promise<string[]> {
		const paths: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.client.list({
				cursor,
				limit: 1000,
				mode: "expanded",
				prefix: "r/",
				token: this.token,
			});
			for (const blob of page.blobs)
				if (AUDIT_PATH_RE.exec(blob.pathname)?.[1] === token)
					paths.push(blob.pathname);
			cursor = page.hasMore ? page.cursor : undefined;
			if (page.hasMore && !cursor)
				throw new Error("Vercel Blob list returned hasMore without a cursor");
		} while (cursor);
		return paths;
	}

	/** Idempotent upload used only by the one-time legacy migration. */
	async putMigratedReport(
		token: string,
		html: string,
		options: ReportBlobWriteOptions = {},
	): Promise<ReportBlobUpload> {
		return this.putReportObject(token, html, true, options);
	}

	async putRawObject(
		pathname: string,
		body: Buffer,
	): Promise<ReportBlobUpload> {
		if (!/^r\/[0-9a-f]{32}\/index\.html$/.test(pathname))
			throw new Error("invalid report probe path");
		return this.putObject(pathname, body, true, "text/html; charset=utf-8");
	}

	async headReportSize(token: string): Promise<number> {
		if (!REPORT_TOKEN_RE.test(token))
			throw new Error("report token must be 32 lowercase hex characters");
		if (!this.client.head) throw new Error("report size lookup unavailable");
		const result = await this.client.head(`r/${token}/index.html`, {
			token: this.token,
		});
		if (!Number.isSafeInteger(result.size) || result.size < 0)
			throw new Error("invalid report object size");
		return result.size;
	}

	async deleteReports(tokens: readonly string[]): Promise<void> {
		const pathnames = tokens.map((token) => {
			if (!REPORT_TOKEN_RE.test(token)) {
				throw new Error("report token must be 32 lowercase hex characters");
			}
			return `r/${token}/index.html`;
		});
		if (pathnames.length > 0) {
			// Audit objects expire by their uploadedAt in the daily sweep (up to 14 days later).
			await this.client.del(pathnames, { token: this.token });
		}
	}

	async sweepExpiredReports(
		now: number = Date.now(),
		createdAtByToken: Readonly<Record<string, string>> = {},
	): Promise<number> {
		let cursor: string | undefined;
		const expired: string[] = [];
		do {
			const page = await this.client.list({
				cursor,
				limit: 1000,
				mode: "expanded",
				prefix: "r/",
				token: this.token,
			});
			for (const blob of page.blobs) {
				const pathMatch = REPORT_PATH_RE.exec(blob.pathname);
				if (!pathMatch) continue;
				const originalCreatedAt = createdAtByToken[pathMatch[1] ?? ""];
				const registryCreatedAt =
					originalCreatedAt === undefined
						? Number.NaN
						: Date.parse(originalCreatedAt);
				const uploadedAt = new Date(blob.uploadedAt).getTime();
				const createdAt = Number.isFinite(registryCreatedAt)
					? registryCreatedAt
					: uploadedAt;
				if (!Number.isFinite(createdAt)) {
					if (!this.warnedMissingCreatedAt) {
						this.warn(
							"[reports] retaining Blob objects with no authoritative createdAt",
						);
						this.warnedMissingCreatedAt = true;
					}
					continue;
				}
				if (isReportExpired(now, createdAt)) {
					expired.push(blob.pathname);
				}
			}
			cursor = page.hasMore ? page.cursor : undefined;
			if (page.hasMore && !cursor) {
				throw new Error("Vercel Blob list returned hasMore without a cursor");
			}
		} while (cursor);
		if (expired.length > 0) {
			await this.client.del(expired, { token: this.token });
		}
		return expired.length;
	}

	private async putReportObject(
		token: string,
		html: string,
		allowOverwrite: boolean,
		options: ReportBlobWriteOptions = {},
	): Promise<ReportBlobUpload> {
		if (!REPORT_TOKEN_RE.test(token)) {
			throw new Error("report token must be 32 lowercase hex characters");
		}
		return this.putObject(
			`r/${token}/index.html`,
			options.gzip ? gzipSync(html, { level: 9 }) : html,
			allowOverwrite,
			"text/html; charset=utf-8",
		);
	}
	private async putObject(
		pathname: string,
		body: string | Buffer,
		allowOverwrite: boolean,
		contentType: string,
	): Promise<ReportBlobUpload> {
		const uploaded = await this.client.put(pathname, body, {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite,
			cacheControlMaxAge: 60,
			contentType,
			token: this.token,
		});
		let uploadedUrl: URL;
		try {
			uploadedUrl = new URL(uploaded.url);
		} catch {
			throw new Error("report upload did not return a private Vercel Blob URL");
		}
		if (
			uploaded.pathname !== pathname ||
			uploadedUrl.protocol !== "https:" ||
			(this.storeId !== "" &&
				uploadedUrl.hostname.split(".")[0] !== this.storeId) ||
			!uploadedUrl.hostname.endsWith(".private.blob.vercel-storage.com") ||
			uploadedUrl.pathname !== `/${pathname}`
		) {
			throw new Error(
				"report upload did not return the expected private Vercel Blob",
			);
		}
		return uploaded;
	}
}
