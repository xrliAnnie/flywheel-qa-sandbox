import { Buffer } from "node:buffer";
import {
	type ParsedReportDocument,
	parseReportDocument,
} from "../contracts/daily-report.js";

const REPORT_REPO = "xrliAnnie/raya";
const REPORT_BRANCH = "main";
const REPORT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export type ReportRepoWriterCategory =
	| "document_invalid"
	| "adopted_invalid"
	| "gh_get"
	| "gh_put"
	| "gh_shape"
	| "aborted";

export class ReportRepoWriterError extends Error {
	readonly name = "ReportRepoWriterError";

	constructor(
		readonly category: ReportRepoWriterCategory,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

export interface RunReportGhOptions {
	input?: string;
	signal?: AbortSignal;
}

export type RunReportGh = (
	args: readonly string[],
	options: RunReportGhOptions,
) => Promise<string>;

export interface ReportRepoWriterOptions {
	ghBin: string;
	run?: RunReportGh;
}

export interface ReportRepoWriteResult {
	adopted: boolean;
	fileSha: string;
	commitSha?: string;
	document: ParsedReportDocument;
}

interface HttpResult {
	status: number;
	body: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseHttp(output: string): HttpResult {
	const firstNewline = output.indexOf("\n");
	const firstLine = (
		firstNewline < 0 ? output : output.slice(0, firstNewline)
	).replace(/\r$/, "");
	const statusMatch = /^HTTP\/\d(?:\.\d)? (\d{3})(?: |$)/.exec(firstLine);
	if (!statusMatch) {
		throw new ReportRepoWriterError(
			"gh_shape",
			"gh --include returned no HTTP status line",
		);
	}
	const headerEndCrLf = output.indexOf("\r\n\r\n");
	const headerEndLf = output.indexOf("\n\n");
	const headerEnd = headerEndCrLf >= 0 ? headerEndCrLf : headerEndLf;
	const separatorLength = headerEndCrLf >= 0 ? 4 : 2;
	if (headerEnd < 0) {
		throw new ReportRepoWriterError(
			"gh_shape",
			"gh --include returned no header boundary",
		);
	}
	const bodyText = output.slice(headerEnd + separatorLength);
	let body: unknown;
	try {
		body = JSON.parse(bodyText);
	} catch (error) {
		throw new ReportRepoWriterError(
			"gh_shape",
			"gh --include returned invalid JSON",
			{ cause: error },
		);
	}
	return { status: Number(statusMatch[1]), body };
}

function gitSha(value: unknown, field: string): string {
	if (typeof value !== "string" || !GIT_SHA_PATTERN.test(value)) {
		throw new ReportRepoWriterError(
			"gh_shape",
			`gh response ${field} is invalid`,
		);
	}
	return value;
}

function decodeGitHubContent(value: unknown): string {
	if (typeof value !== "string") {
		throw new ReportRepoWriterError(
			"gh_shape",
			"gh response content is missing",
		);
	}
	const compact = value.replace(/\n/g, "");
	if (
		compact.length === 0 ||
		compact.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			compact,
		)
	) {
		throw new ReportRepoWriterError(
			"gh_shape",
			"gh response content is not base64",
		);
	}
	const bytes = Buffer.from(compact, "base64");
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new ReportRepoWriterError(
			"gh_shape",
			"gh response content is not UTF-8",
			{ cause: error },
		);
	}
}

export function reportRepoPath(date: string): string {
	if (!REPORT_DATE_PATTERN.test(date)) {
		throw new ReportRepoWriterError(
			"document_invalid",
			"report date is invalid",
		);
	}
	const path = `reports/${date}.md`;
	if (!/^reports\/\d{4}-\d{2}-\d{2}\.md$/.test(path)) {
		throw new ReportRepoWriterError(
			"document_invalid",
			"report path is invalid",
		);
	}
	return path;
}

export class ReportRepoWriter {
	private readonly run: RunReportGh;

