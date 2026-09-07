import type { ShipRelevantPrSnapshot, StateStore } from "../StateStore.js";

export const SHIP_RELEVANT_CLASSIFIER_VERSION = 2;
/** A docs-only exemption is authorization evidence, so it expires when the
 * async GitHub metadata refresher stops making progress. */
export const SHIP_RELEVANT_SNAPSHOT_MAX_AGE_MS = 60_000;

export const MAX_DOCS_ONLY_FILES = 50;
const DOCS_PREFIXES = [
	"doc/",
	"docs/",
	"engineering/doc/",
	"product/doc/",
	"content/doc/",
	"marketing/doc/",
] as const;
const FULL_SHA = /^[0-9a-f]{40}$/;

export type ShipRelevantGitHubApi = (
	path: string,
	options: { signal: AbortSignal },
) => Promise<unknown>;

interface PullMetadata {
	head: { sha: string };
	base: { ref: string; sha: string };
	changed_files: number;
	commits: number;
}

interface PullFile {
	status: "added" | "modified" | "removed" | "renamed";
	filename: string;
	previous_filename?: string;
}

interface GitTreeEntry {
	path: string;
	mode: string;
	type: string;
}

interface PullCommit {
	sha: string;
}

export interface ShipRelevantClassificationSnapshot {
	repo: string;
	pr_number: number;
	pr_head_sha: string;
	base_ref: string;
	base_oid: string;
	classifier_version: number;
	ship_relevant: 0 | 1;
	file_count: number;
	commit_shas: string[];
	sample_paths?: string[];
}

export type ShipRelevantClassification =
	| { kind: "snapshot"; snapshot: ShipRelevantClassificationSnapshot }
	| {
			kind: "unknown";
			reason:
				| "api_error"
				| "metadata_invalid"
				| "metadata_drift"
				| "head_mismatch"
				| "file_count_mismatch"
				| "commit_count_mismatch"
				| "tree_incomplete";
	  };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseMetadata(value: unknown): PullMetadata | undefined {
	if (!isObject(value) || !isObject(value.head) || !isObject(value.base)) {
		return undefined;
	}
	const head = value.head.sha;
	const baseRef = value.base.ref;
	const baseSha = value.base.sha;
	const changedFiles = value.changed_files;
	const commits = value.commits;
	if (
		typeof head !== "string" ||
		!FULL_SHA.test(head.toLowerCase()) ||
		typeof baseRef !== "string" ||
		baseRef.length === 0 ||
		typeof baseSha !== "string" ||
		!FULL_SHA.test(baseSha.toLowerCase()) ||
		typeof changedFiles !== "number" ||
		!Number.isSafeInteger(changedFiles) ||
		changedFiles <= 0 ||
		typeof commits !== "number" ||
		!Number.isSafeInteger(commits) ||
		commits <= 0
	) {
		return undefined;
	}
	return {
		head: { sha: head.toLowerCase() },
		base: { ref: baseRef, sha: baseSha.toLowerCase() },
		changed_files: changedFiles,
		commits,
	};
}

function parsePullCommit(value: unknown): PullCommit | undefined {
	if (!isObject(value) || typeof value.sha !== "string") return undefined;
	const sha = value.sha.toLowerCase();
	return FULL_SHA.test(sha) ? { sha } : undefined;
}

function parsePullFile(value: unknown): PullFile | undefined {
	if (!isObject(value) || typeof value.filename !== "string") return undefined;
	if (
		value.status !== "added" &&
		value.status !== "modified" &&
		value.status !== "removed" &&
		value.status !== "renamed"
	) {
		return undefined;
	}
	if (
		value.status === "renamed" &&
		typeof value.previous_filename !== "string"
	) {
		return undefined;
	}
	return {
		status: value.status,
		filename: value.filename,
		previous_filename:
			typeof value.previous_filename === "string"
				? value.previous_filename
				: undefined,
	};
}

