import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AdapterExecutionContext,
	IHookCallbackServer,
} from "flywheel-core";
import { type ExecFileFn, TmuxAdapter } from "./TmuxAdapter.js";

/**
 * AntigravityTmuxAdapter — launches the Antigravity `agy` CLI in an interactive
 * tmux window. FLY-493.
 *
 * `agy` is a Claude-Code-class agentic CLI (`--print`/`-i`/`--continue`/
 * `--model`/`--dangerously-skip-permissions`/MCP via settings.json), so this
 * reuses ALL of TmuxAdapter's vendor-neutral machinery (the comm.db completion
 * poll, dynamic gate-timeout, heartbeat, session registration, mailbox env) and
 * overrides only the three vendor-specific seams:
 *   1. `type`         — "antigravity-tmux" (AdapterRegistry key).
 *   2. `binaryName`   — "agy" (preflight + tmux launch command).
 *   3. `runPreflight` — tmux + `agy --version` + a FAIL-CLOSED auth probe.
 *   4. `buildCliArgs` — agy flags (no claude-only `--session-id` /
 *      `--permission-mode` / `--append-system-prompt-file` / `--allowed-tools`
 *      / `--name`); the system+task prompt is bootstrapped from a 0600 file.
 *
 * **Transport = none (v1).** agy has no claude-code Agent Team, so no transport
 * is wired (the constructor passes no transport to super). Lead→Runner
 * mid-session push-wake is a follow-up; stage/gate/ask reporting all work
 * vendor-neutrally via flywheel-comm + comm.db, and gates BLOCK in-process
 * (agy stays alive in the pane, like claude). The no-transport Runner finishes
 * at `pr_handoff` (build+PR) — see Blueprint's no-transport finish procedure.
 */
export class AntigravityTmuxAdapter extends TmuxAdapter {
	readonly type = "antigravity-tmux";
	protected readonly binaryName = "agy";
	// FLY-1188: no-transport backend — a `send` to this session must fail
	// loud, never write a claude-code mailbox nobody reads (false delivery).
	protected readonly registrationVendor = "none";

	constructor(
		sessionName: string = "flywheel",
		execFileFn?: ExecFileFn,
		pollIntervalMs: number = 5000,
		defaultTimeoutMs: number = 86_400_000,
		hookServer?: IHookCallbackServer,
	) {
		// No transport (v1 transport=none) — agy has no Agent Team mailbox.
		super(
			sessionName,
			execFileFn,
			pollIntervalMs,
			defaultTimeoutMs,
			hookServer,
			undefined,
		);
	}

	/**
	 * FLY-493 (Codex R1 #4): FAIL-CLOSED preflight. tmux + `agy --version` (binary
	 * resolves on PATH) + a cheap non-mutating auth probe. A signed-out agy
	 * returns "Authentication required" / "Please sign in" (or empty) — fail LOUD
	 * here rather than silently spawning a pane that can't do anything.
	 */
	protected override runPreflight(): void {
		this.execFileFn("tmux", ["-V"]);
		this.execFileFn(this.binaryName, ["--version"]);
		const probe = this.execFileFn(this.binaryName, [
			"--dangerously-skip-permissions",
			"-p",
			"Reply with exactly: AGY_OK",
		]);
		const out = probe.stdout ?? "";
		if (
			!out.includes("AGY_OK") ||
			/Authentication required|Please sign in/i.test(out)
		) {
			throw new Error(
				"[AntigravityTmuxAdapter] agy auth preflight failed (not signed in, " +
					"or the CLI returned no usable output). Sign in to Antigravity " +
					"before dispatching agy runners.",
			);
		}
	}

	/**
	 * FLY-493: agy CLI args. agy lacks claude's `--session-id`,
	 * `--permission-mode`, `--append-system-prompt-file`, `--allowed-tools`,
	 * `--name`. We pass `--model` (if set) + `--dangerously-skip-permissions`
	 * (parity with the unattended claude tmux runner) + an interactive `-i`
	 * bootstrap. Because agy has no system-prompt flag and the Flywheel procedure
	 * prompt is large (FLY-154 tmux argv overflow), the combined system+task
	 * prompt is written to a 0600 per-execution file and `-i` is a SHORT pointer
	 * that tells agy to read and follow it.
	 *
	 * `_sessionId` is accepted for signature parity (the adapter tracks it for
	 * comm.db registration) but agy has no `--session-id` to bind it to.
	 */
	protected override buildCliArgs(
		ctx: AdapterExecutionContext,
		_sessionId: string,
	): { args: string[] } {
		const args: string[] = [];
		if (ctx.model) args.push("--model", ctx.model);
		// Parity with the unattended claude tmux runner (auto-approve in tmux).
		// `--sandbox` is available as a config-gated hardening option (plan §5.9).
		args.push("--dangerously-skip-permissions");

		const combined = [ctx.appendSystemPrompt, ctx.prompt]
			.filter((s): s is string => Boolean(s))
			.join("\n\n---\n\n");
		const promptDir = join(
			tmpdir(),
			"flywheel-runner-prompts",
			ctx.executionId,
		);
		mkdirSync(promptDir, { recursive: true, mode: 0o700 });
		const promptPath = join(promptDir, "agy-bootstrap.md");
		writeFileSync(promptPath, combined, { encoding: "utf-8", mode: 0o600 });

		args.push(
			"-i",
			`Read the instructions in ${promptPath} and follow them exactly. Begin now.`,
		);
		return { args };
	}
}
