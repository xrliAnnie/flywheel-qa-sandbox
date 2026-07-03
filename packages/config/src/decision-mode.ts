/**
 * Founder-consent DECISION_MODE parser — extracted to flywheel-config (FLY-709 F3).
 *
 * Originally lived in packages/teamlead/src/bridge/founder-consent/config.ts.
 * The feature-flag registry resolver (FLY-709) needs to compute the effective
 * value of the DECISION_MODE governance gate, but flywheel-config MUST NOT depend
 * on flywheel-teamlead (see packages/config/src/types.ts). So the small parser
 * lives here; teamlead re-imports it. The heavier parseFounderConsentConfig()
 * stays in teamlead.
 *
 * Behavior is preserved byte-for-byte from the original (reverse-compat sentinel
 * in __tests__/decision-mode.test.ts): canonical value wins (invalid → throw),
 * legacy FLYWHEEL_FOUNDER_CONSENT_ENABLED aliases to enforce only when canonical
 * is absent.
 */

export type DecisionMode = "off" | "audit_only" | "enforce";

/** Minimal env shape (NodeJS.ProcessEnv is assignable to this). */
export type DecisionModeEnv = Record<string, string | undefined>;

/**
 * Resolve the operating mode from the canonical env + legacy alias.
 * Precedence:
 *   1. FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE present → wins (warn if ENABLED also set);
 *      an invalid value THROWS (never falls back).
 *   2. absent + FLYWHEEL_FOUNDER_CONSENT_ENABLED truthy → "enforce".
 *   3. otherwise → "off".
 */
export function resolveDecisionMode(
	env: DecisionModeEnv,
	warn: (msg: string) => void = () => {},
): DecisionMode {
	const raw = env.FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE?.trim();
	const enabledRaw = env.FLYWHEEL_FOUNDER_CONSENT_ENABLED?.trim();
	const enabled = enabledRaw === "true" || enabledRaw === "1";

	if (raw) {
		if (raw !== "off" && raw !== "audit_only" && raw !== "enforce") {
			throw new Error(
				`FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE must be off|audit_only|enforce, got "${raw}"`,
			);
		}
		if (enabledRaw !== undefined) {
			warn(
				"FLYWHEEL_FOUNDER_CONSENT_ENABLED is set but DECISION_MODE takes precedence; legacy alias ignored",
			);
		}
		return raw as DecisionMode;
	}

	return enabled ? "enforce" : "off";
}
