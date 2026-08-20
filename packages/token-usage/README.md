# flywheel-token-usage (FLY-614)

Fine-grained token usage tracking — **per project / per Lead / per completed issue / per model** — so Annie can see *who burns how much* and measure the savings of cost-reduction changes (e.g. the ponytail plugin) before/after.

This is the **monitoring** foundation of the token-management trio (① tracking ② per-project switch ③ evaluation). It only makes usage *visible*; it does not change anything.

## How it works

```
CC jsonl logs (~/.claude/projects)
  → scan + dedup (by requestId)
  → classify by cwd  (project / runner-issue / lead / model)
  → aggregate daily  (scope = total | project | lead | issue | model)
  → persist          (Supabase primary, local SQLite fallback)
  → render           (Apple-light HTML + text + JSON)
  → deliver          (daily auto-post to a Discord channel)
```

- **Metric**: raw token **usage** is primary (input / output / cache split). USD is a secondary relative **weight** only — NOT a real bill (subscription).
- **Hierarchy**: each project's total = its `runner + main` work **+ its Leads** (1:1, no double-count). Under each project: its Leads + that day's **completed** issues (in-progress issues are noted, counted when they complete).
- **lead→project map is config-derived** (authoritative): read from the fleet config `~/.flywheel/projects.json` (`projectName` + `leads[].agentId`), not hardcoded. A small corrected fallback map is used only if the config is unreadable.
- **Completion** is decided at render time from StateStore (`status = 'completed'`, latest non-QA session) — never frozen into the stored aggregates, so it stays correct as issues complete.
- **Trend**: two dimensions — whole-fleet total over time, and each project over time.
- **Attribution accuracy**: total token count matches `ccusage` to within ~0.01% on real logs (subagent sidechains attributed to their parent project via `cwd`).

## CLI

Via the package bin `flywheel-token-report`, or `flywheel-comm token-report`:

```bash
# scan logs → persist daily aggregates (rolling window, default 14 days ending today;
# override with --backfill-days N or TOKEN_USAGE_BACKFILL_DAYS, or --since/--until)
flywheel-comm token-report aggregate [--since YYYY-MM-DD --until YYYY-MM-DD] [--backfill-days N]

# render a day's report from the store
flywheel-comm token-report report --date YYYY-MM-DD \
  [--trend-since YYYY-MM-DD] \
  [--before A..B --after C..D] \        # explicit before/after comparison windows, OR
  [--rollout-date YYYY-MM-DD --window N] \  # ponytail-style fixed anchor (window default 7d)
  [--out report.html] [--json]

# one-shot daily: aggregate the rolling window → report yesterday → write HTML.
# The daily report defaults to a week-over-week before/after comparison hero
# (previous 7 days vs latest 7). Pin a fixed rollout anchor instead via
# --rollout-date / TOKEN_USAGE_ROLLOUT_DATE (+ --window / TOKEN_USAGE_WINDOW_DAYS).
flywheel-comm token-report daily --out /tmp/report.html
```

Common flags: `--db <sqlite-fallback-path>` (default `~/.flywheel/token-usage.db`),
`--completed-db <teamlead.db>`, `--base-dir <~/.claude/projects>`, `--tz <IANA tz>`,
`--backfill-days N` (rolling aggregate window, default 14), `--rollout-date` / `--window`
(fixed before/after anchor). The rolling aggregate window always extends to cover the
comparison's before-window, so a Supabase-unreachable local fallback still self-heals a
full trend + a correct comparison hero.

Reports run an integrity self-check before returning success: the report day must have
a `total` row, its project + Lead attribution must match that total, and the latest
stored total day must reach the requested report day. A failed check is rendered as a
red banner in HTML (and an explicit text error) and exits with code `3` after writing
the artifact. For deliberate empty-data diagnostics only, `--allow-empty` or
`TOKEN_USAGE_ALLOW_EMPTY=1` keeps the visible warning but permits exit code `0`.

## Persistence

- **Primary**: Supabase Postgres table `token_usage_daily` (see
  `supabase/migrations/20260628_token_usage_daily.sql` — table + indexes + RLS
  service-role-only policy + the atomic `replace_token_usage_daily()` RPC). Apply the
  migration once (Supabase CLI / `psql`) before enabling the daily job; the runtime
  only does DML and assumes the table + RPC exist.
- **Fallback**: local SQLite (`~/.flywheel/token-usage.db`) when Supabase creds are
  absent or unreachable, so the daily job never hard-fails. Rows carry `sync_status`;
  replay with `syncLocalToRemote`.
- Stores **daily aggregates only** (~40–60 rows/day → tens of MB/year) — never raw token
  events — so the Supabase free tier lasts for years. The schema is the single source of
  truth for token data (FLY-616 reads `scope='issue'` rows as a cost dimension).

## Daily automation

`scripts/token-usage-daily.sh` + `scripts/launchd/com.flywheel.token-usage-daily.plist` (launchd):
aggregate → render → `flywheel-comm publish-report` to the dedicated **cost-dashboard**
Discord channel (`FLYWHEEL_TOKEN_USAGE_CHANNEL`). Single-writer via an atomic lock; loads
creds from `~/.flywheel/.env`.

One-time deploy step: `scripts/token-usage-setup-channel.sh` find-or-creates the
`cost-dashboard` channel and prints its id (needs a bot with `MANAGE_CHANNELS` +
`FLYWHEEL_GUILD_ID`; run with the operator present — the daily job only reads the id).

## Out of scope

Per-project on/off switch (②), evaluation (③), a live queryable dashboard frontend
(the Supabase schema leaves the path open), %-of-plan-quota, multi-account/multi-machine.
