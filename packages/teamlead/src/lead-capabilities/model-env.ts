import { isAbsolute, normalize } from "node:path";

/** An allowlist of shell basics, not a token-name denylist. No auth/provider env. */
export const LEAD_MODEL_ENV_NAMES = [
	"HOME",
	"PATH",
	"SHELL",
	"LANG",
	"LC_ALL",
	"TERM",
	"USER",
	"LOGNAME",
] as const;
export interface LeadModelEnvPins {
	codexHome: string;
	brokerSocket: string;
	manifestPath: string;
	artifactRoot: string;
	/** Writable model scratch, separate from broker-owned read-only artifacts. */
	modelTempRoot: string;
	projectName: string;
	leadId: string;
	activationId: string;
}

/**
 * Parent calls this after validating the activation and deployed artifacts. Do
 * not spread raw env or credential-bearing runner context over the returned map.
 * Authenticated clients and alert delivery remain in the trusted parent.
 */
export function buildLeadModelEnv(
	env: NodeJS.ProcessEnv,
	pins: LeadModelEnvPins,
): NodeJS.ProcessEnv {
	for (const value of [
		pins.codexHome,
		pins.brokerSocket,
		pins.manifestPath,
		pins.artifactRoot,
		pins.modelTempRoot,
	]) {
		if (
			!isAbsolute(value) ||
			normalize(value) !== value ||
			value === "/" ||
			[...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
		)
			throw new Error("invalid capability process path");
	}
	if (
		pins.modelTempRoot === pins.artifactRoot ||
		pins.modelTempRoot.startsWith(`${pins.artifactRoot}/`)
	)
		throw new Error("model temp overlaps protected artifacts");
	for (const value of [pins.projectName, pins.leadId, pins.activationId])
		if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(value))
			throw new Error("invalid capability process identity");
	const result: NodeJS.ProcessEnv = {};
	for (const name of LEAD_MODEL_ENV_NAMES)
		if (env[name] !== undefined) result[name] = env[name];
	return {
		...result,
		TERM: result.TERM?.trim() || "xterm-256color",
		LANG: result.LANG?.trim() || "en_US.UTF-8",
		CODEX_HOME: pins.codexHome,
		FLYWHEEL_CODEX_TUI_HOME: pins.codexHome,
		TMPDIR: pins.modelTempRoot,
		FLYWHEEL_PROJECT_NAME: pins.projectName,
		FLYWHEEL_LEAD_ID: pins.leadId,
		FLYWHEEL_LEAD_CAPABILITY_ACTIVATION: pins.activationId,
		FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION: "2",
		FLYWHEEL_CODEX_LEAD_PROFILE: "full-access",
		FLYWHEEL_LEAD_CAPABILITY_SOCKET: pins.brokerSocket,
		FLYWHEEL_LEAD_CAPABILITY_MANIFEST: pins.manifestPath,
	};
}
