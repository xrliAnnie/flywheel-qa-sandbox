import { createHash } from "node:crypto";
import { releaseControlFromEnv } from "./release-control-config.mjs";

// Absence means preserve the deployed secrets. This path never writes false:
// disabling automation retains the same audited founder-decision requirement.
// The decision writer's raw credential stays with Bridge, outside Actions.
export function releaseDeploymentSecrets(env) {
	const names = [
		"FW_RELEASE_CONTROL_JSON",
		"FW_RELEASE_DECISION_REQUIRED",
		"FW_AUTO_RELEASE_EXECUTOR_TOKEN",
		"FW_RELEASE_DECISION_TOKEN_SHA256",
	];
	if (names.every((name) => !env[name])) return {};
	const invalid = () => {
		throw new Error("Invalid B4 deployment configuration");
	};
	const parsed = releaseControlFromEnv(env);
	if (!parsed.releaseControl || env.FW_RELEASE_DECISION_REQUIRED !== "true")
		invalid();
	if (
		typeof env.FW_AUTO_RELEASE_EXECUTOR_TOKEN !== "string" ||
		env.FW_AUTO_RELEASE_EXECUTOR_TOKEN.length < 32
	)
		invalid();
	if (!/^[a-f0-9]{64}$/.test(env.FW_RELEASE_DECISION_TOKEN_SHA256 || ""))
		invalid();
	const hash = (value) => createHash("sha256").update(value).digest("hex");
	const executorHash = hash(env.FW_AUTO_RELEASE_EXECUTOR_TOKEN);
	const decisionHash = env.FW_RELEASE_DECISION_TOKEN_SHA256;
	const hashes = [executorHash, decisionHash];
	for (const name of [
		"FW_BETA_PUBLISH_TOKEN",
		"FW_CUSTOMER_RELEASE_TOKEN",
		"FW_CLEANUP_TOKEN",
	]) {
		if (!env[name]) invalid();
		hashes.push(hash(env[name]));
	}
	if (new Set(hashes).size !== hashes.length) invalid();
	// Insertion order deliberately closes the legacy bypass before granting any
	// narrow capability or enabling a new control epoch. Partial staging stops.
	return {
		FW_RELEASE_DECISION_REQUIRED: "true",
		FW_AUTO_RELEASE_EXECUTOR_TOKEN_SHA256: executorHash,
		FW_RELEASE_DECISION_TOKEN_SHA256: decisionHash,
		FW_RELEASE_CONTROL_JSON: JSON.stringify({
			schemaVersion: 1,
			...parsed.releaseControl,
		}),
	};
}
