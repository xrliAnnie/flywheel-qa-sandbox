import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AdapterExecutionContext,
	IHookCallbackServer,
} from "flywheel-core";
import { type ExecFileFn, TmuxAdapter } from "./TmuxAdapter.js";

/**
 * KimiTmuxAdapter — launches the Kimi Code `kimi` CLI in an interactive
 * tmux window. FLY-494 (mirrors FLY-493's AntigravityTmuxAdapter).
 *
 * `kimi` is a Claude-Code-class agentic CLI (MoonshotAI/kimi-code, TS), so this
 * reuses ALL of TmuxAdapter's vendor-neutral machinery (the comm.db completion
 * poll, dynamic gate-timeout, heartbeat, session registration, mailbox env) and
 * overrides only the vendor-specific seams:
 *   1. `type`         — "kimi-tmux" (AdapterRegistry key).
 *   2. `binaryName`   — "kimi" (preflight + tmux launch command).
 *   3. `runPreflight` — tmux + `kimi --version` + a FAIL-CLOSED auth probe.
 *   4. `buildCliArgs` — kimi flags (no claude-only `--session-id` /
 *      `--permission-mode` / `--append-system-prompt-file` / `--allowed-tools`
 *      / `--name`); the system+task prompt is bootstrapped from a 0600 file.
 *
 * **CLI flags verified against kimi 0.18.0** (`kimi --help`, FLY-494 live spike).
 * The earlier doc-based `--print` / `--afk` flags do NOT exist in the shipped
 * binary; the real flags are:
 *   - `-p TEXT` / `--prompt` : "Run one prompt non-interactively and print the
 *     response" — the headless agent-loop mode (kimi takes the prompt as a FLAG
 *     value, not a positional arg, unlike claude/agy).
 *   - `-y` / `--yolo` : "Automatically approve all actions" — the unattended
 *     auto-approve, parity with claude's `--dangerously-skip-permissions` /
 *     agy's `--dangerously-skip-permissions` (a `tmux` runner has no human to
 *     answer a permission prompt). (`--auto` is the softer "auto permission
 *     mode"; we want approve-ALL.)
 *   - `-m NAME` / `--model` : model override (combinable with `-p` + `--yolo`).
 * All kimi-specific flags live in `buildCliArgs` here — a one-line change if a
 * future kimi version shifts them. The fail-closed preflight guarantees a
 * missing / signed-out `kimi` throws LOUD rather than silently spawning a
 * useless pane (plan §0 caveat: this PR ships the WIRING + flag-verified
 * scaffold; full live usability still needs Kimi auth + an authenticated e2e
 * spike, which is gated on the founder logging in via `kimi login`).
 *
 * **Transport = none (v1).** kimi has no claude-code Agent Team, so no transport
 * is wired (the constructor passes no transport to super). Lead→Runner
 * mid-session push-wake is a follow-up; stage/gate/ask reporting all work
 * vendor-neutrally via flywheel-comm + comm.db, and gates BLOCK in-process
 * (kimi stays alive in the pane until its agent loop completes, like agy). The
 * no-transport Runner finishes at `pr_handoff` (build+PR) — see Blueprint's
 * no-transport finish procedure.
 */
/**
 * FLY-494 (Codex code review R1): bound the auth probe so a signed-out /
 * OAuth-stalled / network-stalled `kimi -p` FAILS CLOSED instead of wedging the
 * Bridge dispatch thread (the probe runs synchronously before the normal tmux
 * session-timeout machinery exists). The live spike confirmed an unauthenticated
 * `kimi -p` stalls on the device-code login round-trip, so the bound is real.
 */
const KIMI_PREFLIGHT_TIMEOUT_MS = 20_000;

export class KimiTmuxAdapter extends TmuxAdapter {
	readonly type = "kimi-tmux";
	protected readonly binaryName = "kimi";

