/**
 * FLY-751: per-runner MCP slimming — the pure profile resolver.
 *
 * Why: FLY-753 measured each Claude runner session at ~1.4GB, of which the
 * per-session MCP plugin suite is ~1.0GB — 20 concurrent runners were enough
 * to fill 20GB of swap on the 48GB production machine. Transcript analysis
 * (375 runner sessions, 30 days, 4+ projects) showed the heavy plugins are
 * essentially unused by runners: serena 0/375, context7 1/375, playwright
 * 2/375, discord ~4/372. context7 is deliberately NOT in the default list
 * despite the low usage — the founder ruled runners keep library-doc lookup
 * (2026-07-01, FLY-751 review).
 *
 * FLY-812 (P1 regression fix): Claude-in-Chrome now defaults ON for every
 * runner. FLY-751 had disabled it for all non-QA runners (`!isQa`), which
 * silently broke legitimate non-QA browser users — the founder's Sub nightly
 * cron, the 806 video skill, research runners — fleet-wide. Chrome is a real
 * need, not a QA-only tool; fleet memory is bounded by the FLY-766 leaked-
 * Chrome reaper (the big agent-browser Chrome-for-Testing spikes) plus the
 * retained plugin slim, not by force-disabling the browser. Chrome is only
 * turned off when a runner explicitly opts out via the `no-chrome` label.
 *
 * The profile is consumed by TmuxAdapter (claude-tmux only): disabledPlugins
 * become a per-launch `--settings {"enabledPlugins":{…:false}}` merge and
 * disableChrome becomes `--no-chrome`. Real-machine spike (2026-07-01, tmux
 * interactive form) confirmed the disable semantics: baseline claude spawned
 * 8 MCP child processes (~850MB RSS); disabling the heavy plugins spawned 0
 * while still answering normally.
 *
 * Default ON fleet-wide (FLY-707 default-enable policy). Escape hatches:
 *   - `FLYWHEEL_RUNNER_SLIM_MCP=0`  — global kill-switch (byte-compat spawn)
 *   - `full-mcp` issue label        — per-issue opt-out of ALL slimming
 *     (re-enables serena; a safety hatch for a runner that needs it back)
 *   - `no-chrome` issue label       — per-issue chrome opt-out ONLY (serena
 *     still slimmed) — for runners known not to need the browser
 *   - `FLYWHEEL_RUNNER_DISABLED_PLUGINS` — override the plugin list; UNSET
 *     means the built-in default, SET (even to "") is authoritative after
 *     split/trim/filter. An empty override leaves chrome ON unless `no-chrome`.
 */

export interface RunnerMcpProfile {
	/** Marketplace-qualified plugin keys to disable for this launch. */
	disabledPlugins: string[];
	/** When true the launch gets `--no-chrome` (Claude-in-Chrome off). */
	disableChrome: boolean;
	/**
	 * FLY-1185 §2.7: marketplace-qualified plugin keys to POSITIVELY enable
	 * (`true` entries in the per-launch `--settings` merge). This is how a
	 * launch overrides the machine-level default-off (the ops step disables
	 * playwright in `~/.claude/settings.json`; per-launch settings are the
	 * highest non-managed precedence — FLY-615/751 measured). Applied AFTER
	 * the disable list, so an explicit opt-in always wins.
	 */
	enabledPluginsExtra: string[];
}

const PLAYWRIGHT_PLUGIN = "playwright@claude-plugins-official";

/**
 * Built-in default disable list. FLY-812 (founder review 2026-07-03) narrowed
 * this to serena ONLY. discord and playwright were removed from the default
 * because the founder confirmed real runner uses: runners sometimes need
 * discord during testing, and geoforge3d testing needs playwright — disabling
 * them fleet-wide (FLY-751) risked the same over-slim regression this issue
 * fixes. serena stays because it is genuinely unused (0/375 runner sessions,
 * 30 days, 4+ projects — FLY-751 transcript analysis) and the founder accepted
 * the small ~120-200MB/session save. context7 remains excluded too (founder
 * ruled runners keep library-doc lookup). Any further slim is a separate,
 * measured issue — not this P1.
 */
export const DEFAULT_RUNNER_DISABLED_PLUGINS: readonly string[] = [
	"serena@claude-plugins-official",
];

