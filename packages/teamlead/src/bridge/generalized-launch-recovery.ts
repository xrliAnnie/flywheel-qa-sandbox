import { execFile } from "node:child_process";
import type { WorkflowLaunchOwnerRow } from "../StateStore.js";
import type { ExecutionBodyLivenessReader } from "./execution-body-reader.js";
import type { TmuxTargetLookup } from "./tmux-lookup.js";

export type GeneralizedLaunchLiveness = "alive" | "dead" | "unknown";
export type GeneralizedLaunchTargetLookup = TmuxTargetLookup;

interface GeneralizedLaunchProbeDeps {
	readBodyLiveness?: ExecutionBodyLivenessReader;
}

export type HostProcessByExecutionIdProbe =
	| { verdict: "live"; source: "pgrep" | "process-environment" }
	| { verdict: "absent"; source: "process-environment" }
	| {
			verdict: "unknown";
			source: "pgrep" | "process-environment";
			reason: string;
	  };

/** Read argv and the full host process environment without logging either.
 * Only clean absence from both sensors proves absence; any sensor failure
 * stays conservative through the boolean compatibility wrapper. */
export function hasHostProcessByExecutionId(
	executionId: string,
): Promise<boolean> {
	return probeHostProcessByExecutionId(executionId).then(
		(result) => result.verdict !== "absent",
	);
}

/** Closeout-only tri-state host probe. Sensor failures remain unknown rather
 * than being reported as a live process; the legacy boolean wrapper above
 * still maps unknown to true for its conservative existing callers. */
export function probeHostProcessByExecutionId(
	executionId: string,
): Promise<HostProcessByExecutionIdProbe> {
	return new Promise((resolve) => {
		if (!/^[A-Za-z0-9_.:-]+$/.test(executionId)) {
			resolve({
				verdict: "unknown",
				source: "process-environment",
				reason: "invalid_execution_id",
			});
			return;
		}
		try {
			execFile("pgrep", ["-f", executionId], { timeout: 5_000 }, (error) => {
				if (!error) return resolve({ verdict: "live", source: "pgrep" });
				const code = (error as { code?: number | string }).code;
				if (code !== 1) {
					resolve({
						verdict: "unknown",
						source: "pgrep",
						reason: `pgrep_failed:${String(code ?? "unknown")}`,
					});
					return;
				}
				// Codex's resident daemon/TUI carries the execution identity only in
				// its environment. pgrep inspects argv, so a clean pgrep miss is not
				// absence until the bounded host process snapshot also has no exact
				// FLYWHEEL_EXEC_ID marker. The snapshot is never logged.
				execFile(
					"/bin/ps",
					["eww", "-axo", "pid=,command="],
					{
						timeout: 5_000,
						maxBuffer: 16 * 1024 * 1024,
						encoding: "utf8",
					},
					(psError, stdout) => {
						if (psError || typeof stdout !== "string") {
							const psCode = (psError as { code?: number | string } | null)
								?.code;
							resolve({
								verdict: "unknown",
								source: "process-environment",
								reason: `process_snapshot_failed:${String(psCode ?? "unknown")}`,
							});
							return;
						}
						const marker = `FLYWHEEL_EXEC_ID=${executionId}`;
						const live = stdout
							.split("\n")
							.some((line) =>
								line.split(/\s+/).some((field) => field === marker),
							);
						resolve(
							live
								? { verdict: "live", source: "process-environment" }
								: { verdict: "absent", source: "process-environment" },
						);
					},
				);
			});
		} catch {
			resolve({
				verdict: "unknown",
				source: "pgrep",
				reason: "pgrep_spawn_failed",
			});
		}
	});
}

/** Consume the shared physical-body decision. Missing evidence queues through
 * that reader and remains unknown; presentation metadata grants no authority. */
export async function probeGeneralizedLaunchLiveness(
	executionId: string,
	projectName: string,
	deps: GeneralizedLaunchProbeDeps = {},
): Promise<GeneralizedLaunchLiveness> {
	try {
		const result = deps.readBodyLiveness?.(executionId, projectName);
		return result === "alive" || result === "dead" ? result : "unknown";
	} catch {
		return "unknown";
	}
}

type WorkflowLaunchDeliveryEvidence = Pick<
	WorkflowLaunchOwnerRow,
	"owner_generation" | "committed_generation" | "delivery_state"
>;

interface WorkflowLaunchOwnerReader {
	getWorkflowLaunchOwner(
		executionId: string,
	): WorkflowLaunchDeliveryEvidence | undefined;
}

/** Return only a launch owner whose current generation is durably delivered. */
export function getGeneralizedLaunchDelivery(
	store: WorkflowLaunchOwnerReader,
	executionId: string,
): WorkflowLaunchDeliveryEvidence | undefined {
	const owner = store.getWorkflowLaunchOwner(executionId);
	return owner &&
		owner.committed_generation === owner.owner_generation &&
		owner.delivery_state === "delivered"
		? owner
		: undefined;
}

interface WorkflowLaunchDeliveryWaitOptions {
	timeoutMs?: number;
	intervalMs?: number;
	sleep?: (delayMs: number) => Promise<void>;
}

/** Wait until marker delivery and its current owner generation agree durably. */
export async function waitForGeneralizedLaunchDelivery(
	store: WorkflowLaunchOwnerReader,
	executionId: string,
	options: WorkflowLaunchDeliveryWaitOptions = {},
): Promise<WorkflowLaunchDeliveryEvidence | undefined> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const intervalMs = options.intervalMs ?? 50;
	const sleep =
		options.sleep ??
		((delayMs: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const delivered = getGeneralizedLaunchDelivery(store, executionId);
		if (delivered) return delivered;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return undefined;
		await sleep(Math.min(intervalMs, remaining));
	}
}
