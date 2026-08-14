/**
 * FLY-224 — LeadBackendId: the vendor-pluggable Lead seam (plan §5, Phase 0A §1).
 *
 * Distinct from the Runner's `ExecutorBackend`/`TransportBackend` — this names the
 * backend that runs the LEAD itself:
 *   - "claude-code"      — the existing Claude Code tmux-pane Lead (the default).
 *   - "codex-app-server" — a resident Codex app-server Lead (this issue).
 *
 */

import { effectiveLeadBackend as sharedEffectiveLeadBackend } from "flywheel-comm/canonical-lead";

export type LeadBackendId = "claude-code" | "codex-app-server";

/** Byte-compat default: an unset/unknown backend is the existing Claude path. */
export const DEFAULT_LEAD_BACKEND: LeadBackendId = "claude-code";

/**
 * FLY-247 §2.4: the unified desired-backend precedence — ONE answer for the
 * Dashboard and (via shared conformance fixtures) the fleet CLI's bash
 * implementation:
 *
 *   1. explicit `leads[].backend` (projects.json)         → source "explicit"
 *   2. legacy `.flywheel/config.yaml roles.lead.backend`
 *      / `FLYWHEEL_LEAD_BACKEND` (FLY-224 path)           → source "legacy"
 *   3. default                                             → "claude-code"
 *
 * A legacy value is normalized (unknown → claude-code) but keeps its "legacy"
 * source so consumers can label it as migration-pending drift. Empty string /
 * null / undefined legacy means "not set".
 */
export const effectiveLeadBackend = sharedEffectiveLeadBackend;
