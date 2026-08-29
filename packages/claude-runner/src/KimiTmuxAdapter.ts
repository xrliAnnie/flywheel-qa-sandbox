import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
 *   3. `runPreflight` — tmux + a BOUNDED `kimi --version` liveness check + an
 *      INSTANT credential-presence auth check (no live model round-trip).
 *   4. `extraPaneEnv` — forces IPv4-first DNS in the runner pane.
 *   5. `buildCliArgs` — kimi flags (no claude-only `--session-id` /
 *      `--permission-mode` / `--append-system-prompt-file` / `--allowed-tools`
 *      / `--name`); the system+task prompt is bootstrapped from a 0600 file.
 *
 * **CLI flags verified against kimi 0.18.0 with REAL auth** (`kimi --help` +
 * authenticated live tests, FLY-494). Two corrections happened:
 *   1. the early doc-based `--print` / `--afk` flags do NOT exist; and
 *   2. `--yolo` / `--auto` CANNOT be combined with `-p` — the CLI hard-rejects
 *      `kimi -p … --yolo` with "Cannot combine --prompt with --yolo" (and the
 *      same for `--auto`). The first spike missed this because an unauthenticated
 *      `kimi -p` hangs BEFORE flag validation; the authenticated test exposed it.
 * The real flags:
 *   - `-p TEXT` / `--prompt` : "Run one prompt non-interactively and print the
 *     response" — the headless agent loop. **`-p` mode auto-approves tool calls
 *     by default** (verified: `kimi -p` created a file via its Write tool with no
 *     prompt), so it needs NO separate approve flag — that IS the unattended
 *     posture (and adding `--yolo`/`--auto` would make the CLI reject the launch).
 *   - `-m NAME` / `--model` : model override (combinable with `-p`).
 *     kimi takes the prompt as a FLAG value, not a positional arg (unlike
 *     claude/agy). All kimi-specific flags live in `buildCliArgs` here.
 *
 * **Preflight is FAST (FLY-530 QA + FLY-494 F0).** The original preflight ran a
 * live `kimi -p "Reply KIMI_OK"` model round-trip bounded at 20s. Root cause
 * (measured, not guessed): kimi 0.18.0 cold-starts ~11-18s — `kimi --version`, a
 * purely-local call, takes ~18s to FIRST byte then exits instantly, so the cost
 * is STARTUP, not the "exit delay" the QA first suspected. IPv4-first DNS shaves
 * ~6s of that (an IPv6-resolution stall); the rest is node startup that no flag
 * or (0.18.0-is-latest) upgrade removes. A `-p` round-trip therefore totals
 * ~50-60s and reliably blew the 20s bound on a correctly-signed-in machine →
 * kimi runners could NOT be dispatched at all. The fix replaces the live model
 * probe with an INSTANT credential-presence check (config.toml / credentials dir
 * under `~/.kimi-code`) and bounds the `kimi --version` liveness call so a hung
 * binary can never wedge the Bridge dispatch thread. This matches the claude
 * adapter, which likewise does NO live auth probe; an *expired* key isn't caught
 * here but surfaces loudly in-pane (same trade-off claude makes).
 *
 * **Transport = none (v1).** kimi has no claude-code Agent Team, so no transport
 * is wired (the constructor passes no transport to super). Lead→Runner
 * mid-session push-wake is a follow-up; stage/gate/ask reporting all work
 * vendor-neutrally via flywheel-comm + comm.db, and gates BLOCK in-process
 * (kimi stays alive in the pane until its agent loop completes, like agy). The
 * no-transport Runner finishes at `pr_handoff` (build+PR) — see Blueprint's
 * no-transport finish procedure.
 */
const KIMI_IPV4_FIRST_DNS = "--dns-result-order=ipv4first";
/**
 * FLY-494: default bound for the `kimi --version` liveness probe. kimi 0.18.0
 * cold-starts ~11-18s nominal, but on a busy dogfooding box that startup balloons
 * with CPU contention — FLY-554 re-QA measured `kimi --version` hitting ~48s at
 * load ~150, blowing the original 30s default and reintroducing the very FLY-530
 * false-fail this preflight was meant to cure (a correctly-signed-in machine
 * couldn't dispatch kimi runners). 90s gives ~2x headroom over that worst-case
 * while still failing closed on a genuinely hung binary (a missing binary fails
 * instantly via ENOENT — only a hung startup waits out the full bound, which is
 * rare and acceptable). Override per machine with FLYWHEEL_KIMI_PREFLIGHT_TIMEOUT_MS
 * (the ops escape hatch FLY-530 asked for).
 */
