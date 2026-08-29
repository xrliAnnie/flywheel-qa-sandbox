/**
 * FLY-709 P5 — runner-default stage/apply route handlers (dep-injected, testable).
 *
 * Mirrors the flag route family (flag-routes.ts) so the unified console can
 * apply per-project `roles.runner` model/effort/backend changes through the SAME
 * audited, loopback + same-origin + confirmToken surface as lead/flag changes —
 * instead of the P4 copy-paste-only path. The Bridge mounts these behind the
 * fleet auth block (NOT Bearer). Runner writes only change `config.yaml` (applies
 * to NEW runs — no Lead restart), so a submit that includes runner changes never
 * disrupts a running Lead.
 *
 *  - stage: server resolves projectRoot from liveProjects (EXACTLY one; the
 *    browser never supplies a root), reads config.yaml, computes fileSha,
 *    validates the change args, records a FAIL-CLOSED `staged` audit row
 *    (Codex R2 #1 — no token if intent can't be recorded), issues a SHA-bound
 *    single-use confirmToken.
 *  - apply: verifyAndConsume the token, record a FAIL-CLOSED `apply-requested`
 *    row (no write if it can't be recorded), then `applyRunnerDefaults(...,
 *    { expectedSha })` which re-checks the reviewed SHA INSIDE the config-file
 *    lock (drift → 409, zero bytes) and writes atomically.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	type ApplyResult,
	applyRunnerDefaults,
	EXECUTOR_BACKENDS,
	ROLE_EFFORT_LEVELS,
	RunnerConfigStaleError,
	type RunnerDefaultsChange,
} from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { ConfirmTokenStore } from "./fleet-admin.js";
import { newBatchId } from "./fleet-admin.js";
import type { FleetAdminAudit } from "./fleet-admin-audit.js";

/** The re-verifiable runner-default change (project + dims + reviewed SHA). */
export interface RunnerCanonical {
	kind: "runner";
	batchId: string;
	project: string;
	change: RunnerDefaultsChange;
	/** SHA-256 of the reviewed config.yaml content at stage time. */
	fileSha: string;
}

export interface RunnerRouteDeps {
	/** Live project topology; projectRoot is resolved from HERE, never the client. */
	liveProjects: () => ProjectEntry[];
	/** Read a config.yaml (defaults to fs; injectable for tests). */
	readFile: (path: string) => string;
	/** The writer (defaults to applyRunnerDefaults; injectable for tests). */
	apply?: (
		configPath: string,
		change: RunnerDefaultsChange,
		opts: { expectedSha?: string },
	) => Promise<ApplyResult>;
	tokens: ConfirmTokenStore;
	audit: FleetAdminAudit;
}

export interface RouteResult {
	code: number;
	body: unknown;
}

/** Stable SHA the confirmToken binds to. */
export function runnerCanonicalSha(c: RunnerCanonical): string {
	return createHash("sha256").update(JSON.stringify(c)).digest("hex");
}

/** Resolve EXACTLY one live project's config.yaml path — server-side only. */
function resolveConfigPath(
	deps: RunnerRouteDeps,
	project: string,
): { configPath: string } | { error: string } {
	const matches = deps.liveProjects().filter((p) => p.projectName === project);
	if (matches.length > 1) {
		return {
			error: `ambiguous project "${project}" (${matches.length} entries)`,
		};
	}
	const only = matches[0];
	if (!only) return { error: `unknown project "${project}"` };
	return {
		configPath: join(only.projectRoot, ".flywheel", "config.yaml"),
	};
}

/** Validate the change body (Codex R1 #6): only model|effort|backend, closed enums. */
function validateChange(
	change: unknown,
): RunnerDefaultsChange | { error: string } {
	if (change == null || typeof change !== "object") {
		return { error: "change (object) is required" };
	}
	const c = change as Record<string, unknown>;
	const allowed = new Set(["model", "effort", "backend"]);
	for (const k of Object.keys(c)) {
		if (!allowed.has(k)) return { error: `unknown change dimension "${k}"` };
	}
	const out: RunnerDefaultsChange = {};
	for (const dim of ["model", "effort", "backend"] as const) {
		if (!(dim in c)) continue;
		const v = c[dim];
		if (v !== null && typeof v !== "string") {
			return { error: `change.${dim} must be a string or null` };
		}
		out[dim] = v as string | null;
	}
	if (
		out.backend != null &&
		!EXECUTOR_BACKENDS.includes(out.backend as never)
	) {
		return { error: `unknown backend "${out.backend}"` };
	}
	if (out.effort != null && !ROLE_EFFORT_LEVELS.includes(out.effort as never)) {
		return { error: `unknown effort "${out.effort}"` };
	}
	if (
		out.model === undefined &&
		out.effort === undefined &&
		out.backend === undefined
	) {
		return { error: "no change — give at least one of model/effort/backend" };
	}
	return out;
}

