#!/usr/bin/env bash
# FLY-1023 M4: connector — Veeqo (API key, x-api-key header). READ-ONLY:
# order reads only. Contract: see buddy-connect.sh.

connector_id() { jq -nc '{ok:true, connector:"veeqo"}'; }

_veeqo_api() { # <path>
  local key
  key="$(fs_env_get VEEQO_API_KEY)" || return 1
  printf 'header = "x-api-key: %s"\n' "$key" \
    | curl -fsS -m 20 -K - "https://api.veeqo.com$1" 2>/dev/null
}

connector_connect() {
  local key
  key="$(fs_ask_secret "VEEQO_KEY" "把 Veeqo 的那串密钥贴进来(不会显示)")" || return 1
  fs_env_upsert VEEQO_API_KEY "$key"
  if _veeqo_api "/orders?page_size=1" >/dev/null; then
    jq -nc '{ok:true, connector:"veeqo", connected:true}'
  else
    jq -nc '{ok:false, connector:"veeqo", error_code:"auth_failed", hint:"密钥没验证通过 — 去 Veeqo 后台重新生成一个再贴一次"}'
    return 1
  fi
}

connector_probe() {
  if _veeqo_api "/orders?page_size=1" >/dev/null; then
    jq -nc '{ok:true, connector:"veeqo", probe:"ok"}'
  else
    jq -nc '{ok:false, connector:"veeqo", error_code:"probe_failed", hint:"读不到订单 — 密钥可能失效了"}'
    return 1
  fi
}

connector_pull() {
  local out
  out="$(_veeqo_api "/orders?page_size=10")" \
    || { jq -nc '{ok:false, connector:"veeqo", error_code:"pull_failed"}'; return 1; }
  jq -c '{ok:true, connector:"veeqo",
          orders:[(. // [])[] | {name:(.number // (.id|tostring)), status:(.status // "unknown"),
                   fulfillment:(.status // "unknown"), created_at:(.created_at // "")}]}' <<<"$out" 2>/dev/null \
    || { jq -nc '{ok:false, connector:"veeqo", error_code:"pull_parse_failed"}'; return 1; }
}
