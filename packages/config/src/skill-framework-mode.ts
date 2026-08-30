/**
 * FLY-1356 / FLY-1609 — skill_framework_mode experiment switch.
 *
 * Three mutually-exclusive Runner skill-framework arms:
 *   A `superpowers` — status quo (default + kill-switch target)
 *   B `matt`        — mattpocock/skills 6-skill subset (vendored plugin)
 *   C `bare`        — neither framework installed
 *   D `bare-ponytail` — C assembly plus ponytail code-minimalism rules
 * plus the env-only meta value `split` (per-issue stable-hash bucketing).
 *
 * This module owns the RESOLUTION semantics (plan §0 table). The apply layer
 * (Blueprint: per-backend readiness probes, plugin/prompt effect,
 * `noop_backend` marking for backends without an assembly adapter) lives in
 * edge-worker — not here.
 *
 * The resolver is a TOTAL function (Bar-Raiser R1#1): every input combination
 * returns `{mode, via}` and it never throws. In particular a stale per-dispatch
 * override colliding with a kill (env no longer `split`) is IGNORED with a
 * console.warn — never an error that would break an in-flight successor
 * pipeline. Any parse doubt fails closed to `superpowers` (red line #2).
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecutorBackend } from "./types.js";

export const SKILL_FRAMEWORK_MODES = [
	"superpowers",
	"matt",
	"bare",
	"bare-ponytail",
] as const;
export type SkillFrameworkMode = (typeof SKILL_FRAMEWORK_MODES)[number];

export type SkillAssemblyBaseArm = "superpowers" | "matt" | "bare";

/** Keep experimental attribution values out of prompt/plugin assembly APIs. */
export function skillAssemblyBaseArm(
	mode: SkillFrameworkMode,
): SkillAssemblyBaseArm {
	return mode === "bare-ponytail" ? "bare" : mode;
}

/** env-only meta value: per-issue stable-hash split across the four arms. */
export const SKILL_FRAMEWORK_SPLIT = "split";
export const SKILL_FRAMEWORK_MODE_ENV = "FLYWHEEL_SKILL_FRAMEWORK_MODE";

/** How the effective mode was decided — the attribution join key's second half. */
export const SKILL_FRAMEWORK_VIAS = [
	"default", // env unset or invalid (fail-closed)
	"forced", // env explicitly one of the three modes (global force / kill)
	"project_opt_out", // split, but project config skill_framework.split=false
	"inherited", // historical attribution value; no fresh resolver path emits it
	"override", // split, per-dispatch override (529 eval; successor-carried)
	"sticky", // split, same issue already stamped (sessions lookup by issue_id)
	"hash", // split, first admission → stable hash bucket
	"fallback_superpowers", // matt readiness probe failed (Blueprint layer)
	"noop_backend", // backend capability=none: mode recorded, mechanically no-op
] as const;
export type SkillFrameworkVia = (typeof SKILL_FRAMEWORK_VIAS)[number];

export function isSkillFrameworkVia(v: unknown): v is SkillFrameworkVia {
	return (
		typeof v === "string" &&
		(SKILL_FRAMEWORK_VIAS as readonly string[]).includes(v)
	);
}

/** Real-machine spike values (research.md S2). */
export const SUPERPOWERS_PLUGIN_KEY = "superpowers@superpowers-dev";
export const MATT_SKILLS_PLUGIN_KEY = "matt-skills@matt-skills";

/**
 * FLY-1395 — whether a Runner backend can apply a skill-framework arm.
 * Every executor backend must opt in explicitly so adding a backend cannot
 * silently escape the experiment.
 */
export type BackendSkillAssembly = "native" | "none";
export const BACKEND_SKILL_ASSEMBLY: Record<
	ExecutorBackend,
	BackendSkillAssembly
> = {
	"claude-tmux": "native",
	"codex-tmux": "native",
	"antigravity-tmux": "none",
	"kimi-tmux": "none",
};

/** Namespace produced by ~/.agents/skills/superpowers in Codex discovery. */
export const SUPERPOWERS_CODEX_NAMESPACE = "superpowers";

/** Codex's HOME-scoped shared skill root; home override keeps tests hermetic. */
export function defaultAgentsSkillsDir(home: string = homedir()): string {
	return join(home, ".agents", "skills");
}

export function isSkillFrameworkMode(v: unknown): v is SkillFrameworkMode {
	return (
		typeof v === "string" &&
		(SKILL_FRAMEWORK_MODES as readonly string[]).includes(v)
	);
}

/**
 * Stable per-issue bucket: sha256(identifier) first 4 bytes as a big-endian
 * uint32, % 4, bucket order fixed by SKILL_FRAMEWORK_MODES. Deterministic —
 * the same identifier always lands in the same arm.
 */