	constructor(options: ReportRepoWriterOptions) {
		if (!options.ghBin.startsWith("/")) {
			throw new Error("daily report ghBin must be absolute");
		}
		if (!options.run)
			throw new Error("daily report host command adapter required");
		this.run = options.run;
	}

	async probe(
		date: string,
		signal?: AbortSignal,
	): Promise<ReportRepoWriteResult | null> {
		return this.get(reportRepoPath(date), date, signal);
	}

	async createOrAdopt(
		date: string,
		document: string,
		signal?: AbortSignal,
	): Promise<ReportRepoWriteResult> {
		const path = reportRepoPath(date);
		let local: ParsedReportDocument;
		try {
			local = parseReportDocument(document, { date });
		} catch (error) {
			throw new ReportRepoWriterError(
				"document_invalid",
				"local daily report document is invalid",
				{ cause: error },
			);
		}
		const existing = await this.get(path, date, signal);
		if (existing) return existing;

		const created = await this.put(path, date, document, local, signal);
		if (created) return created;
		const raced = await this.get(path, date, signal);
		if (!raced) {
			throw new ReportRepoWriterError(
				"gh_get",
				"report create raced but the remote document is still missing",
			);
		}
		return raced;
	}

	private async get(
		path: string,
		date: string,
		signal?: AbortSignal,
	): Promise<ReportRepoWriteResult | null> {
		const output = await this.runChecked(
			[
				"api",
				"--include",
				`repos/${REPORT_REPO}/contents/${path}?ref=${REPORT_BRANCH}`,
			],
			{ signal },
			"gh_get",
		);
		const result = parseHttp(output);
		if (result.status === 404) return null;
		if (result.status !== 200) {
			throw new ReportRepoWriterError(
				"gh_get",
				`report GET returned HTTP ${result.status}`,
			);
		}
		const body = record(result.body);
		if (!body || body.encoding !== "base64") {
			throw new ReportRepoWriterError("gh_shape", "report GET body is invalid");
		}
		const fileSha = gitSha(body.sha, "file sha");
		const remote = decodeGitHubContent(body.content);
		let parsed: ParsedReportDocument;
		try {
			parsed = parseReportDocument(remote, { date });
		} catch (error) {
			throw new ReportRepoWriterError(
				"adopted_invalid",
				"existing daily report document is invalid",
				{ cause: error },
			);
		}
		return { adopted: true, fileSha, document: parsed };
	}

	private async put(
		path: string,
		date: string,
		document: string,
		parsed: ParsedReportDocument,
		signal?: AbortSignal,
	): Promise<ReportRepoWriteResult | null> {
		const input = JSON.stringify({
			message: `report(raya): ${date}`,
			content: Buffer.from(document, "utf8").toString("base64"),
			branch: REPORT_BRANCH,
		});
		const output = await this.runChecked(
			[
				"api",
				"--include",
				"--method",
				"PUT",
				`repos/${REPORT_REPO}/contents/${path}`,
				"--input",
				"-",
			],
			{ input, signal },
			"gh_put",
		);
		const result = parseHttp(output);
		if (result.status === 422) return null;
		if (result.status !== 201) {
			throw new ReportRepoWriterError(
				"gh_put",
				`report PUT returned HTTP ${result.status}`,
			);
		}
		const body = record(result.body);
		const content = record(body?.content);
		const commit = record(body?.commit);
		return {
			adopted: false,
			fileSha: gitSha(content?.sha, "file sha"),
			commitSha: gitSha(commit?.sha, "commit sha"),
			document: parsed,
		};
	}

	private async runChecked(
		args: readonly string[],
		options: RunReportGhOptions,
		category: "gh_get" | "gh_put",
	): Promise<string> {
		try {
			const output = await this.run(args, options);
			options.signal?.throwIfAborted();
			return output;
		} catch (error) {
			if (options.signal?.aborted) {
				throw new ReportRepoWriterError("aborted", "report gh call aborted", {
					cause: error,
				});
			}
			throw new ReportRepoWriterError(category, "report gh call failed", {
				cause: error,
			});
		}
	}
}
