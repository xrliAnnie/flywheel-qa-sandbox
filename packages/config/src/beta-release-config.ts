/** Defaults apply only after explicit beta configuration and scheduler takeover. */
export const BETA_RELEASE_DEFAULT_INTERVAL_HOURS = 24;

export interface BetaReleaseConfig {
	interval_hours: number;
	workflow_file?: string;
	token_env?: string;
}

export function parseBetaReleaseConfig(
	value: unknown,
): BetaReleaseConfig | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("beta_release must be a mapping");
	}
	const raw = value as Record<string, unknown>;
	if (
		Object.keys(raw).some(
			(key) => !["interval_hours", "workflow_file", "token_env"].includes(key),
		)
	) {
		throw new Error("beta_release contains an unknown field");
	}
	const interval = Object.hasOwn(raw, "interval_hours")
		? raw.interval_hours
		: BETA_RELEASE_DEFAULT_INTERVAL_HOURS;
	if (
		typeof interval !== "number" ||
		!Number.isSafeInteger(interval) ||
		interval < 1 ||
		interval > 168
	) {
		throw new Error(
			"beta_release.interval_hours must be an integer from 1 to 168",
		);
	}
	if (
		Object.hasOwn(raw, "workflow_file") &&
		(typeof raw.workflow_file !== "string" ||
			!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.ya?ml$/.test(raw.workflow_file) ||
			raw.workflow_file.includes(".."))
	) {
		throw new Error(
			"beta_release.workflow_file must be a safe workflow basename",
		);
	}
	if (
		Object.hasOwn(raw, "token_env") &&
		(typeof raw.token_env !== "string" ||
			!/^[A-Z][A-Z0-9_]{0,127}$/.test(raw.token_env))
	) {
		throw new Error(
			"beta_release.token_env must be an environment variable name",
		);
	}
	return {
		interval_hours: interval,
		...(typeof raw.workflow_file === "string"
			? { workflow_file: raw.workflow_file }
			: {}),
		...(typeof raw.token_env === "string" ? { token_env: raw.token_env } : {}),
	};
}
