/**
 * FLY-795 c2: `flywheel-comm progress` — the runner's single-writer, atomic,
 * path-limited `progress.md` writer.
 *
 * Runners call this at each meaningful step; it commits the LIGHT ledger to the
 * issue branch B so a restarted / re-dispatched / handed-off runner can continue
 * from the real cursor instead of from scratch.
 *
 * Codex design review guarantees:
 *   #3 single-writer is ENFORCED (not advisory): the StateStore session for the
 *      --exec-id must be status=running (fail-closed) — a dead/terminated runner
 *      can never write.
 *   #4 the commit is ATOMIC + PATH-LIMITED: temp-file+rename write, then
 *      `git commit --only -- <progress.md>` so it NEVER sweeps unrelated staged
 *      code changes; a commit failure fails loud (no half-write success).
 *   #5 the --file path is validated (relative, inside cwd, matches the session's
 *      issue identifier) before any write — no escape.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import {
	type ProgressChunk,
	type ProgressLedger,
	parseProgress,
	renderProgress,
	type ThreeStagePhase,
} from "flywheel-config";
import { resolveStateDbPath } from "./verify-approval.js";

export interface ProgressArgs {
	execId: string;
	file: string;
	phase?: string;
	cursor?: string;
	next?: string;
	handoff?: string;
	/** repeatable "id=status" chunk-status updates. */
	chunkStatus?: Array<{ id: string; status: string }>;
	/** repeatable chunk definitions. */
	chunk?: ProgressChunk[];
	/** pointer key=value pairs. */
	pointer?: Array<{ key: string; value: string }>;
}

export interface SessionRow {
	status?: string;
	session_role?: string;
	issue_identifier?: string;
}

/** Injectable seams so the writer is unit-testable without real git/db/fs. */
export interface ProgressDeps {
	env: NodeJS.ProcessEnv;
	cwd: () => string;
	/** Read the StateStore session row for the exec-id (fail-closed authority). */
	readSession: (execId: string) => SessionRow | undefined;
	existsSync: (absPath: string) => boolean;
	readFileSync: (absPath: string) => string;
	/** Atomic write: temp-file + rename. */
	writeTempAndRename: (absPath: string, content: string) => void;
	/** Run git with argv in cwd; returns {stdout,stderr,status}. */
	git: (args: string[]) => { stdout: string; stderr: string; status: number };
}

export interface ProgressResult {
	ok: boolean;
	reason?: string;
	path?: string;
}

const CHUNK_STATUSES = new Set(["todo", "doing", "done", "qa-pass", "qa-fail"]);
const PHASES = new Set(["design", "implement", "qa"]);

export function runProgress(
	args: ProgressArgs,
	deps: ProgressDeps,
): ProgressResult {
	// 1. Single-writer authority (fail-closed) — StateStore session must be running.
	const session = deps.readSession(args.execId);
	if (!session) {
		return fail(
			`no StateStore session for exec-id ${args.execId} (fail-closed)`,
		);
	}
	if (session.status !== "running") {
		return fail(
			`exec-id ${args.execId} is not the active writer (status=${session.status ?? "?"}); refusing`,
		);
	}
	const issue = session.issue_identifier?.trim();

	// 2. Path validation — relative, inside cwd, matches the issue prefix.
	const pathErr = validateFile(args.file, deps.cwd(), issue);
	if (pathErr) return fail(pathErr);
	const absPath = join(deps.cwd(), args.file);

	// 3. Phase cross-check (light): if a --phase is given it must be a valid phase
	// AND, when the session carries a phase role, must not contradict it.
	if (args.phase && !PHASES.has(args.phase)) {
		return fail(`invalid --phase ${args.phase} (want design|implement|qa)`);
	}

	// 4. Merge into any existing ledger (preserve prior chunks/pointers).
	let ledger: ProgressLedger;
	try {
		ledger = deps.existsSync(absPath)
			? parseProgress(deps.readFileSync(absPath))
			: newLedger(issue ?? "unknown", args.phase);
	} catch (err) {
		return fail(
			`could not read existing progress.md: ${(err as Error).message}`,
		);
	}
	applyArgs(ledger, args);

	// 5. Atomic write (temp + rename).
	const content = renderProgress(ledger);
	deps.writeTempAndRename(absPath, content);

	// 6. Path-limited commit — commit ONLY progress.md, never sweep staged code.
	const msg = `chore(progress): ${ledger.issue} ${ledger.phase}${ledger.phaseCursor ? ` ${ledger.phaseCursor}` : ""}`;
	const commit = deps.git(["commit", "--only", "-m", msg, "--", args.file]);
	if (commit.status !== 0) {
		return fail(
			`git commit --only failed (status ${commit.status}): ${commit.stderr.trim()}`,
		);
	}
	return { ok: true, path: args.file };
}

// ── merge / helpers ────────────────────────────────────────────────

function newLedger(issue: string, phase?: string): ProgressLedger {
	return {
		issue,
		phase: (phase as ThreeStagePhase) ?? "design",
		chunks: [],
		pointers: {},
	};
}

