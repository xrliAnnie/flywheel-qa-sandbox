# FLY-713 ③ — Supabase `token_usage_daily` unreachable: diagnosis + fix

**Date**: 2026-06-30
**Issue**: FLY-713 (priority-2 ③)

## Symptom

Every daily token-usage run logged and the report rendered a warning banner:

```
[token-usage] Supabase unreachable (supabase queryDaily: Could not find the table
'public.token_usage_daily' in the schema cache); using local-only store …
```

So the report silently fell back to the local SQLite store on every run.

## Root cause (diagnosed, not guessed)

Probed the prod Supabase project (`cjnscsizaqdwjjfqvplc`) with the service-role key:

| Probe | Result |
|---|---|
| `GET /rest/v1/token_usage_daily` | **404 PGRST205** — "Could not find the table" |
| `POST /rest/v1/rpc/replace_token_usage_daily` | **404 PGRST202** — "Could not find the function" |
| `GET /rest/v1/` (cipher_* tables) | **200** — reachable |

So the connection / creds / project are **fine** — only the FLY-614 migration was
missing. `supabase/migrations/20260628_token_usage_daily.sql` (from FLY-614 #384)
creates the table + indexes + RLS + the `replace_token_usage_daily` RPC, and the
store's own comment says the DDL is "applied out-of-band". It was **never applied**
to prod — nothing ensured it, so it silently never ran.

## Fix

Applied the (idempotent) migration to prod via the direct DB connection:

```bash
set -a; . ~/.flywheel/.env; set +a          # SUPABASE_DB_PASSWORD
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql \
  -h db.cjnscsizaqdwjjfqvplc.supabase.co -p 5432 -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -f supabase/migrations/20260628_token_usage_daily.sql
```

The migration is `CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE FUNCTION` /
`DROP POLICY IF EXISTS` + `CREATE POLICY` — additive and idempotent, so re-running
it is safe.

## Verification

- `GET /rest/v1/token_usage_daily` → **200** (was 404); RPC `POST` → **204**.
  PostgREST auto-reloaded its schema cache after the DDL.
- Real run `token-report aggregate --since 2026-06-29 --until 2026-06-30` →
  `store=supabase` (no local fallback), persisted 2 days.
- REST confirms rows landed: `day=2026-06-29 scope=total total_tokens=2263103985`.
- The live daily report now reaches Supabase — no fallback, no warning banner.

## Follow-up (out of scope for FLY-713)

The root cause is operational: nothing ensures a merged migration is applied to
prod. A durable fix (a `token-report migrate` / deploy hook that applies pending
Supabase migrations, or wiring these into the fleet setup) is worth a follow-up so
this class of "migration merged but never applied" can't recur silently.