export function isShipDocsPath(path: string): boolean {
	return DOCS_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function filePaths(file: PullFile): string[] {
	return file.status === "renamed"
		? [file.filename, file.previous_filename!]
		: [file.filename];
}

function parseTree(value: unknown): Map<string, GitTreeEntry> | undefined {
	if (
		!isObject(value) ||
		value.truncated !== false ||
		!Array.isArray(value.tree)
	) {
		return undefined;
	}
	const entries = new Map<string, GitTreeEntry>();
	for (const raw of value.tree) {
		if (
			!isObject(raw) ||
			typeof raw.path !== "string" ||
			typeof raw.mode !== "string" ||
			typeof raw.type !== "string"
		) {
			return undefined;
		}
		entries.set(raw.path, {
			path: raw.path,
			mode: raw.mode,
			type: raw.type,
		});
	}
	return entries;
}

function isRegularDocumentEntry(
	tree: Map<string, GitTreeEntry>,
	path: string,
): boolean {
	const entry = tree.get(path);
	return entry?.type === "blob" && entry.mode === "100644";
}

export async function classifyShipRelevantDiff(input: {
	repo: string;
	prNumber: number;
	prHeadSha: string;
	api: ShipRelevantGitHubApi;
	signal?: AbortSignal;
}): Promise<ShipRelevantClassification> {
	if (
		!/^[^/]+\/[^/]+$/.test(input.repo) ||
		!Number.isSafeInteger(input.prNumber) ||
		input.prNumber <= 0 ||
		!FULL_SHA.test(input.prHeadSha.toLowerCase())
	) {
		return { kind: "unknown", reason: "metadata_invalid" };
	}

	let metadata: PullMetadata | undefined;
	const signal = input.signal ?? new AbortController().signal;
	try {
		metadata = parseMetadata(
			await input.api(`/repos/${input.repo}/pulls/${input.prNumber}`, {
				signal,
			}),
		);
	} catch {
		return { kind: "unknown", reason: "api_error" };
	}
	if (!metadata) return { kind: "unknown", reason: "metadata_invalid" };
	if (metadata.head.sha !== input.prHeadSha.toLowerCase()) {
		return { kind: "unknown", reason: "head_mismatch" };
	}
	if (metadata.commits > 250) {
		return { kind: "unknown", reason: "commit_count_mismatch" };
	}

	const commitShas: string[] = [];
	try {
		for (let page = 1; ; page++) {
			const rawPage = await input.api(
				`/repos/${input.repo}/pulls/${input.prNumber}/commits?per_page=100&page=${page}`,
				{ signal },
			);
			if (!Array.isArray(rawPage)) {
				return { kind: "unknown", reason: "api_error" };
			}
			if (rawPage.length === 0) break;
			for (const raw of rawPage) {
				const commit = parsePullCommit(raw);
				if (!commit) {
					return { kind: "unknown", reason: "commit_count_mismatch" };
				}
				commitShas.push(commit.sha);
			}
		}
	} catch {
		return { kind: "unknown", reason: "api_error" };
	}
	if (commitShas.length !== metadata.commits) {
		return { kind: "unknown", reason: "commit_count_mismatch" };
	}

	const snapshotBase = {
		repo: input.repo,
		pr_number: input.prNumber,
		pr_head_sha: metadata.head.sha,
		base_ref: metadata.base.ref,
		base_oid: metadata.base.sha,
		classifier_version: SHIP_RELEVANT_CLASSIFIER_VERSION,
		file_count: metadata.changed_files,
		commit_shas: commitShas,
	};
	if (metadata.changed_files > MAX_DOCS_ONLY_FILES) {
		return {
			kind: "snapshot",
			snapshot: { ...snapshotBase, ship_relevant: 1 },
		};
	}

	const files: PullFile[] = [];
	try {
		for (let page = 1; ; page++) {
			const rawPage = await input.api(
				`/repos/${input.repo}/pulls/${input.prNumber}/files?per_page=100&page=${page}`,
				{ signal },
			);
			if (!Array.isArray(rawPage)) {
				return { kind: "unknown", reason: "api_error" };
			}
			if (rawPage.length === 0) break;
			for (const raw of rawPage) {
				const file = parsePullFile(raw);
				if (!file) {
					return {
						kind: "snapshot",
						snapshot: { ...snapshotBase, ship_relevant: 1 },
					};
				}
				files.push(file);
			}
		}
	} catch {
		return { kind: "unknown", reason: "api_error" };
	}
	if (files.length !== metadata.changed_files) {
		return { kind: "unknown", reason: "file_count_mismatch" };
	}

	const nonDocs = files
		.flatMap(filePaths)
		.filter((path) => !isShipDocsPath(path));
	if (nonDocs.length > 0) {
		return {
			kind: "snapshot",
			snapshot: {
				...snapshotBase,
				ship_relevant: 1,
				sample_paths: nonDocs.slice(0, 10),
			},
		};
	}

	const needsHead = files.some((file) => file.status !== "removed");
	const needsBase = files.some((file) => file.status !== "added");
	let headTree: Map<string, GitTreeEntry> | undefined;
	let baseTree: Map<string, GitTreeEntry> | undefined;
	try {
		if (needsHead) {
			headTree = parseTree(
				await input.api(
					`/repos/${input.repo}/git/trees/${metadata.head.sha}?recursive=1`,
					{ signal },
				),
			);
			if (!headTree) return { kind: "unknown", reason: "tree_incomplete" };
		}
		if (needsBase) {
			baseTree = parseTree(
				await input.api(
					`/repos/${input.repo}/git/trees/${metadata.base.sha}?recursive=1`,
					{ signal },
				),
			);
			if (!baseTree) return { kind: "unknown", reason: "tree_incomplete" };
		}
	} catch {
		return { kind: "unknown", reason: "tree_incomplete" };
	}

	for (const file of files) {
		const headPaths = file.status === "removed" ? [] : [file.filename];
		const basePaths =
			file.status === "added"
				? []
				: [file.status === "renamed" ? file.previous_filename! : file.filename];
		if (
			headPaths.some((path) => !isRegularDocumentEntry(headTree!, path)) ||
			basePaths.some((path) => !isRegularDocumentEntry(baseTree!, path))
		) {
			return {
				kind: "snapshot",
				snapshot: {
					...snapshotBase,
					ship_relevant: 1,
					sample_paths: filePaths(file).slice(0, 10),
				},
			};
		}
	}

	let finalMetadata: PullMetadata | undefined;
	try {
		finalMetadata = parseMetadata(
			await input.api(`/repos/${input.repo}/pulls/${input.prNumber}`, {
				signal,
			}),
		);
	} catch {
		return { kind: "unknown", reason: "api_error" };
	}
	if (!finalMetadata) return { kind: "unknown", reason: "metadata_invalid" };
	if (finalMetadata.head.sha !== metadata.head.sha) {
		return { kind: "unknown", reason: "head_mismatch" };
	}
	if (
		finalMetadata.base.ref !== metadata.base.ref ||
		finalMetadata.base.sha !== metadata.base.sha ||
		finalMetadata.changed_files !== metadata.changed_files ||
		finalMetadata.commits !== metadata.commits
	) {
		return { kind: "unknown", reason: "metadata_drift" };
	}

	return {
		kind: "snapshot",
		snapshot: { ...snapshotBase, ship_relevant: 0 },
	};
}

export const SHIP_RELEVANCE_GITHUB_BUDGET_PER_HOUR = 1_500;
export const SHIP_RELEVANCE_REQUESTS_PER_PASS = 40;
export const SHIP_RELEVANCE_MAX_CONCURRENCY = 4;

export interface ShipRelevantRefreshCandidate {
	executionId: string;
	repoIdentity: string;
	repoSlug: string;
	prNumber: number;
	prHeadSha: string;
	role: "primary" | "declared";
	api: ShipRelevantGitHubApi;
}

export interface ShipRelevantRunRefresh {
	executionId: string;
	primary: ShipRelevantRefreshCandidate;
	declared: ShipRelevantRefreshCandidate[];
}

interface RefreshBudget {
	controller: AbortController;
	deadline: number;
	requests: number;
}

function storedClassification(
	snapshot: ShipRelevantPrSnapshot,
): ShipRelevantClassification {
	return {
		kind: "snapshot",
		snapshot: {
			repo: snapshot.repo_slug,
			pr_number: snapshot.pr_number,
			pr_head_sha: snapshot.pr_head_sha,
			base_ref: snapshot.base_ref,
			base_oid: snapshot.base_oid,
			classifier_version: snapshot.classifier_version,
			ship_relevant: snapshot.ship_relevant,
			file_count: snapshot.file_count,
			commit_shas: snapshot.commit_shas,
		},
	};
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		async () => {
			for (;;) {
				const index = next++;
				if (index >= items.length) return;
				results[index] = await worker(items[index]!);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

/** Async producer for the synchronous founder-hold predicate. */
export class ShipRelevantDiffService {
	private readonly inFlight = new Map<
		string,
		Promise<ShipRelevantClassification>
	>();
	private readonly retryAfter = new Map<string, number>();
	private readonly metadataAfter = new Map<string, number>();
	private readonly lastAttemptAt = new Map<string, number>();
	private readonly requestTimes: number[] = [];
	private passInFlight: Promise<void> | undefined;

	constructor(
		private readonly store: Pick<
			StateStore,
			| "putShipRelevantPrSnapshot"
			| "deleteShipRelevantPrSnapshot"
			| "deleteShipRelevantPrSnapshotsExcept"
			| "getShipRelevantPrSnapshot"
		>,
		private readonly options: {
			now?: () => number;
			retryMs?: number;
			metadataRetryMs?: number;
			primaryDocsMetadataRetryMs?: number;
			declaredDocsMetadataRetryMs?: number;
			requestBudgetPerHour?: number;
			requestsPerPass?: number;
			maxConcurrency?: number;
			maxDeclaredPrs?: number;
		} = {},
	) {}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private key(input: ShipRelevantRefreshCandidate): string {
		return `${input.executionId}:${input.repoSlug.toLowerCase()}:${input.prNumber}:${input.prHeadSha.toLowerCase()}`;
	}

	private deleteSnapshot(input: ShipRelevantRefreshCandidate): void {
		this.store.deleteShipRelevantPrSnapshot(
			input.executionId,
			input.repoSlug,
			input.prNumber,
		);
	}

	private budgetedApi(
		api: ShipRelevantGitHubApi,
		budget: RefreshBudget,
	): ShipRelevantGitHubApi {
		return async (path) => {
			const now = this.now();
			while (
				this.requestTimes.length > 0 &&
				this.requestTimes[0]! <= now - 60 * 60_000
			) {
				this.requestTimes.shift();
			}
			if (now >= budget.deadline) budget.controller.abort();
			if (
				budget.controller.signal.aborted ||
				budget.requests >=
					(this.options.requestsPerPass ?? SHIP_RELEVANCE_REQUESTS_PER_PASS) ||
				this.requestTimes.length >=
					(this.options.requestBudgetPerHour ??
						SHIP_RELEVANCE_GITHUB_BUDGET_PER_HOUR)
			) {
				throw new Error("ship_relevance_request_budget_exhausted");
			}
			budget.requests += 1;
			this.requestTimes.push(now);
			return api(path, { signal: budget.controller.signal });
		};
	}

	private async ensureCandidate(
		input: ShipRelevantRefreshCandidate,
		budget: RefreshBudget,
	): Promise<ShipRelevantClassification> {
		const key = this.key(input);
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const now = this.now();
		this.lastAttemptAt.set(key, now);
		for (const [candidate, retryAt] of this.retryAfter) {
			if (retryAt <= now) this.retryAfter.delete(candidate);
		}
		for (const [candidate, retryAt] of this.metadataAfter) {
			if (retryAt <= now) this.metadataAfter.delete(candidate);
		}

		let cached = this.store.getShipRelevantPrSnapshot(
			input.executionId,
			input.repoSlug,
			input.prNumber,
		);
		let cachedMatches =
			cached?.repo_slug.toLowerCase() === input.repoSlug.toLowerCase() &&
			cached.pr_number === input.prNumber &&
			cached.pr_head_sha.toLowerCase() === input.prHeadSha.toLowerCase() &&
			cached.role === input.role &&
			cached.classifier_version === SHIP_RELEVANT_CLASSIFIER_VERSION;
		if (cached && !cachedMatches) {
			this.deleteSnapshot(input);
			this.retryAfter.delete(key);
			this.metadataAfter.delete(key);
			cached = undefined;
			cachedMatches = false;
		}

		const retryMs = this.options.retryMs ?? 60_000;
		const metadataRetryMs = Math.min(
			this.options.metadataRetryMs ?? 30_000,
			Math.floor(SHIP_RELEVANT_SNAPSHOT_MAX_AGE_MS / 2),
		);
		const docsMetadataRetryMs = Math.min(
			input.role === "declared"
				? (this.options.declaredDocsMetadataRetryMs ?? 30_000)
				: (this.options.primaryDocsMetadataRetryMs ?? 10_000),
			metadataRetryMs,
		);
		const api = this.budgetedApi(input.api, budget);
		const work = (async (): Promise<ShipRelevantClassification> => {
			if (cachedMatches && cached) {
				if ((this.metadataAfter.get(key) ?? 0) > now) {
					return storedClassification(cached);
				}
				let metadata: PullMetadata | undefined;
				try {
					metadata = parseMetadata(
						await api(`/repos/${input.repoSlug}/pulls/${input.prNumber}`, {
							signal: budget.controller.signal,
						}),
					);
				} catch {
					this.deleteSnapshot(input);
					this.metadataAfter.delete(key);
					this.retryAfter.set(key, now + retryMs);
					return { kind: "unknown", reason: "api_error" };
				}
				if (!metadata) {
					this.deleteSnapshot(input);
					this.metadataAfter.delete(key);
					this.retryAfter.set(key, now + retryMs);
					return { kind: "unknown", reason: "metadata_invalid" };
				}
				if (metadata.head.sha !== input.prHeadSha.toLowerCase()) {
					this.deleteSnapshot(input);
					this.metadataAfter.delete(key);
					this.retryAfter.set(key, now + retryMs);
					return { kind: "unknown", reason: "head_mismatch" };
				}
				if (
					metadata.base.ref !== cached.base_ref ||
					metadata.base.sha !== cached.base_oid.toLowerCase() ||
					metadata.changed_files !== cached.file_count ||
					metadata.commits !== cached.commit_shas.length
				) {
					this.deleteSnapshot(input);
					this.retryAfter.delete(key);
					this.metadataAfter.delete(key);
					cached = undefined;
					cachedMatches = false;
				} else {
					const refreshed = {
						...cached,
						computed_at: new Date(now).toISOString(),
					};
					this.store.putShipRelevantPrSnapshot(refreshed);
					this.metadataAfter.set(
						key,
						now +
							(cached.ship_relevant === 1
								? metadataRetryMs
								: docsMetadataRetryMs),
					);
					return storedClassification(refreshed);
				}
			}
			if ((this.retryAfter.get(key) ?? 0) > now) {
				return { kind: "unknown", reason: "api_error" };
			}

			const result = await classifyShipRelevantDiff({
				repo: input.repoSlug,
				prNumber: input.prNumber,
				prHeadSha: input.prHeadSha,
				api,
				signal: budget.controller.signal,
			});
			if (result.kind === "snapshot") {
				const { repo, ...snapshot } = result.snapshot;
				this.store.putShipRelevantPrSnapshot({
					execution_id: input.executionId,
					repo_slug: repo,
					role: input.role,
					...snapshot,
					computed_at: new Date(now).toISOString(),
				});
				this.retryAfter.set(key, now + retryMs);
				if (result.snapshot.ship_relevant === 1) {
					this.metadataAfter.set(key, now + metadataRetryMs);
				} else {
					this.metadataAfter.delete(key);
				}
			} else {
				this.deleteSnapshot(input);
				this.retryAfter.set(key, now + retryMs);
				this.metadataAfter.delete(key);
			}
			return result;
		})().finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, work);
		return work;
	}

	ensure(input: {
		executionId: string;
		repo: string;
		prNumber: number;
		prHeadSha: string;
		role?: "primary" | "declared";
		api: ShipRelevantGitHubApi;
	}): Promise<ShipRelevantClassification> {
		const controller = new AbortController();
		return this.ensureCandidate(
			{
				executionId: input.executionId,
				repoIdentity: input.role === "declared" ? input.repo : "__main__",
				repoSlug: input.repo,
				prNumber: input.prNumber,
				prHeadSha: input.prHeadSha,
				role: input.role ?? "primary",
				api: input.api,
			},
			{
				controller,
				deadline: Number.POSITIVE_INFINITY,
				requests: 0,
			},
		);
	}

	private candidateOrder(
		a: ShipRelevantRefreshCandidate,
		b: ShipRelevantRefreshCandidate,
	): number {
		const snapshot = (candidate: ShipRelevantRefreshCandidate) =>
			this.store.getShipRelevantPrSnapshot(
				candidate.executionId,
				candidate.repoSlug,
				candidate.prNumber,
			);
		const aSnapshot = snapshot(a);
		const bSnapshot = snapshot(b);
		if (Boolean(aSnapshot) !== Boolean(bSnapshot)) return aSnapshot ? 1 : -1;
		if (!aSnapshot && !bSnapshot) {
			return (
				(this.lastAttemptAt.get(this.key(a)) ?? Number.NEGATIVE_INFINITY) -
				(this.lastAttemptAt.get(this.key(b)) ?? Number.NEGATIVE_INFINITY)
			);
		}
		const computedOrder =
			Date.parse(aSnapshot!.computed_at) - Date.parse(bSnapshot!.computed_at);
		if (computedOrder !== 0) return computedOrder;
		return this.key(a).localeCompare(this.key(b));
	}

	private async runRefreshPass(
		runs: ShipRelevantRunRefresh[],
		deadline: number,
	): Promise<void> {
		const controller = new AbortController();
		const budget: RefreshBudget = { controller, deadline, requests: 0 };
		const delay = Math.max(0, deadline - this.now());
		const timeout = Number.isFinite(delay)
			? setTimeout(() => controller.abort(), delay)
			: undefined;
		try {
			const maxDeclaredPrs = this.options.maxDeclaredPrs ?? 8;
			const eligible = runs.filter((run) => {
				const candidates = [run.primary, ...run.declared];
				this.store.deleteShipRelevantPrSnapshotsExcept(
					run.executionId,
					candidates.map((candidate) => ({
						repoSlug: candidate.repoSlug,
						prNumber: candidate.prNumber,
					})),
				);
				return run.declared.length <= maxDeclaredPrs;
			});
			const primaryRuns = [...eligible].sort((a, b) =>
				this.candidateOrder(a.primary, b.primary),
			);
			const primaryResults = await mapWithConcurrency(
				primaryRuns,
				this.options.maxConcurrency ?? SHIP_RELEVANCE_MAX_CONCURRENCY,
				(run) => this.ensureCandidate(run.primary, budget),
			);
			const primaryByExecution = new Map(
				primaryResults.map((result, index) => [
					primaryRuns[index]!.executionId,
					result,
				]),
			);
			const pending = eligible
				.filter((run) => {
					const result = primaryByExecution.get(run.executionId);
					return (
						result?.kind === "snapshot" && result.snapshot.ship_relevant === 0
					);
				})
				.map((run) => ({
					executionId: run.executionId,
					candidates: [...run.declared].sort((a, b) =>
						this.candidateOrder(a, b),
					),
				}));
			while (pending.length > 0 && !controller.signal.aborted) {
				const round = pending
					.map((run) => ({ run, candidate: run.candidates.shift() }))
					.filter(
						(
							entry,
						): entry is {
							run: (typeof pending)[number];
							candidate: ShipRelevantRefreshCandidate;
						} => entry.candidate !== undefined,
					)
					.sort((a, b) => this.candidateOrder(a.candidate, b.candidate));
				if (round.length === 0) break;
				const results = await mapWithConcurrency(
					round,
					this.options.maxConcurrency ?? SHIP_RELEVANCE_MAX_CONCURRENCY,
					(entry) => this.ensureCandidate(entry.candidate, budget),
				);
				for (let index = pending.length - 1; index >= 0; index--) {
					const entry = round.find((item) => item.run === pending[index]);
					const result = entry ? results[round.indexOf(entry)] : undefined;
					if (
						pending[index]!.candidates.length === 0 ||
						result?.kind !== "snapshot" ||
						result.snapshot.ship_relevant === 1
					) {
						pending.splice(index, 1);
					}
				}
			}
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	async refresh(
		runs: ShipRelevantRunRefresh[],
		options: { deadline: number },
	): Promise<void> {
		if (this.passInFlight) return;
		const pass = this.runRefreshPass(runs, options.deadline).finally(() => {
			if (this.passInFlight === pass) this.passInFlight = undefined;
		});
		this.passInFlight = pass;
		await pass;
	}
}
