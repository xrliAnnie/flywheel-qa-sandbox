/** Founder-consent production policy, solidified by FLY-1981. */

export type DecisionMode = "off" | "audit_only" | "enforce";

/** Compatibility shape retained for existing callers. Retired inputs are ignored. */
export type DecisionModeEnv = Record<string, string | undefined>;

/** Production always audits; module-level tests may still inject other modes. */
export function resolveDecisionMode(
	_env: DecisionModeEnv,
	_warn: (msg: string) => void = () => {},
): DecisionMode {
	return "audit_only";
}
