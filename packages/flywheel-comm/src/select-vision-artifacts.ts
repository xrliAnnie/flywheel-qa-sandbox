/**
 * GEO-151 ProofShot — deterministic vision artifact selector.
 *
 * Picks which capture artifacts the Runner should `Read` for V1 self-vision,
 * staying under a token budget. The contract:
 *
 * - **SUMMARY.md** (any file named `SUMMARY.md` or `summary.md`) is always
 *   selected — it's the cheapest single source of truth for the capture.
 * - **WebM** (and other video formats) are NEVER selected — multimodal Read
 *   does not OCR video efficiently and the byte size blows the budget.
 * - **PNG** is ranked by category: error/key frames first, then first/last,
 *   then anything else. Up to 3 PNGs by default.
 * - **Token estimate**: SUMMARY ≈ 500 tokens (text), PNG ≈ 1500 tokens
 *   (1280×720 multimodal). Numbers are intentionally conservative.
 * - **Budget exceeded**: if the candidate selection blows the budget, we
 *   downgrade to `[SUMMARY, last-PNG]` (or just `[SUMMARY]` if no PNG fits)
 *   so the Runner gets at least the text summary and a final shot.
 *
 * Pure function — does NOT touch the filesystem. Caller provides the file
 * inventory (path + bytes + kind). Wrapper code in
 * `packages/flywheel-comm/src/commands/visual-capture.ts` is responsible for
 * stat-ing the output dir and assigning `kind`.
 */

/** Categorized capture artifact descriptor. */
export interface ArtifactFile {
	/** Absolute filesystem path (caller-resolved). */
	path: string;
	/** File size in bytes (informational; not used directly in token estimate). */
	bytes: number;
	/** Artifact category (drives selection ranking). */
	kind: "summary" | "png" | "webm" | "other";
	/**
	 * Optional hint that this PNG marks an error/failure step (e.g., test
	 * assertion failure). Errors are ranked first within the PNG bucket so
	 * Runner sees them even when budget is tight.
	 */
	isError?: boolean;
	/**
	 * Optional hint that this PNG marks a "key" step (e.g., explicit
	 * `proofshot exec key`). Ranked after errors but before generic frames.
	 */
	isKey?: boolean;
}

/** Result of selection — the lists are disjoint and totalTokens is the sum over `selected`. */
export interface SelectionResult {
	selected: ArtifactFile[];
	dropped: ArtifactFile[];
	totalTokens: number;
}

/** Token estimate per artifact kind. Conservative numbers. */
export const SUMMARY_TOKEN_ESTIMATE = 500;
export const PNG_TOKEN_ESTIMATE = 1500;

/** Default cap on PNGs selected per capture (after error/key ranking). */
export const DEFAULT_PNG_LIMIT = 3;

/**
 * Estimate tokens for a single artifact. Pure — does NOT touch the file.
 * WebM/other return 0 because we never select them, so they never enter
 * the budget calculation either.
 */
export function estimateArtifactTokens(file: ArtifactFile): number {
	if (file.kind === "summary") return SUMMARY_TOKEN_ESTIMATE;
	if (file.kind === "png") return PNG_TOKEN_ESTIMATE;
	return 0;
}

/**
 * Internal: rank PNGs for inclusion. Lower rank wins (sorts ascending).
 * Tie-break by original index so the result is deterministic across
 * stable sorts (`Array.prototype.sort` is stable in Node 22+).
 */
interface RankedPng {
	file: ArtifactFile;
	rank: number;
	originalIndex: number;
}

function rankPng(file: ArtifactFile, idx: number, total: number): RankedPng {
	let rank = 100; // generic frame
	if (file.isError) rank = 0;
	else if (file.isKey) rank = 10;
	else if (idx === 0)
		rank = 20; // first frame
	else if (idx === total - 1) rank = 25; // last frame
	return { file, rank, originalIndex: idx };
}

/**
 * Select artifacts up to `budget` tokens.
 *
 * @param files - All artifacts produced by a single ProofShot capture session.
 *                Order matters for PNG first/last ranking.
 * @param budget - Maximum token total allowed across selected files.
 * @param options - Optional override for max PNG selections (default 3).
 */
export function selectVisionArtifacts(
	files: ArtifactFile[],
	budget: number,
	options: { pngLimit?: number } = {},
): SelectionResult {
	const pngLimit = options.pngLimit ?? DEFAULT_PNG_LIMIT;

	// Bucket
	const summaries: ArtifactFile[] = [];
	const pngs: ArtifactFile[] = [];
	const dropped: ArtifactFile[] = [];

	for (const f of files) {
		if (f.kind === "summary") summaries.push(f);
		else if (f.kind === "png") pngs.push(f);
		else dropped.push(f); // webm / other — never selected
	}

	// Always pick SUMMARY if present. If multiple, take all (they're cheap).
	// Cap at one to be safe — multiple summaries is a wrapper bug and double
	// counting would skew the budget.
	const selectedSummaries = summaries.slice(0, 1);
	if (summaries.length > 1) dropped.push(...summaries.slice(1));

	// Rank PNGs and take up to pngLimit by ranking.
	const rankedPngs = pngs
		.map((f, idx) => rankPng(f, idx, pngs.length))
		.sort((a, b) => a.rank - b.rank || a.originalIndex - b.originalIndex);
	const topPngs = rankedPngs.slice(0, pngLimit).map((r) => r.file);
	const droppedRankedPngs = rankedPngs.slice(pngLimit).map((r) => r.file);
	dropped.push(...droppedRankedPngs);

	// Compute candidate selection + tokens.
	const candidate: ArtifactFile[] = [...selectedSummaries, ...topPngs];
	const totalTokens = candidate.reduce(
		(sum, f) => sum + estimateArtifactTokens(f),
		0,
	);

	if (totalTokens <= budget) {
		return { selected: candidate, dropped, totalTokens };
	}

	// Downgrade path: SUMMARY + last PNG only (deterministic — last by
	// original index). If that still blows the budget (e.g., budget < 2000),
	// fall back to SUMMARY only.
	const summaryTokens = selectedSummaries.reduce(
		(s, f) => s + estimateArtifactTokens(f),
		0,
	);
	const lastPng = pngs.length > 0 ? pngs[pngs.length - 1]! : undefined;
	const downgradeCandidate: ArtifactFile[] = [...selectedSummaries];
	if (lastPng && summaryTokens + PNG_TOKEN_ESTIMATE <= budget) {
		downgradeCandidate.push(lastPng);
	}

	// Anything in the original candidate that didn't make the downgrade
	// goes to dropped.
	const downgradeSet = new Set(downgradeCandidate.map((f) => f.path));
	for (const f of candidate) {
		if (!downgradeSet.has(f.path)) {
			dropped.push(f);
		}
	}
	// Dedupe `dropped` (last PNG might have been in topPngs already if it
	// wasn't ranked top-3 by error/key — but the downgrade path put it in
	// candidate. Avoid showing it twice).
	const droppedSet = new Set<string>();
	const dedupedDropped: ArtifactFile[] = [];
	for (const f of dropped) {
		if (droppedSet.has(f.path)) continue;
		if (downgradeSet.has(f.path)) continue;
		droppedSet.add(f.path);
		dedupedDropped.push(f);
	}

	const downgradeTotal = downgradeCandidate.reduce(
		(s, f) => s + estimateArtifactTokens(f),
		0,
	);

	return {
		selected: downgradeCandidate,
		dropped: dedupedDropped,
		totalTokens: downgradeTotal,
	};
}
