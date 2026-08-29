#!/usr/bin/env bash
# FLY-1023 M4: connector — email over IMAP (app password; Gmail-first with a
# generic-IMAP fallback). READ-ONLY by construction: the only verbs used are
# EXAMINE (read-only select) and SEARCH; message BODIES are never cached —
# the pull summarizes headers (from-domain / subject / date) only.
# curl's imaps:// support carries the transport; credentials travel via a
# curl config on stdin (never argv). Contract: see buddy-connect.sh.

connector_id() { jq -nc '{ok:true, connector:"imap"}'; }

_imap_curl() { # <url-suffix> <request>
  local host user pass
  host="$(fs_env_get IMAP_HOST)" || return 1
  user="$(fs_env_get IMAP_USER)" || return 1
  pass="$(fs_env_get IMAP_APP_PASSWORD)" || return 1
  printf 'user = "%s:%s"\n' "$user" "$pass" \
    | curl -fsS -m 25 -K - "imaps://${host}/INBOX${1:-}" --request "${2:-EXAMINE INBOX}" 2>/dev/null
}

connector_connect() {
  local host user pass
  host="$(fs_env_get IMAP_HOST 2>/dev/null || true)"
  if [ -z "$host" ]; then
    host="$(fs_ask_value "IMAP_HOST" "邮箱服务商的收件地址(Gmail 直接回车用 imap.gmail.com)")" || return 1
    [ -n "$host" ] || host="imap.gmail.com"
    fs_env_upsert IMAP_HOST "$host"
  fi
  user="$(fs_ask_value "IMAP_USER" "你的邮箱地址")" || return 1
  fs_env_upsert IMAP_USER "$user"
  pass="$(fs_ask_secret "IMAP_APP_PASSWORD" "邮箱的应用专用密码(不是登录密码;Gmail 在「安全性→两步验证→应用专用密码」里生成;不会显示)")" || return 1
  fs_env_upsert IMAP_APP_PASSWORD "$pass"
  if _imap_curl "" "EXAMINE INBOX" >/dev/null; then
    jq -nc '{ok:true, connector:"imap", connected:true}'
  else
    jq -nc '{ok:false, connector:"imap", error_code:"auth_failed", hint:"没连上邮箱 — 确认用的是「应用专用密码」而不是登录密码,再试一次"}'
    return 1
  fi
}

connector_probe() {
  if _imap_curl "" "EXAMINE INBOX" >/dev/null; then
    jq -nc '{ok:true, connector:"imap", probe:"ok"}'
  else
    jq -nc '{ok:false, connector:"imap", error_code:"probe_failed", hint:"邮箱连不上了 — 应用专用密码可能被回收了"}'
    return 1
  fi
}

# pull → recent-message summary: COUNT of matches in the last 7 days plus
# the raw id list length. Header-level detail (from/subject per message) is
# fetched lazily by the Captain when it needs to cross-check one order —
# NEVER cached here (red line: no mail-content persistence).
connector_pull() {
  local since ids n
  since="$(date -v-7d '+%d-%b-%Y' 2>/dev/null || date -d '7 days ago' '+%d-%b-%Y' 2>/dev/null)"
  ids="$(_imap_curl "" "SEARCH SINCE $since")" \
    || { jq -nc '{ok:false, connector:"imap", error_code:"pull_failed"}'; return 1; }
  n="$(printf '%s' "$ids" | tr ' ' '\n' | grep -c '^[0-9][0-9]*$' || true)"
  jq -nc --argjson n "${n:-0}" --arg s "$since" \
    '{ok:true, connector:"imap", recent_messages:{since:$s, count:$n}}'
}
