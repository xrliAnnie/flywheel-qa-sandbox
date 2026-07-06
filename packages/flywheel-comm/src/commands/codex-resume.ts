/**
 * FLY-123: `flywheel-comm codex-resume` — the zero-interpolation Codex
 * cycle launcher (Codex design review R2 #2).
 *
 * THE security contract: the tmux watcher may only inject the FIXED-SHAPE
 * command `node <cli> codex-resume --state <absPath> [--message <dedupeKey>]`
 * into an idle runner shell. ALL variable content (the Lead's reply / the
 * initial prompt) lives in a 0600 state+prompt file pair and reaches codex
 * via execFile argv + stdin — it NEVER passes through a shell.
 *
 * The same helper launches BOTH cycle kinds (uniform mechanism — the spike
 * validated this shape end-to-end):
 * - mode "fresh":  codex-with-fallback exec --json -o <last> -C <cwd> -s <sandbox> [-m <model>] -
 * - mode "resume": codex-with-fallback exec resume <threadId> --json -o <last> [-m <model>] -
 *   (resume accepts NO -C/-s — cwd/sandbox inherit from the session;
 *    verified empirically in Spike-δ. The helper chdir's to state.cwd so the
 *    relative behavior matches the original session.)
 *
 * On child exit the helper writes the done-marker JSON — the
 * CodexTmuxAdapter's cycle-completion signal (pane death is NOT the signal
 * here; the pane hosts a long-lived shell).
 */