export function handleRunnerStage(
	deps: RunnerRouteDeps,
	input: { project?: unknown; change?: unknown },
	origin: string,
): RouteResult {
	if (typeof input?.project !== "string") {
		return { code: 400, body: { error: "project (string) is required" } };
	}
	const change = validateChange(input.change);
	if ("error" in change) return { code: 400, body: { error: change.error } };
	const resolved = resolveConfigPath(deps, input.project);
	if ("error" in resolved)
		return { code: 400, body: { error: resolved.error } };
	let content: string;
	try {
		content = deps.readFile(resolved.configPath);
	} catch (err) {
		// Missing/unreadable config → reject at stage (no token; Codex R1 #6).
		return {
			code: 400,
			body: { error: `no readable config.yaml: ${(err as Error).message}` },
		};
	}
	const canonical: RunnerCanonical = {
		kind: "runner",
		batchId: newBatchId(),
		project: input.project,
		change,
		fileSha: createHash("sha256").update(content, "utf8").digest("hex"),
	};
	// FAIL-CLOSED audit (Codex R2 #1): no token if intent can't be recorded.
	if (
		!deps.audit.record({
			batchId: canonical.batchId,
			event: "staged",
			canonicalRequest: JSON.stringify(canonical),
			origin,
		})
	) {
		return {
			code: 503,
			body: { error: "audit unavailable — refusing to stage" },
		};
	}
	const confirmToken = deps.tokens.issue(runnerCanonicalSha(canonical));
	return { code: 200, body: { canonical, confirmToken } };
}

export async function handleRunnerApply(
	deps: RunnerRouteDeps,
	canonical: RunnerCanonical,
	confirmToken: string,
	origin: string,
): Promise<RouteResult> {
	const sha = runnerCanonicalSha(canonical);
	const attemptId = confirmToken.slice(0, 16);
	const verdict = deps.tokens.verifyAndConsume(confirmToken, sha);
	if (!verdict.ok) {
		deps.audit.record({
			batchId: canonical.batchId,
			event: "denied",
			attemptId,
			reason: verdict.reason,
			origin,
		});
		return { code: 401, body: { error: verdict.reason } };
	}
	const resolved = resolveConfigPath(deps, canonical.project);
	if ("error" in resolved) {
		deps.audit.record({
			batchId: canonical.batchId,
			event: "denied",
			attemptId,
			reason: resolved.error,
			origin,
		});
		return { code: 400, body: { error: resolved.error } };
	}
	// FAIL-CLOSED pre-write audit (Codex R2 #1): no config write if it can't record.
	if (
		!deps.audit.record({
			batchId: canonical.batchId,
			event: "apply-requested",
			attemptId,
			canonicalRequest: JSON.stringify(canonical),
			origin,
		})
	) {
		return {
			code: 503,
			body: { error: "audit unavailable — refusing to apply" },
		};
	}
	const apply = deps.apply ?? applyRunnerDefaults;
	try {
		const result = await apply(resolved.configPath, canonical.change, {
			expectedSha: canonical.fileSha,
		});
		deps.audit.record({
			batchId: canonical.batchId,
			event: "apply-result",
			result: "applied",
			origin,
		});
		return { code: 200, body: { ok: true, changed: result.changed } };
	} catch (err) {
		const stale = err instanceof RunnerConfigStaleError;
		deps.audit.record({
			batchId: canonical.batchId,
			event: "denied",
			attemptId,
			reason: (err as Error).message,
			origin,
		});
		return {
			code: stale ? 409 : 500,
			body: { error: (err as Error).message },
		};
	}
}
