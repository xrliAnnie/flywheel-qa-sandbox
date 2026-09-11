/** Operator-owned process allowlist; project YAML and persisted bindings cannot grant secret access. */
export function betaCredentialAllowed(
	name: string | undefined,
	env: Readonly<Record<string, string | undefined>>,
): boolean {
	if (!name || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) return false;
	const names = (env.FLYWHEEL_BETA_ACTIONS_TOKEN_ENVS ?? "")
		.split(",")
		.map((entry) => entry.trim());
	return (
		names.every((entry) => /^[A-Z][A-Z0-9_]{0,127}$/.test(entry)) &&
		names.includes(name)
	);
}