export interface ResolveRunnerMcpProfileArgs {
	/**
	 * Session role from the start request. Since FLY-812 narrowed the default
	 * slim to serena only, playwright is kept for every runner; this "qa" carve-
	 * out now only matters as a defense when an operator env-disables playwright.
	 */
	sessionRole?: string;
	/**
	 * Linear issue labels (any case) — `full-mcp` opts out of all slimming,
	 * `no-chrome` opts out of the browser only (FLY-812).
	 */
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

	// FLY-1185 §2.7 KNOWN LIMITATION (byte-compat trade-off, documented in the
	// plan): FLYWHEEL_RUNNER_SLIM_MCP=0 keeps the legacy null-profile spawn, so
	// the `playwright` label CANNOT opt back in under the kill-switch — the
	// machine-level default-off then applies unconditionally.
	if (env.FLYWHEEL_RUNNER_SLIM_MCP?.trim() === "0") return null;

	const labels = args.issueLabels ?? [];
	const lower = labels.map((l) => l.toLowerCase());
	const isQa = args.sessionRole === "qa";

	// FLY-1185 §2.7: positive opt-ins — the ONLY way playwright comes back
	// after the machine-level default-off. QA runners keep it structurally;
	// the `playwright` label opts a specific issue in; `full-mcp` means
	// "everything available", which now must also carry the positive
	// playwright entry (returning null would leave the machine default OFF).
	const enabledPluginsExtra: string[] = [];
	if (isQa || lower.includes("playwright") || lower.includes("full-mcp")) {
		enabledPluginsExtra.push(PLAYWRIGHT_PLUGIN);
	}

	if (lower.includes("full-mcp")) {
		// full-mcp: no slimming — but the positive opt-ins must NOT degenerate
		// to a null profile (§2.7 "extra 非空不退化 null").
		return enabledPluginsExtra.length > 0
			? { disabledPlugins: [], disableChrome: false, enabledPluginsExtra }
			: null;
	}

	// UNSET env → built-in default; SET (including "") is authoritative.
	const rawList = env.FLYWHEEL_RUNNER_DISABLED_PLUGINS;
	const baseList =
		rawList === undefined
			? [...DEFAULT_RUNNER_DISABLED_PLUGINS]
			: rawList
					.split(",")
					.map((entry) => entry.trim())
					.filter(Boolean);

	// QA keeps playwright even if it was env-disabled. Post-FLY-812 the default
	// list no longer contains playwright (kept fleet-wide for geoforge3d
	// testing), so this filter is a no-op for the built-in default and only
	// bites when FLYWHEEL_RUNNER_DISABLED_PLUGINS explicitly lists playwright.
	const disabledPlugins = isQa
		? baseList.filter((plugin) => plugin !== PLAYWRIGHT_PLUGIN)
		: baseList;
	// FLY-812: Claude-in-Chrome defaults ON for every runner (regression fix —
	// FLY-751's `!isQa` broke the founder's Sub nightly cron / 806 skill /
	// research runners). Chrome is only disabled when a runner explicitly opts
	// out via the `no-chrome` label. Fleet memory is bounded by the FLY-766
	// leaked-Chrome reaper + the retained plugin slim, not by killing chrome.
	const disableChrome = lower.includes("no-chrome");

	// FLY-1185 §2.7: a positive opt-in must never appear in the disable list —
	// applied disabled-first-extra-after in the adapter merge, but keeping the
	// sets disjoint here makes the intent audit-obvious.
	const disabledMinusExtra = disabledPlugins.filter(
		(p) => !enabledPluginsExtra.includes(p),
	);

	// Nothing left to slim AND nothing to positively enable AND chrome stays on
	// → no profile, spawn byte-identical to the legacy form. An explicit
	// `no-chrome` opt-out OR a positive opt-in still has work to do and must
	// survive this guard even with an empty disable list (§2.7).
	if (
		disabledMinusExtra.length === 0 &&
		!disableChrome &&
		enabledPluginsExtra.length === 0
	) {
		return null;
	}

	return {
		disabledPlugins: disabledMinusExtra,
		disableChrome,
		enabledPluginsExtra,
	};
}
