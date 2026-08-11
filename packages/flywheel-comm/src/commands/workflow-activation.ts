import { existsSync } from "node:fs";
import type { RunnerWorkflowActivation } from "../db.js";
import { CommDB } from "../db.js";

export function currentWorkflowActivationFromEnv(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): RunnerWorkflowActivation | null {
	const dbPath = env.FLYWHEEL_COMM_DB?.trim();
	if (!dbPath || !existsSync(dbPath)) return null;
	const db = CommDB.openReadonly(dbPath);
	try {
		const resolved = db.resolveRunnerWorkflowActivation(executionId);
		if (resolved.state === "stale") {
			throw new Error(
				`workflow activation is not current for ${executionId}: ${resolved.reason}`,
			);
		}
		return resolved.state === "active" ? resolved.activation : null;
	} finally {
		db.close();
	}
}

export function currentWorkflowCompletionActivationFromEnv(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): RunnerWorkflowActivation | null {
	const activation = currentWorkflowActivationFromEnv(executionId, env);
	if (!activation) return null;
	try {
		const context = JSON.parse(activation.context_json) as unknown;
		if (
			context &&
			typeof context === "object" &&
			!Array.isArray(context) &&
			(context as Record<string, unknown>).kind === "runner_ship_carrier"
		) {
			return null;
		}
	} catch {
		// Preserve the activation so the Bridge can fail closed on malformed
		// workflow authority instead of silently falling back by execution id.
	}
	return activation;
}

export function currentWorkflowCredentialFromEnv(input: {
	executionId: string;
	kind: "submission" | "output";
	envName:
		| "FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL"
		| "FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL";
	env?: NodeJS.ProcessEnv;
}): string | undefined {
	const env = input.env ?? process.env;
	const activation = currentWorkflowActivationFromEnv(input.executionId, env);
	if (!activation) return env[input.envName]?.trim() || undefined;
	const credential =
		input.kind === "submission"
			? activation.submission_credential
			: activation.output_credential;
	if (!credential) {
		throw new Error(
			`current workflow activation has no ${input.kind} credential for ${input.executionId}`,
		);
	}
	return credential;
}
