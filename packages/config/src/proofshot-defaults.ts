/**
 * GEO-151 ProofShot — default values for skills.proofshot config.
 *
 * Kept in a separate module so they are stable, dependency-free constants that
 * Bridge handlers can import without pulling in YAML/file-IO surface.
 */

import type { ProofShotConfig } from "./types.js";

/** Default stages where ProofShot auto-trigger fires. */
export const DEFAULT_PROOFSHOT_CAPTURE_STAGES: readonly string[] = [
	"test",
	"code_review",
	"pr_created",
];

/** Default angles for 3D model capture (GeoForge3D). */
export const DEFAULT_PROOFSHOT_CAPTURE_ANGLES: readonly string[] = [
	"front",
	"side",
	"iso",
	"top",
];

/** Default vision token budget for selectVisionArtifacts(). */
export const DEFAULT_PROOFSHOT_VISION_TOKEN_BUDGET = 10_000;

/**
 * Default artifact path allowlist (regex patterns). Only files matching at
 * least one of these patterns may be POSTed via `flywheel-comm notify`.
 *
 * Intentionally narrow: `~/.flywheel/screens/` (default capture output) and
 * `/tmp/flywheel-screens/` (ephemeral debug). Projects can extend via
 * `skills.proofshot.artifact_path_allowlist`.
 */
export const DEFAULT_PROOFSHOT_PATH_ALLOWLIST: readonly string[] = [
	"^/Users/.+/\\.flywheel/screens/",
	"^/tmp/flywheel-screens/",
];

/**
 * Default ProofShot config — applied when project `.flywheel/config.yaml`
 * omits `skills.proofshot` (i.e., project did not opt in). `enabled=false`
 * means the handler short-circuits on every stage_changed event, so this is
 * safe as a global default.
 */
export const DEFAULT_PROOFSHOT_CONFIG: Required<
	Pick<
		ProofShotConfig,
		| "enabled"
		| "capture_stages"
		| "vision_default"
		| "vision_token_budget"
		| "model_capture_angles"
		| "artifact_path_allowlist"
	>
> = {
	enabled: false,
	capture_stages: [...DEFAULT_PROOFSHOT_CAPTURE_STAGES],
	vision_default: true,
	vision_token_budget: DEFAULT_PROOFSHOT_VISION_TOKEN_BUDGET,
	model_capture_angles: [...DEFAULT_PROOFSHOT_CAPTURE_ANGLES],
	artifact_path_allowlist: [...DEFAULT_PROOFSHOT_PATH_ALLOWLIST],
};
