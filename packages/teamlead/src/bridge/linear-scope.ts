/**
 * FLY-371: shared request-level resolution for the `projectName` → Linear
 * binding mapping used by `/api/linear/create-issue`, `/api/linear/issues`, and
 * `/api/triage/data`.
 *
 * Two helpers, deliberately split:
 *   - `resolveProjectNameParam` — framework-agnostic parse + lookup of the
 *     `projectName` request value (one place, so the three handlers don't drift
 *     on repeated params / empty strings / unknown-vs-no-binding / null binding).
 *   - `resolveLinearScope` — pure merge of explicit list/triage filters over a
 *     binding's defaults (explicit always wins).
 */

import type { ProjectEntry, ProjectLinearBinding } from "../ProjectConfig.js";
import { resolveProjectLinearBinding } from "../ProjectConfig.js";

/** Discriminated result — handlers map `!ok` to `res.status(status).json({error})`. */
export type ProjectNameResolution =
	| { ok: true; binding: ProjectLinearBinding | undefined }
	| { ok: false; status: number; error: string };

/**
 * Resolve a request's `projectName` value to its Linear binding.
 *
 * Accepts `unknown` (Codex R2 MEDIUM-2): create-issue takes `projectName` from a
 * JSON body, where `projectName: 123` is a realistic malformed request — a
 * narrower `string | undefined` signature would make the non-string 400 check
 * unreachable at the type level and invite a cast that drops it.
 *
 * Semantics:
 *   - `undefined`               → ok, binding `undefined` (caller did not opt in;
 *                                 byte-compatible — endpoints behave as before).
 *   - array (repeated param)    → first element, then resolved as below.
 *   - non-string / empty / blank → 400.
 *   - unknown project           → 404 "Unknown Flywheel project".
 *   - known, but no binding /
 *     `linear: null`            → 404 "...has no linear binding" (fail-loud — do
 *                                 NOT silently fall back to an unscoped query).
 *   - known + binding           → ok with the binding.
 */
export function resolveProjectNameParam(
	projects: ProjectEntry[],
	rawProjectName: unknown,
): ProjectNameResolution {
	// Express may hand repeated query params as an array; take the first value
	// to match the existing `Array.isArray(req.query.x) ? x[0] : x` convention.
	const raw = Array.isArray(rawProjectName)
		? rawProjectName[0]
		: rawProjectName;

	if (raw === undefined) return { ok: true, binding: undefined };
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return {
			ok: false,
			status: 400,
			error: "projectName must be a non-empty string",
		};
	}

	const entry = projects.find((p) => p.projectName === raw);
	if (!entry) {
		return {
			ok: false,
			status: 404,
			error: `Unknown Flywheel project "${raw}"`,
		};
	}

	const binding = resolveProjectLinearBinding(projects, raw); // null → undefined
	if (!binding) {
		return {
			ok: false,
			status: 404,
			error: `Flywheel project "${raw}" has no linear binding`,
		};
	}

	return { ok: true, binding };
}

/**
 * Pure merge of explicit list/triage filters over a binding's defaults.
 * Explicit always wins. A binding with both `project` and `label` defaults BOTH
 * (project filter AND label filter) — exactly reproducing the cos's hardcoded
 * `?project=Flywheel&labels=Flywheel`.
 *
 * NOTE (Codex R2 LOW-3): `explicit.labels` is treated as authoritative whenever
 * it is a non-empty array, so callers MUST filter out blank label tokens (e.g.
 * `?labels=` → `[""]`) BEFORE calling this — otherwise a blank suppresses the
 * binding default and produces no useful filter. The endpoint-level tests cover
 * that `?labels=` falls back to the binding label.
 */
export function resolveLinearScope(
	binding: ProjectLinearBinding | undefined,
	explicit: { project?: string; labels?: string[] },
): { project?: string; labels?: string[] } {
	const project = explicit.project ?? binding?.project;
	const labels =
		explicit.labels && explicit.labels.length > 0
			? explicit.labels
			: binding?.label
				? [binding.label]
				: undefined;
	return { project, labels };
}

/**
 * FLY-967 (Codex R1): does a concrete issue fall inside a project binding?
 * Mirrors resolveLinearScope's both-filters semantics: every constraint the
 * binding declares must hold — team key (identifier prefix), project name,
 * and scope label. Used by the read (exact-identifier) and write (comment)
 * proxies so an explicit identifier can never cross the project boundary.
 */
export function issueMatchesBinding(
	issue: { identifier: string; labels: string[]; project: string | null },
	binding: ProjectLinearBinding,
): boolean {
	if (binding.team && issue.identifier.split("-")[0] !== binding.team) {
		return false;
	}
	if (binding.project && issue.project !== binding.project) return false;
	if (binding.label && !issue.labels.includes(binding.label)) return false;
	return true;
}
