/**
 * CIPHER dimension extraction — classify execution evidence into pattern dimensions.
 * Pure functions, no I/O.
 */

import type { PatternDimensions, SnapshotInputDto } from "./types.js";

const AUTH_PATHS =
	/\/(auth|login|session|token|password|middleware|guard)\b/i;
const TEST_PATHS = /\.(test|spec)\.(ts|js|tsx|jsx)$|\/__tests__\//;
const FRONTEND_PATHS =
	/\/(components?|pages?|views?|hooks?|styles?|css)\b/i;
const CONFIG_PATHS = /\.(ya?ml|json|toml|env|config)\b/i;

/**
 * Extract pattern dimensions from a SnapshotInputDto.
 * Used at the event-route boundary (TeamLead process) where we have
 * the DTO fields but NOT a full ExecutionContext.
 */
export function extractDimensions(input: SnapshotInputDto): PatternDimensions {
	const primaryLabel = input.labels[0] ?? "unlabeled";

	const totalLines = input.linesAdded + input.linesRemoved;
	const sizeBucket: PatternDimensions["sizeBucket"] =
		totalLines <= 20
			? "tiny"
			: totalLines <= 100
				? "small"
				: totalLines <= 500
					? "medium"
					: "large";

	const areaTouched = classifyArea(input.changedFilePaths);

	const exitStatus = normalizeExitStatus(input.exitReason);

	const hasPriorFailures = input.consecutiveFailures > 0;

	const commitVolume: PatternDimensions["commitVolume"] =
		input.commitCount <= 1
			? "single"
			: input.commitCount <= 5
				? "few"
				: "many";

	const diffScale: PatternDimensions["diffScale"] =
		input.filesChangedCount <= 2
			? "trivial"
			: input.filesChangedCount <= 5
				? "small"
				: input.filesChangedCount <= 15
					? "medium"
					: "large";

	const hasTests = input.changedFilePaths.some((p) => TEST_PATHS.test(p));
	const touchesAuth = input.changedFilePaths.some((p) =>
		AUTH_PATHS.test(p),
	);

	return {
		primaryLabel,
		sizeBucket,
		areaTouched,
		exitStatus,
		hasPriorFailures,
		commitVolume,
		diffScale,
		hasTests,
		touchesAuth,
	};
}

function classifyArea(
	paths: string[],
): PatternDimensions["areaTouched"] {
	if (paths.length === 0) return "mixed";

	let frontend = 0,
		backend = 0,
		auth = 0,
		test = 0,
		config = 0;
	for (const p of paths) {
		if (AUTH_PATHS.test(p)) auth++;
		else if (TEST_PATHS.test(p)) test++;
		else if (CONFIG_PATHS.test(p)) config++;
		else if (FRONTEND_PATHS.test(p)) frontend++;
		else backend++;
	}

	const total = paths.length;
	if (auth > total * 0.5) return "auth";
	if (test > total * 0.5) return "test";
	if (config > total * 0.5) return "config";
	if (frontend > 0 && backend > 0) return "mixed";
	if (frontend > backend) return "frontend";
	return "backend";
}

function normalizeExitStatus(
	exitReason: string,
): PatternDimensions["exitStatus"] {
	if (exitReason === "timeout") return "timeout";
	if (exitReason === "error") return "error";
	return "completed";
}
