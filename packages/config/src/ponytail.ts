/**
 * FLY-615: ponytail (code-minimalism) gradual-rollout resolution — PURE logic.
 *
 * Resolves a per-run ponytail condition from a layered ladder:
 *   per-run flag > per-issue Linear label > D-arm injection > project > default
 *
 * This module is intentionally side-effect free (no fs / exec / network) so it
 * is fully unit-testable. The impure half — checking whether the ponytail
 * plugin is actually installed/usable for the chosen backend ("readiness") — is
 * applied by the caller (Blueprint) AFTER `resolvePonytailRequested`, then
 * folded in via `toPonytailCondition`.
 *
 * Two-stage condition model (Codex design-review R3/R5/R6):
 *   - `requested`  = what the ladder asked for: { want: on|off, source }.
 *   - `effective`  = what actually ran after readiness: on | off | unavailable.
 * The persisted `ponytail_condition` string encodes both, and distinguishes
 * two unavailable classes so retry can behave correctly:
 *   - `unavailable:readiness:<want>:<source>` — request resolved, plugin/node
 *     missing; retry preserves the frozen request and re-runs readiness.
 *   - `unavailable:selector:label_unreadable` — request could NOT be resolved
 *     (Linear labels unreadable while project default is on); retry must
 *     re-resolve from refreshed labels so a recovered `ponytail-off` is honored.
 */

/** Runtime-only project layer synthesized from the scoped flag store. */
export interface PonytailConfig {
	enabled: boolean;
}

/** Canonical plugin id (marketplace `ponytail`, plugin `ponytail`). */
export const PONYTAIL_PLUGIN = "ponytail@ponytail";
/** Linear label that forces ponytail ON for an issue. */
export const PONYTAIL_LABEL_ON = "ponytail";
/** Linear label that forces ponytail OFF for an issue. */
export const PONYTAIL_LABEL_OFF = "ponytail-off";

export type PonytailWant = "on" | "off";
export type PonytailSource = "run" | "label" | "arm" | "project" | "default";
export type PonytailEffective = "on" | "off" | "unavailable";

/** The intent the ladder resolved to (before readiness). */
export interface PonytailRequested {
	want: PonytailWant;
	source: PonytailSource;
}

/**
 * Fresh-start input: NOT pre-collapsed (Codex R4). Carries raw label state so
 * the resolver — which is the only place that also sees project config — can
 * tell "labels unreadable + project off" (byte-compat off) from "labels
 * unreadable + project on" (selector-unavailable).
 */
export interface PonytailRunSignal {
	/** Per-run `/api/runs/start` body override. Highest precedence. */
	runOverride?: PonytailWant;
	/** Lowercased issue labels (only meaningful when labelStatus === "readable"). */
	labels?: string[];
	/** Whether the issue's Linear labels could be read this run. */
	labelStatus: "readable" | "unreadable";
}

/** Blueprint's ponytail input — fresh start vs retry (Codex R5). */
export type PonytailInput =
	| { kind: "start_signal"; signal: PonytailRunSignal }
	| { kind: "frozen_requested"; requested: PonytailRequested };

/** Retry carries both predecessor intent and a trustworthy current selector. */
export interface PonytailRetryInput {
	frozen?: PonytailRequested;
	freshSignal: PonytailRunSignal;
}

/** Result of the pure ladder resolution. */
export type ResolvePonytailResult =
	| { kind: "resolved"; requested: PonytailRequested }
	/** Labels unreadable while project default is on — undecidable; fail-loud,
	 *  retry must re-resolve from refreshed labels (do NOT freeze as on:project). */
	| { kind: "selector_unavailable" };

/** Thrown when an issue carries BOTH `ponytail` and `ponytail-off` labels. */
export class PonytailLabelConflictError extends Error {
	constructor() {
		super(
			`Issue has both "${PONYTAIL_LABEL_ON}" and "${PONYTAIL_LABEL_OFF}" labels — ambiguous ponytail intent, refusing to guess.`,
		);
		this.name = "PonytailLabelConflictError";
	}
}

/**
 * Pure ladder resolution. Throws `PonytailLabelConflictError` on conflicting
 * labels (fail-loud). Returns `selector_unavailable` only for the
 * label-unreadable-under-project-on case.
 *
 * @param input         start_signal (resolve fresh) or frozen_requested (retry).
 * @param projectConfig the per-project `ponytail` config (undefined = no project layer).
 */