const DEFAULT_KIMI_PREFLIGHT_TIMEOUT_MS = 90_000;
const KIMI_PREFLIGHT_TIMEOUT_ENV = "FLYWHEEL_KIMI_PREFLIGHT_TIMEOUT_MS";

export class KimiTmuxAdapter extends TmuxAdapter {
	readonly type = "kimi-tmux";
	protected readonly binaryName = "kimi";
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
	 * FLY-494: kimi config home (`~/.kimi-code`). Overridable seam so tests can
	 * point the credential check at a temp dir without touching the real home.
	 */
	protected resolveKimiConfigDir(): string {
		return join(homedir(), ".kimi-code");
	}

	/**
	 * FLY-494: NODE_OPTIONS forcing IPv4-first DNS. kimi is a Node CLI whose
	 * 0.18.0 startup stalls ~6s on IPv6 name resolution (FLY-494 F0); preferring
	 * IPv4 shaves it. Merged with any inherited NODE_OPTIONS (idempotent — never
	 * appended twice).
	 */
	private kimiNodeOptions(): string {
		const existing = process.env.NODE_OPTIONS?.trim();
		if (!existing) return KIMI_IPV4_FIRST_DNS;
		// Codex R1 (LOW): an inherited but CONFLICTING dns-result-order (e.g.
		// `ipv6first`/`verbatim`) would defeat the ipv4first promise if left as-is.
		// Replace it in place (preserving every other NODE_OPTIONS token); only
		// append when there is no dns-result-order at all.
		if (/--dns-result-order=\S+/.test(existing)) {
			return existing.replace(/--dns-result-order=\S+/, KIMI_IPV4_FIRST_DNS);
		}
		return `${existing} ${KIMI_IPV4_FIRST_DNS}`;
	}

	/**
	 * FLY-494: resolve the `kimi --version` liveness-probe bound. Defaults to
	 * DEFAULT_KIMI_PREFLIGHT_TIMEOUT_MS; FLYWHEEL_KIMI_PREFLIGHT_TIMEOUT_MS
	 * overrides it (ops escape hatch). A non-positive / non-numeric override is
	 * ignored (falls back to the default — never a 0/NaN bound that would disable
	 * the safety net silently).
	 */
	private preflightTimeoutMs(): number {
		const raw = process.env[KIMI_PREFLIGHT_TIMEOUT_ENV];
		if (raw !== undefined) {
			// Codex R1 (MED): FLOOR FIRST, then require > 0. `Number("0.5") > 0`
			// is true but `Math.floor(0.5) === 0` → execFileSync reads 0 as "no
			// timeout", silently disabling the wedge safety net. Sub-1ms / 0 / NaN
			// overrides therefore fall back to the default rather than removing the
			// bound.
			const ms = Math.floor(Number(raw));
			if (Number.isFinite(ms) && ms > 0) return ms;
		}
		return DEFAULT_KIMI_PREFLIGHT_TIMEOUT_MS;
	}

	/**
	 * FLY-494: inject IPv4-first DNS into the runner pane so every kimi model call
	 * skips the IPv6-resolution startup stall (FLY-494 F0), not just preflight.
	 */
	protected override extraPaneEnv(): Record<string, string> {
		return { NODE_OPTIONS: this.kimiNodeOptions() };
	}

