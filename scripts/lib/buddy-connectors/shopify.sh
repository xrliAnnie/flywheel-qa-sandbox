#!/usr/bin/env bash
# FLY-1023 M4: connector — Shopify (custom-app Admin API token, read_orders).
# Contract (see buddy-connect.sh): connector_id / connector_connect /
# connector_probe / connector_pull — one JSON line on stdout, semantic exits
# (0 ok / 1 fail / 3 needs-guidance). READ-ONLY scope is an iron rule: the
# only endpoints touched are order reads.
#
# Self-serve auth (research R6): the merchant creates a custom app in their
# own admin (Settings → Apps → Develop apps), grants read_orders, and pastes
# the Admin API access token into the hidden input — no platform OAuth app,
# no review queue. Real-store verification = QA stage.

connector_id() { jq -nc '{ok:true, connector:"shopify"}'; }

_shopify_api() { # <path> — GET with the token via curl config on stdin
  local domain token
  domain="$(fs_env_get SHOPIFY_STORE_DOMAIN)" || return 1
  token="$(fs_env_get SHOPIFY_ADMIN_TOKEN)" || return 1
  printf 'header = "X-Shopify-Access-Token: %s"\n' "$token" \
    | curl -fsS -m 20 -K - "https://${domain}/admin/api/2024-01$1" 2>/dev/null
}

connector_connect() {
  local domain token
  domain="$(fs_env_get SHOPIFY_STORE_DOMAIN 2>/dev/null || true)"
  if [ -z "$domain" ]; then
    domain="$(fs_ask_value "SHOPIFY_STORE_DOMAIN" "你的店铺后台网址(形如 yourshop.myshopify.com)")" || return 1
    printf '%s' "$domain" | grep -Eq '^[a-z0-9][a-z0-9.-]+$' \
      || { jq -nc '{ok:false, connector:"shopify", error_code:"bad_domain", hint:"店铺网址看着不太对,应该形如 yourshop.myshopify.com"}'; return 1; }
    fs_env_upsert SHOPIFY_STORE_DOMAIN "$domain"
  fi
  token="$(fs_ask_secret "SHOPIFY_TOKEN" "把那串访问密钥贴进来(不会显示)")" || return 1
  fs_env_upsert SHOPIFY_ADMIN_TOKEN "$token"
  if _shopify_api "/orders.json?limit=1&status=any" >/dev/null; then
    jq -nc '{ok:true, connector:"shopify", connected:true}'
  else
    jq -nc '{ok:false, connector:"shopify", error_code:"auth_failed", hint:"密钥没验证通过 — 回到店铺后台确认 app 勾了「读订单」权限,重新复制一次密钥"}'
    return 1
  fi
}

connector_probe() {
  if _shopify_api "/orders.json?limit=1&status=any" >/dev/null; then
    jq -nc '{ok:true, connector:"shopify", probe:"ok"}'
  else
    jq -nc '{ok:false, connector:"shopify", error_code:"probe_failed", hint:"读不到订单 — 密钥可能过期或权限不够"}'
    return 1
  fi
}

# pull → NON-SENSITIVE order summaries only: number/status/fulfillment/time.
connector_pull() {
  local out
  out="$(_shopify_api "/orders.json?limit=10&status=any")" \
    || { jq -nc '{ok:false, connector:"shopify", error_code:"pull_failed"}'; return 1; }
  jq -c '{ok:true, connector:"shopify",
          orders:[(.orders // [])[] | {name, status:(.financial_status // "unknown"),
                   fulfillment:(.fulfillment_status // "unfulfilled"),
                   created_at}]}' <<<"$out" 2>/dev/null \
    || { jq -nc '{ok:false, connector:"shopify", error_code:"pull_parse_failed"}'; return 1; }
}
