/**
 * FLY-224 — LeadBackendId: the vendor-pluggable Lead seam (plan §5, Phase 0A §1).
 *
 * Distinct from the Runner's `ExecutorBackend`/`TransportBackend` — this names the
 * backend that runs the LEAD itself:
 *   - "claude-code"      — the existing Claude Code tmux-pane Lead (the default).
 *   - "codex-app-server" — a resident Codex app-server Lead (this issue).
 *
 * Also home to the Phase-6b pane-watchdog isolation: only the Claude tmux-pane
 * backend is observable by the pane-text `LeadWatchdog`; a Codex Lead is a process
 * (no pane), so it MUST be excluded or the pane watchdog false-alarms on it
 * (capture-pane finds nothing → spurious freeze/monitoring-lost). Codex Leads get
 * the process-based `LeadHealthProbe` (Phase 6a) instead.
 */

export type LeadBackendId = "claude-code" | "codex-app-server";

/** Byte-compat default: an unset/unknown backend is the existing Claude path. */
export const DEFAULT_LEAD_BACKEND: LeadBackendId = "claude-code";

/** Normalize an arbitrary value to a known LeadBackendId (unknown → default). */
export function normalizeLeadBackend(
	value: string | undefined | null,
): LeadBackendId {
	return value === "codex-app-server"
		? "codex-app-server"
		: DEFAULT_LEAD_BACKEND;
}

/**
 * True only for the backend the pane-text `LeadWatchdog` can observe (the Claude
 * tmux pane). Codex (and any future non-pane backend) is false. An unset/unknown
 * value defaults to the Claude path → pane-watched (byte-compat).
 */
export function isPaneBasedLeadBackend(
	value: LeadBackendId | string | undefined | null,
): boolean {
	return normalizeLeadBackend(value ?? undefined) === "claude-code";
}

/**
 * FLY-247 §2.4: the unified desired-backend precedence — ONE answer for the
 * Dashboard, the watchdog partition, and (via shared conformance fixtures) the
 * fleet CLI's bash implementation:
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
export function effectiveLeadBackend(
	explicit: LeadBackendId | undefined,
	legacy?: string | undefined | null,
): { backend: LeadBackendId; source: "explicit" | "legacy" | "default" } {
	if (explicit !== undefined) {
		return { backend: normalizeLeadBackend(explicit), source: "explicit" };
	}
	if (typeof legacy === "string" && legacy.length > 0) {
		return { backend: normalizeLeadBackend(legacy), source: "legacy" };
	}
	return { backend: DEFAULT_LEAD_BACKEND, source: "default" };
}

/**
 * Partition projects/leads into those the pane-text watchdog should watch vs.
 * those to exclude (non-pane backends, e.g. Codex). Generic over the entry type
 * so callers pass `ProjectEntry[]` without coupling this module to it.
 *
 * BYTE-COMPAT: when every lead is the Claude/default backend, `paneWatched` is the
 * SAME elements in the SAME order as the input — wiring this in front of the
 * existing `LeadWatchdog` is a no-op for an all-Claude deployment.
 */
export function partitionLeadsForPaneWatchdog<T>(
	projects: readonly T[],
	resolveBackend: (project: T) => LeadBackendId | string | undefined,
): { paneWatched: T[]; excluded: T[] } {
	const paneWatched: T[] = [];
	const excluded: T[] = [];
	for (const p of projects) {
		if (isPaneBasedLeadBackend(resolveBackend(p))) paneWatched.push(p);
		else excluded.push(p);
	}
	return { paneWatched, excluded };
}
