/**
 * FLY-286: Xiaohongshu-learning analysis + feedback data layer.
 *
 * The post-hoc review model (replacing FLY-222's pre-create prune gate) needs a
 * durable, structured record of (a) what each note was analyzed into + what
 * action the Runner took, and (b) the founder's structured review actions. This
 * is the SHARED data layer: FLY-286 implements the local-filesystem stores
 * below; FLY-298 (phone/public writeback) provides a different `FeedbackStore`
 * implementation that writes the SAME records — so the `AnalysisStore` /
 * `FeedbackStore` INTERFACES are the reuse seam, not the fs paths (codex
 * design-review R1#12).
 *
 * Contracts (codex R1#7):
 *  - atomic writes (temp file + rename), `0600`, parent dirs created on demand;
 *  - safe path segments only (same charset as the state layer) — a malicious
 *    project/collection/runToken cannot escape the store dir;
 *  - schemaVersion-checked reads; a missing file reads as `null` (not a throw);
 *  - a hard per-file size cap (loud reject, never silent truncation);
 *  - **NO raw image/video bytes** are ever persisted — only text + original-site
 *    URLs (privacy + copyright: link the original, never re-host).
 *
 * Layout (sibling to the state FILE `<stateDir>/<project>__<cid>.json`):
 *   <stateDir>/<project>__<cid>/analysis/<runToken>.json
 *   <stateDir>/<project>__<cid>/feedback/<runToken>.json
 */

import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export const XIAOHONGSHU_ANALYSIS_SCHEMA_VERSION = 1 as const;
export const XIAOHONGSHU_FEEDBACK_SCHEMA_VERSION = 1 as const;

/** Keep the N most recent analysis runs per collection; prune older on write. */
export const DEFAULT_ANALYSIS_RETENTION = 20;
/** Hard per-file cap (loud reject; the store never silently truncates). */
export const MAX_STORE_FILE_BYTES = 1024 * 1024; // 1 MB

// ─── schema v1 ────────────────────────────────────────────────────────────────

export type XiaohongshuMediaKind = "text" | "image" | "video";
export type XiaohongshuPostStatus =
	| "analyzed"
	| "created"
	| "candidate"
	| "no_action";

/** One analyzed note. Holds TEXT + original-site URLs only — never media bytes. */
export interface XiaohongshuAnalyzedPost {
	noteId: string;
	title: string;
	/** Original-site note URL (link, never re-hosted media). */
	url: string;
	mediaKinds: XiaohongshuMediaKind[];
	summary: string;
	judgment: { useful: boolean; reason: string };
	/** Present when the post is a draft (auto-created OR candidate-not-created). */
	candidateIssue?: { title: string; body: string };
	/** Present when an issue was auto-created for this post. */
	createdIssue?: { issueId: string; opId: string; state: string };
	status: XiaohongshuPostStatus;
}

export interface XiaohongshuAnalysisRun {
	schemaVersion: typeof XIAOHONGSHU_ANALYSIS_SCHEMA_VERSION;
	runToken: string;
	execId: string;
	project: string;
	collectionId: string;
	collectionLabel: string;
	generatedAt: string;
	/** What window this run saw. `capped` = collection > MCP window (no cursor). */
	sourceWindow: { fetched: number; total: number; capped: boolean };
	posts: XiaohongshuAnalyzedPost[];
	summary: {
		analyzed: number;
		created: number;
		candidates: number;
		skipped: number;
	};
	/** Set once the review page is delivered; null until then. */
	review: { reportToken: string; deliveredAt?: string } | null;
}

/** Structured review action — the ONLY authority for close/create (not free text). */
export type XiaohongshuReviewActionKind =
	| "keep"
	| "close_created"
	| "promote_candidate"
	| "edit"
	| "skip";

export interface XiaohongshuReviewAction {
	noteId: string;
	action: XiaohongshuReviewActionKind;
	/** For close_created: the target issue's opId. */
	targetOpId?: string;
	/** For promote_candidate: the candidateId to create. */
	candidateId?: string;
	/** For edit: overrides applied when (re)creating. */
	edit?: { title?: string; body?: string };
	at: string;
}

/** Free-text comment — feeds learning/escalation, NEVER drives close/create. */
export interface XiaohongshuReviewComment {
	noteId: string;
	text: string;
	at: string;
}

export interface XiaohongshuFeedbackFile {
	schemaVersion: typeof XIAOHONGSHU_FEEDBACK_SCHEMA_VERSION;
	runToken: string;
	comments: XiaohongshuReviewComment[];
	actions: XiaohongshuReviewAction[];
	/** opId -> consumption record (the feedback-consume pass is idempotent). */
	consumedActions: { opId: string; at: string; result: string }[];
}