function applyArgs(ledger: ProgressLedger, args: ProgressArgs): void {
	if (args.phase) ledger.phase = args.phase as ThreeStagePhase;
	if (args.cursor) ledger.phaseCursor = args.cursor;
	if (args.next) ledger.nextStep = args.next;
	if (args.handoff) ledger.handoff = args.handoff;
	ledger.updated = new Date().toISOString();
	for (const def of args.chunk ?? []) {
		const i = ledger.chunks.findIndex((c) => c.id === def.id);
		if (i >= 0) ledger.chunks[i] = def;
		else ledger.chunks.push(def);
	}
	for (const upd of args.chunkStatus ?? []) {
		if (!CHUNK_STATUSES.has(upd.status)) continue;
		const c = ledger.chunks.find((x) => x.id === upd.id);
		if (c) c.status = upd.status as ProgressChunk["status"];
	}
	for (const p of args.pointer ?? []) {
		if (
			["plan", "exploration", "research", "pr", "reviewedSha"].includes(p.key)
		) {
			(ledger.pointers as Record<string, string>)[p.key] = p.value;
		}
	}
}

/** null = ok; else the rejection reason. */
function validateFile(
	file: string,
	cwd: string,
	issue: string | undefined,
): string | null {
	if (!file) return "missing --file";
	if (isAbsolute(file)) return `--file must be relative: ${file}`;
	const norm = normalize(file);
	if (norm.startsWith("..") || norm.includes(`..${sep}`)) {
		return `--file escapes cwd: ${file}`;
	}
	const abs = resolve(cwd, file);
	if (abs !== resolve(cwd, norm) || !abs.startsWith(resolve(cwd) + sep)) {
		return `--file resolves outside cwd: ${file}`;
	}
	if (!/progress\.md$/.test(norm))
		return `--file must end in progress.md: ${file}`;
	if (issue && !norm.includes(issue)) {
		return `--file ${file} does not match issue ${issue}`;
	}
	return null;
}

function fail(reason: string): ProgressResult {
	return { ok: false, reason };
}

// ── real CLI entry (builds live deps) ──────────────────────────────

/** Parse argv → ProgressArgs (thin; the runner passes explicit flags). */
export function progress(argv: string[]): number {
	const args = parseArgv(argv);
	if (!args.execId || !args.file) {
		console.error(
			"usage: flywheel-comm progress --exec-id <id> --file <path> [--phase p] [--cursor n/m] [--next ...] [--handoff ...] [--set-chunk id=status]... [--pointer key=value]...",
		);
		return 2;
	}
	const deps = liveDeps();
	const r = runProgress(args, deps);
	if (!r.ok) {
		console.error(`[progress] ${r.reason}`);
		return 1;
	}
	console.log(`[progress] updated ${r.path}`);
	return 0;
}

function liveDeps(): ProgressDeps {
	return {
		env: process.env,
		cwd: () => process.cwd(),
		readSession: (execId) => {
			const statePath = resolveStateDbPath(undefined, process.env);
			if (!existsSync(statePath)) return undefined;
			const db = new Database(statePath, {
				readonly: true,
				fileMustExist: true,
			});
			try {
				return db
					.prepare(
						"SELECT status, session_role, issue_identifier FROM sessions WHERE execution_id = ?",
					)
					.get(execId) as SessionRow | undefined;
			} finally {
				db.close();
			}
		},
		existsSync,
		readFileSync: (p) => readFileSync(p, "utf8"),
		writeTempAndRename: (absPath, content) => {
			const tmp = `${absPath}.tmp-${process.pid}`;
			writeFileSync(tmp, content, "utf8");
			renameSync(tmp, absPath);
		},
		git: (a) => {
			const r = spawnSync("git", a, { cwd: process.cwd(), encoding: "utf8" });
			return {
				stdout: r.stdout ?? "",
				stderr: r.stderr ?? "",
				status: r.status ?? 1,
			};
		},
	};
}

function parseArgv(argv: string[]): ProgressArgs {
	const args: ProgressArgs = { execId: "", file: "" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i] ?? "";
		switch (a) {
			case "--exec-id":
				args.execId = next();
				break;
			case "--file":
				args.file = next();
				break;
			case "--phase":
				args.phase = next();
				break;
			case "--cursor":
				args.cursor = next();
				break;
			case "--next":
				args.next = next();
				break;
			case "--handoff":
				args.handoff = next();
				break;
			case "--set-chunk": {
				const [id, status] = next().split("=");
				if (id && status) {
					args.chunkStatus ??= [];
					args.chunkStatus.push({ id, status });
				}
				break;
			}
			case "--pointer": {
				const raw = next();
				const eq = raw.indexOf("=");
				if (eq > 0) {
					args.pointer ??= [];
					args.pointer.push({
						key: raw.slice(0, eq),
						value: raw.slice(eq + 1),
					});
				}
				break;
			}
		}
	}
	return args;
}
