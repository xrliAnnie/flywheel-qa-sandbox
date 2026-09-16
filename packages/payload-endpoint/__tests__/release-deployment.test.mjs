import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { releaseDeploymentSecrets } from "../src/release-deployment.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const control = {
	schemaVersion: 1,
	projectId: "flywheel",
	audience: "payload",
	activationEpoch: 4,
	mode: "off",
	enabled: false,
};
const env = {
	FW_RELEASE_CONTROL_JSON: JSON.stringify(control),
	FW_RELEASE_DECISION_REQUIRED: "true",
	FW_AUTO_RELEASE_EXECUTOR_TOKEN: "executor".repeat(8),
	FW_RELEASE_DECISION_TOKEN_SHA256: hash("bridge-only-decision"),
	FW_BETA_PUBLISH_TOKEN: "beta",
	FW_CUSTOMER_RELEASE_TOKEN: "customer",
	FW_CLEANUP_TOKEN: "cleanup",
};
test("absent B4 configuration leaves existing deployment secrets untouched", () => {
	assert.deepEqual(releaseDeploymentSecrets({}), {});
	assert.deepEqual(
		releaseDeploymentSecrets({
			FW_RELEASE_CONTROL_JSON: "",
			FW_RELEASE_DECISION_REQUIRED: "",
		}),
		{},
	);
});
test("explicit disabled deployment keeps strict policy and stages hashes only", () => {
	const secrets = releaseDeploymentSecrets(env);
	assert.deepEqual(secrets, {
		FW_RELEASE_DECISION_REQUIRED: "true",
		FW_AUTO_RELEASE_EXECUTOR_TOKEN_SHA256: hash(
			env.FW_AUTO_RELEASE_EXECUTOR_TOKEN,
		),
		FW_RELEASE_DECISION_TOKEN_SHA256: env.FW_RELEASE_DECISION_TOKEN_SHA256,
		FW_RELEASE_CONTROL_JSON: JSON.stringify(control),
	});
	assert.ok(
		!JSON.stringify(secrets).includes(env.FW_AUTO_RELEASE_EXECUTOR_TOKEN),
	);
});
for (const patch of [
	{ FW_RELEASE_DECISION_REQUIRED: "false" },
	{ FW_RELEASE_DECISION_REQUIRED: "" },
	{ FW_RELEASE_CONTROL_JSON: "" },
	{ FW_RELEASE_CONTROL_JSON: "{" },
	{ FW_AUTO_RELEASE_EXECUTOR_TOKEN: "" },
	{ FW_AUTO_RELEASE_EXECUTOR_TOKEN: "short" },
	{ FW_RELEASE_DECISION_TOKEN_SHA256: "BAD" },
	{
		FW_RELEASE_DECISION_TOKEN_SHA256: hash(env.FW_AUTO_RELEASE_EXECUTOR_TOKEN),
	},
	...[
		"FW_BETA_PUBLISH_TOKEN",
		"FW_CUSTOMER_RELEASE_TOKEN",
		"FW_CLEANUP_TOKEN",
	].flatMap((key) => [
		{ [key]: env.FW_AUTO_RELEASE_EXECUTOR_TOKEN },
		{ FW_RELEASE_DECISION_TOKEN_SHA256: hash(env[key]) },
	]),
])
	test(`reject unsafe deployment patch ${JSON.stringify(Object.keys(patch))}`, () => {
		assert.throws(
			() => releaseDeploymentSecrets({ ...env, ...patch }),
			/Invalid B4 deployment configuration/,
		);
	});
test("observe and canary retain strict policy", () => {
	for (const mode of ["observe", "canary"]) {
		const value = { ...control, mode, enabled: mode === "canary" };
		assert.equal(
			releaseDeploymentSecrets({
				...env,
				FW_RELEASE_CONTROL_JSON: JSON.stringify(value),
			}).FW_RELEASE_DECISION_REQUIRED,
			"true",
		);
	}
});
