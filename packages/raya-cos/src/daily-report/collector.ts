import { Buffer } from "node:buffer";
import {
	compareReportSources,
	type ReportSilent,
	type ReportSource,
} from "../contracts/daily-report.js";
import type { ReportGenerationSource } from "./generator.js";

const REPORT_REPO = "xrliAnnie/raya";
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SUMMARY_PATH_PATTERN =
	/^summaries\/([^/]+)\/(\d{4}-\d{2}-\d{2})--(?:([^/]+)--)?(\d{2})\.md$/;
const ALLOWED_FILE_STATUSES = new Set(["added", "modified"]);

export type CollectorCategory =
	| "gh_ref"
	| "gh_pulls"
	| "gh_detail"
	| "gh_files"
	| "gh_tree"
	| "gh_tree_truncated"
	| "gh_contents"
	| "gh_shape"
	| "aborted";

export class CollectorError extends Error {
	readonly name = "CollectorError";

	constructor(
		readonly category: CollectorCategory,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

export interface RunSummaryGhOptions {
	signal?: AbortSignal;
}

export type RunSummaryGh = (
	args: readonly string[],
	options: RunSummaryGhOptions,
) => Promise<string>;

export type SummarySkipReason =
	| "too_many_files"
	| "ineligible_files"
	| "head_moved";

export interface SummaryCollectorOptions {
	ghBin: string;
	maxSummaryBytes: number;
	maxTotalBytes: number;
	timeZone?: string;
	run?: RunSummaryGh;
	onSkipped?(pr: number, reason: SummarySkipReason): void;
}

export interface SummaryCollection {
	mainCommit: string;
	sources: ReportGenerationSource[];
	silent: ReportSilent[];
}

interface PathParts {
	path: string;
	project: string;
	date: string;
	lead: string | null;
}

interface Candidate extends PathParts {
	state: "open" | "merged";
	pr?: number;
	head: string;
}

interface PullDetail {
	number: number;
	head: string;
	changedFiles: number;
}

interface DecodedSummary {
	blob: string;
	content: string;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseJson(output: string, context: string): unknown {
	try {
		return JSON.parse(output);
	} catch (error) {
		throw new CollectorError("gh_shape", `${context} returned invalid JSON`, {
			cause: error,
		});
	}
}

function gitSha(value: unknown, context: string): string {
	if (typeof value !== "string" || !GIT_SHA_PATTERN.test(value)) {
		throw new CollectorError("gh_shape", `${context} is not a git sha`);
	}
	return value;
}

function integer(value: unknown, context: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || Number(value) < minimum) {
		throw new CollectorError(
			"gh_shape",
			`${context} is not a safe integer >= ${minimum}`,
		);
	}
	return Number(value);
}

function parseSummaryPath(path: unknown): PathParts | null {
	if (typeof path !== "string") return null;
	const match = SUMMARY_PATH_PATTERN.exec(path);
	if (!match) return null;
	return {
		path,
		project: match[1],
		date: match[2],
		lead: match[3] ?? null,
	};
}

function flattenPages(value: unknown, context: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new CollectorError("gh_shape", `${context} is not a page array`);
	}
	const flattened: unknown[] = [];
	for (const page of value) {
		if (!Array.isArray(page)) {
			throw new CollectorError(
				"gh_shape",
				`${context} contains a non-array page`,
			);
		}
		flattened.push(...page);
	}
	return flattened;
}

function isCalendarDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	return (
		parsed.getUTCFullYear() === year &&
		parsed.getUTCMonth() === month - 1 &&
		parsed.getUTCDate() === day
	);
}

function localDate(iso: string, timeZone: string): string | null {
	if (DATE_PATTERN.test(iso)) {
		return isCalendarDate(iso) ? iso : null;
	}
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
			iso,
		)
	) {
		return null;
	}
	const timestamp = Date.parse(iso);
	if (Number.isNaN(timestamp)) return null;
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(timestamp);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((candidate) => candidate.type === type)?.value;
	return `${part("year")}-${part("month")}-${part("day")}`;
}

