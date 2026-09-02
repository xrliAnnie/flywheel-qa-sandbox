import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync as nodeExistsSync } from "node:fs";
import { promisify } from "node:util";

const FORENSIC_OUTPUT_LIMIT = 32_000;
const FORENSIC_COMMAND_BUFFER_LIMIT = 1_048_576;
const FORENSIC_COMMAND_TIMEOUT_MS = 3_000;

export interface CodexTransportDeathEvidence {
	executionId: string;
	socketPath: string;
	reason: string;
	at: string;
	trigger: "transport_close" | "zombie_declaration";
}

interface SnapshotStore {
	getSession(
		executionId: string,
	): { issue_id: string; project_name?: string | null } | undefined;
	insertEvent(event: {
		event_id: string;
		execution_id: string;
		issue_id: string;
		project_name: string;
		event_type: string;
		source: string;
		payload: Record<string, unknown>;
	}): void;
}

interface SnapshotDeps {
	existsSync?: (path: string) => boolean;
	execFile?: (
		command: string,
		args: string[],
		options: { encoding: "utf8"; timeout: number; maxBuffer: number },
	) => Promise<{ stdout: string }>;
	randomId?: () => string;
}

const nodeExecFileAsync = promisify(nodeExecFile) as unknown as NonNullable<
	SnapshotDeps["execFile"]
>;

function message(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(
		0,
		FORENSIC_OUTPUT_LIMIT,
	);
}

function bounded(value: string): string {
	return value.slice(0, FORENSIC_OUTPUT_LIMIT);
}

function isEmptyLsofResult(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const failure = error as {
		code?: unknown;
		stdout?: unknown;
		stderr?: unknown;
	};
	return (
		failure.code === 1 &&
		typeof failure.stdout === "string" &&
		failure.stdout.trim() === "" &&
		typeof failure.stderr === "string" &&
		failure.stderr.trim() === ""
	);
}

/** Capture the two OS views needed to explain a detached daemon death. */
export async function recordCodexTransportDeathSnapshot(
	store: SnapshotStore,
	evidence: CodexTransportDeathEvidence,
	maintenanceTicks: readonly string[],
	deps: SnapshotDeps = {},
): Promise<void> {
	const existsSync = deps.existsSync ?? nodeExistsSync;
	const execFile = deps.execFile ?? nodeExecFileAsync;
	const socket: {
		path: string;
		exists: boolean;
		lsof?: string;
		lsofError?: string;
	} = {
		path: evidence.socketPath,
		exists: existsSync(evidence.socketPath),
	};
	const commandOptions = {
		encoding: "utf8" as const,
		timeout: FORENSIC_COMMAND_TIMEOUT_MS,
		maxBuffer: FORENSIC_COMMAND_BUFFER_LIMIT,
	};
	const [lsofResult, processResult] = await Promise.allSettled([
		execFile("lsof", ["-nP", evidence.socketPath], commandOptions),
		execFile(
			"ps",
			["-axo", "pid=,ppid=,pgid=,lstart=,command="],
			commandOptions,
		),
	]);
	if (lsofResult.status === "fulfilled") {
		socket.lsof = bounded(lsofResult.value.stdout);
	} else if (isEmptyLsofResult(lsofResult.reason)) {
		socket.lsof = "";
	} else {
		socket.lsofError = message(lsofResult.reason);
	}

	let processRows: string[] = [];
	let processError: string | undefined;
	if (processResult.status === "fulfilled") {
		processRows = processResult.value.stdout
			.split(/\r?\n/)
			.filter(
				(row) =>
					row.includes(evidence.executionId) ||
					row.includes(evidence.socketPath),
			)
			.map(bounded);
	} else {
		processError = message(processResult.reason);
	}

	const session = store.getSession(evidence.executionId);
	store.insertEvent({
		event_id: `codex-transport-death-${evidence.executionId}-${(deps.randomId ?? randomUUID)()}`,
		execution_id: evidence.executionId,
		issue_id: session?.issue_id ?? "unknown",
		project_name: session?.project_name ?? "unknown",
		event_type: "codex_transport_death_snapshot",
		source: "bridge.codex-transport-forensics",
		payload: {
			at: evidence.at,
			trigger: evidence.trigger,
			reason: evidence.reason,
			socket,
			processRows,
			...(processError ? { processError } : {}),
			maintenanceTicks: maintenanceTicks.slice(-3),
		},
	});
}
