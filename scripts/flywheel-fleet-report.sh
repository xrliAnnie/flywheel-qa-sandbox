#!/bin/bash
# FLY-247 WI-5: render the fleet three-layer table as HTML and publish it via
# flywheel-comm publish-report (FLY-203 pipeline). Thin wrapper — the data
# comes from `flywheel-fleet.sh plan` evidence collection.
#
#   flywheel-fleet-report.sh --project <p> [--channel <id>] [--out <file>]
#
# Apple light theme per ~/.claude/rules/html-report-style.md.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export FLYWHEEL_FLEET_SOURCED=1
export FLYWHEEL_DAEMON_SOURCED=1
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/flywheel-fleet.sh"
set +e

PUBLISH_BIN="${FLYWHEEL_FLEET_PUBLISH_BIN:-flywheel-comm}"

PROJECT=""
CHANNEL=""
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) [ -n "${2:-}" ] || die "--project requires a value"; PROJECT="$2"; shift 2 ;;
    --channel) [ -n "${2:-}" ] || die "--channel requires a value"; CHANNEL="$2"; shift 2 ;;
    --out) [ -n "${2:-}" ] || die "--out requires a value"; OUT="$2"; shift 2 ;;
    *) die "report: unknown argument $1" ;;
  esac
done

guard_env_source

[ -n "$OUT" ] || OUT="$(mktemp "${TMPDIR:-/tmp}/fleet-report.XXXXXX").html"

html_escape() {
  # config/carrier values are external input — escape before HTML interpolation
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&#39;/g"
}

rows=""
while IFS=$'\t' read -r p l r; do
  [ -n "$p" ] || continue
  st=$(collect_lead_state "$PROJECTS_JSON" "$p" "$l" "$r")
  cls=$(classify_lead "$st")
  dm=$(jq -r '.desired.model // "-"' <<< "$st"); dm=$(html_escape "${dm:--}")
  db=$(jq -r '.desired.backend' <<< "$st"); db=$(html_escape "$db")
  mm=$(jq -r '.carrier.manifestModel // "-"' <<< "$st"); mm=$(html_escape "${mm:--}")
  pm=$(jq -r '.carrier.plistModel // "-"' <<< "$st"); pm=$(html_escape "${pm:--}")
  mg=$(jq -r '.observed.management' <<< "$st")
  rt=$(jq -r '.observed.runtime' <<< "$st")
  p=$(html_escape "$p"); l=$(html_escape "$l"); cls=$(html_escape "$cls")
  color="#34c759"
  case "$cls" in
    APPLICABLE) color="#ff9500" ;;
    UNAPPLIED*) color="#86868b" ;;
  esac
  rows="${rows}<div class=\"card\" style=\"border-left:4px solid ${color}\">
    <div class=\"card-header\"><span class=\"issue-id\">${p}-${l}</span></div>
    <div class=\"card-title\">desired ${dm}@${db} · manifest ${mm} · plist ${pm}</div>
    <div class=\"card-reason\">observed: ${mg} / ${rt} — ${cls}</div>
  </div>"
done <<< "$(enumerate_targets "$PROJECTS_JSON" "" "$PROJECT")"

cat > "$OUT" <<HTML
<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fleet Report</title>
<style>
body{background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,system-ui,sans-serif;max-width:960px;margin:0 auto;padding:24px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);padding:16px;margin-bottom:12px}
.issue-id{font-family:'SF Mono',monospace;color:#1a365d;font-weight:600}
.card-title{margin-top:6px}
.card-reason{color:#86868b;font-size:0.9em;margin-top:4px}
h1{font-size:1.3em}
</style></head>
<body><h1>Fleet — per-Lead model/backend</h1>${rows}
<p style="color:#86868b">Generated $(date '+%Y-%m-%d %H:%M:%S'). Runner follow: not yet wired (FLY-247 Increment 2).</p>
</body></html>
HTML

flog "Report written: ${OUT}"

publish_args=(publish-report --html "$OUT")
[ -n "$PROJECT" ] && publish_args+=(--project "$PROJECT")
[ -n "$CHANNEL" ] && publish_args+=(--channel "$CHANNEL")
"$PUBLISH_BIN" "${publish_args[@]}"