	constructor(
		sessionName: string = "flywheel",
		execFileFn?: ExecFileFn,
		pollIntervalMs: number = 5000,
		defaultTimeoutMs: number = 86_400_000,
		hookServer?: IHookCallbackServer,
	) {
		// No transport (v1 transport=none) — kimi has no Agent Team mailbox.
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
	 * FLY-494: FAIL-CLOSED preflight. tmux + `kimi --version` (binary resolves on
	 * PATH) + a cheap non-mutating auth probe via `kimi -p` (one non-interactive
	 * prompt). A signed-out kimi returns "Authentication required" / "Please sign
	 * in" / "not logged in" — OR (verified in the FLY-494 live spike) simply HANGS
	 * on the device-code login round-trip; either way fail LOUD rather than
	 * silently spawning a pane that can't do anything.
	 *
	 * Codex code review R1 (MED): the probe is BOUNDED by KIMI_PREFLIGHT_TIMEOUT_MS
	 * — a signed-out kimi that stalls on the login round-trip or a hung network
	 * must fail closed (killed child → thrown error), not wedge the Bridge
	 * dispatch thread (the probe runs before any tmux session-timeout exists). The
	 * live spike confirmed an unauthenticated `kimi -p` stalls until killed, so
	 * the bound is load-bearing, not theoretical.
	 */
	protected override runPreflight(): void {
		this.execFileFn("tmux", ["-V"]);
		this.execFileFn(this.binaryName, ["--version"]);
		let out: string;
		try {
			const probe = this.execFileFn(
				this.binaryName,
				["-p", "Reply with exactly: KIMI_OK", "--yolo"],
				{ timeoutMs: KIMI_PREFLIGHT_TIMEOUT_MS },
			);
			out = probe.stdout ?? "";
		} catch (err) {
			// Bounded probe threw (timeout kills the child, or the CLI errored) —
			// fail CLOSED with a clear message rather than leaking a raw ETIMEDOUT.
			throw new Error(
				"[KimiTmuxAdapter] kimi auth preflight failed or timed out (not " +
					"signed in, OAuth/network stall, or no usable output). Install the " +
					"kimi CLI and sign in (`/login` inside kimi, or `kimi login`) before " +
					`dispatching kimi runners. Cause: ${(err as Error).message}`,
			);
		}
		if (
			!out.includes("KIMI_OK") ||
			/Authentication required|Please sign in|not logged in/i.test(out)
		) {
			throw new Error(
				"[KimiTmuxAdapter] kimi auth preflight failed (not signed in, or the " +
					"CLI returned no usable output). Install the kimi CLI and sign in " +
					"(`/login` inside kimi, or `kimi login`) before dispatching kimi runners.",
			);
		}
	}

	/**
	 * FLY-494: kimi CLI args (verified against kimi 0.18.0 — FLY-494 live spike).
	 * kimi lacks claude's `--session-id`, `--permission-mode`,
	 * `--append-system-prompt-file`, `--allowed-tools`, `--name`. We pass `--yolo`
	 * (auto-approve ALL actions — unattended-runner posture, parity with the
	 * claude/agy `--dangerously-skip-permissions`) + `--model` (if set) + a `-p`
	 * seed prompt (`-p` = "run one prompt non-interactively and print the
	 * response", the headless agent loop). Because kimi has no system-prompt flag
	 * and the Flywheel procedure prompt is large (FLY-154 tmux argv overflow), the
	 * combined system+task prompt is written to a 0600 per-execution file and `-p`
	 * is a SHORT pointer that tells kimi to read and follow it.
	 *
	 * `_sessionId` is accepted for signature parity (the adapter tracks it for
	 * comm.db registration) but kimi has no `--session-id` to bind it to.
	 */
	protected override buildCliArgs(
		ctx: AdapterExecutionContext,
		_sessionId: string,
	): string[] {
		const args: string[] = [];
		// Auto-approve ALL actions — the unattended-runner posture (a tmux runner
		// has no human to answer a permission prompt). `-p` below runs the prompt
		// non-interactively and prints the response.
		args.push("--yolo");
		if (ctx.model) args.push("--model", ctx.model);

		const combined = [ctx.appendSystemPrompt, ctx.prompt]
			.filter((s): s is string => Boolean(s))
			.join("\n\n---\n\n");
		const promptDir = join(
			tmpdir(),
			"flywheel-runner-prompts",
			ctx.executionId,
		);
		mkdirSync(promptDir, { recursive: true, mode: 0o700 });
		const promptPath = join(promptDir, "kimi-bootstrap.md");
		writeFileSync(promptPath, combined, { encoding: "utf-8", mode: 0o600 });

		// kimi takes the prompt as a FLAG value (`-p`), not a positional arg.
		args.push(
			"-p",
			`Read the instructions in ${promptPath} and follow them exactly. Begin now.`,
		);
		return args;
	}
}
