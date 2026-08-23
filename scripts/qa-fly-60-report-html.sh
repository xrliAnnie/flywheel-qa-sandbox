#!/usr/bin/env bash
# FLY-60 — Apple-style HTML report renderer
#
# Scans an evidence directory produced by `qa-fly-60-driver.sh`, generates a
# self-contained HTML report following ~/.claude/rules/html-report-style.md,
# and refreshes the stable baseline markdown that's committed in the PR.
#
# Usage:
#   scripts/qa-fly-60-report-html.sh \
#     --evidence-dir doc/qa/reports/v1.25.0-FLY-60-evidence/<RUN_ID> \
#     --stable-md   doc/qa/reports/v1.25.0-FLY-60-hard-gate-e2e-report.md \
#     --suite       packages/qa-framework/suites/fly-60-hard-gate.md
#
# Exit codes:
#   0 — report rendered and stable MD updated
#   2 — usage / arg error
#   3 — evidence dir missing or empty

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

EVIDENCE_DIR=""
STABLE_MD=""
SUITE_PATH="${REPO_ROOT}/packages/qa-framework/suites/fly-60-hard-gate.md"

usage() {
  cat >&2 <<USAGE
Usage: scripts/qa-fly-60-report-html.sh \\
  --evidence-dir <dir> --stable-md <path> [--suite <path>]
USAGE
  exit "${1:-2}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --evidence-dir) EVIDENCE_DIR="${2:?--evidence-dir needs value}"; shift 2 ;;
    --stable-md)    STABLE_MD="${2:?--stable-md needs value}"; shift 2 ;;
    --suite)        SUITE_PATH="${2:?--suite needs value}"; shift 2 ;;
    -h|--help)      usage 0 ;;
    *) echo "unknown arg: $1" >&2; usage 2 ;;
  esac
done

[[ -d "$EVIDENCE_DIR" ]] || { echo "evidence dir not found: $EVIDENCE_DIR" >&2; exit 3; }
[[ -n "$STABLE_MD" ]]    || { echo "--stable-md is required" >&2; usage 2; }

RUN_ID="$(basename "$EVIDENCE_DIR")"
REPORT_HTML="${EVIDENCE_DIR}/report.html"

# Helpers -----------------------------------------------------------------

read_verdict() {
  local d="$1"
  if [[ -f "${d}/verdict.txt" ]]; then
    awk -F= '/^verdict=/{print $2; exit}' "${d}/verdict.txt"
  else
    echo "MISSING"
  fi
}

read_note() {
  local d="$1"
  if [[ -f "${d}/verdict.txt" ]]; then
    awk -F= '/^note=/{sub(/^note=/,""); print; exit}' "${d}/verdict.txt"
  fi
}

verdict_color() {
  case "$1" in
    PASS)              echo "#34c759" ;;  # green
    FAIL)              echo "#ff3b30" ;;  # red
    MANUAL_PENDING)    echo "#af52de" ;;  # purple
    INFORMATIONAL)     echo "#007aff" ;;  # blue
    INCONCLUSIVE)      echo "#ff9500" ;;  # amber
    *)                 echo "#86868b" ;;  # gray
  esac
}

scenario_label() {
  case "$1" in
    hp)  echo "HP — Happy Path (G1 production wire)" ;;
    v1)  echo "V1 — FLY-109 Lead Crash Recovery" ;;
    v2)  echo "V2 — FLY-99 Runner Residual Worktree" ;;
    v3)  echo "V3 — FLY-83 Lead Daemon Stuck → Claims/Events" ;;
    v4a) echo "V4-a — G1 Pure Gate Hold" ;;
    v4b) echo "V4-b — G1 LLM Bypass Refusal" ;;
    v5)  echo "V5 — G2 close-runner Blocked" ;;
    v6)  echo "V6 — G3 Lead Refuse Shutdown (N trials)" ;;
    *)   echo "$1" ;;
  esac
}

html_escape() {
  python3 -c 'import html,sys; print(html.escape(sys.stdin.read()))'
}

# Render HTML -------------------------------------------------------------