function parseFrontmatter(document: string): Record<string, string> | null {
	if (!document.startsWith("---\n")) return null;
	const end = document.indexOf("\n---\n", 4);
	if (end < 0) return null;
	const result: Record<string, string> = {};
	for (const line of document.slice(4, end).split("\n")) {
		const match = /^([a-z][a-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
		if (!match || Object.hasOwn(result, match[1])) return null;
		result[match[1]] = match[2];
	}
	return result;
}

function summaryContract(
	document: string,
	path: PathParts,
	timeZone: string,
): { contract: ReportSource["contract"]; lead: string } {
	const frontmatter = parseFrontmatter(document);
	if (!frontmatter) {
		return {
			contract: "invalid:frontmatter_missing",
			lead: path.lead ?? "unknown",
		};
	}
	const lead = frontmatter.lead || path.lead || "unknown";
	if (frontmatter.project !== path.project) {
		return { contract: "invalid:project_mismatch", lead };
	}
	if (!frontmatter.lead || (path.lead && frontmatter.lead !== path.lead)) {
		return { contract: "invalid:lead_mismatch", lead };
	}
	const period = frontmatter.period?.split("/");
	if (
		period?.length !== 2 ||
		!localDate(period[0], timeZone) ||
		!localDate(period[1], timeZone)
	) {
		return { contract: "invalid:period_unparseable", lead };
	}
	if (localDate(period[1], timeZone) !== path.date) {
		return { contract: "invalid:period_mismatch", lead };
	}
	if (!/^## Facts\s*$/m.test(document)) {
		return { contract: "invalid:facts_missing", lead };
	}
	if (!/^## Judgment\s*$/m.test(document)) {
		return { contract: "invalid:judgment_missing", lead };
	}
	return { contract: "ok", lead };
}

function truncateUtf8(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
		try {
			return decoder.decode(bytes.subarray(0, end));
		} catch {
			// A UTF-8 scalar is at most four bytes, so one of these boundaries is valid.
		}
	}
	return "";
}

function sourceSort(
	left: ReportGenerationSource,
	right: ReportGenerationSource,
): number {
	return compareReportSources(left, right);
}

function sourceLocation(source: ReportGenerationSource): string {
	return `${source.state}#${source.pr ?? "main"}@${source.head}`;
}

export class SummaryCollector {
	private readonly run: RunSummaryGh;
	private readonly timeZone: string;

	constructor(private readonly options: SummaryCollectorOptions) {
		if (!options.ghBin.startsWith("/")) {
			throw new Error("daily report ghBin must be absolute");
		}
		if (!options.run)
			throw new Error("daily report host command adapter required");
		this.run = options.run;
		this.timeZone = options.timeZone ?? "America/Los_Angeles";
	}

	async collect(
		date: string,
		signal?: AbortSignal,
	): Promise<SummaryCollection> {
		if (!DATE_PATTERN.test(date)) {
			throw new CollectorError("gh_shape", "daily report date is invalid");
		}
		const mainCommit = await this.readMainRef(signal);
		const knownPaths = new Map<string, PathParts>();
		const candidates: Candidate[] = [];
		const pulls = await this.readOpenPulls(signal);
		for (const pull of pulls) {
			const listed = record(pull);
			if (
				!listed ||
				typeof listed.draft !== "boolean" ||
				!record(listed.base) ||
				typeof record(listed.base)?.ref !== "string"
			) {
				throw new CollectorError("gh_shape", "open PR list item is invalid");
			}
			const pr = integer(listed.number, "open PR number", 1);
			if (listed.draft || record(listed.base)?.ref !== "main") continue;
			const eligible = await this.readEligiblePull(pr, signal);
			if (!eligible) continue;
			for (const path of eligible.paths) {
				knownPaths.set(path.path, path);
				if (path.date === date) {
					candidates.push({
						...path,
						state: "open",
						pr,
						head: eligible.head,
					});
				}
			}
		}

		const tree = await this.readTree(mainCommit, signal);
		for (const item of tree) {
			const entry = record(item);
			if (
				!entry ||
				typeof entry.path !== "string" ||
				typeof entry.type !== "string"
			) {
				throw new CollectorError("gh_shape", "main tree item is invalid");
			}
			if (entry.type !== "blob") continue;
			const path = parseSummaryPath(entry.path);
			if (!path) continue;
			gitSha(entry.sha, `tree blob ${entry.path}`);
			knownPaths.set(path.path, path);
			if (path.date === date) {
				candidates.push({ ...path, state: "merged", head: mainCommit });
			}
		}

		const collected: ReportGenerationSource[] = [];
		for (const candidate of candidates) {
			const decoded = await this.readContents(candidate, signal);
			const checked = summaryContract(
				decoded.content,
				candidate,
				this.timeZone,
			);
			const bytes = Buffer.byteLength(decoded.content, "utf8");
			const truncated = bytes > this.options.maxSummaryBytes;
			collected.push({
				state: candidate.state,
				...(candidate.pr === undefined ? {} : { pr: candidate.pr }),
				head: candidate.head,
				blob: decoded.blob,
				path: candidate.path,
				project: candidate.project,
				lead: checked.lead,
				contract: checked.contract,
				bytes,
				truncated,
				omitted: false,
				divergent: false,
				also_in: [],
				content: truncated
					? truncateUtf8(decoded.content, this.options.maxSummaryBytes)
					: decoded.content,
			});
		}

		const sources = this.deduplicateAndBudget(collected);
		const latestByProject = new Map<string, string>();
		for (const path of knownPaths.values()) {
			const previous = latestByProject.get(path.project);
			if (!previous || previous < path.date) {
				latestByProject.set(path.project, path.date);
			}
		}
		const silent = [...latestByProject]
			.filter(([, last]) => last < date)
			.map(([project, last_summary]) => ({ project, last_summary }))
			.sort((left, right) => left.project.localeCompare(right.project));
		return { mainCommit, sources, silent };
	}

	private async readMainRef(signal?: AbortSignal): Promise<string> {
		const value = record(
			parseJson(
				await this.runChecked(
					["api", `repos/${REPORT_REPO}/git/ref/heads/main`],
					signal,
					"gh_ref",
				),
				"main ref",
			),
		);
		return gitSha(record(value?.object)?.sha, "main ref sha");
	}

	private async readOpenPulls(signal?: AbortSignal): Promise<unknown[]> {
		return flattenPages(
			parseJson(
				await this.runChecked(
					[
						"api",
						"--paginate",
						"--slurp",
						`repos/${REPORT_REPO}/pulls?state=open&per_page=100`,
					],
					signal,
					"gh_pulls",
				),
				"open PRs",
			),
			"open PRs",
		);
	}

	private async readEligiblePull(
		pr: number,
		signal?: AbortSignal,
	): Promise<{ head: string; paths: PathParts[] } | null> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const first = await this.readPullDetail(pr, signal);
			if (first.changedFiles > 3_000) {
				this.options.onSkipped?.(pr, "too_many_files");
				return null;
			}
			const files = await this.readPullFiles(pr, signal);
			if (files.length !== first.changedFiles) {
				throw new CollectorError(
					"gh_shape",
					`PR ${pr} files count does not match changed_files`,
				);
			}
			const paths: PathParts[] = [];
			let eligible = true;
			for (const file of files) {
				const entry = record(file);
				const path = parseSummaryPath(entry?.filename);
				if (
					!entry ||
					typeof entry.status !== "string" ||
					!ALLOWED_FILE_STATUSES.has(entry.status) ||
					!path
				) {
					eligible = false;
					break;
				}
				paths.push(path);
			}
			if (!eligible) {
				this.options.onSkipped?.(pr, "ineligible_files");
				return null;
			}
			const second = await this.readPullDetail(pr, signal);
			if (first.head === second.head) return { head: first.head, paths };
		}
		this.options.onSkipped?.(pr, "head_moved");
		return null;
	}

	private async readPullDetail(
		pr: number,
		signal?: AbortSignal,
	): Promise<PullDetail> {
		const value = record(
			parseJson(
				await this.runChecked(
					["api", `repos/${REPORT_REPO}/pulls/${pr}`],
					signal,
					"gh_detail",
				),
				`PR ${pr} detail`,
			),
		);
		if (
			!value ||
			value.number !== pr ||
			typeof value.draft !== "boolean" ||
			record(value.base)?.ref !== "main"
		) {
			throw new CollectorError("gh_shape", `PR ${pr} detail is invalid`);
		}
		return {
			number: pr,
			head: gitSha(record(value.head)?.sha, `PR ${pr} head`),
			changedFiles: integer(value.changed_files, `PR ${pr} changed_files`),
		};
	}

	private async readPullFiles(
		pr: number,
		signal?: AbortSignal,
	): Promise<unknown[]> {
		return flattenPages(
			parseJson(
				await this.runChecked(
					[
						"api",
						"--paginate",
						"--slurp",
						`repos/${REPORT_REPO}/pulls/${pr}/files?per_page=100`,
					],
					signal,
					"gh_files",
				),
				`PR ${pr} files`,
			),
			`PR ${pr} files`,
		);
	}

	private async readTree(
		mainCommit: string,
		signal?: AbortSignal,
	): Promise<unknown[]> {
		const value = record(
			parseJson(
				await this.runChecked(
					["api", `repos/${REPORT_REPO}/git/trees/${mainCommit}?recursive=1`],
					signal,
					"gh_tree",
				),
				"main tree",
			),
		);
		if (
			!value ||
			typeof value.truncated !== "boolean" ||
			!Array.isArray(value.tree)
		) {
			throw new CollectorError("gh_shape", "main tree response is invalid");
		}
		if (value.truncated) {
			throw new CollectorError(
				"gh_tree_truncated",
				"main recursive tree is truncated",
			);
		}
		return value.tree;
	}

	private async readContents(
		candidate: Candidate,
		signal?: AbortSignal,
	): Promise<DecodedSummary> {
		const value = record(
			parseJson(
				await this.runChecked(
					[
						"api",
						`repos/${REPORT_REPO}/contents/${candidate.path}?ref=${candidate.head}`,
					],
					signal,
					"gh_contents",
				),
				`summary ${candidate.path}`,
			),
		);
		if (
			!value ||
			value.encoding !== "base64" ||
			typeof value.content !== "string"
		) {
			throw new CollectorError(
				"gh_shape",
				`summary ${candidate.path} is invalid`,
			);
		}
		const compact = value.content.replace(/\n/g, "");
		if (
			compact.length === 0 ||
			compact.length % 4 !== 0 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				compact,
			)
		) {
			throw new CollectorError(
				"gh_shape",
				`summary ${candidate.path} is not base64`,
			);
		}
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(
				Buffer.from(compact, "base64"),
			);
		} catch (error) {
			throw new CollectorError(
				"gh_shape",
				`summary ${candidate.path} is not UTF-8`,
				{ cause: error },
			);
		}
		return { blob: gitSha(value.sha, "summary blob"), content };
	}

	private deduplicateAndBudget(
		collected: ReportGenerationSource[],
	): ReportGenerationSource[] {
		const byPath = new Map<string, ReportGenerationSource[]>();
		for (const source of collected) {
			const group = byPath.get(source.path) ?? [];
			group.push(source);
			byPath.set(source.path, group);
		}
		const deduplicated: ReportGenerationSource[] = [];
		for (const pathGroup of byPath.values()) {
			const byBlob = new Map<string, ReportGenerationSource[]>();
			for (const source of pathGroup) {
				const group = byBlob.get(source.blob) ?? [];
				group.push(source);
				byBlob.set(source.blob, group);
			}
			const divergent = byBlob.size > 1;
			for (const blobGroup of byBlob.values()) {
				blobGroup.sort(sourceSort);
				const [primary, ...duplicates] = blobGroup;
				deduplicated.push({
					...primary,
					divergent,
					also_in: duplicates.map(sourceLocation).sort(),
				});
			}
		}
		deduplicated.sort(sourceSort);
		let used = 0;
		let exhausted = false;
		return deduplicated.map((source) => {
			const bytes = Buffer.byteLength(source.content, "utf8");
			if (exhausted || used + bytes > this.options.maxTotalBytes) {
				exhausted = true;
				return { ...source, omitted: true, content: "" };
			}
			used += bytes;
			return source;
		});
	}

	private async runChecked(
		args: readonly string[],
		signal: AbortSignal | undefined,
		category: Exclude<
			CollectorCategory,
			"gh_shape" | "gh_tree_truncated" | "aborted"
		>,
	): Promise<string> {
		try {
			return await this.run(args, { signal });
		} catch (error) {
			if (signal?.aborted) {
				throw new CollectorError("aborted", "summary collection aborted", {
					cause: error,
				});
			}
			throw new CollectorError(
				category,
				`summary collection ${category} failed`,
				{
					cause: error,
				},
			);
		}
	}
}
