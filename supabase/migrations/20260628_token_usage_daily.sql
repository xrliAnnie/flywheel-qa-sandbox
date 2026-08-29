-- FLY-614 Token Usage Tracking — daily aggregate persistence (Supabase Postgres).
-- Stores ONLY daily aggregates (project / lead / issue / model / total), never raw token events.
-- Written by the local token-usage job/CLI via service_role key; read by the report renderer
-- and (future) a permanent queryable dashboard. Mirrors the cipher migration's RLS pattern.

-- 1. token_usage_daily — one row per (day, scope, dim_key)
CREATE TABLE IF NOT EXISTS token_usage_daily (
  day                 DATE        NOT NULL,
  scope               TEXT        NOT NULL CHECK (scope IN ('total','project','lead','issue','model')),
  dim_key             TEXT        NOT NULL DEFAULT '',   -- '' for total; project/lead/issue/model name
  project             TEXT,                              -- attribution project (lead/issue rows) — enables nesting + per-project trend
  input_tokens        BIGINT      NOT NULL DEFAULT 0,
  output_tokens       BIGINT      NOT NULL DEFAULT 0,
  cache_read_tokens   BIGINT      NOT NULL DEFAULT 0,
  cache_write_tokens  BIGINT      NOT NULL DEFAULT 0,
  total_tokens        BIGINT      NOT NULL DEFAULT 0,    -- input+output+cache_read+cache_write
  fresh_tokens        BIGINT      NOT NULL DEFAULT 0,    -- input+output+cache_write (cache-read excluded)
  cost_micro_usd      BIGINT      NOT NULL DEFAULT 0,    -- relative "weight" only (subscription, not a real bill)
  is_completed        BOOLEAN,                           -- denormalized convenience for scope='issue'; render-time StateStore join is source of truth
  source              TEXT        NOT NULL DEFAULT 'cc-jsonl',  -- single-valued in v1 (audit metadata)
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, scope, dim_key)
);

CREATE INDEX IF NOT EXISTS idx_tud_day ON token_usage_daily(day);
CREATE INDEX IF NOT EXISTS idx_tud_scope_proj ON token_usage_daily(scope, project);

-- 2. RLS — service-role only (no anon/client access). Matches cipher migration.
ALTER TABLE token_usage_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON token_usage_daily;
CREATE POLICY "service_role_all" ON token_usage_daily FOR ALL USING (auth.role() = 'service_role');

-- 3. Atomic replace for one day — delete that day's managed rows then insert the full set,
--    in a single server-side call (supabase-js DML alone cannot wrap a multi-statement transaction).
--    v1 is single-source ('cc-jsonl'), so a day is replaced wholesale; source is kept in the
--    delete predicate so a second source could be added later without touching this contract.
CREATE OR REPLACE FUNCTION replace_token_usage_daily(p_day DATE, p_source TEXT, p_rows JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM token_usage_daily WHERE day = p_day AND source = p_source;

  INSERT INTO token_usage_daily
    (day, scope, dim_key, project, input_tokens, output_tokens, cache_read_tokens,
     cache_write_tokens, total_tokens, fresh_tokens, cost_micro_usd, is_completed, source, updated_at)
  SELECT
    p_day,
    r->>'scope',
    COALESCE(r->>'dim_key',''),
    r->>'project',
    COALESCE((r->>'input_tokens')::BIGINT,0),
    COALESCE((r->>'output_tokens')::BIGINT,0),
    COALESCE((r->>'cache_read_tokens')::BIGINT,0),
    COALESCE((r->>'cache_write_tokens')::BIGINT,0),
    COALESCE((r->>'total_tokens')::BIGINT,0),
    COALESCE((r->>'fresh_tokens')::BIGINT,0),
    COALESCE((r->>'cost_micro_usd')::BIGINT,0),
    CASE WHEN r ? 'is_completed' THEN (r->>'is_completed')::BOOLEAN ELSE NULL END,
    p_source,
    now()
  FROM jsonb_array_elements(p_rows) AS r;
END;
$$;

-- Only the service_role may execute the replace function (no anon/authenticated).
REVOKE ALL ON FUNCTION replace_token_usage_daily(DATE, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replace_token_usage_daily(DATE, TEXT, JSONB) TO service_role;
