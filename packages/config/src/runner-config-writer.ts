/**
 * FLY-709 P4.3/P4.4 — the per-project runner-default / cron-model config
 * WRITER (`<projectRoot>/.flywheel/config.yaml`).
 *
 * Contract (Codex design review R1 #1/#2):
 * - Absent config file = fail-loud. A roles-only skeleton cannot pass
 *   ConfigLoader (project/linear/runners/teams/decision_layer are required),
 *   so fabricating one would be lying about the project's state.
 * - `roles.<role>.backend` is required by the loader → writing model/effort
 *   onto an absent `roles.runner` also materializes `backend: claude-tmux`
 *   (unless an explicit backend is part of the same change). Removing backend
 *   is only legal when the whole block empties (block is then deleted, and an
 *   empty `roles` map with it) — an orphaned model would make the loader
 *   reject the ENTIRE config on next load.
 * - Writer-level cross-field guard: only the claude-tmux runner consumes
 *   `--effort` (types.ts), and the loader does NOT enforce this today — so the
 *   writer refuses a target state with effort on a non-claude-tmux backend
 *   rather than writing inert config that displays as applied.
 * - Comment-preserving edits (yaml Document API), then loader round-trip on
 *   the new content BEFORE an atomic same-dir temp+rename. Any failure path
 *   changes zero bytes on disk.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { YAMLMap, YAMLSeq } from "yaml";
import { parseDocument } from "yaml";
import { ConfigLoader } from "./ConfigLoader.js";
import { normalizeDispatchModel } from "./model-tiers.js";
import { EXECUTOR_BACKENDS, ROLE_EFFORT_LEVELS } from "./types.js";

export interface RunnerDefaultsChange {
	/** undefined = dimension untouched; null = remove the override. */
	model?: string | null;
	effort?: string | null;
	backend?: string | null;
}

export interface CronModelChange {
	collectionId: string;
	/** null = remove the per-collection model (back to project default). */
	model: string | null;
}

export interface ApplyResult {
	/** Dotted keys that were set or removed. */
	changed: string[];
}

/**
 * FLY-709 P5 (Codex design review R2 #1): thrown when the reviewed config.yaml
 * content SHA (captured at the console `stage` step) no longer matches the file
 * inside the write lock — another writer (CLI, a second route call, a manual
 * edit) changed it between stage and apply. The route maps this to HTTP 409 and
 * changes zero bytes. Distinct from a generic Error so callers can 409 vs 500.
 */
export class RunnerConfigStaleError extends Error {
	readonly code = "stale" as const;
	constructor(configPath: string) {
		super(
			`config.yaml changed since it was reviewed (${configPath}) — re-open the console and re-stage`,
		);
		this.name = "RunnerConfigStaleError";
	}
}

