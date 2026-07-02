/**
 * FLY-751: per-runner MCP slimming — the pure profile resolver.
 *
 * Why: FLY-753 measured each Claude runner session at ~1.4GB, of which the
 * per-session MCP plugin suite is ~1.0GB — 20 concurrent runners were enough
 * to fill 20GB of swap on the 48GB production machine. Transcript analysis
 * (375 runner sessions, 30 days, 4+ projects) showed the heavy plugins are
 * essentially unused by runners: serena 0/375, context7 1/375, playwright
 * 2/375, discord ~4/372. Browser (claude-in-chrome) usage is real but ~90%
 * QA sessions — hence the QA exemption below. context7 is deliberately NOT
 * in the default list despite the low usage — the founder ruled runners keep
 * library-doc lookup (2026-07-01, FLY-751 review).
 *
 * The profile is consumed by TmuxAdapter (claude-tmux only): disabledPlugins
 * become a per-launch `--settings {"enabledPlugins":{…:false}}` merge and
 * disableChrome becomes `--no-chrome`. Real-machine spike (2026-07-01, tmux
 * interactive form) confirmed the disable semantics: baseline claude spawned
 * 8 MCP child processes (~850MB RSS); with the four plugins disabled it
 * spawned 0 while still answering normally.
 *
 * Default ON fleet-wide (FLY-707 default-enable policy). Escape hatches:
 *   - `FLYWHEEL_RUNNER_SLIM_MCP=0`  — global kill-switch (byte-compat spawn)
 *   - `full-mcp` issue label        — per-issue opt-out (content/research
 *     runners that genuinely need discord/browser)
 *   - `FLYWHEEL_RUNNER_DISABLED_PLUGINS` — override the plugin list; UNSET
 *     means the built-in default, SET (even to "") is authoritative after
 *     split/trim/filter. An empty override still slims chrome for non-QA.
 */

export interface RunnerMcpProfile {
	/** Marketplace-qualified plugin keys to disable for this launch. */
	disabledPlugins: string[];
	/** When true the launch gets `--no-chrome` (Claude-in-Chrome off). */
	disableChrome: boolean;
}

const PLAYWRIGHT_PLUGIN = "playwright@claude-plugins-official";

/**
 * Built-in default disable list. Chosen from the FLY-753 measured suite by
 * runner usage rate (see module doc); each entry costs 120-200MB per session.
 * discord stays pending the founder's final call in the FLY-751 thread —
 * removing it is a one-line change here (runners can't post to Discord
 * anyway: the Bridge forbids it, delivery goes through the Lead relay).
 */
export const DEFAULT_RUNNER_DISABLED_PLUGINS: readonly string[] = [
	"discord@claude-plugins-official",
	PLAYWRIGHT_PLUGIN,
	"serena@claude-plugins-official",
];

export interface ResolveRunnerMcpProfileArgs {
	/** Session role from the start request — "qa" keeps the browser. */
	sessionRole?: string;
	/** Linear issue labels (any case) — `full-mcp` opts out entirely. */
	issueLabels?: readonly string[];
	/** Process env (injectable for tests). */
	env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the MCP slim profile for a claude-tmux runner launch, or `null`
 * when the launch must NOT be slimmed (kill-switch, full-mcp label, or a
 * degenerate profile with nothing to disable). Pure given args.env.
 */
export function resolveRunnerMcpProfile(
	args: ResolveRunnerMcpProfileArgs,
): RunnerMcpProfile | null {
	const env = args.env ?? process.env;

	if (env.FLYWHEEL_RUNNER_SLIM_MCP?.trim() === "0") return null;

	const labels = args.issueLabels ?? [];
	if (labels.some((label) => label.toLowerCase() === "full-mcp")) return null;

	// UNSET env → built-in default; SET (including "") is authoritative.
	const rawList = env.FLYWHEEL_RUNNER_DISABLED_PLUGINS;
	const baseList =
		rawList === undefined
			? [...DEFAULT_RUNNER_DISABLED_PLUGINS]
			: rawList
					.split(",")
					.map((entry) => entry.trim())
					.filter(Boolean);

	const isQa = args.sessionRole === "qa";
	const disabledPlugins = isQa
		? baseList.filter((plugin) => plugin !== PLAYWRIGHT_PLUGIN)
		: baseList;
	const disableChrome = !isQa;

	// QA with an empty list has nothing left to slim — treat as no profile so
	// the spawn stays byte-identical to the legacy form.
	if (disabledPlugins.length === 0 && !disableChrome) return null;

	return { disabledPlugins, disableChrome };
}
