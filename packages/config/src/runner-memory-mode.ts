import { createHash } from "node:crypto";

export const RUNNER_MEMORY_MODES = ["off", "split", "role", "shared"] as const;
export type RunnerMemoryMode = (typeof RUNNER_MEMORY_MODES)[number];
export type RunnerMemoryArm = Extract<RunnerMemoryMode, "role" | "shared">;
export type RunnerMemorySelection = "off" | RunnerMemoryArm;

export const RUNNER_MEMORY_MODE_ENV = "FLYWHEEL_RUNNER_MEMORY_MODE";

export function isRunnerMemoryMode(value: unknown): value is RunnerMemoryMode {
	return (
		typeof value === "string" &&
		(RUNNER_MEMORY_MODES as readonly string[]).includes(value)
	);
}

/** Stable 50/50 bucket based on the complete, team-qualified issue identifier. */
export function hashRunnerMemoryArm(issueIdentifier: string): RunnerMemoryArm {
	const digest = createHash("sha256")
		.update(issueIdentifier.trim(), "utf8")
		.digest();
	return (digest[0] ?? 0) % 2 === 0 ? "role" : "shared";
}

/** Resolve the temporary experiment mode into the spawn behavior for one issue. */
export function resolveRunnerMemorySelection(input: {
	mode: unknown;
	issueIdentifier: string;
}): RunnerMemorySelection {
	if (!isRunnerMemoryMode(input.mode) || input.mode === "off") return "off";
	if (input.mode === "split") {
		return hashRunnerMemoryArm(input.issueIdentifier);
	}
	return input.mode;
}
