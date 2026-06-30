#!/bin/bash
# FLY-519: fleet-capture.sh
#
# Snapshot the CURRENT live fleet host into a sanitized, committable artifact
# (default <repo>/fleet/). Run this on the OLD machine before a migration; the
# artifact is what provision-fleet-host.sh materializes on the NEW machine.
#
# RED LINE (Annie / Tadashi): the artifact must contain ZERO secrets. We do
# three things: (1) projects.json carries only token ENV *names*, copied as-is;
# (2) ~/.flywheel/.env is redacted to key names only (env.example); (3) the
# whole artifact is staged, scanned with scan_for_secrets, and only moved into
# place if the scan is clean — a leak aborts non-zero and leaves nothing.
#
# State migration (real tokens, memory DBs, codex-homes auth, thread continuity)
# is deliberately OUT of scope here — that is Annie-handled per the runbook.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/fleet-sanitize.sh
source "$SCRIPT_DIR/lib/fleet-sanitize.sh"

HOME_DIR="${HOME:-}"
OUT_DIR="$REPO_ROOT/fleet"
CAPTURE_DATE=""
FORCE=0

usage() {
  cat <<EOF
Usage: fleet-capture.sh [--home DIR] [--out DIR] [--date ISO8601] [--force]
  --home DIR    home to read ~/.flywheel from (default: \$HOME)
  --out DIR     artifact output dir (default: <repo>/fleet)
  --date ISO    capture timestamp (default: current UTC)
  --force       overwrite an existing non-empty artifact
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --home) HOME_DIR="$2"; shift 2 ;;
    --out)  OUT_DIR="$2"; shift 2 ;;
    --date) CAPTURE_DATE="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "fleet-capture: unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

FW="$HOME_DIR/.flywheel"
PROJECTS="$FW/projects.json"
ENV_FILE="$FW/.env"
LAUNCH_AGENTS="$HOME_DIR/Library/LaunchAgents"

[ -n "$CAPTURE_DATE" ] || CAPTURE_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ ! -f "$PROJECTS" ]; then
  echo "fleet-capture: not a fleet host — missing $PROJECTS" >&2
  exit 2
fi
command -v jq >/dev/null 2>&1 || { echo "fleet-capture: jq required" >&2; exit 2; }

if [ "$FORCE" -ne 1 ] && [ -f "$OUT_DIR/manifest.json" ]; then
  echo "fleet-capture: $OUT_DIR already has a capture; pass --force to overwrite" >&2
  exit 2
fi

STAGE="$(mktemp -d -t fly519-capture-stage-XXXXXX)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# ── 1. projects.json (jq-normalized to one field per line) ────────────────
# Normalize via jq (not a verbatim cp) so the committed artifact is guaranteed
# pretty-printed — one field per line. This upholds the invariant the secret
# scanner relies on and removes any minified-JSON bypass (Codex R2 HIGH).
if ! jq -e 'if type=="array" then . else error("projects.json must be a JSON array") end' \
      "$PROJECTS" > "$STAGE/projects.json" 2>/dev/null; then
  echo "fleet-capture: ABORT — $PROJECTS is not a valid JSON array" >&2
  exit 2
fi
# From here on, read the VALIDATED, normalized copy so every downstream jq sees
# the same well-formed one-field-per-line content (self-consistent; no second
# parse of the raw file that could diverge or fail silently).
PROJECTS="$STAGE/projects.json"

# ── 2. env.example (redacted key names only) ──────────────────────────────
if [ -f "$ENV_FILE" ]; then
  redact_env_to_keys "$ENV_FILE" "$STAGE/env.example"
else
  printf '# No ~/.flywheel/.env found at capture time.\n' > "$STAGE/env.example"
fi

