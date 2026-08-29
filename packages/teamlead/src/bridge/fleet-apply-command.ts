/**
 * FLY-709 P4.2 (Path C) — copyable apply-command generation.
 *
 * The hosted page cannot call the Bridge back (CSP `default-src 'none'`,
 * Bridge is loopback-only), so remote control is copy-paste: the console
 * renders a command Annie pastes to a Lead, and the Lead runs it on the
 * machine. These builders are the single source of that command text for both
 * the localhost console and the hosted interactive page.
 *
 * Safety contract (Codex design review R1 #4):
 * - The script/CLI paths are the Bridge-runtime ones (same derivation
 *   `spawnEngine` uses) — never a hardcoded checkout, so staging/worktree
 *   deployments emit commands that target their own checkout.
 * - EVERY argv token is single-quoted with embedded-quote escaping: model ids
 *   like `claude-opus-4-8[1m]` are zsh-glob-sensitive, and paths may contain
 *   spaces/apostrophes.
 * - A Lead-backend change is NEVER rendered as an apply flag — the engine
 *   fail-closes on backend diffs (managed switch = FLY-264). It becomes a
 *   comment line pointing at the manual cutover runbook.
 */

/** POSIX single-quote: wrap in '...', escaping embedded ' as '\''. */
export function shellQuote(token: string): string {
	return `'${token.replace(/'/g, "'\\''")}'`;
}

/** null = back to account default → the CLI literal "default". */
function cliValue(v: string | null): string {
	return v === null ? "default" : v;
}

export interface LeadApplyChange {
	/** Exact {project}-{lead} key (fleet engine --lead grammar). */
	key: string;
	/** undefined = dimension untouched; null = back to account default. */
	toModel?: string | null;
	toEffort?: string | null;
	/** Present when the draft includes a Lead-backend change (manual cutover). */
	backendNote?: { from: string; to: string };
}

export function buildLeadApplyCommands(
	fleetScriptPath: string,
	changes: LeadApplyChange[],
): string {
	const lines: string[] = [];
	for (const change of changes) {
		if (change.backendNote) {
			lines.push(
				`# ${change.key}: backend ${change.backendNote.from} → ${change.backendNote.to} 需人工 cutover（受管切换 = FLY-264 未做，见 FLY-350/398 runbook）`,
			);
		}
		const dims: string[] = [];
		if (change.toModel !== undefined) {
			dims.push("--model", shellQuote(cliValue(change.toModel)));
		}
		if (change.toEffort !== undefined) {
			dims.push("--effort", shellQuote(cliValue(change.toEffort)));
		}
		if (dims.length === 0) continue;
		lines.push(
			[
				"bash",
				shellQuote(fleetScriptPath),
				"apply",
				"--lead",
				shellQuote(change.key),
				...dims,
				"--yes",
			].join(" "),
		);
	}
	return lines.join("\n");
}

export interface RunnerApplyChange {
	/** undefined = dimension untouched; null = remove override (default). */
	model?: string | null;
	effort?: string | null;
	backend?: string | null;
}

export function buildRunnerApplyCommand(
	commCliPath: string,
	projectName: string,
	change: RunnerApplyChange,
	cronId?: string,
): string {
	const dims: string[] = [];
	if (change.backend !== undefined) {
		dims.push("--backend", shellQuote(cliValue(change.backend)));
	}
	if (change.model !== undefined) {
		dims.push("--model", shellQuote(cliValue(change.model)));
	}
	if (change.effort !== undefined) {
		dims.push("--effort", shellQuote(cliValue(change.effort)));
	}
	if (dims.length === 0) return "";
	return [
		"node",
		shellQuote(commCliPath),
		"runner-config",
		"apply",
		"--project",
		shellQuote(projectName),
		...(cronId !== undefined ? ["--cron", shellQuote(cronId)] : []),
		...dims,
		"--yes",
	].join(" ");
}

/**
 * The SAME builders as embeddable browser JS (ES5, no template literals — it
 * is inlined into pages that are themselves TS template literals). Exposed as
 * `window.FleetCmd`. A vitest parity suite evaluates this source and asserts
 * byte-identical output with the TS builders above, so the two cannot drift.
 */
export const APPLY_COMMAND_JS: string = [
	"var FleetCmd = (function(){",
	"  function shq(t){ return \"'\" + String(t).replace(/'/g, \"'\\\\''\") + \"'\"; }",
	'  function cliVal(v){ return v === null ? "default" : v; }',
	"  function leadCommands(fleetScriptPath, changes){",
	"    var lines = [];",
	"    for (var i = 0; i < changes.length; i++) {",
	"      var c = changes[i];",
	"      if (c.backendNote) {",
	'        lines.push("# " + c.key + ": backend " + c.backendNote.from + " \\u2192 " + c.backendNote.to + " \\u9700\\u4eba\\u5de5 cutover\\uff08\\u53d7\\u7ba1\\u5207\\u6362 = FLY-264 \\u672a\\u505a\\uff0c\\u89c1 FLY-350/398 runbook\\uff09");',
	"      }",
	"      var dims = [];",
	'      if (c.toModel !== undefined) { dims.push("--model", shq(cliVal(c.toModel))); }',
	'      if (c.toEffort !== undefined) { dims.push("--effort", shq(cliVal(c.toEffort))); }',
	"      if (dims.length === 0) continue;",
	'      lines.push(["bash", shq(fleetScriptPath), "apply", "--lead", shq(c.key)].concat(dims).concat(["--yes"]).join(" "));',
	"    }",
	'    return lines.join("\\n");',
	"  }",
	"  function runnerCommand(commCliPath, projectName, change, cronId){",
	"    var dims = [];",
	'    if (change.backend !== undefined) { dims.push("--backend", shq(cliVal(change.backend))); }',
	'    if (change.model !== undefined) { dims.push("--model", shq(cliVal(change.model))); }',
	'    if (change.effort !== undefined) { dims.push("--effort", shq(cliVal(change.effort))); }',
	'    if (dims.length === 0) return "";',
	'    var argv = ["node", shq(commCliPath), "runner-config", "apply", "--project", shq(projectName)];',
	'    if (cronId !== undefined) { argv = argv.concat(["--cron", shq(cronId)]); }',
	'    return argv.concat(dims).concat(["--yes"]).join(" ");',
	"  }",
	"  return { leadCommands: leadCommands, runnerCommand: runnerCommand };",
	"})();",
].join("\n");
