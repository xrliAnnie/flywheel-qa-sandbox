import { createHash } from "node:crypto";
import { del, get, list, put } from "@vercel/blob";
import { isReportExpired } from "./report-retention.js";

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
	pathname: string;
	url: string;
}

export interface ReportBlobStore {
	putReport(token: string, html: string): Promise<ReportBlobUpload>;
	putEpicPage(
		token: string,
		html: string,
		audit?: EpicAuditUpload,
	): Promise<ReportBlobUpload>;
	putMigratedReport(token: string, html: string): Promise<ReportBlobUpload>;
	deleteReports(tokens: readonly string[]): Promise<void>;
	sweepExpiredReports(
		now?: number,
		createdAtByToken?: Readonly<Record<string, string>>,
	): Promise<number>;
}

export interface ReportBlobClient {
	get?(
		pathname: string,
		options: { access: "private"; token: string; useCache: false },
	): Promise<{
		statusCode: number;
		stream: ReadableStream<Uint8Array> | null;
	} | null>;
	put(
		pathname: string,
		body: string,
		options: {
			access: "private";
			addRandomSuffix: false;
			allowOverwrite: boolean;
			cacheControlMaxAge: number;
			contentType: string;
			token: string;
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
		token: string,
		client: ReportBlobClient = defaultClient,
		warn: (message: string) => void = console.warn,
	) {
		if (token.trim().length === 0) {
			throw new Error("BLOB_READ_WRITE_TOKEN must be non-empty");
		}
		this.token = token;
		this.client = client;
		this.warn = warn;
	}

	async putReport(token: string, html: string): Promise<ReportBlobUpload> {
		return this.putReportObject(token, html, false);
	}

	/** Idempotent overwrite for one stable hosted Epic page token. */
	async putEpicPage(
		token: string,
		html: string,
		audit?: EpicAuditUpload,
	): Promise<ReportBlobUpload> {
		if (!audit) return this.putReportObject(token, html, true);
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
		const oldHtml =
			current?.statusCode === 200 && current.stream
				? await new Response(current.stream).text()
				: "";
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
		const result = await this.putReportObject(token, boundHtml, true);
		// Upload failures preserve the old HTML and all audit versions. Prune only
		// after the new HTML is visible; retries read the remote publication again.
		try {
			const stale = (await this.auditPaths(token)).filter((path) => {
				const hash = AUDIT_PATH_RE.exec(path)![2];
				return hash !== audit.sha256 && hash !== previous;
			});
			if (stale.length) await this.client.del(stale, { token: this.token });
		} catch (error) {
			this.warn(`[reports] epic audit cleanup failed: ${String(error)}`);
		}
		return result;
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
	): Promise<ReportBlobUpload> {
		return this.putReportObject(token, html, true);
	}

	async deleteReports(tokens: readonly string[]): Promise<void> {
		const pathnames = tokens.map((token) => {
			if (!REPORT_TOKEN_RE.test(token)) {
				throw new Error("report token must be 32 lowercase hex characters");
			}
			return `r/${token}/index.html`;
		});
		if (pathnames.length > 0) {
			for (const token of tokens)
				pathnames.push(...(await this.auditPaths(token)));
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
	): Promise<ReportBlobUpload> {
		if (!REPORT_TOKEN_RE.test(token)) {
			throw new Error("report token must be 32 lowercase hex characters");
		}
		return this.putObject(
			`r/${token}/index.html`,
			html,
			allowOverwrite,
			"text/html; charset=utf-8",
		);
	}
	private async putObject(
		pathname: string,
		body: string,
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