import { spawn } from "node:child_process";
import {
	createWriteStream,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

export interface CodexCycleState {
	version: 1;
	mode: "fresh" | "resume";
	/** Required for resume. UUID (codex thread id). */
	threadId?: string;
	/** 0600 file holding the prompt / Lead reply text (read via stdin). */
	promptPath: string;
	/** Working directory (fresh: -C; resume: process chdir). */
	cwd: string;
	/** fresh-mode sandbox. Default workspace-write. */
	sandbox?: "read-only" | "workspace-write" | "danger-full-access";
	/**
	 * FLY-123 QA Finding 1 (HIGH): extra writable roots for workspace-write.
	 * Bare workspace-write denies `~/.flywheel` → `flywheel-comm gate/stage/
	 * complete` inside the runner fail (`unable to open database file`), the
	 * gate marker is never written, and the adapter silently misclassifies
	 * the exit as terminal success. The adapter passes the flywheel state
	 * roots here; fresh-mode argv emits
	 * `-c sandbox_workspace_write.writable_roots=[...]`.
	 * QA-verified: sandbox params persist across `exec resume` — resume argv
	 * needs (and gets) no sandbox flags.
	 */
	writableRoots?: string[];
	/**
	 * FLY-123 QA Finding 1b (HIGH): bare workspace-write denies ALL network
	 * incl. localhost — no Bridge POST, no git push, no `gh pr create`.
	 * Phase 1 parity posture: the Claude runner runs `bypassPermissions`
	 * (no OS sandbox at all), so workspace-write + flywheel roots + network
	 * is still strictly tighter. Emits
	 * `-c sandbox_workspace_write.network_access=true` in fresh mode.
	 */
	networkAccess?: boolean;
	/**
	 * FLY-209 GitHub credential — the token is NO LONGER carried here.
	 * FLY-123 WS-C moved it off the codex argv (ps-visible) AND out of this
	 * 0600 state file into the per-runner `$CODEX_HOME/config.toml`
	 * (`[shell_environment_policy.set] GH_TOKEN`). codex picks it up via the
	 * CODEX_HOME the adapter injects into the tmux window env. The cycle state
	 * carries paths/metadata only — never a credential.
	 */
	model?: string;
	/** codex stdout JSONL destination. */
	jsonlPath: string;
	/** -o / --output-last-message destination. */
	lastMessagePath: string;
	/** Done-marker the executor adapter watches: {exitCode, ts, mode, threadId?}. */
	doneMarkerPath: string;
}

export interface CodexResumeArgs {
	statePath: string;
	/** Optional mailbox dedupe key — logged for traceability only. */
	message?: string;
	env?: NodeJS.ProcessEnv;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** dedupeKey rides the injected command line — strict charset. */
const DEDUPE_KEY_RE = /^[a-zA-Z0-9:_@.-]{1,128}$/;
const MODEL_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const SANDBOXES = new Set([
	"read-only",
	"workspace-write",
	"danger-full-access",
]);

export function validateCycleState(raw: unknown): CodexCycleState {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("codex-resume: state must be a JSON object");
	}
	const s = raw as Record<string, unknown>;
	if (s.version !== 1) {
		throw new Error(`codex-resume: unsupported state version ${s.version}`);
	}
	if (s.mode !== "fresh" && s.mode !== "resume") {
		throw new Error(`codex-resume: invalid mode "${s.mode}"`);
	}
	if (s.mode === "resume") {
		if (typeof s.threadId !== "string" || !UUID_RE.test(s.threadId)) {
			throw new Error(
				"codex-resume: resume mode requires a UUID threadId (got invalid/missing value)",
			);
		}
	}
	for (const field of [
		"promptPath",
		"cwd",
		"jsonlPath",
		"lastMessagePath",
		"doneMarkerPath",
	] as const) {
		if (typeof s[field] !== "string" || !isAbsolute(s[field] as string)) {
			throw new Error(`codex-resume: ${field} must be an absolute path`);
		}
	}
	if (s.sandbox != null && !SANDBOXES.has(s.sandbox as string)) {
		throw new Error(`codex-resume: invalid sandbox "${s.sandbox}"`);
	}
	if (s.writableRoots != null) {
		if (
			!Array.isArray(s.writableRoots) ||
			!s.writableRoots.every(
				(r) => typeof r === "string" && isAbsolute(r) && !r.includes('"'),
			)
		) {
			throw new Error(
				"codex-resume: writableRoots must be absolute paths (no quotes)",
			);
		}
	}
	if (s.networkAccess != null && typeof s.networkAccess !== "boolean") {
		throw new Error("codex-resume: networkAccess must be a boolean");
	}
	// FLY-123 WS-C: no ghToken in cycle state — it lives in $CODEX_HOME/config.toml.
	if (s.model != null && !MODEL_RE.test(s.model as string)) {
		throw new Error(`codex-resume: invalid model "${s.model}"`);
	}
	return s as unknown as CodexCycleState;
}

/** Reject group/other-readable state files (must be 0600). */
function assertOwnerOnly(path: string, label: string): void {
	const mode = statSync(path).mode & 0o777;
	if ((mode & 0o077) !== 0) {
		throw new Error(
			`codex-resume: ${label} ${path} must be 0600 (got ${mode.toString(8)})`,
		);
	}
}

export function buildCodexCycleArgv(state: CodexCycleState): string[] {
	if (state.mode === "fresh") {
		const argv = [
			"exec",
			"--json",
			"-o",
			state.lastMessagePath,
			"-C",
			state.cwd,
			"-s",
			state.sandbox ?? "workspace-write",
		];
		// QA Finding 1: flywheel protocol surface (CommDB / markers) + network
		// (Bridge POST, git push, gh). Sandbox params persist across resume —
		// fresh-mode only (QA-verified on codex 0.137.0).
		if (state.writableRoots?.length) {
			argv.push(
				"-c",
				`sandbox_workspace_write.writable_roots=${JSON.stringify(state.writableRoots)}`,
			);
		}
		if (state.networkAccess) {
			argv.push("-c", "sandbox_workspace_write.network_access=true");
		}
		// FLY-123 WS-C: GH_TOKEN is delivered via $CODEX_HOME/config.toml
		// ([shell_environment_policy.set]), NOT the argv — zero ps leak. codex
		// loads config.toml unless --ignore-user-config (which we never pass).
		if (state.model) argv.push("-m", state.model);
		argv.push("-"); // prompt from stdin
		return argv;
	}
	// resume: NO -C / -s (Spike-δ verified: unexpected-argument error)
	const argv = [
		"exec",
		"resume",
		state.threadId as string,
		"--json",
		"-o",
		state.lastMessagePath,
	];
	// FLY-123 WS-C: GH_TOKEN comes from $CODEX_HOME/config.toml (inherited via
	// CODEX_HOME), not the argv — on resume too, since config.toml is loaded
	// every exec/resume. No per-cycle re-pass needed.
	if (state.model) argv.push("-m", state.model);
	argv.push("-");
	return argv;
}

/**
 * Run one codex cycle. Resolves with the codex exit code AFTER the done
 * marker is written. Never throws for codex failures (exit code carries it);
 * throws only for validation/setup errors BEFORE codex starts.
 */
export async function codexResume(args: CodexResumeArgs): Promise<number> {
	const env = args.env ?? process.env;

	if (args.message !== undefined && !DEDUPE_KEY_RE.test(args.message)) {
		throw new Error(
			"codex-resume: --message must match ^[a-zA-Z0-9:_@.-]{1,128}$",
		);
	}
	if (!isAbsolute(args.statePath)) {
		throw new Error("codex-resume: --state must be an absolute path");
	}
	assertOwnerOnly(args.statePath, "state file");

	const state = validateCycleState(
		JSON.parse(readFileSync(args.statePath, "utf-8")),
	);
	assertOwnerOnly(state.promptPath, "prompt file");
	const prompt = readFileSync(state.promptPath, "utf-8");

	const binary = env.FLYWHEEL_CODEX_BIN?.trim() || "codex-with-fallback";
	const argv = buildCodexCycleArgv(state);

	mkdirSync(dirname(state.jsonlPath), { recursive: true });
	mkdirSync(dirname(state.doneMarkerPath), { recursive: true });
	const jsonlOut = createWriteStream(state.jsonlPath, {
		flags: "a",
		mode: 0o600,
	});

	// FLY-123 WS-C (R1 HIGH #1): strip any inherited GitHub-token env so it
	// never reaches the shim/codex process environment (ps-visible). codex
	// reads the token from $CODEX_HOME/config.toml and injects it into the
	// SANDBOX shell — the outer processes don't need (and must not carry) it.
	const childEnv: NodeJS.ProcessEnv = { ...env };
	for (const k of [
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"GH_ENTERPRISE_TOKEN",
		"GITHUB_ENTERPRISE_TOKEN",
	]) {
		delete childEnv[k];
	}

	const exitCode: number = await new Promise((resolve) => {
		const child = spawn(binary, argv, {
			cwd: state.cwd,
			// stdout → JSONL file; stderr → pane (operator visibility, matches
			// the spike harness); stdin ← prompt text (zero argv/shell leak).
			stdio: ["pipe", "pipe", "inherit"],
			env: childEnv,
		});
		child.stdout.pipe(jsonlOut);
		child.on("error", (err) => {
			process.stderr.write(
				`[codex-resume] failed to spawn ${binary}: ${err.message}\n`,
			);
			resolve(127);
		});
		child.on("close", (code) => {
			resolve(code ?? 1);
		});
		child.stdin.write(prompt);
		child.stdin.end();
	});
	jsonlOut.end();

	const marker: Record<string, unknown> = {
		exitCode,
		ts: new Date().toISOString(),
		mode: state.mode,
	};
	if (state.threadId) marker.threadId = state.threadId;
	if (args.message) marker.message = args.message;
	writeFileSync(state.doneMarkerPath, JSON.stringify(marker, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});

	return exitCode;
}
