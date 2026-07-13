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
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";

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
 * FLY-1188 T-1: incremental codex JSONL → pane progress renderer.
 *
 * The codex runner pane hosts a bare shell and codex stdout goes to the
 * JSONL file — before this, the founder opening the cmux tab saw an EMPTY
 * shell for the whole cycle (/eleven hardship #3). This renderer feeds on
 * the SAME byte stream that goes to the file and writes a human progress
 * line per event to the helper's own stdout (= the pane).
 *
 * Contract:
 * - FAIL-OPEN: rendering must never affect the file side or the cycle —
 *   every entry point swallows its own errors; bad JSON lines and unknown
 *   event types are skipped silently.
 * - T-1 = VISIBLE progress, not an interactive TUI (founder input stays on
 *   Discord/Lead; T-2 is a recorded future).
 * - Event vocabulary from the real codex 0.144.1 `--json` probe
 *   (research.md §4): thread.started / turn.started / turn.completed /
 *   item.started / item.completed with item types agent_message,
 *   command_execution (command + exit_code), file_change (path + kind).
 *   Field access is defensive — a vocabulary drift renders less, never
 *   crashes.
 * - A single line is capped at 1 MiB: a runaway line (huge aggregated
 *   output) is discarded up to its newline instead of being buffered.
 */
export class CodexJsonlRenderer {
	private buf = "";
	private discardingOversizedLine = false;
	private turnStartedAt: number | undefined;
	/** UTF-8-safe incremental decode — a multi-byte char split across chunk
	 * boundaries must not become replacement characters (M3 review LOW-1). */
	private decoder = new StringDecoder("utf8");
	/** Defensive cap on a single buffered line, in UTF-16 code units (≈1MiB
	 * for ASCII JSONL; the point is boundedness, not byte accounting). */
	private static readonly MAX_LINE_CODE_UNITS = 1_048_576;
	private static readonly CMD_WIDTH = 120;
	private static readonly MSG_WIDTH = 200;

	constructor(
		private writeLine: (line: string) => void,
		private mode: string,
	) {}

	feed(chunk: Buffer | string): void {
		try {
			this.buf += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
			if (this.discardingOversizedLine) {
				const nl = this.buf.indexOf("\n");
				if (nl === -1) {
					this.buf = "";
					return;
				}
				this.buf = this.buf.slice(nl + 1);
				this.discardingOversizedLine = false;
			}
			let nl = this.buf.indexOf("\n");
			while (nl !== -1) {
				const line = this.buf.slice(0, nl);
				this.buf = this.buf.slice(nl + 1);
				this.renderLine(line);
				nl = this.buf.indexOf("\n");
			}
			if (this.buf.length > CodexJsonlRenderer.MAX_LINE_CODE_UNITS) {
				this.buf = "";
				this.discardingOversizedLine = true;
			}
		} catch {
			// fail-open — the file side is authoritative
		}
	}

	/** Render a trailing line without a newline (stream end). */
	flush(): void {
		try {
			this.buf += this.decoder.end(); // drain a partial trailing multi-byte char
			if (this.buf.trim().length > 0) this.renderLine(this.buf);
			this.buf = "";
			this.discardingOversizedLine = false;
		} catch {
			// fail-open
		}
	}

	private renderLine(line: string): void {
		if (!line.trim()) return;
		let evt: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				return;
			evt = parsed as Record<string, unknown>;
		} catch {
			return; // non-JSON line (wrapper banner) — skip
		}
		switch (evt.type) {
			case "thread.started": {
				const tid =
					typeof evt.thread_id === "string"
						? evt.thread_id.slice(0, 8)
						: "unknown";
				this.writeLine(`── codex thread ${tid} (${this.mode}) ──`);
				return;
			}
			case "turn.started":
				this.turnStartedAt = Date.now();
				this.writeLine(`── turn started (${this.mode}) ──`);
				return;
			case "turn.completed": {
				const secs =
					this.turnStartedAt !== undefined
						? ` in ${Math.round((Date.now() - this.turnStartedAt) / 1000)}s`
						: "";
				this.writeLine(`── turn completed${secs} ──`);
				return;
			}
			case "item.started":
			case "item.completed":
				this.renderItem(
					evt.item as Record<string, unknown> | undefined,
					evt.type === "item.completed",
				);
				return;
			default:
				return; // unknown event type — skip
		}
	}

	private renderItem(
		item: Record<string, unknown> | undefined,
		completed: boolean,
	): void {
		if (!item || typeof item !== "object") return;
		switch (item.type ?? item.item_type) {
			case "command_execution": {
				const cmd = this.oneLine(item.command, CodexJsonlRenderer.CMD_WIDTH);
				if (completed) {
					const exit =
						typeof item.exit_code === "number"
							? ` (exit ${item.exit_code})`
							: "";
					this.writeLine(`▶ ${cmd}${exit}`);
				} else {
					this.writeLine(`▶ ${cmd}`);
				}
				return;
			}
			case "file_change": {
				if (!completed) return; // render once, at completion
				// probe shape: path + kind on the item; tolerate a changes[] list
				const changes = Array.isArray(item.changes)
					? (item.changes as Array<Record<string, unknown>>)
					: [item];
				for (const change of changes) {
					if (!change || typeof change !== "object") continue;
					const path = this.oneLine(change.path, CodexJsonlRenderer.CMD_WIDTH);
					if (!path) continue;
					const kind =
						typeof change.kind === "string" ? ` (${change.kind})` : "";
					this.writeLine(`✎ ${path}${kind}`);
				}
				return;
			}
			case "agent_message": {
				if (!completed) return; // full text arrives at completion
				const text = this.oneLine(
					item.text ?? item.message,
					CodexJsonlRenderer.MSG_WIDTH,
				);
				if (text) this.writeLine(`💬 ${text}`);
				return;
			}
			default:
				return; // unknown item type — skip
		}
	}

	private oneLine(value: unknown, width: number): string {
		if (typeof value !== "string") return "";
		const flat = value.replace(/\s+/g, " ").trim();
		return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
	}
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

	// FLY-1188 T-1: the pane renderer feeds on the SAME bytes that go to the
	// JSONL file (single tee) — the file side is byte-authoritative, the
	// renderer is fail-open decoration on the helper's own stdout (= pane).
	// Pane saturation policy (M3 review MEDIUM-1): when process.stdout
	// signals backpressure, DROP decoration lines until it drains — the pane
	// must never push back on the file side or buffer unboundedly.
	let paneBlocked = false;
	const renderer = new CodexJsonlRenderer((line) => {
		if (paneBlocked) return;
		if (!process.stdout.write(`${line}\n`)) {
			paneBlocked = true;
			process.stdout.once("drain", () => {
				paneBlocked = false;
			});
		}
	}, state.mode);

	// FLY-1188 (R1 #9 pipeline restructure): resolve only after BOTH the
	// child exited AND the JSONL write stream finished flushing to disk. The
	// old shape resolved on child close and only then called jsonlOut.end() —
	// the done-marker could land before the file finished, and every
	// marker-gated JSONL consumer (adapter threadId parse, the coming
	// anti-spin scan) could read a truncated file.
	let fileError: Error | null = null;
	const childExit: number = await new Promise((resolve) => {
		let childCode: number | null = null;
		let fileDone = false;
		const maybeResolve = () => {
			if (childCode !== null && fileDone) resolve(childCode);
		};
		jsonlOut.on("close", () => {
			// fs.WriteStream auto-destroys on error and still emits 'close' —
			// the single completion point for the file side (success OR error).
			fileDone = true;
			maybeResolve();
		});

		const child = spawn(binary, argv, {
			cwd: state.cwd,
			// stdout → JSONL file + pane renderer; stderr → pane (operator
			// visibility, matches the spike harness); stdin ← prompt text
			// (zero argv/shell leak).
			stdio: ["pipe", "pipe", "inherit"],
			env: childEnv,
		});

		jsonlOut.on("error", (err) => {
			// M3 review HIGH-1: a file-side failure is recorded and FAILS the
			// cycle CLOSED (below) — never a success marker over a missing/
			// truncated JSONL. The stream is destroyed; un-wedge a paused
			// child so it can still run to completion for its exit code.
			fileError = err;
			process.stderr.write(
				`[codex-resume] JSONL write failed (cycle will fail closed): ${err.message}\n`,
			);
			try {
				child.stdout.resume();
			} catch {
				// stdout may already be closed
			}
		});
		child.stdout.on("data", (chunk: Buffer) => {
			renderer.feed(chunk);
			if (fileError) return; // file side dead — fail-close already recorded
			// M3 review MEDIUM-1: honor Writable backpressure (the old pipe()
			// semantics) — pause the child on a full buffer, resume on drain.
			if (!jsonlOut.write(chunk)) {
				child.stdout.pause();
				jsonlOut.once("drain", () => {
					child.stdout.resume();
				});
			}
		});
		child.stdout.on("end", () => {
			if (!fileError) jsonlOut.end();
		});
		child.on("error", (err) => {
			process.stderr.write(
				`[codex-resume] failed to spawn ${binary}: ${err.message}\n`,
			);
			// M3 review MEDIUM-2: the FIRST terminal outcome wins — a later
			// 'close' (spawn failures emit close with a platform-dependent
			// code) must not overwrite the stable 127.
			if (childCode === null) childCode = 127;
			if (!fileError) jsonlOut.end(); // stdout never ends on spawn failure
			maybeResolve();
		});
		child.on("close", (code) => {
			if (childCode === null) childCode = code ?? 1;
			maybeResolve();
		});
		child.stdin.write(prompt);
		child.stdin.end();
	});
	renderer.flush();

	// M3 review HIGH-1 (fail-close): a JSONL file failure makes the cycle a
	// FAILURE regardless of the child's exit code — the marker contract is
	// "marker present ⇒ file complete", and a lying success marker would
	// send every downstream consumer (adapter classify, threadId parse,
	// anti-spin) off a truncated/absent file.
	const exitCode = fileError !== null && childExit === 0 ? 1 : childExit;

	const marker: Record<string, unknown> = {
		exitCode,
		ts: new Date().toISOString(),
		mode: state.mode,
	};
	if (fileError !== null) {
		marker.fileError = (fileError as Error).message;
	}
	if (state.threadId) marker.threadId = state.threadId;
	if (args.message) marker.message = args.message;
	// FLY-1188: ATOMIC marker write (temp+rename) AFTER the JSONL stream
	// finished — a consumer that sees the marker is guaranteed a complete
	// file and never a half-written marker.
	const markerTmp = `${state.doneMarkerPath}.tmp`;
	writeFileSync(markerTmp, JSON.stringify(marker, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});
	renameSync(markerTmp, state.doneMarkerPath);

	return exitCode;
}
