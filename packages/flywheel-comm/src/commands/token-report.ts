/**
 * FLY-614: `flywheel-comm token-report` — thin delegate to the flywheel-token-usage
 * engine. Keeps the heavy deps (better-sqlite3 / supabase) lazy-loaded so they only
 * load when this command is actually invoked.
 *
 * Subcommands (forwarded verbatim):
 *   flywheel-comm token-report aggregate [--since --until | --backfill-days N] [--db]
 *   flywheel-comm token-report report   [--date --trend-since --before --after |
 *                                        --rollout-date --window] [--out --json]
 *                                       [--allow-empty]
 *   flywheel-comm token-report daily    [--out]  (roll up the rolling window → report
 *       yesterday with a week-over-week before/after hero, or a --rollout-date anchor)
 *
 * Daily delivery to a Discord channel is done by pairing the `--out <html>` of this
 * command with `flywheel-comm publish-report --html <html> --project flywheel`.
 * Report integrity failures are written visibly, then propagated as exit code 3;
 * `--allow-empty` keeps the warning but explicitly permits exit code 0.
 */
export async function runTokenReport(args: string[]): Promise<void> {
	const { runTokenReportCli } = await import("flywheel-token-usage");
	const code = await runTokenReportCli(args);
	if (code !== 0) process.exitCode = code;
}
