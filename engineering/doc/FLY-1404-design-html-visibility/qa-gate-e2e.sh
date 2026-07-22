#!/usr/bin/env bash
# FLY-1404 real-machine gate verification (independent QA).
# Same repo harness; the ONLY variable per case is whether/where the design
# HTML is committed. Proves the CLI gate really blocks (not a vacuous unit test).
set -u
CLI="/Users/xiaorongli/Dev/flywheel-FLY-1404/packages/flywheel-comm/dist/index.js"
GATE_MSG="FLY-1404 founder design HTML is required"
DISABLED_MSG="design-HTML gate DISABLED"

export FLYWHEEL_EXEC_ID="qa-fly1404-exec"
export FLYWHEEL_ISSUE_ID="FLY-1404"
export FLYWHEEL_PROJECT_NAME="flywheel"
export FLYWHEEL_BRIDGE_URL="http://127.0.0.1:59999"   # unreachable → past-gate proof
unset FLYWHEEL_DESIGN_HTML_GATE

mkrepo() {
  local d; d="$(mktemp -d)"
  git -C "$d" init -q -b main
  git -C "$d" config user.email qa@x.com
  git -C "$d" config user.name qa
  echo root > "$d/README.md"
  git -C "$d" add -A && git -C "$d" commit -qm init
  git -C "$d" checkout -q -b flywheel-FLY-1404
  echo "$d"
}

run_case() {
  local name="$1" repo="$2" gate="${3:-}"
  local out rc
  if [ -n "$gate" ]; then
    out="$(cd "$repo" && FLYWHEEL_DESIGN_HTML_GATE="$gate" node "$CLI" complete --route phase_design_complete --base-ref main 2>&1)"
  else
    out="$(cd "$repo" && node "$CLI" complete --route phase_design_complete --base-ref main 2>&1)"
  fi
  rc=$?
  echo "=================================================="
  echo "CASE: $name (exit=$rc)"
  if echo "$out" | grep -qF "$GATE_MSG"; then echo "  -> GATE BLOCKED (required msg present)"; else echo "  -> gate NOT blocked (no required msg)"; fi
  if echo "$out" | grep -qF "$DISABLED_MSG"; then echo "  -> ESCAPE DISABLED msg present"; fi
  echo "--- stderr (first 3 lines) ---"
  echo "$out" | head -3
}

# CASE A: no HTML at all → MUST block
R="$(mkrepo)"
echo "plan text" > "$R/plan.md"
mkdir -p "$R/engineering/doc/FLY-1404-x"; echo notes > "$R/engineering/doc/FLY-1404-x/plan.md"
git -C "$R" add -A && git -C "$R" commit -qm "design docs no html"
run_case "A: no HTML committed" "$R"

# CASE B: HTML committed in the issue doc folder → MUST pass gate (mutation of A)
echo "<html><body>design</body></html>" > "$R/engineering/doc/FLY-1404-x/design.html"
git -C "$R" add -A && git -C "$R" commit -qm "add founder design html"
run_case "B: HTML committed in doc/FLY-1404-x/ (mutation of A)" "$R"

# CASE C: no HTML but escape env=0 → MUST skip loudly
R2="$(mkrepo)"
echo notes > "$R2/plan.md"; git -C "$R2" add -A && git -C "$R2" commit -qm docs
run_case "C: no HTML + FLYWHEEL_DESIGN_HTML_GATE=0 (escape)" "$R2" "0"

# CASE D: HTML committed but OUTSIDE the doc folder (site/index.html) → MUST block
R3="$(mkrepo)"
mkdir -p "$R3/site"; echo "<html></html>" > "$R3/site/index.html"
git -C "$R3" add -A && git -C "$R3" commit -qm "html outside doc"
run_case "D: HTML outside issue doc folder (site/index.html)" "$R3"

# CASE E: prefix collision — only doc/FLY-14040-x/ HTML present → MUST block
R4="$(mkrepo)"
mkdir -p "$R4/engineering/doc/FLY-14040-x"; echo "<html></html>" > "$R4/engineering/doc/FLY-14040-x/a.html"
git -C "$R4" add -A && git -C "$R4" commit -qm "prefix collision html"
run_case "E: prefix collision doc/FLY-14040-x/a.html" "$R4"

echo "=================================================="
echo "DONE"