/** SHA-256 hex of the config.yaml content — the reviewed-baseline stamp. */
export function configContentSha(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * FLY-709 P5 (Codex design review R1 #2): run async `fn` while holding an
 * exclusive cross-process advisory lock on `<configPath>.lock`. Unlike the flag
 * `.env` writer (fully synchronous), the runner-config writer is async
 * (ConfigLoader round-trip), so this acquires via `openSync(O_EXCL)` in an
 * ASYNC poll loop — it never blocks the event loop while another writer holds
 * the lock, and the awaited `fn` runs its whole read→check→write to completion
 * before release. This is the SINGLE lock-acquisition point (Codex R2 #3): the
 * route/CLI never wrap another lock around `applyRunnerDefaults`, so the
 * non-reentrant lock cannot deadlock.
 *
 * Fail-CLOSED: if the lock cannot be acquired within `timeoutMs`, throw rather
 * than write unguarded.
 */
export async function withConfigFileLock<T>(
	configPath: string,
	fn: () => Promise<T>,
	opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
	const lockPath = `${configPath}.lock`;
	const timeoutMs = opts.timeoutMs ?? 3000;
	const pollMs = opts.pollMs ?? 25;
	const start = Date.now();
	let fd: number | undefined;
	for (;;) {
		try {
			fd = openSync(lockPath, "wx"); // O_EXCL — fails if the lock is held
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (Date.now() - start >= timeoutMs) {
				throw new Error(`config lock busy (${lockPath}) — try again`);
			}
			await sleep(pollMs);
		}
	}
	try {
		return await fn();
	} finally {
		try {
			if (fd !== undefined) closeSync(fd);
		} catch {}
		try {
			unlinkSync(lockPath);
		} catch {}
	}
}

function readConfigFile(configPath: string): string {
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(configPath);
	} catch {
		throw new Error(
			`no project config at ${configPath} — create the project's full .flywheel/config.yaml first (project/linear/runners/teams/decision_layer are required); the writer does not fabricate skeletons`,
		);
	}
	if (st.isSymbolicLink()) {
		throw new Error(`refusing to write through a symlink: ${configPath}`);
	}
	return readFileSync(configPath, "utf8");
}

/** Round-trip the NEW content through ConfigLoader, then atomic temp+rename. */
async function validateAndPersist(
	configPath: string,
	nextContent: string,
): Promise<void> {
	await new ConfigLoader(async () => nextContent).load(configPath);
	const tmp = join(
		dirname(configPath),
		`.config.yaml.fly709-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
	);
	writeFileSync(tmp, nextContent, { encoding: "utf8", mode: 0o644 });
	try {
		renameSync(tmp, configPath);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// best-effort cleanup; the rename failure below is the real signal
		}
		throw err;
	}
	// Codex design review R1 #3: rename is the commit point (the temp was
	// created 0o644, so its perms carry over). A post-rename chmod is
	// belt-and-suspenders — it must NOT throw and make the caller report failure
	// after the new bytes already replaced the old config.
	try {
		chmodSync(configPath, 0o644);
	} catch {
		// best-effort; the config is already installed with the temp's 0o644 mode.
	}
}

function scalarOrUndefined(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

export async function applyRunnerDefaults(
	configPath: string,
	change: RunnerDefaultsChange,
	opts: { expectedSha?: string } = {},
): Promise<ApplyResult> {
	// ── pure argument validation (no file touch → no lock needed) ──
	if (
		change.model === undefined &&
		change.effort === undefined &&
		change.backend === undefined
	) {
		return { changed: [] };
	}
	if (
		change.backend != null &&
		!EXECUTOR_BACKENDS.includes(change.backend as never)
	) {
		throw new Error(
			`unknown runner backend "${change.backend}" — must be one of ${EXECUTOR_BACKENDS.join(", ")}`,
		);
	}
	if (
		change.effort != null &&
		!ROLE_EFFORT_LEVELS.includes(change.effort as never)
	) {
		throw new Error(
			`unknown runner effort "${change.effort}" — must be one of ${ROLE_EFFORT_LEVELS.join(", ")}`,
		);
	}
	if (change.model != null && change.model.trim() === "") {
		throw new Error("runner model must be a non-empty string or null");
	}

	// ── Codex R1 #2 / R2 #3: single non-reentrant lock; read → (optional
	// expectedSha drift check) → compute → persist all run inside it. ──
	return withConfigFileLock(configPath, async () => {
		const content = readConfigFile(configPath);
		if (
			opts.expectedSha !== undefined &&
			configContentSha(content) !== opts.expectedSha
		) {
			throw new RunnerConfigStaleError(configPath);
		}
		const doc = parseDocument(content);
		const runnerNode = doc.getIn(["roles", "runner"]) as YAMLMap | undefined;
		const current = {
			model: scalarOrUndefined(doc.getIn(["roles", "runner", "model"])),
			effort: scalarOrUndefined(doc.getIn(["roles", "runner", "effort"])),
			backend: scalarOrUndefined(doc.getIn(["roles", "runner", "backend"])),
		};

		// Target state after this change (undefined = key absent).
		const target = {
			model:
				change.model === undefined
					? current.model
					: (change.model ?? undefined),
			effort:
				change.effort === undefined
					? current.effort
					: (change.effort ?? undefined),
			backend:
				change.backend === undefined
					? current.backend
					: (change.backend ?? undefined),
		};

		const bornNow = runnerNode == null;
		const changed: string[] = [];

		// Materialize the required backend when the block is born from a
		// model/effort write and no explicit backend was supplied.
		if (
			bornNow &&
			target.backend === undefined &&
			(target.model !== undefined || target.effort !== undefined)
		) {
			target.backend = "claude-tmux";
			changed.push("roles.runner.backend");
		}

		const blockNonEmpty =
			target.model !== undefined || target.effort !== undefined;
		if (target.backend === undefined && blockNonEmpty) {
			throw new Error(
				"removing roles.runner.backend is only allowed when the whole roles.runner block empties (backend is required by ConfigLoader while model/effort remain)",
			);
		}
		// Unknown extra keys in the block also anchor the required backend.
		if (target.backend === undefined && runnerNode != null) {
			const managed = new Set(["model", "effort", "backend"]);
			const extras = runnerNode.items.filter(
				(it) => !managed.has(String((it.key as { value?: unknown })?.value)),
			);
			if (extras.length > 0) {
				throw new Error(
					"removing roles.runner.backend is only allowed when the whole roles.runner block empties (it still has other keys)",
				);
			}
		}
		if (target.effort !== undefined && target.backend !== "claude-tmux") {
			throw new Error(
				`effort is only consumed by the claude-tmux runner (target backend is "${target.backend}") — clear effort first or keep backend claude-tmux`,
			);
		}

		// Apply the explicit dimensions.
		const dims: (keyof RunnerDefaultsChange)[] = ["backend", "model", "effort"];
		for (const dim of dims) {
			const v = change[dim];
			if (v === undefined) continue;
			if (v === null) {
				if (current[dim] !== undefined) {
					doc.deleteIn(["roles", "runner", dim]);
					changed.push(`roles.runner.${dim}`);
				}
			} else {
				if (current[dim] !== v) {
					doc.setIn(["roles", "runner", dim], v);
					changed.push(`roles.runner.${dim}`);
				}
			}
		}
		// Materialized backend (recorded above) is written here.
		if (
			bornNow &&
			changed.includes("roles.runner.backend") &&
			change.backend === undefined
		) {
			doc.setIn(["roles", "runner", "backend"], "claude-tmux");
		}

		// Whole-block cleanup when everything cleared.
		if (
			target.backend === undefined &&
			target.model === undefined &&
			target.effort === undefined
		) {
			doc.deleteIn(["roles", "runner"]);
			const roles = doc.getIn(["roles"]) as YAMLMap | undefined;
			if (roles != null && roles.items.length === 0) {
				doc.deleteIn(["roles"]);
			}
		}

		if (changed.length === 0) return { changed };
		await validateAndPersist(configPath, doc.toString());
		return { changed };
	});
}

export async function applyCronModel(
	configPath: string,
	change: CronModelChange,
): Promise<ApplyResult> {
	// ── pure argument validation (no file touch → no lock needed) ──
	if (change.model !== null && normalizeDispatchModel(change.model) === null) {
		throw new Error(
			`model "${change.model}" is not a recognized model tier id or alias`,
		);
	}
	// FLY-709 P5 (Codex code review R1 #1): applyCronModel writes the SAME
	// <projectRoot>/.flywheel/config.yaml that applyRunnerDefaults does, so it
	// MUST take the same config-file lock — otherwise a concurrent runner-default
	// write and cron-model write can read the same base and clobber each other
	// (lost update), and the runner route's staged-fileSha guard cannot protect
	// against this second writer. read → mutate → persist all run inside the lock.
	return withConfigFileLock(configPath, async () => {
		const content = readConfigFile(configPath);
		const doc = parseDocument(content);
		const collections = doc.getIn(["xiaohongshu_learning", "collections"]) as
			| YAMLSeq
			| undefined;
		const items = (collections?.items ?? []) as YAMLMap[];
		const idx = items.findIndex(
			(it) =>
				typeof it?.get === "function" &&
				it.get("collection_id") === change.collectionId,
		);
		if (idx < 0) {
			throw new Error(
				`no xiaohongshu_learning collection with collection_id "${change.collectionId}" in ${configPath}`,
			);
		}
		const path = ["xiaohongshu_learning", "collections", idx, "model"];
		const currentModel = scalarOrUndefined(doc.getIn(path));
		const changedKey = `xiaohongshu_learning.collections["${change.collectionId}"].model`;
		if (change.model === null) {
			if (currentModel === undefined) return { changed: [] };
			doc.deleteIn(path);
		} else {
			if (currentModel === change.model) return { changed: [] };
			doc.setIn(path, change.model);
		}
		await validateAndPersist(configPath, doc.toString());
		return { changed: [changedKey] };
	});
}