# ── 3. manifest.json ──────────────────────────────────────────────────────
# repos[]: one per project (+ the flywheel repo). targetDir stored home-relative
# where possible so provision re-roots under its own $HOME.
rel_to_home() {  # <abs-path> -> home-relative or unchanged
  local p="$1"
  case "$p" in
    "$HOME_DIR"/*) printf '%s' "${p#"$HOME_DIR"/}" ;;
    *) printf '%s' "$p" ;;
  esac
}

REPOS_JSON="$(jq -c '[]' <<<'null')"
add_repo() {  # <name> <slug-or-null> <targetDirRel>
  REPOS_JSON="$(jq -c --arg n "$1" --arg s "$2" --arg d "$3" \
    '. + [{name:$n, slug:(if $s=="" then null else $s end), targetDir:$d}]' <<<"$REPOS_JSON")"
}

# flywheel repo itself (best-effort origin slug from its checkout under home).
FW_REPO_DIR="$HOME_DIR/Dev/flywheel"
FW_SLUG=""
if [ -d "$FW_REPO_DIR/.git" ]; then
  FW_URL="$(git -C "$FW_REPO_DIR" remote get-url origin 2>/dev/null || true)"
  FW_SLUG="$(printf '%s' "$FW_URL" | sed -E 's#^https://github.com/##; s#^git@github.com:##; s#\.git$##')"
fi
add_repo "flywheel" "$FW_SLUG" "$(rel_to_home "$FW_REPO_DIR")"

# one repo per project (skip a duplicate flywheel entry).
while IFS=$'\t' read -r pname proot pslug; do
  [ "$pname" = "flywheel" ] && continue
  add_repo "$pname" "$pslug" "$(rel_to_home "$proot")"
done < <(jq -r '.[] | [.projectName, .projectRoot, (.projectRepo // "")] | @tsv' "$PROJECTS")

# launchdJobs[]: labels only, classified lead vs aux.
JOBS_JSON="$(jq -c '[]' <<<'null')"
if [ -d "$LAUNCH_AGENTS" ]; then
  while IFS= read -r plist; do
    [ -e "$plist" ] || continue
    label="$(basename "$plist" .plist)"
    kind="aux"
    case "$label" in com.flywheel.lead.*) kind="lead" ;; esac
    JOBS_JSON="$(jq -c --arg l "$label" --arg k "$kind" '. + [{label:$l, kind:$k}]' <<<"$JOBS_JSON")"
  done < <(find "$LAUNCH_AGENTS" -maxdepth 1 -name 'com.flywheel.*.plist' | sort)
fi

# skills wiring.
SKILLS_SYNC_PRESENT=false
SKILLS_UPDATE_PRESENT=false
SKILLS_REPO=""
[ -f "$FW/bin/skills-sync.sh" ] && SKILLS_SYNC_PRESENT=true
[ -f "$LAUNCH_AGENTS/com.flywheel.skills-update.plist" ] && SKILLS_UPDATE_PRESENT=true
if [ -f "$FW/bin/skills-sync.sh" ]; then
  SKILLS_REPO="$(grep -oE '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]*skills[A-Za-z0-9_.-]*' "$FW/bin/skills-sync.sh" | head -1 || true)"
fi

# deps[]: known toolchain with PER-PLATFORM install hints (FLY-650).
# Schema: platforms.{darwin:{channel,formula}, linux:{apt,dnf,presentCheck}}.
# `required:true` deps with no linux mapping fail-loud on a Linux provision
# (platform-deps.sh). node/pnpm are present-check on Linux (nvm/corepack path).
# cmux is darwin-only (required:false → skipped on Linux). AI CLIs are manual.
DEPS_JSON='[
  {"name":"homebrew","required":false,"platforms":{"darwin":{"channel":"installer"}}},
  {"name":"node","required":true,"platforms":{"darwin":{"channel":"brew","formula":"node"},"linux":{"presentCheck":true}},"check":{"command":"node"}},
  {"name":"pnpm","required":true,"platforms":{"darwin":{"channel":"brew","formula":"pnpm"},"linux":{"presentCheck":true}},"check":{"command":"pnpm"}},
  {"name":"tmux","required":true,"platforms":{"darwin":{"channel":"brew","formula":"tmux"},"linux":{"apt":"tmux","dnf":"tmux"}},"check":{"command":"tmux"}},
  {"name":"gh","required":true,"platforms":{"darwin":{"channel":"brew","formula":"gh"},"linux":{"apt":"gh","dnf":"gh"}},"check":{"command":"gh"}},
  {"name":"jq","required":true,"platforms":{"darwin":{"channel":"brew","formula":"jq"},"linux":{"apt":"jq","dnf":"jq"}},"check":{"command":"jq"}},
  {"name":"git","required":true,"platforms":{"darwin":{"channel":"brew","formula":"git"},"linux":{"apt":"git","dnf":"git"}},"check":{"command":"git"}},
  {"name":"cmux","required":false,"platforms":{"darwin":{"channel":"manual"}},"note":"darwin-only viewer; cmux app + flywheel-cmux-install.sh"},
  {"name":"codex","required":false,"channel":"manual","note":"OpenAI Codex CLI"},
  {"name":"claude","required":false,"channel":"manual","note":"Claude Code CLI"},
  {"name":"kimi","required":false,"channel":"manual","note":"Kimi Code CLI (brew kimi-code)"},
  {"name":"agy","required":false,"channel":"manual","note":"Antigravity CLI"}
]'

jq -n \
  --arg date "$CAPTURE_DATE" \
  --argjson repos "$REPOS_JSON" \
  --argjson jobs "$JOBS_JSON" \
  --argjson deps "$DEPS_JSON" \
  --argjson sync "$SKILLS_SYNC_PRESENT" \
  --argjson upd "$SKILLS_UPDATE_PRESENT" \
  --arg skrepo "$SKILLS_REPO" \
  '{
    schemaVersion: 1,
    meta: { capturedAt: $date, tool: "fleet-capture.sh" },
    deps: $deps,
    repos: $repos,
    launchdJobs: $jobs,
    skills: {
      skillsSyncPresent: $sync,
      skillsUpdatePlistPresent: $upd,
      canonicalRepo: (if $skrepo=="" then null else $skrepo end)
    }
  }' > "$STAGE/manifest.json"

# ── 3b. host.json (FLY-650 D2=B core/host config) ─────────────────────────
# The captured host.json carries only PORTABLE fields (skillsRepo). platform /
# supervisorBackend / viewerBackend are deliberately OMITTED so the TARGET host
# derives them from its own uname via host-config.sh — a darwin capture must NOT
# pin the wrong platform onto a Linux provision target (D3=B). flywheelDir /
# stateDir are also omitted (target defaults to today's values; an operator may
# add overrides on the target). leadEnablement omitted (reserved; see §3.6).
# Zero secrets — skillsRepo is a public repo slug; the secret-scan gate covers it.
jq -n --arg repo "${SKILLS_REPO:-xrliAnnie/flywheel-skills}" \
  '{ schemaVersion: 1, skillsRepo: (if $repo=="" then "xrliAnnie/flywheel-skills" else $repo end) }' \
  > "$STAGE/host.json"

# ── 4. FINAL SECRET GATE (red line) ───────────────────────────────────────
if ! scan_for_secrets "$STAGE"; then
  echo "fleet-capture: ABORT — secret-like content detected in staged artifact." >&2
  echo "fleet-capture: nothing was written to $OUT_DIR." >&2
  exit 1
fi

# ── 5. atomic-ish move into place ─────────────────────────────────────────
mkdir -p "$OUT_DIR"
cp "$STAGE/projects.json" "$STAGE/env.example" "$STAGE/manifest.json" "$STAGE/host.json" "$OUT_DIR/"

# ── 6. WHOLE-ARTIFACT GATE (Codex R1 HIGH-2) ──────────────────────────────
# The STAGE scan only covers the files we generated. A pre-existing stale or
# foreign file in $OUT_DIR (e.g. a leftover leak from a prior bad run, esp.
# with --force) would otherwise survive unscanned in the committed dir. Scan
# the FINAL committed directory so success means "the whole fleet/ dir is
# clean", not just "the three new files are clean". Fail-closed.
if ! scan_for_secrets "$OUT_DIR"; then
  echo "fleet-capture: ABORT — the output dir $OUT_DIR contains secret-like content" >&2
  echo "fleet-capture: (likely a pre-existing/foreign file). Remove it and re-run." >&2
  exit 1
fi

echo "fleet-capture: wrote sanitized artifact to $OUT_DIR"
echo "  - projects.json   (env NAMES only)"
echo "  - env.example     ($(grep -cE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_]' "$OUT_DIR/env.example" 2>/dev/null || echo 0) keys, zero values)"
echo "  - manifest.json   ($(jq '.repos|length' "$OUT_DIR/manifest.json") repos, $(jq '.launchdJobs|length' "$OUT_DIR/manifest.json") launchd jobs, platform-keyed deps)"
echo "  - host.json       (FLY-650 core/host config — portable fields; target derives platform)"
echo "fleet-capture: review for zero secrets before committing to git."
