import type { StateStore } from "../StateStore.js";

export const SHIP_RELEVANT_CLASSIFIER_VERSION = 1;

const MAX_DOCS_ONLY_FILES = 50;
const DOCS_PREFIXES = [
	"doc/",
	"docs/",
	"engineering/doc/",
	"product/doc/",
	"content/doc/",
	"marketing/doc/",
] as const;
const FULL_SHA = /^[0-9a-f]{40}$/;

export type ShipRelevantGitHubApi = (path: string) => Promise<unknown>;

interface PullMetadata {
	head: { sha: string };
	base: { ref: string; sha: string };
	changed_files: number;
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

export interface ShipRelevantClassificationSnapshot {
	repo: string;
	pr_number: number;
	pr_head_sha: string;
	base_ref: string;
	base_oid: string;
	classifier_version: number;
	ship_relevant: 0 | 1;
	file_count: number;
	sample_paths?: string[];
}

export type ShipRelevantClassification =
	| { kind: "snapshot"; snapshot: ShipRelevantClassificationSnapshot }
	| {
			kind: "unknown";
			reason:
				| "api_error"
				| "metadata_invalid"
				| "head_mismatch"
				| "file_count_mismatch"
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
	if (
		typeof head !== "string" ||
		!FULL_SHA.test(head.toLowerCase()) ||
		typeof baseRef !== "string" ||
		baseRef.length === 0 ||
		typeof baseSha !== "string" ||
		!FULL_SHA.test(baseSha.toLowerCase()) ||
		typeof changedFiles !== "number" ||
		!Number.isSafeInteger(changedFiles) ||
		changedFiles <= 0
	) {
		return undefined;
	}
	return {
		head: { sha: head.toLowerCase() },
		base: { ref: baseRef, sha: baseSha.toLowerCase() },
		changed_files: changedFiles,
	};
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

function isDocsPath(path: string): boolean {
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
	try {
		metadata = parseMetadata(
			await input.api(`/repos/${input.repo}/pulls/${input.prNumber}`),
		);
	} catch {
		return { kind: "unknown", reason: "api_error" };
	}
	if (!metadata) return { kind: "unknown", reason: "metadata_invalid" };
	if (metadata.head.sha !== input.prHeadSha.toLowerCase()) {
		return { kind: "unknown", reason: "head_mismatch" };
	}

	const snapshotBase = {
		repo: input.repo,
		pr_number: input.prNumber,
		pr_head_sha: metadata.head.sha,
		base_ref: metadata.base.ref,
		base_oid: metadata.base.sha,
		classifier_version: SHIP_RELEVANT_CLASSIFIER_VERSION,
		file_count: metadata.changed_files,
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

	const nonDocs = files.flatMap(filePaths).filter((path) => !isDocsPath(path));
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
				),
			);
			if (!headTree) return { kind: "unknown", reason: "tree_incomplete" };
		}
		if (needsBase) {
			baseTree = parseTree(
				await input.api(
					`/repos/${input.repo}/git/trees/${metadata.base.sha}?recursive=1`,
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

	return {
		kind: "snapshot",
		snapshot: { ...snapshotBase, ship_relevant: 0 },
	};
}

/**
 * Async producer for the synchronous founder-hold predicate. Classifications
 * are coalesced per exact candidate and unknown refreshes remove any stale
 * exemption before entering a bounded retry backoff.
 */
export class ShipRelevantDiffService {
	private readonly inFlight = new Map<
		string,
		Promise<ShipRelevantClassification>
	>();
	private readonly retryAfter = new Map<string, number>();

	constructor(
		private readonly store: Pick<
			StateStore,
			| "putShipRelevantDiffSnapshot"
			| "deleteShipRelevantDiffSnapshot"
			| "getShipRelevantDiffSnapshot"
		>,
		private readonly options: { now?: () => number; retryMs?: number } = {},
	) {}

	ensure(input: {
		executionId: string;
		repo: string;
		prNumber: number;
		prHeadSha: string;
		api: ShipRelevantGitHubApi;
	}): Promise<ShipRelevantClassification> {
		const key = `${input.executionId}:${input.prHeadSha.toLowerCase()}`;
		const existing = this.inFlight.get(key);
		if (existing) return existing;

		const now = this.options.now?.() ?? Date.now();
		const cached = this.store.getShipRelevantDiffSnapshot(
			input.executionId,
			input.prHeadSha,
		);
		const cachedMatches =
			cached?.repo === input.repo &&
			cached.pr_number === input.prNumber &&
			cached.classifier_version === SHIP_RELEVANT_CLASSIFIER_VERSION;
		if (cached && !cachedMatches) {
			this.store.deleteShipRelevantDiffSnapshot(
				input.executionId,
				input.prHeadSha,
			);
			this.retryAfter.delete(key);
		}
		if ((this.retryAfter.get(key) ?? 0) > now) {
			if (cachedMatches && cached) {
				const { execution_id, computed_at, ...snapshot } = cached;
				void execution_id;
				void computed_at;
				return Promise.resolve({ kind: "snapshot", snapshot });
			}
			return Promise.resolve({ kind: "unknown", reason: "api_error" });
		}

		const work = classifyShipRelevantDiff({
			repo: input.repo,
			prNumber: input.prNumber,
			prHeadSha: input.prHeadSha,
			api: input.api,
		})
			.then((result) => {
				if (result.kind === "snapshot") {
					this.store.putShipRelevantDiffSnapshot({
						execution_id: input.executionId,
						...result.snapshot,
					});
					this.retryAfter.set(key, now + (this.options.retryMs ?? 60_000));
				} else {
					this.store.deleteShipRelevantDiffSnapshot(
						input.executionId,
						input.prHeadSha,
					);
					this.retryAfter.set(key, now + (this.options.retryMs ?? 60_000));
				}
				return result;
			})
			.finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, work);
		return work;
	}
}