// ─── store interfaces (the FLY-298 reuse seam) ────────────────────────────────

export interface AnalysisStore {
	writeRun(run: XiaohongshuAnalysisRun): void;
	readRun(
		project: string,
		collectionId: string,
		runToken: string,
	): XiaohongshuAnalysisRun | null;
	/** runTokens present for a collection, for crash-recovery / prior-run lookup. */
	listRuns(project: string, collectionId: string): string[];
}

export interface FeedbackStore {
	writeFeedback(
		project: string,
		collectionId: string,
		feedback: XiaohongshuFeedbackFile,
	): void;
	readFeedback(
		project: string,
		collectionId: string,
		runToken: string,
	): XiaohongshuFeedbackFile | null;
}

// ─── shared fs helpers ────────────────────────────────────────────────────────

/** Same charset as the state layer's safeSegment — keeps paths inside the dir. */
function safeSegment(s: string, what: string): string {
	if (typeof s !== "string" || !/^[A-Za-z0-9._-]+$/.test(s)) {
		throw new Error(
			`xiaohongshu-analysis-store: unsafe ${what} ${JSON.stringify(s)} (allowed: A-Za-z0-9._-)`,
		);
	}
	return s;
}

function collectionDir(
	stateDir: string,
	project: string,
	collectionId: string,
): string {
	return join(
		stateDir,
		`${safeSegment(project, "project")}__${safeSegment(collectionId, "collectionId")}`,
	);
}

/**
 * Create `dir` under the TRUSTED `root` (the configured state dir) WITHOUT
 * following symlinks (codex code review R1#2 / plan §5).
 *
 * Ancestors of `root` are system/config-controlled and trusted (and may
 * legitimately be symlinks — e.g. macOS `/var` → `/private/var`), so they are
 * NOT inspected. Only the components BELOW `root` (the per-collection +
 * analysis/feedback subdirs the store auto-creates) are walked: an existing
 * component that is a symlink (or a non-directory) is rejected, so a symlink an
 * attacker pre-planted under the state dir cannot redirect writes outside it.
 * Missing components are created `0700`.
 */
function mkdirNoSymlink(root: string, dir: string): void {
	mkdirSync(root, { recursive: true });
	const rel = relative(root, dir);
	if (rel === "") return;
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(
			`xiaohongshu-analysis-store: ${dir} escapes state root ${root}`,
		);
	}
	let cur = root;
	for (const seg of rel.split(sep).filter((s) => s.length > 0)) {
		cur = join(cur, seg);
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(cur);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				mkdirSync(cur, { mode: 0o700 });
				continue;
			}
			throw err;
		}
		if (st.isSymbolicLink()) {
			throw new Error(
				`xiaohongshu-analysis-store: refusing to write through symlink ${cur}`,
			);
		}
		if (!st.isDirectory()) {
			throw new Error(
				`xiaohongshu-analysis-store: path component is not a directory: ${cur}`,
			);
		}
	}
}

/** Atomic, 0600, size-capped, symlink-safe JSON write under trusted `root`. */
function writeJsonAtomic(root: string, file: string, data: unknown): void {
	const json = JSON.stringify(data, null, 2);
	const bytes = Buffer.byteLength(json, "utf-8");
	if (bytes > MAX_STORE_FILE_BYTES) {
		throw new Error(
			`xiaohongshu-analysis-store: refusing to write ${bytes} bytes > cap ${MAX_STORE_FILE_BYTES} (${file})`,
		);
	}
	mkdirNoSymlink(root, join(file, ".."));
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	// `wx` = O_CREAT|O_EXCL: never follow/overwrite a (possibly symlinked) temp.
	writeFileSync(tmp, json, { mode: 0o600, flag: "wx" });
	renameSync(tmp, file);
}

/**
 * Verify every component from the trusted `root` down to `target` (inclusive,
 * file or dir) is NOT a symlink (codex code review R2#1 — the read/list paths
 * must reject symlinks just like the write path, else a pre-planted symlinked
 * store dir lets reads escape the root). Ancestors of `root` are trusted and
 * not inspected. Returns "missing" if any component is absent (caller treats it
 * as a missing file → null / empty list); throws on a symlinked component.
 */
function pathNoSymlinkUnderRoot(
	root: string,
	target: string,
): "ok" | "missing" {
	const rel = relative(root, target);
	if (rel === "") return "ok";
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(
			`xiaohongshu-analysis-store: ${target} escapes state root ${root}`,
		);
	}
	let cur = root;
	for (const seg of rel.split(sep).filter((s) => s.length > 0)) {
		cur = join(cur, seg);
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(cur);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
			throw err;
		}
		if (st.isSymbolicLink()) {
			throw new Error(
				`xiaohongshu-analysis-store: refusing to read through symlink ${cur}`,
			);
		}
	}
	return "ok";
}