	/**
	 * FLY-494 (FLY-530 QA fix): FAST fail-closed preflight.
	 *   1. tmux liveness (instant, local).
	 *   2. `kimi --version` — BOUNDED (preflightTimeoutMs) + IPv4-first DNS. kimi
	 *      0.18.0 cold-starts ~11-18s; the bound stops a missing / hung binary
	 *      from wedging the Bridge dispatch thread (the probe runs before any tmux
	 *      session-timeout exists). ENOENT/timeout → throws LOUD.
	 *   3. credential PRESENCE — an INSTANT fs check (NOT a ~50-60s live `-p`
	 *      model round-trip; that false-failed every authed machine, FLY-530). A
	 *      signed-out machine has no config.toml and no credentials → fail LOUD.
	 */
	protected override runPreflight(): void {
		const timeoutMs = this.preflightTimeoutMs();
		const env = { NODE_OPTIONS: this.kimiNodeOptions() };
		this.execFileFn("tmux", ["-V"]);
		try {
			this.execFileFn(this.binaryName, ["--version"], { timeoutMs, env });
		} catch (err) {
			throw new Error(
				"[KimiTmuxAdapter] kimi --version failed or timed out (binary " +
					"missing/broken or hung at startup). Install the kimi CLI " +
					"(`brew install kimi-code`) before dispatching kimi runners. " +
					`Cause: ${(err as Error).message}`,
			);
		}
		this.assertKimiAuthConfigured();
	}

	/**
	 * FLY-494: instant credential-presence auth check. Considered signed in when
	 * EITHER `~/.kimi-code/config.toml` exists non-empty (the Moonshot api_key
	 * path) OR `~/.kimi-code/credentials/` is a non-empty dir (the device-code /
	 * membership OAuth path). This is a fs STAT of the documented config home — it
	 * does NOT parse kimi's TOML schema. An *expired* key passes here and fails
	 * loudly in-pane (same trade-off as the claude adapter, which does no live
	 * auth probe either).
	 */
	private assertKimiAuthConfigured(): void {
		const dir = this.resolveKimiConfigDir();
		const configToml = join(dir, "config.toml");
		const credentialsDir = join(dir, "credentials");
		const hasConfig = this.fileHasContent(configToml);
		const hasCredentials = this.dirHasEntries(credentialsDir);
		if (!hasConfig && !hasCredentials) {
			throw new Error(
				"[KimiTmuxAdapter] kimi is not signed in: neither " +
					`${configToml} (with a Moonshot api_key) nor ${credentialsDir} ` +
					"was found. Sign in (`kimi login`) or write your api_key into " +
					"config.toml before dispatching kimi runners.",
			);
		}
	}

	/** True when `path` exists as a non-empty regular file. */
	private fileHasContent(path: string): boolean {
		try {
			// Codex R1 (LOW): require a regular FILE — a directory named
			// `config.toml` also has a non-zero size and must NOT satisfy auth.
			const s = statSync(path);
			return s.isFile() && s.size > 0;
		} catch {
			return false;
		}
	}

	/** True when `path` is a directory with ≥1 entry (readdirSync throws on a
	 * missing path or a non-directory → false). */
	private dirHasEntries(path: string): boolean {
		try {
			return readdirSync(path).length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * FLY-494: kimi CLI args (verified against kimi 0.18.0 with REAL auth).
	 * kimi lacks claude's `--session-id`, `--permission-mode`,
	 * `--append-system-prompt-file`, `--allowed-tools`, `--name`. The unattended
	 * invocation is just `--model` (if set) + a `-p` seed prompt: `-p` runs one
	 * prompt non-interactively, prints the response, AND auto-approves tool calls
	 * by default — so it IS the unattended posture with NO separate approve flag.
	 * Do NOT add `--yolo` / `--auto`: the CLI hard-rejects combining them with `-p`
	 * ("Cannot combine --prompt with --yolo"), which would break every launch.
	 * Because kimi has no system-prompt flag and the Flywheel procedure prompt is
	 * large (FLY-154 tmux argv overflow), the combined system+task prompt is
	 * written to a 0600 per-execution file and `-p` is a SHORT pointer that tells
	 * kimi to read and follow it.
	 *
	 * `_sessionId` is accepted for signature parity (the adapter tracks it for
	 * comm.db registration) but kimi has no `--session-id` to bind it to.
	 */
	protected override buildCliArgs(
		ctx: AdapterExecutionContext,
		_sessionId: string,
	): string[] {
		const args: string[] = [];
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
