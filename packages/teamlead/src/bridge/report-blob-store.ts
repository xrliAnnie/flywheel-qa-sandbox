import { del, list, put } from "@vercel/blob";
import { isReportExpired } from "./report-retention.js";

const REPORT_TOKEN_RE = /^[0-9a-f]{32}$/;
const REPORT_PATH_RE = /^r\/([0-9a-f]{32})\/index\.html$/;

export interface ReportBlobUpload {
	pathname: string;
	url: string;
}

export interface ReportBlobStore {
	putReport(token: string, html: string): Promise<ReportBlobUpload>;
	putMigratedReport(token: string, html: string): Promise<ReportBlobUpload>;
	deleteReports(tokens: readonly string[]): Promise<void>;
	sweepExpiredReports(
		now?: number,
		createdAtByToken?: Readonly<Record<string, string>>,
	): Promise<number>;
}

export interface ReportBlobClient {
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
		const pathname = `r/${token}/index.html`;
		const uploaded = await this.client.put(pathname, html, {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite,
			cacheControlMaxAge: 60,
			contentType: "text/html; charset=utf-8",
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
