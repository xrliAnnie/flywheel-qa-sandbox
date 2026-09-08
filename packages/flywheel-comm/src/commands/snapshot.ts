import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	cleanupRunnerSnapshots,
	createManagedSnapshot,
	createRepairSnapshot,
	pruneRepairSnapshots,
	readDataDisk,
	type SnapshotOwner,
	SnapshotStorageError,
} from "../snapshot-storage.js";

export async function runSnapshotCommand(
	args: string[],
	deps: {
		readDataDisk?: typeof readDataDisk;
		cleanupRunnerSnapshots?: typeof cleanupRunnerSnapshots;
		createManagedSnapshot?: typeof createManagedSnapshot;
		createRepairSnapshot?: typeof createRepairSnapshot;
		pruneRepairSnapshots?: typeof pruneRepairSnapshots;
		env?: NodeJS.ProcessEnv;
		fetch?: typeof fetch;
		sleep?: (ms: number) => Promise<void>;
		now?: () => number;
		stdout?: (text: string) => void;
		stderr?: (text: string) => void;
	} = {},
): Promise<number> {
	const stdout = deps.stdout ?? ((text) => process.stdout.write(text));
	const stderr = deps.stderr ?? ((text) => process.stderr.write(text));
	if (args[0] === "disk" && args.length === 1) {
		stdout(
			`${JSON.stringify({ ok: true, ...(deps.readDataDisk ?? readDataDisk)() })}\n`,
		);
		return 0;
	}
	if (args[0] === "repair") {
		let values: ReturnType<typeof parseSnapshotArgs>;
		try {
			values = parseSnapshotArgs(args.slice(1));
		} catch {
			stderr(
				`${JSON.stringify({ ok: false, reason: "invalid_snapshot_arguments", retryable: false })}\n`,
			);
			return 2;
		}
		const env = deps.env ?? process.env;
		const configured = configuredDatabase(values.kind, values.project, env);
		if (
			configured === undefined ||
			resolve(configured) !== resolve(values.source)
		) {
			stderr(
				`${JSON.stringify({ ok: false, reason: "source_not_configured_database", retryable: false })}\n`,
			);
			return 1;
		}
		try {
			const result = await retrySnapshotLock(
				() =>
					(deps.createRepairSnapshot ?? createRepairSnapshot)({
						source: values.source,
						issueIdentifier: values.issue,
						databaseKind: values.kind,
						project: values.project,
					}),
				deps,
			);
			stdout(`${JSON.stringify({ ok: true, ...result })}\n`);
			return 0;
		} catch (error) {
			stderr(
				`${JSON.stringify({
					ok: false,
					reason:
						error instanceof SnapshotStorageError
							? error.reason
							: "snapshot_failed",
					retryable: error instanceof SnapshotStorageError && error.retryable,
				})}\n`,
			);
			return 1;
		}
	}
	if (args[0] === "runner") {
		let values: ReturnType<typeof parseRunnerArgs>;
		try {
			values = parseRunnerArgs(args.slice(1));
		} catch {
			stderr(
				`${JSON.stringify({ ok: false, reason: "invalid_snapshot_arguments", retryable: false })}\n`,
			);
			return 2;
		}
		const env = deps.env ?? process.env;
		const executionId = env.FLYWHEEL_EXEC_ID?.trim();
		const configured = configuredDatabase(values.kind, values.project, env);
		if (
			!executionId ||
			configured === undefined ||
			resolve(configured) !== resolve(values.source)
		) {
			stderr(
				`${JSON.stringify({ ok: false, reason: "runner_snapshot_context_invalid", retryable: false })}\n`,
			);
			return 1;
		}
		let owner: SnapshotOwner;
		try {
			owner = await fetchSnapshotOwner(env, deps.fetch ?? fetch);
		} catch {
			stderr(
				`${JSON.stringify({ ok: false, reason: "snapshot_owner_unavailable", retryable: true })}\n`,
			);
			return 1;
		}
		try {
			const result = await retrySnapshotLock(
				() =>
					(deps.createManagedSnapshot ?? createManagedSnapshot)({
						source: values.source,
						owner,
						databaseKind: values.kind,
						project: values.project,
					}),
				deps,
			);
			stdout(`${JSON.stringify({ ok: true, ...result })}\n`);
			return 0;
		} catch (error) {
			stderr(
				`${JSON.stringify({
					ok: false,
					reason:
						error instanceof SnapshotStorageError
							? error.reason
							: "snapshot_failed",
					retryable: error instanceof SnapshotStorageError && error.retryable,
				})}\n`,
			);
			return 1;
		}
	}
	if (args[0] === "prune") {
		if (
			args.slice(1).some((arg) => arg !== "--apply" && arg !== "--dry-run") ||
			(args.includes("--apply") && args.includes("--dry-run"))
		) {
			stderr(
				`${JSON.stringify({ ok: false, reason: "invalid_snapshot_arguments", retryable: false })}\n`,
			);
			return 2;
		}
		try {
			const result = await retrySnapshotLock(
				() =>
					(deps.pruneRepairSnapshots ?? pruneRepairSnapshots)({
						dryRun: !args.includes("--apply"),
						now: new Date(),
					}),
				deps,
			);
			stdout(`${JSON.stringify({ ok: true, ...result })}\n`);
			return 0;
		} catch (error) {
			stderr(
				`${JSON.stringify({
					ok: false,
					reason:
						error instanceof SnapshotStorageError
							? error.reason
							: "snapshot_prune_failed",
					retryable: error instanceof SnapshotStorageError && error.retryable,
				})}\n`,
			);
			return 1;
		}
	}
	if (args[0] === "release" && args.length === 1) {
		const env = deps.env ?? process.env;
		let owner: SnapshotOwner;
		try {
			owner = await fetchSnapshotOwner(env, deps.fetch ?? fetch);
		} catch {
			stderr(
				`${JSON.stringify({ ok: false, reason: "snapshot_owner_unavailable", retryable: true })}\n`,
			);
			return 1;
		}
		try {
			const result = await retrySnapshotLock(
				() =>
					(deps.cleanupRunnerSnapshots ?? cleanupRunnerSnapshots)({
						executionId: owner.executionId,
						expectedOwner: owner,
						authorize: (freshOwner) =>
							JSON.stringify(freshOwner) === JSON.stringify(owner),
					}),
				deps,
			);
			stdout(`${JSON.stringify({ ok: true, ...result })}\n`);
			return 0;
		} catch (error) {
			stderr(
				`${JSON.stringify({
					ok: false,
					reason:
						error instanceof SnapshotStorageError
							? error.reason
							: "snapshot_release_failed",
					retryable: error instanceof SnapshotStorageError && error.retryable,
				})}\n`,
			);
			return 1;
		}
	}
	stderr(
		`${JSON.stringify({ ok: false, reason: "invalid_snapshot_command", retryable: false })}\n`,
	);
	return 2;
}

