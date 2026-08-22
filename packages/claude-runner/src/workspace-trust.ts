import {
	chmod,
	mkdir,
	readFile,
	rename,
	rmdir,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const DEFAULT_LOCK_WAIT_SECONDS = 30;
const DEFAULT_LOCK_STALE_SECONDS = 60;
const LOCK_RETRY_MS = 100;
const MAX_SOURCE_MERGE_ATTEMPTS = 5;

interface SourceVersion {
	raw?: string;
	dev?: number;
	ino?: number;
	mtimeMs?: number;
	size?: number;
	mode: number;
}

export interface PretrustClaudeWorkspaceHooks {
	/** Test seam for a non-Flywheel writer landing between merge and commit. */
	beforeSourceCheck?: (attempt: number) => Promise<void> | void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function secondsFromEnv(
	value: string | undefined,
	fallback: number,
	name: string,
): number {
	if (value === undefined || value.trim() === "") return fallback;
	if (!/^\d+$/.test(value.trim())) {
		throw new Error(
			`pretrustClaudeWorkspace: ${name} must be a non-negative integer`,
		);
	}
	return Number(value.trim());
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sameInode(
	path: string,
	owned: { dev: number; ino: number },
): Promise<boolean> {
	try {
		const current = await stat(path);
		return current.dev === owned.dev && current.ino === owned.ino;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Bare mkdir/rmdir protocol shared with inject-linear-issue.sh,
 * test-teardown.sh, flywheel-claude-profile, and withMkdirLock({ bare:true }).
 * Keep the stale/wait env names and defaults aligned across languages.
 */
async function withClaudeJsonLock<T>(
	lockPath: string,
	env: NodeJS.ProcessEnv,
	fn: () => Promise<T>,
): Promise<T> {
	const waitMs =
		secondsFromEnv(
			env.CLAUDE_LOCK_WAIT_S,
			DEFAULT_LOCK_WAIT_SECONDS,
			"CLAUDE_LOCK_WAIT_S",
		) * 1_000;
	const staleMs =
		secondsFromEnv(
			env.CLAUDE_LOCK_STALE_S,
			DEFAULT_LOCK_STALE_SECONDS,
			"CLAUDE_LOCK_STALE_S",
		) * 1_000;
	const deadline = Date.now() + waitMs;
	let owned: { dev: number; ino: number } | undefined;

	for (;;) {
		try {
			await mkdir(lockPath);
			const acquired = await stat(lockPath);
			owned = { dev: acquired.dev, ino: acquired.ino };
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const holder = await stat(lockPath);
				if (Date.now() - holder.mtimeMs > staleMs) {
					try {
						await rmdir(lockPath);
						continue;
					} catch (removeError) {
						if ((removeError as NodeJS.ErrnoException).code === "ENOENT") {
							continue;
						}
					}
				}
			} catch (inspectError) {
				if ((inspectError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw inspectError;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`pretrustClaudeWorkspace: timed out waiting for ${lockPath}`,
				);
			}
			await sleep(LOCK_RETRY_MS);
		}
	}

	let result: T | undefined;
	let failure: unknown;
	try {
		result = await fn();
	} catch (error) {
		failure = error;
	} finally {
		if (owned && (await sameInode(lockPath, owned))) {
			try {
				await rmdir(lockPath);
			} catch (releaseError) {
				if (!failure) failure = releaseError;
			}
		}
	}
	if (failure) throw failure;
	return result as T;
}

function parseClaudeState(raw: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`pretrustClaudeWorkspace: state is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isPlainObject(parsed)) {
		throw new Error(
			"pretrustClaudeWorkspace: state root must be a plain object",
		);
	}
	if (parsed.projects !== undefined && !isPlainObject(parsed.projects)) {
		throw new Error("pretrustClaudeWorkspace: projects must be a plain object");
	}
	return parsed;
}

async function readSourceVersion(path: string): Promise<SourceVersion> {
	try {
		const [raw, metadata] = await Promise.all([
			readFile(path, "utf8"),
			stat(path),
		]);
		return {
			raw,
			dev: metadata.dev,
			ino: metadata.ino,
			mtimeMs: metadata.mtimeMs,
			size: metadata.size,
			mode: metadata.mode & 0o777,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { mode: 0o600 };
		}
		throw error;
	}
}

function sameSourceVersion(left: SourceVersion, right: SourceVersion): boolean {
	return (
		left.raw === right.raw &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mtimeMs === right.mtimeMs &&
		left.size === right.size
	);
}

async function readExistingState(path: string): Promise<{
	state: Record<string, unknown>;
	mode: number;
	source: SourceVersion;
}> {
	const source = await readSourceVersion(path);
	return {
		state: source.raw === undefined ? {} : parseClaudeState(source.raw),
		mode: source.mode,
		source,
	};
}

/** Seed one canonical workspace into Claude's machine-level trust state. */
export async function pretrustClaudeWorkspace(
	workspacePath: string,
	env: NodeJS.ProcessEnv = process.env,
	hooks: PretrustClaudeWorkspaceHooks = {},
): Promise<"written" | "already_trusted"> {
	if (!isAbsolute(workspacePath) || workspacePath.includes("\0")) {
		throw new Error(
			"pretrustClaudeWorkspace: workspacePath must be absolute and NUL-free",
		);
	}
	const claudeJson =
		env.FLYWHEEL_CLAUDE_JSON?.trim() || join(homedir(), ".claude.json");
	const lockPath =
		env.FLYWHEEL_CLAUDE_JSON_LOCK?.trim() || `${claudeJson}.lock`;

	return withClaudeJsonLock(lockPath, env, async () => {
		for (let attempt = 1; attempt <= MAX_SOURCE_MERGE_ATTEMPTS; attempt += 1) {
			const { state, mode, source } = await readExistingState(claudeJson);
			const projects = (state.projects ?? {}) as Record<string, unknown>;
			const existing = projects[workspacePath];
			if (existing !== undefined && !isPlainObject(existing)) {
				throw new Error(
					"pretrustClaudeWorkspace: project entry must be a plain object",
				);
			}
			if (existing?.hasTrustDialogAccepted === true) return "already_trusted";

			state.projects = {
				...projects,
				[workspacePath]: {
					...(existing ?? {}),
					hasTrustDialogAccepted: true,
				},
			};
			const bytes = `${JSON.stringify(state, null, 2)}\n`;
			const temporary = join(
				dirname(claudeJson),
				`.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.claude.json.tmp`,
			);
			let renamed = false;
			try {
				await writeFile(temporary, bytes, {
					encoding: "utf8",
					flag: "wx",
					mode,
				});
				await chmod(temporary, mode);
				await hooks.beforeSourceCheck?.(attempt);
				const current = await readSourceVersion(claudeJson);
				if (!sameSourceVersion(source, current)) continue;
				await rename(temporary, claudeJson);
				renamed = true;
			} finally {
				if (!renamed) await unlink(temporary).catch(() => {});
			}

			const verified = parseClaudeState(await readFile(claudeJson, "utf8"));
			const verifiedProjects = verified.projects as
				| Record<string, unknown>
				| undefined;
			const verifiedEntry = verifiedProjects?.[workspacePath];
			if (
				!isPlainObject(verifiedEntry) ||
				verifiedEntry.hasTrustDialogAccepted !== true
			) {
				throw new Error(
					"pretrustClaudeWorkspace: post-write verification lost workspace trust",
				);
			}
			return "written";
		}
		throw new Error(
			`pretrustClaudeWorkspace: source kept changing after ${MAX_SOURCE_MERGE_ATTEMPTS} merge attempts`,
		);
	});
}