/**
 * Read + parse JSON under the trusted `root`. Rejects symlinked path components
 * (R2#1), returns null for a missing file, and enforces the hard size cap on
 * the READ side (R1#3) so a corrupt/oversized file can't cause an unbounded
 * read+parse.
 */
function readJson<T>(root: string, file: string): T | null {
	if (pathNoSymlinkUnderRoot(root, file) === "missing") return null;
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	if (st.size > MAX_STORE_FILE_BYTES) {
		throw new Error(
			`xiaohongshu-analysis-store: refusing to read ${st.size} bytes > cap ${MAX_STORE_FILE_BYTES} (${file})`,
		);
	}
	return JSON.parse(readFileSync(file, "utf-8")) as T;
}

// ─── local-filesystem implementations ─────────────────────────────────────────

export function createLocalAnalysisStore(stateDir: string): AnalysisStore {
	const dirFor = (p: string, c: string) =>
		join(collectionDir(stateDir, p, c), "analysis");
	return {
		writeRun(run) {
			if (run.schemaVersion !== XIAOHONGSHU_ANALYSIS_SCHEMA_VERSION) {
				throw new Error(
					`xiaohongshu-analysis-store: unsupported analysis schemaVersion ${run.schemaVersion}`,
				);
			}
			const dir = dirFor(run.project, run.collectionId);
			const file = join(dir, `${safeSegment(run.runToken, "runToken")}.json`);
			writeJsonAtomic(stateDir, file, run);
			// Retention: keep the newest N run files; prune older (best-effort).
			let names: string[];
			try {
				names = readdirSync(dir).filter((n) => n.endsWith(".json"));
			} catch {
				return;
			}
			if (names.length <= DEFAULT_ANALYSIS_RETENTION) return;
			// Sort by mtime ascending; remove the oldest beyond the cap.
			const withRun = names
				.map((n) => {
					// A corrupt/oversized old file must not block a new write's
					// retention — treat it as oldest (at:"") so it is pruned first.
					try {
						const r = readJson<XiaohongshuAnalysisRun>(stateDir, join(dir, n));
						return { n, at: r?.generatedAt ?? "" };
					} catch {
						return { n, at: "" };
					}
				})
				.sort((a, b) => a.at.localeCompare(b.at));
			for (const { n } of withRun.slice(
				0,
				withRun.length - DEFAULT_ANALYSIS_RETENTION,
			)) {
				try {
					rmSync(join(dir, n));
				} catch {
					/* best-effort prune */
				}
			}
		},
		readRun(project, collectionId, runToken) {
			const file = join(
				dirFor(project, collectionId),
				`${safeSegment(runToken, "runToken")}.json`,
			);
			const run = readJson<XiaohongshuAnalysisRun>(stateDir, file);
			if (run && run.schemaVersion !== XIAOHONGSHU_ANALYSIS_SCHEMA_VERSION) {
				throw new Error(
					`xiaohongshu-analysis-store: unsupported analysis schemaVersion ${run.schemaVersion} in ${file}`,
				);
			}
			return run;
		},
		listRuns(project, collectionId) {
			const dir = dirFor(project, collectionId);
			// Reject a symlinked store dir before reading it (R2#1).
			if (pathNoSymlinkUnderRoot(stateDir, dir) === "missing") return [];
			try {
				return readdirSync(dir)
					.filter((n) => n.endsWith(".json"))
					.map((n) => n.slice(0, -".json".length));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw err;
			}
		},
	};
}

export function createLocalFeedbackStore(stateDir: string): FeedbackStore {
	const fileFor = (p: string, c: string, runToken: string) =>
		join(
			collectionDir(stateDir, p, c),
			"feedback",
			`${safeSegment(runToken, "runToken")}.json`,
		);
	return {
		writeFeedback(project, collectionId, feedback) {
			if (feedback.schemaVersion !== XIAOHONGSHU_FEEDBACK_SCHEMA_VERSION) {
				throw new Error(
					`xiaohongshu-analysis-store: unsupported feedback schemaVersion ${feedback.schemaVersion}`,
				);
			}
			writeJsonAtomic(
				stateDir,
				fileFor(project, collectionId, feedback.runToken),
				feedback,
			);
		},
		readFeedback(project, collectionId, runToken) {
			const fb = readJson<XiaohongshuFeedbackFile>(
				stateDir,
				fileFor(project, collectionId, runToken),
			);
			if (fb && fb.schemaVersion !== XIAOHONGSHU_FEEDBACK_SCHEMA_VERSION) {
				throw new Error(
					`xiaohongshu-analysis-store: unsupported feedback schemaVersion ${fb.schemaVersion}`,
				);
			}
			return fb;
		},
	};
}