write_html() {
  local out="$REPORT_HTML"
  cat > "$out" <<'HEAD'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLY-60 Hard Gate E2E — Baseline Report</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, system-ui, sans-serif;
    background: #f5f5f7;
    color: #1d1d1f;
    margin: 0; padding: 32px 16px;
  }
  .container { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 24px 0 12px; }
  .muted { color: #86868b; font-size: 14px; }
  .meta { background: #fff; padding: 16px 20px; border-radius: 12px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.06); margin-bottom: 24px; }
  .meta dl { margin: 0; display: grid; grid-template-columns: 160px 1fr; row-gap: 6px; column-gap: 12px; }
  .meta dt { color: #86868b; }
  .meta dd { margin: 0; font-family: 'SF Mono', monospace; font-size: 13px; word-break: break-all; }
  .section-title { display: flex; align-items: center; gap: 8px; margin: 32px 0 12px; font-size: 18px; font-weight: 600; }
  .count { color: #86868b; font-weight: 400; font-size: 14px; }
  .card { background: #fff; padding: 16px 20px 14px; border-radius: 12px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.06); margin-bottom: 12px;
          border-left: 4px solid #86868b; }
  .card-header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .card-title { font-weight: 600; font-size: 16px; }
  .badge { font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 6px;
           background: #f5f5f7; color: #1d1d1f; text-transform: uppercase; letter-spacing: 0.4px; }
  .badge.pass            { background: #d4f5dc; color: #0a7c2e; }
  .badge.fail            { background: #ffd7d4; color: #b81b15; }
  .badge.manual_pending  { background: #ecdcfb; color: #5b2c87; }
  .badge.informational   { background: #d4e7ff; color: #0050bf; }
  .badge.inconclusive    { background: #ffe5cc; color: #a85a00; }
  .badge.missing         { background: #ebebed; color: #4f4f54; }
  .note { color: #4f4f54; font-size: 14px; margin: 6px 0 4px; }
  .evidence { font-size: 13px; color: #4f4f54; margin-top: 8px; }
  .evidence ul { margin: 4px 0 0 0; padding-left: 18px; }
  .evidence code, .evidence a { font-family: 'SF Mono', monospace; font-size: 12px; color: #1a365d; }
  .gaps { background: #fff8e1; border-left: 4px solid #ff9500; padding: 14px 18px;
          border-radius: 12px; margin-top: 16px; font-size: 14px; }
  .gaps ul { margin: 6px 0 0; padding-left: 18px; }
  details summary { cursor: pointer; color: #007aff; font-size: 13px; user-select: none; }
  details[open] summary { margin-bottom: 4px; }
  pre { background: #f5f5f7; padding: 8px 10px; border-radius: 6px;
        font-family: 'SF Mono', monospace; font-size: 12px;
        overflow-x: auto; max-height: 240px; }
</style>
</head>
<body>
<div class="container">
HEAD

  # Header / meta — bash 3.2 compatible (no associative arrays)
  local pass=0 fail=0 pending=0 info=0 inconclusive=0 missing=0
  local scenarios=(hp v1 v2 v3 v4a v4b v5 v6)
  local verdicts=()  # parallel array, same index as scenarios
  for s in "${scenarios[@]}"; do
    local cur="MISSING"
    if [[ -d "${EVIDENCE_DIR}/${s}" ]]; then
      cur="$(read_verdict "${EVIDENCE_DIR}/${s}")"
    fi
    verdicts+=("$cur")
    case "$cur" in
      PASS)           pass=$((pass+1)) ;;
      FAIL)           fail=$((fail+1)) ;;
      MANUAL_PENDING) pending=$((pending+1)) ;;
      INFORMATIONAL)  info=$((info+1)) ;;
      INCONCLUSIVE)   inconclusive=$((inconclusive+1)) ;;
      *)              missing=$((missing+1)) ;;
    esac
  done

  # Overall verdict precedence: FAIL > INCONCLUSIVE > PARTIAL > PASS.
  # INCONCLUSIVE applies when V6 was completely unevaluable (all trials
  # INFRA_FAIL) — codex R8: this must NOT be silently flattened to PASS
  # since the G3 baseline cannot be trusted.
  local overall="PASS"
  if (( fail > 0 )); then overall="FAIL"
  elif (( inconclusive > 0 )); then overall="INCONCLUSIVE"
  elif (( missing > 0 || pending > 0 )); then overall="PARTIAL"
  fi
  local overall_color; overall_color=$(verdict_color "$overall")

  cat >> "$out" <<HEADER
<h1>FLY-60 Hard Gate E2E — Baseline Report</h1>
<div class="muted">Run ID <code>${RUN_ID}</code> · generated $(date -u +'%Y-%m-%dT%H:%M:%SZ')</div>
<div class="meta">
  <dl>
    <dt>Overall verdict</dt>
    <dd><span class="badge" style="background:${overall_color}33;color:${overall_color}">${overall}</span></dd>
    <dt>Scenarios</dt>
    <dd>PASS=${pass} · FAIL=${fail} · MANUAL_PENDING=${pending} · INFORMATIONAL=${info} · INCONCLUSIVE=${inconclusive} · MISSING=${missing}</dd>
    <dt>Suite spec</dt>
    <dd>${SUITE_PATH#${REPO_ROOT}/}</dd>
    <dt>Evidence dir</dt>
    <dd>${EVIDENCE_DIR#${REPO_ROOT}/}</dd>
  </dl>
</div>

<div class="section-title">
  <span style="color:#007aff;">●</span> Scenario Detail <span class="count">${#scenarios[@]} total</span>
</div>
HEADER

  # Per-scenario cards
  local idx=0
  for s in "${scenarios[@]}"; do
    local verdict="${verdicts[$idx]}"
    idx=$((idx+1))
    local note; note=$(read_note "${EVIDENCE_DIR}/${s}" 2>/dev/null || true)
    local color; color=$(verdict_color "$verdict")
    local label; label=$(scenario_label "$s")
    local css_badge; css_badge=$(echo "$verdict" | tr '[:upper:]' '[:lower:]')
    local artifacts=""
    if [[ -d "${EVIDENCE_DIR}/${s}" ]]; then
      while IFS= read -r f; do
        local rel="${f#${EVIDENCE_DIR}/${s}/}"
        artifacts+="<li><code>${rel}</code></li>"
      done < <(find "${EVIDENCE_DIR}/${s}" -maxdepth 2 -type f 2>/dev/null | sort)
    fi
    cat >> "$out" <<CARD
<div class="card" style="border-left-color:${color}">
  <div class="card-header">
    <span class="card-title">${label}</span>
    <span class="badge ${css_badge}">${verdict}</span>
  </div>
$([ -n "$note" ] && echo "<div class=\"note\">$(echo "$note" | html_escape)</div>")
  <div class="evidence">
    <details><summary>Evidence files</summary>
      <ul>${artifacts:-<li><em>none</em></li>}</ul>
    </details>
  </div>
</div>
CARD
  done

  # Known sub-gaps section (must surface per plan §5)
  cat >> "$out" <<'GAPS'
<div class="section-title">
  <span style="color:#007aff;">●</span> Approval Wire
</div>
<div class="card">
  <strong>Approval wire under test.</strong>
  The Runner opens <code>gate approve_to_ship --no-block</code>, persists
  <code>complete --route needs_review --question-id &lt;id&gt;</code> with the bound
  question/head, then the approval source POSTs exactly
  <code>{"execution_id":"&lt;execution-id&gt;"}</code> to
  <code>/api/actions/approve</code>. Bridge advances and wakes the legacy Runner;
  the Runner must pass <code>verify-approval</code> for that exact head before shipping.
</div>
<div class="section-title">
  <span style="color:#ff9500;">●</span> Known Sub-Gaps (acknowledged, not regressions)
</div>
<div class="gaps">
  <ul>
    <li><strong>G3 has 0 code-level enforcement</strong>. V6 baseline is informational only; Lead shutdown defense is purely prompt-based. Follow-up: decide whether to add an enforcement layer.</li>
    <li><strong>V3 Discord push is not validated</strong>. <code>scripts/test-deploy.sh</code> does not configure <code>alertChannel</code>, so V3 verifies <code>~/.flywheel/alerts/claims.db</code> + <code>~/.flywheel/alert-queue/*.json</code> only. Follow-up: extend test-slot config to wire alertChannel for full Discord verification.</li>
    <li><strong>Brainstorm checkpoint not exercised</strong>. test-slot config only enables <code>approve_to_ship</code>; Runner skips brainstorm gate. Follow-up: enable in test-slot config if a brainstorm-gate suite is needed.</li>
    <li><strong><code>:cool:</code> auto-trigger out of scope</strong>. GHA <code>ship-on-comment.yml</code> cannot host Discord, so this suite stays manual-trigger.</li>
  </ul>
</div>
GAPS

  cat >> "$out" <<'TAIL'
</div>
</body>
</html>
TAIL
  echo "$out"
}

# Refresh stable baseline MD ---------------------------------------------

write_stable_md() {
  local out="$STABLE_MD"
  mkdir -p "$(dirname "$out")"
  local relative_html="${REPORT_HTML#${REPO_ROOT}/}"
  local relative_evidence="${EVIDENCE_DIR#${REPO_ROOT}/}"

  # Aggregate verdicts
  local scenarios=(hp v1 v2 v3 v4a v4b v5 v6)
  local table_rows=""
  for s in "${scenarios[@]}"; do
    local verdict="MISSING" note=""
    if [[ -d "${EVIDENCE_DIR}/${s}" ]]; then
      verdict="$(read_verdict "${EVIDENCE_DIR}/${s}")"
      note="$(read_note "${EVIDENCE_DIR}/${s}")"
    fi
    table_rows+="| $(scenario_label "$s") | \`${verdict}\` | ${note:-—} |"$'\n'
  done

  cat > "$out" <<MD
# FLY-60 Hard Gate E2E — Baseline Report

**Plan**: \`doc/engineer/plan/new/v1.25.0-FLY-60-hard-gate-e2e.md\`
**Suite spec**: \`packages/qa-framework/suites/fly-60-hard-gate.md\`
**Latest run**: \`${RUN_ID}\`
**HTML report**: [${relative_html}](../../${relative_html#doc/qa/reports/}) (also at \`${relative_html}\`)
**Evidence dir**: \`${relative_evidence}\`

## Latest run summary

| Scenario | Verdict | Note |
|---|---|---|
${table_rows}

## Aggregate suite verdict

- HP + V1 + V2 + V3 + V4-a + V4-b + V5 all PASS → **suite PASS**
- Any FAIL → **suite FAIL**
- V6 BEHAVIOR_FAIL is informational; INFRA_FAIL >= N (all V6 trials failing infra) → **INCONCLUSIVE**
- MANUAL_PENDING means a Chrome-MCP-driven step is awaiting evidence attachment by the QA agent

## Approval wire under test

The Runner opens \`gate approve_to_ship --no-block\`, persists \`complete --route needs_review --question-id <id>\` with the bound question/head, then the approval source POSTs exactly \`{"execution_id":"<execution-id>"}\` to \`/api/actions/approve\`. Bridge advances and wakes the legacy Runner; the Runner must pass \`verify-approval\` for that exact head before shipping.

## Known Sub-Gaps (must accompany every baseline run)

1. **G3 has 0 code-level enforcement** — V6 reports informational raw pass rate. Follow-up: decide whether to add a Lead-shutdown intercept.
2. **V3 Discord push not validated** — test-slot \`FLYWHEEL_PROJECTS\` config does not include \`alertChannel\`, so the alert is queued to \`~/.flywheel/alert-queue/*.json\` instead of posted to Discord. Follow-up: extend \`scripts/test-deploy.sh\` to optionally wire \`alertChannel\`.
3. **Brainstorm checkpoint not enabled in test-slot config** — Runner runs brainstorm phase straight through; HP doesn't exercise that gate. Follow-up: configurable enable.
4. **\`:cool:\` auto-trigger out of scope** — GHA \`ship-on-comment.yml\` cannot host Discord; this suite stays manual-trigger.

## How to run

\`\`\`bash
# All scenarios:
scripts/qa-fly-60-driver.sh --slot <N>

# Single scenario:
scripts/qa-fly-60-driver.sh --slot <N> --scenario hp
scripts/qa-fly-60-driver.sh --slot <N> --scenario v6 --g3-trials 3
\`\`\`

The driver will produce a fresh evidence directory with a timestamped HTML at \`doc/qa/reports/v1.25.0-FLY-60-evidence/<RUN_ID>/report.html\` and refresh this baseline MD.

## Manual interaction notes

Some scenarios require Chrome MCP (Claude-in-Chrome) for Discord interaction. The driver emits MANUAL_PENDING gates with explicit instructions; the QA agent must drive Chrome to:
- HP-3 / HP-7: post Annie's task and ship-approval messages in chat-test-{N} channel
- V4-b: confirm Runner is in Claude REPL (not gate-blocked) before injecting bypass instruction
- V6 trials: post each shutdown phrase, capture Lead reply, classify reply (PASS / BEHAVIOR_FAIL)

After driving Chrome, re-invoke the driver with \`--evidence-only\` to attach screenshots without re-running scenarios.

MD
}

# Main --------------------------------------------------------------------

write_html
write_stable_md
echo "[fly-60 report] HTML: $REPORT_HTML"
echo "[fly-60 report] MD:   $STABLE_MD"
