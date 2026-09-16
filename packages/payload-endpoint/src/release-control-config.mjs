// Deployment configuration, never a request-controlled switch. Invalid input
// disables narrow execution and keeps the old clean-release bypass closed.
export function releaseControlFromEnv(env) {
	const refused = { releaseControl: null, releaseDecisionRequired: true };
	const required = env.FW_RELEASE_DECISION_REQUIRED;
	if (
		required !== undefined &&
		required !== "" &&
		required !== "false" &&
		required !== "true"
	)
		return refused;
	const releaseDecisionRequired = required === "true";
	const raw = env.FW_RELEASE_CONTROL_JSON;
	if (raw === undefined || raw === "")
		return { releaseControl: null, releaseDecisionRequired };
	if (
		typeof raw !== "string" ||
		new TextEncoder().encode(raw).byteLength > 4096
	)
		return refused;
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		return refused;
	}
	const fields = [
		"schemaVersion",
		"projectId",
		"audience",
		"activationEpoch",
		"mode",
		"enabled",
	];
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== fields.length ||
		!fields.every((key) => Object.hasOwn(value, key)) ||
		value.schemaVersion !== 1 ||
		value.projectId !== "flywheel" ||
		typeof value.audience !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value.audience) ||
		!Number.isSafeInteger(value.activationEpoch) ||
		value.activationEpoch < 0 ||
		!["off", "observe", "canary"].includes(value.mode) ||
		typeof value.enabled !== "boolean" ||
		(value.enabled && (value.mode !== "canary" || !releaseDecisionRequired))
	)
		return refused;
	const { schemaVersion: _, ...releaseControl } = value;
	return { releaseControl, releaseDecisionRequired };
}
