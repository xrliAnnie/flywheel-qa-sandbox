/**
 * FLY-159: Shared constants for flywheel-comm gate timeout behavior.
 *
 * Imported by:
 * - flywheel-comm CLI (default --timeout / --timeout-behavior fallback)
 * - edge-worker Blueprint (default cpConfig.timeout_ms when checkpoint
 *   enabled but no project-yaml override)
 * - flywheel-config ConfigLoader (floor validation for project-yaml override)
 *
 * Rationale (see doc/engineer/plan/inprogress/v1.28.0-FLY-159-gate-timeout-48h.md):
 * Gate timeouts are wait-for-human, not wait-for-system. Defaults must be
 * measured in days, not minutes. Project YAML can still tune within the floor.
 */

import type { TimeoutBehavior } from "./types.js";

/**
 * Default gate timeout (CLI fallback + Blueprint injection): 48h.
 *
 * Was 1h (CLI) / 30min (Blueprint) before FLY-159, then 24h (first FLY-159
 * iteration). Bumped to 48h after Annie noted she's regularly offline >24h
 * (travel, long weekends). Humans wait in days, not hours.
 */
export const DEFAULT_GATE_TIMEOUT_MS = 48 * 60 * 60 * 1000;

/**
 * Floor for project-yaml `checkpoints.<name>.timeout_ms`: 4h.
 *
 * Project YAML values below the floor are warn-and-raised (not throw) by
 * ConfigLoader so a misconfigured project still boots. Floor exists to
 * prevent footguns like "1h timeout" that would re-introduce the Designer
 * Runner failure mode FLY-159 was filed for, while still letting projects
 * pick shorter-than-48h gates for spike testing.
 */
export const MIN_GATE_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/**
 * Default timeout behavior (CLI fallback): `fail-close`.
 *
 * Was `fail-open` before FLY-159. fail-open means "silently continue
 * after timeout" — for `approve_to_ship` that's "ship code no one reviewed".
 * Projects that genuinely want soft gates must set
 * `checkpoints.<name>.timeout_behavior: fail-open` explicitly.
 */
export const DEFAULT_TIMEOUT_BEHAVIOR: TimeoutBehavior = "fail-close";

/**
 * Buffer between the gate timeout (48h) and the Runner-side hard caps
 * (Blueprint `waitingTimeoutMs`, TmuxAdapter `BASH_MAX_TIMEOUT_MS`).
 *
 * Runner caps must be `>= DEFAULT_GATE_TIMEOUT_MS + GATE_TIMEOUT_BUFFER_MS`
 * so the gate CLI's fail-close path can fire (resolveGate + POST
 * `gate_timed_out`) before the Runner is killed. Both caps are set to 49h
 * (`176_400_000ms`) elsewhere in the codebase; this constant documents the
 * arithmetic so future tweaks stay consistent.
 */
export const GATE_TIMEOUT_BUFFER_MS = 1 * 60 * 60 * 1000;
