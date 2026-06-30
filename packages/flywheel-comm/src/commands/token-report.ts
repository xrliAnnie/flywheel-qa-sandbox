/**
 * FLY-614: `flywheel-comm token-report` — thin delegate to the flywheel-token-usage
 * engine. Keeps the heavy deps (better-sqlite3 / supabase) lazy-loaded so they only
 * load when this command is actually invoked.
 *
 * Subcommands (forwarded verbatim):
 *   flywheel-comm token-report aggregate [--since --until] [--db]
 *   flywheel-comm token-report report   [--date --trend-since --before --after --out --json]
 *   flywheel-comm token-report daily    [--out]            (aggregate today+yesterday → report yesterday)
 *
 * Daily delivery to a Discord channel is done by pairing the `--out <html>` of this
 * command with `flywheel-comm publish-report --html <html> --project flywheel`.
 */
export async function runTokenReport(args: string[]): Promise<void> {
	const { runTokenReportCli } = await import("flywheel-token-usage");
	const code = await runTokenReportCli(args);
	if (code !== 0) process.exitCode = code;
}
