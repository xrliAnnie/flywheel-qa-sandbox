/**
 * FLY-614: `flywheel-comm token-report` — thin delegate to the flywheel-token-usage
 * engine. Keeps the heavy deps (better-sqlite3 / supabase) lazy-loaded so they only
 * load when this command is actually invoked.
 *
 * Subcommands (forwarded verbatim):
 *   flywheel-comm token-report aggregate [--since --until | --backfill-days N] [--db]
 *   flywheel-comm token-report report   [--date --trend-since --before --after |
 *                                        --rollout-date --window] [--out --json]
 *   flywheel-comm token-report daily    [--out]  (roll up the rolling window → report
 *       yesterday with a week-over-week before/after hero, or a --rollout-date anchor)
 *
 * Daily delivery to a Discord channel is done by pairing the `--out <html>` of this
 * command with `flywheel-comm publish-report --html <html> --project flywheel`.
 */
export async function runTokenReport(args: string[]): Promise<void> {
	const { runTokenReportCli } = await import("flywheel-token-usage");
	const code = await runTokenReportCli(args);
	if (code !== 0) process.exitCode = code;
}
