/**
 * GEO-151 ProofShot — manifest.json schema + write helper.
 *
 * The wrapper writes `manifest.json` to the capture output dir AFTER
 * `selectVisionArtifacts()` runs. `flywheel-comm notify --paths-from
 * <manifest>` reads it on the Runner side to figure out which paths to POST
 * + recover identity (`execId`, `issue_id`, `project_name`, `dedup_key`,
 * `attempt`).
 *
 * Naming: WIRE form (snake_case JSON) per §3.6.1 of the plan. The handler
 * passes the same fields via `--dedup-key` + `--attempt` CLI flags
 * (kebab-case), and the wrapper writes them into the manifest as snake_case
 * (canonical wire form). TS-internal code uses camelCase `dedupKey` /
 * `attempt`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SelectionResult } from "../select-vision-artifacts.js";

/** Schema of `manifest.json`. */
export interface CaptureManifest {
	/** Selected paths (matches selected.path). */
	selected: string[];
	/** Dropped paths (matches dropped.path). */
	dropped: string[];
	/** Total tokens for selected. */
	totalTokens: number;
	/** "ui" or "3d". */
	captureKind: "ui" | "3d";
	/** Flywheel execution_id. */
	execId: string;
	/** Linear issue_id. */
	issue_id: string;
	/** Project name. */
	project_name: string;
	/** Pipeline stage that triggered the capture. */
	stage: string;
	/** `${execId}|${stage}|${captureKind}` — correlation key. */
	dedup_key: string;
	/** 1-based retry attempt. */
	attempt: number;
}

export interface WriteManifestArgs {
	outputDir: string;
	selection: SelectionResult;
	captureKind: "ui" | "3d";
	execId: string;
	issueId: string;
	projectName: string;
	stage: string;
	dedupKey: string;
	attempt: number;
}

/**
 * Write `outputDir/manifest.json`. Returns the manifest path so the wrapper
 * can echo it in stdout for the Runner step-2 (`flywheel-comm notify
 * --paths-from <manifest>`).
 */
export function writeCaptureManifest(args: WriteManifestArgs): string {
	const manifest: CaptureManifest = {
		selected: args.selection.selected.map((f) => f.path),
		dropped: args.selection.dropped.map((f) => f.path),
		totalTokens: args.selection.totalTokens,
		captureKind: args.captureKind,
		execId: args.execId,
		issue_id: args.issueId,
		project_name: args.projectName,
		stage: args.stage,
		dedup_key: args.dedupKey,
		attempt: args.attempt,
	};
	const path = join(args.outputDir, "manifest.json");
	writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
	return path;
}