export function hashModeBucket(identifier: string): SkillFrameworkMode {
	const digest = createHash("sha256").update(identifier).digest();
	// Modulo the fixed arm count is always in range; the cast satisfies
	// noUncheckedIndexedAccess.
	return SKILL_FRAMEWORK_MODES[
		digest.readUInt32BE(0) % SKILL_FRAMEWORK_MODES.length
	] as SkillFrameworkMode;
}

export interface SkillFrameworkResolveArgs {
	/** Raw Bridge-global store control (call_time read → direct-toggleable). */
	raw?: string;
	/** Linear identifier (e.g. "FLY-1356"); hash input on first admission. */
	issueIdentifier: string;
	/** Per-dispatch override (529 eval / successor-carried). split-only. */
	override?: SkillFrameworkMode;
	/** Existing sessions stamp for this issue_id (sticky, R1#4). split-only. */
	priorStamp?: SkillFrameworkMode;
	/**
	 * The sticky-stamp lookup THREW (store read failure) — Codex R1 HIGH-2.
	 * Under `split` this blocks the hash fallthrough: a broken read must fail
	 * closed to A, never land the issue in an experimental arm. split-only.
	 */
	priorStampReadFailed?: boolean;
	/** Project participation (skill_framework.split); default true. */
	projectSplitParticipation?: boolean;
}

/** Validate an optional mode-ish input; junk → undefined + warn (fail-closed). */
function sanitizeMode(
	value: unknown,
	label: string,
): SkillFrameworkMode | undefined {
	if (value === undefined || value === null) return undefined;
	if (isSkillFrameworkMode(value)) return value;
	console.warn(
		`[skill-framework-mode] ignoring invalid ${label}: ${String(value)}`,
	);
	return undefined;
}

/**
 * Plan §0 priority table (high → low). Total function — never throws.
 * The matt readiness fallback and `noop_backend` marking are the Blueprint
 * apply layer's job and deliberately NOT handled here.
 */
export function resolveSkillFrameworkMode(args: SkillFrameworkResolveArgs): {
	mode: SkillFrameworkMode;
	via: SkillFrameworkVia;
} {
	const raw = args.raw;
	const override = sanitizeMode(args.override, "override");
	const priorStamp = sanitizeMode(args.priorStamp, "priorStamp");

	// env unset → default A. A stale override outside `split` is ignored (R1#1).
	if (raw === undefined || raw === "") {
		if (override) {
			console.warn(
				`[skill-framework-mode] override "${override}" ignored: ${SKILL_FRAMEWORK_MODE_ENV} is unset (kill/default in effect)`,
			);
		}
		return { mode: "superpowers", via: "default" };
	}

	// Global force (also the kill-switch position: set back to "superpowers").
	if (isSkillFrameworkMode(raw)) {
		if (override && override !== raw) {
			console.warn(
				`[skill-framework-mode] override "${override}" ignored: flag is forced to "${raw}" (kill-switch semantics — in-flight pipelines proceed as forced)`,
			);
		}
		return { mode: raw, via: "forced" };
	}

	if (raw === SKILL_FRAMEWORK_SPLIT) {
		// Project opt-out lever: false pins the project to A under split.
		if (args.projectSplitParticipation === false) {
			return { mode: "superpowers", via: "project_opt_out" };
		}
		// Explicit per-dispatch arm (529 eval), sticky for the whole pipeline.
		if (override) return { mode: override, via: "override" };
		// Same issue already admitted → keep its bucket (identifier drift-proof).
		if (priorStamp) return { mode: priorStamp, via: "sticky" };
		// Codex R1 HIGH-2: a FAILED stamp read must never fall through to the
		// hash — the issue may already be stamped in another arm (hashing here
		// could split it), and an infrastructure fault must never push an issue
		// INTO an experimental arm. Fail closed to A with the same safety-pin
		// via as the matt readiness fallback (eval hygiene already excludes
		// fallback_superpowers rows — runbook §5). Deliberately AFTER the
		// sticky check: a successfully read stamp is authoritative.
		if (args.priorStampReadFailed) {
			console.warn(
				"[skill-framework-mode] sticky-stamp read failed — failing closed to superpowers (never hash on a broken read)",
			);
			return { mode: "superpowers", via: "fallback_superpowers" };
		}
		return { mode: hashModeBucket(args.issueIdentifier), via: "hash" };
	}

	// Unknown env value → fail closed to A (never silently enter an arm).
	console.warn(
		`[skill-framework-mode] invalid ${SKILL_FRAMEWORK_MODE_ENV}="${raw}" — failing closed to superpowers`,
	);
	return { mode: "superpowers", via: "default" };
}