export function resolvePonytailRequested(
	input: PonytailInput,
	projectConfig: PonytailConfig | undefined,
	opts: { armInject?: boolean } = {},
): ResolvePonytailResult {
	// Retry of a previously-resolved request: return verbatim, never re-resolve
	// (keeps A/B bucket + source stable across retries).
	if (input.kind === "frozen_requested") {
		return { kind: "resolved", requested: { ...input.requested } };
	}

	const sig = input.signal;

	// 1. per-run override — explicit, beats everything (incl. label read failure).
	if (sig.runOverride === "on") {
		return { kind: "resolved", requested: { want: "on", source: "run" } };
	}
	if (sig.runOverride === "off") {
		return { kind: "resolved", requested: { want: "off", source: "run" } };
	}

	const projectOn = projectConfig?.enabled === true;

	// 2. per-issue label — but only if labels were actually readable.
	if (sig.labelStatus === "unreadable") {
		// Can't read labels. Only dangerous to fall through when the project is
		// rolling ponytail ON (an unseen `ponytail-off` could be exempting this
		// issue) → selector-unavailable. When the project is off/absent, ponytail
		// was never requested → plain `off:default`, fully byte-compatible.
		if (opts.armInject || projectOn) {
			return { kind: "selector_unavailable" };
		}
		return { kind: "resolved", requested: { want: "off", source: "default" } };
	}

	const labels = sig.labels ?? [];
	const hasOn = labels.includes(PONYTAIL_LABEL_ON);
	const hasOff = labels.includes(PONYTAIL_LABEL_OFF);
	if (hasOn && hasOff) {
		throw new PonytailLabelConflictError();
	}
	if (hasOff) {
		return { kind: "resolved", requested: { want: "off", source: "label" } };
	}
	if (hasOn) {
		return { kind: "resolved", requested: { want: "on", source: "label" } };
	}

	// 3. D-arm injection. It deliberately owns attribution ahead of the project
	// layer so a D session never masquerades as ordinary project rollout.
	if (opts.armInject) {
		return { kind: "resolved", requested: { want: "on", source: "arm" } };
	}

	// 4. per-project default.
	if (projectOn) {
		return { kind: "resolved", requested: { want: "on", source: "project" } };
	}

	// 5. default off.
	return { kind: "resolved", requested: { want: "off", source: "default" } };
}

/** A fully-resolved per-run ponytail condition (drives spawn + persisted tag). */
export interface PonytailCondition {
	effective: PonytailEffective;
	requested: PonytailRequested;
	/** Compact persisted form (the `ponytail_condition` session column). */
	encoded: string;
}

/**
 * Fold readiness into a resolved request to produce the final condition.
 * Only `want: "on"` consults readiness; `want: "off"` is always effective off.
 *
 * @param requested   the ladder result.
 * @param readinessOk whether ponytail is actually usable for this run's backend
 *                    (plugin installed + node present, etc). Ignored for off.
 */
export function toPonytailCondition(
	requested: PonytailRequested,
	readinessOk: boolean,
): PonytailCondition {
	if (requested.want === "off") {
		return {
			effective: "off",
			requested,
			encoded: `off:${requested.source}`,
		};
	}
	if (readinessOk) {
		return {
			effective: "on",
			requested,
			encoded: `on:${requested.source}`,
		};
	}
	return {
		effective: "unavailable",
		requested,
		encoded: `unavailable:readiness:${requested.want}:${requested.source}`,
	};
}

/** The selector-unavailable condition (labels unreadable under project-on). */
export const PONYTAIL_SELECTOR_UNAVAILABLE =
	"unavailable:selector:label_unreadable";

/**
 * Conflict condition: an issue carried BOTH `ponytail` and `ponytail-off`. We
 * refuse to guess — the run proceeds WITHOUT ponytail, but is recorded as a
 * distinct `unavailable:conflict` (NOT a silent `off:default`) so it is loud +
 * excluded from FLY-614/616 A/B buckets. Retry re-resolves (labels may be fixed).
 */
export const PONYTAIL_CONFLICT = "unavailable:conflict";

/**
 * Decode a persisted `ponytail_condition` into the retry input. Readiness and
 * normally-resolved conditions become a `frozen_requested` (preserve the A/B
 * bucket); the selector-unavailable condition signals the caller to re-resolve
 * from refreshed labels.
 */
export type PonytailRetryPlan =
	| { kind: "frozen"; requested: PonytailRequested }
	| { kind: "reresolve" };

export function decodePonytailConditionForRetry(
	encoded: string | null | undefined,
): PonytailRetryPlan | null {
	if (!encoded) return null;
	// selector-unavailable + conflict both re-resolve on retry (labels may have
	// recovered / been de-conflicted), never freeze the degraded state.
	if (
		encoded === PONYTAIL_SELECTOR_UNAVAILABLE ||
		encoded === PONYTAIL_CONFLICT
	) {
		return { kind: "reresolve" };
	}
	const parts = encoded.split(":");
	// unavailable:readiness:<want>:<source>
	if (parts[0] === "unavailable" && parts[1] === "readiness") {
		const want = parts[2];
		const source = parts[3];
		if (isWant(want) && isSource(source)) {
			return { kind: "frozen", requested: { want, source } };
		}
		return null;
	}
	// <on|off>:<source>
	if ((parts[0] === "on" || parts[0] === "off") && parts.length === 2) {
		const want = parts[0];
		const source = parts[1];
		if (isWant(want) && isSource(source)) {
			return { kind: "frozen", requested: { want, source } };
		}
	}
	return null;
}

function isWant(v: string | undefined): v is PonytailWant {
	return v === "on" || v === "off";
}
function isSource(v: string | undefined): v is PonytailSource {
	return (
		v === "run" ||
		v === "label" ||
		v === "arm" ||
		v === "project" ||
		v === "default"
	);
}
