#!/usr/bin/env bash
# FLY-1023 M4: connector — Ordoro (API key, basic auth). READ-ONLY: order
# reads only. Contract: see buddy-connect.sh.

connector_id() { jq -nc '{ok:true, connector:"ordoro"}'; }

_ordoro_api() { # <path>
  local key
  key="$(fs_env_get ORDORO_API_KEY)" || return 1
  printf 'user = "%s"\n' "$key" \
    | curl -fsS -m 20 -K - "https://api.ordoro.com$1" 2>/dev/null
}

connector_connect() {
  local key
  key="$(fs_ask_secret "ORDORO_KEY" "把 Ordoro 的那串密钥贴进来(不会显示,格式一般是 用户名:密钥)")" || return 1
  fs_env_upsert ORDORO_API_KEY "$key"
  if _ordoro_api "/order?limit=1" >/dev/null; then
    jq -nc '{ok:true, connector:"ordoro", connected:true}'
  else
    jq -nc '{ok:false, connector:"ordoro", error_code:"auth_failed", hint:"密钥没验证通过 — 去 Ordoro 后台确认一下再贴一次"}'
    return 1
  fi
}

connector_probe() {
  if _ordoro_api "/order?limit=1" >/dev/null; then
    jq -nc '{ok:true, connector:"ordoro", probe:"ok"}'
  else
    jq -nc '{ok:false, connector:"ordoro", error_code:"probe_failed", hint:"读不到订单 — 密钥可能失效了"}'
    return 1
  fi
}

connector_pull() {
  local out
  out="$(_ordoro_api "/order?limit=10")" \
    || { jq -nc '{ok:false, connector:"ordoro", error_code:"pull_failed"}'; return 1; }
  jq -c '{ok:true, connector:"ordoro",
          orders:[(.order // [])[] | {name:(.order_number // ""), status:(.status // "unknown"),
                   fulfillment:(.status // "unknown"), created_at:(.order_placed_date // "")}]}' <<<"$out" 2>/dev/null \
    || { jq -nc '{ok:false, connector:"ordoro", error_code:"pull_parse_failed"}'; return 1; }
}