async function retrySnapshotLock<T>(
	operation: () => Promise<T>,
	deps: {
		sleep?: (ms: number) => Promise<void>;
		now?: () => number;
	},
): Promise<T> {
	const now = deps.now ?? Date.now;
	const sleep =
		deps.sleep ??
		((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	const startedAt = now();
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			const delay = Math.min(1_000 * 2 ** (attempt - 1), 5_000);
			if (
				!(error instanceof SnapshotStorageError) ||
				error.reason !== "snapshot_lock_busy" ||
				attempt >= 12 ||
				now() - startedAt + delay >= 90_000
			) {
				throw error;
			}
			await sleep(delay);
		}
	}
}

function configuredDatabase(
	kind: "teamlead" | "comm",
	project: string | undefined,
	env: NodeJS.ProcessEnv,
): string | undefined {
	return kind === "teamlead"
		? env.FLYWHEEL_STATE_DB_PATH?.trim() ||
				env.TEAMLEAD_DB_PATH?.trim() ||
				env.FLYWHEEL_TEAMLEAD_DB?.trim() ||
				join(homedir(), ".flywheel", "teamlead.db")
		: env.FLYWHEEL_COMM_DB?.trim() ||
				(project
					? join(homedir(), ".flywheel", "comm", project, "comm.db")
					: undefined);
}

async function fetchSnapshotOwner(
	env: NodeJS.ProcessEnv,
	fetchImpl: typeof fetch,
): Promise<SnapshotOwner> {
	const executionId = env.FLYWHEEL_EXEC_ID?.trim();
	const token = env.TEAMLEAD_API_TOKEN?.trim();
	const bridge = env.FLYWHEEL_BRIDGE_URL?.trim() || env.BRIDGE_URL?.trim();
	if (!executionId || !token || !bridge) {
		throw new Error("runner snapshot context unavailable");
	}
	const endpoint = new URL(
		`/api/sessions/${encodeURIComponent(executionId)}/snapshot-owner`,
		bridge,
	);
	if (
		!["http:", "https:"].includes(endpoint.protocol) ||
		endpoint.username ||
		endpoint.password
	) {
		throw new Error("invalid Bridge URL");
	}
	const response = await fetchImpl(endpoint.toString(), {
		headers: { Authorization: `Bearer ${token}` },
	});
	const body = (await response.json()) as {
		ok?: unknown;
		owner?: SnapshotOwner;
	};
	if (
		!response.ok ||
		body.ok !== true ||
		!body.owner ||
		body.owner.executionId !== executionId
	) {
		throw new Error("snapshot owner unavailable");
	}
	return body.owner;
}

function parseSnapshotArgs(args: string[]): {
	source: string;
	issue: string;
	kind: "teamlead" | "comm";
	project?: string;
} {
	const { values, positionals } = parseArgs({
		args,
		options: {
			source: { type: "string" },
			issue: { type: "string" },
			kind: { type: "string" },
			project: { type: "string" },
		},
		allowPositionals: true,
		strict: true,
	});
	if (
		positionals.length !== 0 ||
		!values.source ||
		!values.issue ||
		(values.kind !== "teamlead" && values.kind !== "comm") ||
		(values.kind === "teamlead" && values.project !== undefined) ||
		(values.kind === "comm" && !values.project)
	) {
		throw new Error("invalid snapshot arguments");
	}
	return {
		source: values.source,
		issue: values.issue,
		kind: values.kind,
		project: values.project,
	};
}

function parseRunnerArgs(args: string[]): {
	source: string;
	kind: "teamlead" | "comm";
	project?: string;
} {
	const { values, positionals } = parseArgs({
		args,
		options: {
			source: { type: "string" },
			kind: { type: "string" },
			project: { type: "string" },
		},
		allowPositionals: true,
		strict: true,
	});
	if (
		positionals.length !== 0 ||
		!values.source ||
		(values.kind !== "teamlead" && values.kind !== "comm") ||
		(values.kind === "teamlead" && values.project !== undefined) ||
		(values.kind === "comm" && !values.project)
	) {
		throw new Error("invalid snapshot arguments");
	}
	return {
		source: values.source,
		kind: values.kind,
		project: values.project,
	};
}
