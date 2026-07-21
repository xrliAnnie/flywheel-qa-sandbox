import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { CommDB } from "flywheel-comm/db";
import type {
	WorkflowDeadExecutionActivityBaseline,
	WorkflowDeadExecutionActivityEvidence,
	WorkflowDeadExecutionCommitMarkerBaseline,
	WorkflowDeadExecutionWatchRow,
} from "../StateStore.js";
import { commDbPathForProject } from "./commdb-path.js";
import { defaultExecCapture } from "./session-capture.js";
import { lookupTmuxTarget } from "./tmux-lookup.js";

type ActivityTmuxTarget =
	| { kind: "found"; target: string }
	| { kind: "gone" }
	| { kind: "error" };

export interface DeadExecutionActivityProbeDeps {
	statCommitMarker: (path: string) => WorkflowDeadExecutionCommitMarkerBaseline;
	countCommDbMessages: (
		executionId: string,
		projectName: string,
	) => number | null;
	resolveTmuxTarget: (
		executionId: string,
		projectName: string,
	) => ActivityTmuxTarget;
	captureTmuxOutput: (target: string) => Promise<string | null>;
}

function outputDigest(output: string): string {
	return createHash("sha256").update(output).digest("hex");
}

function defaultStatCommitMarker(
	path: string,
): WorkflowDeadExecutionCommitMarkerBaseline {
	try {
		return { state: "present", mtimeMs: statSync(path).mtimeMs };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { state: "absent" }
			: { state: "unknown" };
	}
}

/** Reuses CommDB's execution-bound message ledger; errors stay unknown. */
function defaultCountCommDbMessages(
	executionId: string,
	projectName: string,
): number | null {
	if (/[/\\]|\.\./.test(projectName)) return null;
	const dbPath = commDbPathForProject(projectName);
	if (!existsSync(dbPath)) return 0;
	let db: CommDB | undefined;
	try {
		db = CommDB.openReadonly(dbPath);
		return db.countMessagesFrom(executionId);
	} catch {
		return null;
	} finally {
		db?.close();
	}
}

function defaultResolveTmuxTarget(
	executionId: string,
	projectName: string,
): ActivityTmuxTarget {
	const target = lookupTmuxTarget(executionId, projectName);
	if (target.kind === "found") {
		return { kind: "found", target: target.target.tmuxWindow };
	}
	return target.kind === "gone" ? { kind: "gone" } : { kind: "error" };
}

async function defaultCaptureTmuxOutput(
	target: string,
): Promise<string | null> {
	try {
		// A bounded tail is enough to detect renewed output without making every
		// one-second patrol copy unbounded scrollback.
		return await defaultExecCapture(target, 200);
	} catch {
		return null;
	}
}

const DEFAULT_DEPS: DeadExecutionActivityProbeDeps = {
	statCommitMarker: defaultStatCommitMarker,
	countCommDbMessages: defaultCountCommDbMessages,
	resolveTmuxTarget: defaultResolveTmuxTarget,
	captureTmuxOutput: defaultCaptureTmuxOutput,
};

export async function captureDeadExecutionActivityBaseline(
	input: {
		executionId: string;
		projectName: string;
		markerPath: string;
		sessionCommitCount: number | null;
	},
	deps: DeadExecutionActivityProbeDeps = DEFAULT_DEPS,
): Promise<WorkflowDeadExecutionActivityBaseline> {
	const tmux = deps.resolveTmuxTarget(input.executionId, input.projectName);
	const tmuxTarget = tmux.kind === "found" ? tmux.target : null;
	const tmuxOutput = tmuxTarget
		? await deps.captureTmuxOutput(tmuxTarget)
		: null;
	return {
		commitMarker: deps.statCommitMarker(input.markerPath),
		commDbMessageCount: deps.countCommDbMessages(
			input.executionId,
			input.projectName,
		),
		tmuxTarget,
		tmuxOutputDigest: tmuxOutput === null ? null : outputDigest(tmuxOutput),
		sessionCommitCount: input.sessionCommitCount,
	};
}

export async function probeDeadExecutionActivity(
	input: {
		watch: WorkflowDeadExecutionWatchRow;
		markerPath: string;
		sessionCommitCount: number | null;
	},
	deps: DeadExecutionActivityProbeDeps = DEFAULT_DEPS,
): Promise<WorkflowDeadExecutionActivityEvidence | null> {
	const baseline = input.watch.baseline;
	const marker = deps.statCommitMarker(input.markerPath);
	if (
		marker.state === "present" &&
		(baseline.commitMarker.state === "absent" ||
			(baseline.commitMarker.state === "present" &&
				marker.mtimeMs > baseline.commitMarker.mtimeMs))
	) {
		return {
			kind: "commit_marker",
			detail:
				baseline.commitMarker.state === "present"
					? `launch commit marker mtime advanced from ${baseline.commitMarker.mtimeMs} to ${marker.mtimeMs}`
					: `launch commit marker appeared at mtime ${marker.mtimeMs}`,
		};
	}
	if (
		baseline.sessionCommitCount !== null &&
		input.sessionCommitCount !== null &&
		input.sessionCommitCount > baseline.sessionCommitCount
	) {
		return {
			kind: "session_commit",
			detail: `session commit count advanced from ${baseline.sessionCommitCount} to ${input.sessionCommitCount}`,
		};
	}
	const messageCount = deps.countCommDbMessages(
		input.watch.dead_execution_id,
		input.watch.project_name,
	);
	if (
		baseline.commDbMessageCount !== null &&
		messageCount !== null &&
		messageCount > baseline.commDbMessageCount
	) {
		return {
			kind: "commdb_write",
			detail: `message count advanced from ${baseline.commDbMessageCount} to ${messageCount}`,
		};
	}

	const resolved = deps.resolveTmuxTarget(
		input.watch.dead_execution_id,
		input.watch.project_name,
	);
	const targets = new Set<string>();
	if (resolved.kind === "found") targets.add(resolved.target);
	if (baseline.tmuxTarget) targets.add(baseline.tmuxTarget);
	for (const target of targets) {
		const output = await deps.captureTmuxOutput(target);
		if (output === null) continue;
		const digest = outputDigest(output);
		if (
			(baseline.tmuxTarget === target &&
				baseline.tmuxOutputDigest !== null &&
				digest !== baseline.tmuxOutputDigest) ||
			(baseline.tmuxTarget !== target && output.length > 0)
		) {
			return {
				kind: "tmux_output",
				detail: `tmux output changed on ${target}`,
			};
		}
	}
	return null;
}
