#!/usr/bin/env bash
# FLY-1023 M0: flywheel-buddy-steps.sh — the machine-readable step CLI.
#
# A THIN shell over the UNCHANGED flywheel-setup.sh step implementations
# (FLYWHEEL_SETUP_SOURCED source seam): every setup step becomes individually
# invokable with a single-line JSON result on stdout, so a conversational
# layer (the Buddy shell, FLY-910) can drive execution step by step while
# owning all user-facing wording itself.
#
# Contract:
#   flywheel-buddy-steps.sh [identity-flags] run    <step-id>
#   flywheel-buddy-steps.sh [identity-flags] verify <step-id>
#   flywheel-buddy-steps.sh [identity-flags] status [--json]
#   flywheel-buddy-steps.sh [identity-flags] state get <buddy-key>
#   flywheel-buddy-steps.sh [identity-flags] state set <buddy-key> <value>
#   flywheel-buddy-steps.sh [identity-flags] steps
#
#   stdout  = EXACTLY one JSON line: {ok, step?, status?, evidence?, key?,
#             value?, error_code?, hint?, log?}. Everything the underlying
#             engine/steps print is captured into a 0600 log file (the buddy
#             layer speaks to the user in its own words — raw engine output
#             is a jargon red-line violation, PRD FLY-910 §5).
#   exit    = 0 success · 1 failure · 3 needs-guidance (a step's return 3,
#             inherited from the fs_discord_api 403 convention).
#
# RED LINES (same envelope as the base wizard):
#   - secrets never enter argv/journal/log/JSON output; hidden-TTY reads
#     happen INSIDE the step functions (fs_ask_secret), not here.
#   - secret-class FLYWHEEL_SETUP_ANSWER_* / FLYWHEEL_SETUP_POOL_TOKEN_*
#     injection is REFUSED by default: the env channel would put tokens into
#     process environments the buddy layer does not control. Hermetic tests
#     opt in via FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION=1.
#   - journal v2: {version:2, steps:{…v1 unchanged…}, buddy:{…}} — same
#     file, same safety envelope, v1 upgraded in place idempotently. The
#     buddy region takes WHITELISTED non-secret keys only, every value is
#     secret-scanned before it lands.
#   - the interactive wizard (flywheel-setup.sh run directly) is untouched:
#     it never sees version 2 unless the buddy layer touched the journal
#     first, and all its jq updates preserve unknown top-level keys.
set -uo pipefail

BS_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source the UNCHANGED wizard (functions only — fs_main guarded off).
export FLYWHEEL_SETUP_SOURCED=1
# shellcheck source=flywheel-setup.sh
source "$BS_SCRIPT_DIR/flywheel-setup.sh"
# shellcheck source=lib/fleet-sanitize.sh
source "$BS_SCRIPT_DIR/lib/fleet-sanitize.sh"

# The buddy step order — the base 10 plus the buddy-only github step (M3,
# after linear / before config so the config artifact can record the repo
# binding). SINGLE POINT for the Buddy shell (`steps` subcommand) and for
# done-step rehydration order.
BS_STEP_IDS=(preflight skeleton model_key bots channels linear github config services finish captain_health digest)

# ── buddy-only step: github (M3 / BI-3) ─────────────────────────────────────
# gh-CLI path (§6.7 MVP): device/web login (no tokens pasted — gh keeps its
# own credential store) → find-or-create the project repo → bind origin →
# first push of the skeleton → ls-remote verification. Org-policy/permission
# failures fall back to a guided path (user creates the repo in the web UI,
# we re-verify). Evidence records the repo full name only.
BS_GITHUB_URL_BASE="${FLYWHEEL_BUDDY_GITHUB_URL_BASE:-https://github.com/}"

step_run_github() {
  command -v gh >/dev/null 2>&1 \
    || { fs_err "the gh command is missing (preflight should have installed it) — re-run the preflight step"; return 1; }
  [ -d "$FS_PROJECT_ROOT/.git" ] \
    || { fs_err "project skeleton not present at $FS_PROJECT_ROOT (skeleton step incomplete?)"; return 1; }

  # (a) auth: gh's OWN web/device flow on the caller's TTY. No tokens here.
  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    if [ -r /dev/tty ]; then
      fs_log "launching the GitHub sign-in (a one-time code + browser confirm)" >&2
      gh auth login --hostname github.com --git-protocol https --web </dev/tty >/dev/tty 2>&1 || true
    fi
    gh auth status --hostname github.com >/dev/null 2>&1 \
      || { fs_err "GitHub sign-in did not complete"; return 3; }
  fi

  # (b) repo full name: explicit --project-slug wins; else <login>/<project>.
  local repo_full owner
  if [ -n "${FS_PROJECT_SLUG:-}" ]; then
    repo_full="$FS_PROJECT_SLUG"
  else
    owner="$(gh api user -q .login 2>/dev/null)"
    [ -n "$owner" ] || { fs_err "could not read the GitHub account name"; return 1; }
    repo_full="$owner/$FS_PROJECT"
  fi

  # (c) find-or-create (org policy / permission → guided web-UI fallback).
  if ! gh repo view "$repo_full" >/dev/null 2>&1; then
    if ! gh repo create "$repo_full" --private >/dev/null 2>&1; then
      fs_log "cannot create $repo_full from here (account/organization policy?)." >&2
      fs_log "Create a PRIVATE repository named exactly '$repo_full' at https://github.com/new — then continue." >&2
      fs_ask_value "GITHUB_REPO_CREATED_MANUALLY" "Press Enter once the repository exists (y)" >/dev/null || return 3
      gh repo view "$repo_full" >/dev/null 2>&1 \
        || { fs_err "repository $repo_full still not found"; return 3; }
    fi
  fi

  # (d) first snapshot (skeleton only runs git init), bind origin, push,
  # verify the remote answers. Commit identity is one-shot -c: we never touch
  # the user's git config.
  if ! git -C "$FS_PROJECT_ROOT" rev-parse HEAD >/dev/null 2>&1; then
    git -C "$FS_PROJECT_ROOT" add -A >/dev/null 2>&1
    git -C "$FS_PROJECT_ROOT" -c user.name="Flywheel Setup" -c user.email="setup@flywheel.invalid" \
      commit -qm "Project skeleton (flywheel onboarding)" \
      || { fs_err "could not record the first snapshot of the project files"; return 1; }
  fi
  local url="${BS_GITHUB_URL_BASE}${repo_full}.git"
  if git -C "$FS_PROJECT_ROOT" remote get-url origin >/dev/null 2>&1; then
    git -C "$FS_PROJECT_ROOT" remote set-url origin "$url"
  else
    git -C "$FS_PROJECT_ROOT" remote add origin "$url"
  fi
  git -C "$FS_PROJECT_ROOT" push -u origin HEAD >/dev/null 2>&1 \
    || { fs_err "first push to $repo_full failed — check the repository is empty and you have write access"; return 1; }
  git -C "$FS_PROJECT_ROOT" ls-remote origin >/dev/null 2>&1 \
    || { fs_err "the remote did not answer after the push"; return 1; }

  # downstream wiring: the config artifact records projectRepo from
  # FS_PROJECT_SLUG — set it now, restore it on resume (step_hydrate_github).
  FS_PROJECT_SLUG="$repo_full"
  setup_mark_done github "$(jq -nc --arg r "$repo_full" '{repo:$r, auth:"gh"}')"
}

step_verify_github() {
  local ev repo
  ev="$(setup_step_evidence github)"
  repo="$(jq -r '.repo // empty' <<<"$ev")"
  [ -n "$repo" ] || return 1
  git -C "$FS_PROJECT_ROOT" remote get-url origin 2>/dev/null | grep -q "$repo"
}

step_hydrate_github() {
  local repo
  repo="$(setup_step_evidence github | jq -r '.repo // empty')"
  [ -n "$repo" ] || return 1
  FS_PROJECT_SLUG="$repo"
}

# ── buddy-only step: captain_health (M5) ────────────────────────────────────
# The placement health check, extended past the base finish step's Bridge
# probe: ① Bridge answers 2xx ② the Captain's bot identity answers Discord
# ③ the chat channel takes a post+read probe (the _fs_channel_probe pattern —
# the same two load-bearing needs the runtime has). All three green or the
# step is NOT done (fail-closed). A live "Captain answers a ping" belongs to
# the real-machine QA stage; the REST probe is the hermetic contract.
step_run_captain_health() {
  local url="${FLYWHEEL_BRIDGE_URL:-http://127.0.0.1:9876}"
  curl -fsS -m 5 "$url/api/runs/active" >/dev/null 2>&1 \
    || { fs_err "the team's home base is not answering at $url"; return 1; }
  local tok
  tok="$(fs_env_get "$FS_ENG_ENV")" \
    || { fs_err "no $FS_ENG_ENV in .env (bots step incomplete?)"; return 1; }
  fs_discord_api GET /users/@me "$tok" >/dev/null \
    || { fs_err "the Captain's Discord identity did not answer"; return 1; }
  [ -n "${FS_CHANNEL_ENG:-}" ] && [ "$FS_CHANNEL_ENG" != "__FILL_DISCORD_CHANNEL_ID_ENG__" ] \
    || { fs_err "no chat channel recorded (channels step incomplete?)"; return 1; }
  _fs_channel_probe "$tok" "$FS_CHANNEL_ENG" "Captain" || return 1
  # level:transport-probe — honest scope marker (Codex R1#4): this proves the
  # PIPE (Bridge up, bot identity valid, channel readable+postable), not that
  # a live Captain answers; the live-answer check is the real-machine QA
  # acceptance gate (runbook §5).
  setup_mark_done captain_health \
    '{"bridge":"2xx","bot":"identity-ok","channel":"post+read probe","level":"transport-probe"}'
}

# Buddy-region keys writable via `state set` — non-secret by design.
BS_BUDDY_KEY_WHITELIST='^(cursor|first_task_summary|team_proposal|connected_systems|requested_systems|escalated|brain_session_id)$'

# ── JSON emission (the ONLY stdout writers in this file) ────────────────────
bs_emit() { jq -nc "$@"; }

bs_emit_fail() { # <exit-code> <error_code> <hint> [step]
  local rc="$1" code="$2" hint="$3" step="${4:-}"
  bs_emit --arg c "$code" --arg h "$hint" --arg s "$step" --arg l "${BS_LOG_FILE:-}" \
    '{ok:false, error_code:$c, hint:$h}
     | (if $s != "" then . + {step:$s} else . end)
     | (if $l != "" then . + {log:$l} else . end)'
  exit "$rc"
}

# ── identity resolution: flags > journal buddy.identity > defaults ──────────
bs_resolve_identity() {
  # journal-recorded identity (a previous buddy run) fills unset values so a
  # bare resume (`run <id>` with no flags) continues the same instance.
  local jf="$FLYWHEEL_SETUP_STATE_DIR/setup-state.json"
  if [ -f "$jf" ]; then
    local rec
    rec="$(jq -c '.buddy.identity // {}' "$jf" 2>/dev/null || echo '{}')"
    [ -n "$FS_PROJECT" ]     || FS_PROJECT="$(jq -r '.project // empty' <<<"$rec")"
    [ -n "$FS_DEPT" ]        || FS_DEPT="$(jq -r '.department // empty' <<<"$rec")"
    [ -n "$FS_COS_PERSONA" ] || FS_COS_PERSONA="$(jq -r '.cosPersona // empty' <<<"$rec")"
    [ -n "$FS_ENG_PERSONA" ] || FS_ENG_PERSONA="$(jq -r '.engPersona // empty' <<<"$rec")"
    [ -n "$FS_LINEAR_TEAM" ] || FS_LINEAR_TEAM="$(jq -r '.linearTeam // empty' <<<"$rec")"
    [ -n "$FS_PROJECT_SLUG" ] || FS_PROJECT_SLUG="$(jq -r '.projectSlug // empty' <<<"$rec")"
    [ -n "$FS_SKILLS_REPO" ] || FS_SKILLS_REPO="$(jq -r '.skillsRepo // empty' <<<"$rec")"
  fi
  FS_PROJECT="${FS_PROJECT:-myproject}"
  FS_DEPT="${FS_DEPT:-engineering}"
  FS_COS_PERSONA="${FS_COS_PERSONA:-Cos}"
  FS_ENG_PERSONA="${FS_ENG_PERSONA:-Eng}"
  FS_SKILLS_REPO="${FS_SKILLS_REPO:-xrliAnnie/flywheel-skills}"
}

# ── journal v2 (in place, idempotent, same safety envelope) ─────────────────
# Writes are PRETTY-PRINTED like every base-engine journal write (plain jq,
# no -c): scan_for_secrets' assignment layer checks token runs line-wide, so
# a minified one-line journal would cross-match unrelated fields.
bs_journal_ensure_v2() {
  local jf="$FS_STATE_FILE" cur next
  cur="$(cat "$jf")"
  next="$(jq '.version = 2 | .buddy = (.buddy // {})' <<<"$cur")"
  if [ "$(jq -S . <<<"$cur")" != "$(jq -S . <<<"$next")" ]; then
    printf '%s\n' "$next" | _fs_atomic_write_600 "$jf"
  fi
}

bs_persist_identity() {
  local jf="$FS_STATE_FILE" cur next
  cur="$(cat "$jf")"
  next="$(jq \
    --arg p "$FS_PROJECT" --arg d "$FS_DEPT" --arg cp "$FS_COS_PERSONA" \
    --arg ep "$FS_ENG_PERSONA" --arg lt "${FS_LINEAR_TEAM:-}" \
    --arg ps "${FS_PROJECT_SLUG:-}" --arg sr "$FS_SKILLS_REPO" \
    '.buddy.identity = {project:$p, department:$d, cosPersona:$cp,
                        engPersona:$ep, linearTeam:$lt, projectSlug:$ps,
                        skillsRepo:$sr}' <<<"$cur")"
  if [ "$(jq -S . <<<"$cur")" != "$(jq -S . <<<"$next")" ]; then
    printf '%s\n' "$next" | _fs_atomic_write_600 "$jf"
  fi
}

# ── engine boot for run/verify/state-set (mirrors fs_main's init, under the
#    same lock, plus v2 upgrade + done-step rehydration) ─────────────────────
bs_engine_boot() {
  _fs_bootstrap_jq
  bs_resolve_identity
  fs_derive_identity
  FS_FLEET_DIR="$FLYWHEEL_SETUP_STATE_DIR/setup-fleet"
  FS_GUILD_ID="${FS_GUILD_ID:-__FILL_DISCORD_GUILD_ID__}"
  FS_FOUNDER_ID="${FS_FOUNDER_ID:-__FILL_DISCORD_USER_ID_FOUNDER__}"
  FS_CHANNEL_GENERAL="${FS_CHANNEL_GENERAL:-__FILL_DISCORD_CHANNEL_ID_GENERAL__}"
  FS_CHANNEL_COS="${FS_CHANNEL_COS:-__FILL_DISCORD_CHANNEL_ID_COS__}"
  FS_CHANNEL_ENG="${FS_CHANNEL_ENG:-__FILL_DISCORD_CHANNEL_ID_ENG__}"

  # live-fleet guard — identical rule to fs_main: never touch a state root
  # hosting a fleet this wizard did not create.
  local pj="$FLYWHEEL_SETUP_STATE_DIR/projects.json"
  local sf="$FLYWHEEL_SETUP_STATE_DIR/setup-state.json"
  if [ -f "$pj" ] && [ ! -f "$sf" ]; then
    local nleads
    nleads="$(jq '[.[].leads[]?] | length' "$pj" 2>/dev/null || echo 0)"
    if [ "${nleads:-0}" -gt 0 ]; then
      fs_die "this machine already hosts a live fleet ($nleads leads in $pj) that flywheel-setup did not create — refusing to touch it"
    fi
  fi

  setup_engine_init
  bs_journal_ensure_v2
  bs_persist_identity

  # rehydrate FS_* values from every DONE step, in canonical order, so a
  # single-step invocation sees exactly what a resumed full run would see.
  local id hfn
  for id in "${BS_STEP_IDS[@]}"; do
    if [ "$(setup_step_status "$id")" = "done" ]; then
      hfn="step_hydrate_${id}"
      if declare -F "$hfn" >/dev/null 2>&1; then
        "$hfn" || fs_die "step '$id': evidence rehydration failed (corrupt journal?)"
      fi
    fi
  done
}

# ── secret-class answer-injection refusal ───────────────────────────────────
bs_refuse_secret_injection() {
  [ "${FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION:-0}" = "1" ] && return 0
  local bad
  bad="$(env | grep -oE '^(FLYWHEEL_SETUP_ANSWER_[A-Z0-9_]*(TOKEN|API_KEY|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*|FLYWHEEL_SETUP_POOL_TOKEN_[A-Z0-9_]*)=' | head -3 || true)"
  if [ -n "$bad" ]; then
    bs_emit_fail 1 secret_injection_refused \
      "secret-class answer env vars are refused in buddy mode (secrets are typed into the hidden prompt, never injected): ${bad//$'\n'/ }"
  fi
  return 0
}

# ── state-dir resolution WITHOUT the engine (reads + log path) ──────────────
bs_resolve_state_dir() {
  [ -n "$FLYWHEEL_SETUP_STATE_DIR" ] || FLYWHEEL_SETUP_STATE_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
}

bs_open_log() {
  BS_LOG_FILE="$FLYWHEEL_SETUP_STATE_DIR/buddy-steps.log"
  if [ -d "$FLYWHEEL_SETUP_STATE_DIR" ] && [ ! -L "$BS_LOG_FILE" ]; then
    ( umask 077; touch "$BS_LOG_FILE" 2>/dev/null ) || BS_LOG_FILE="/dev/null"
  else
    # state dir not created yet — boot output goes to a private temp log.
    BS_LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/buddy-steps-log.XXXXXX")" || BS_LOG_FILE="/dev/null"
    chmod 600 "$BS_LOG_FILE" 2>/dev/null || true
  fi
}

# bs_captured <fn...> — run <fn> in a subshell with ALL its stdout/stderr
# appended to the 0600 log (fs_log writes stdout in the base wizard; nothing
# human-readable may reach OUR stdout). fs_die inside only kills the subshell,
# so the parent still emits machine-readable failure JSON. /dev/tty prompts
# (fs_ask_*) are untouched — interactive guided input still works.
bs_captured() {
  ( "$@" ) >>"$BS_LOG_FILE" 2>&1
}

bs_log_tail_hint() {
  [ -f "$BS_LOG_FILE" ] && tail -n 1 "$BS_LOG_FILE" 2>/dev/null | cut -c1-300 || true
}

# ── subcommands ─────────────────────────────────────────────────────────────
bs_cmd_run() {
  local id="$1"
  bs_refuse_secret_injection
  declare -F "step_run_${id}" >/dev/null 2>&1 \
    || bs_emit_fail 1 unknown_step "no implementation for step '$id'" "$id"
  bs_captured bs_run_one "$id"
  local rc=$?
  [ "${FLYWHEEL_BUDDY_STEPS_VERBOSE:-0}" = "1" ] && tail -n 40 "$BS_LOG_FILE" >&2
  if [ "$rc" -eq 0 ]; then
    local ev status
    status="$(jq -r --arg id "$id" '.steps[$id].status // "pending"' "$FLYWHEEL_SETUP_STATE_DIR/setup-state.json" 2>/dev/null)"
    ev="$(jq -c --arg id "$id" '.steps[$id].evidence // {}' "$FLYWHEEL_SETUP_STATE_DIR/setup-state.json" 2>/dev/null || echo '{}')"
    bs_emit --arg s "$id" --arg st "$status" --argjson ev "$ev" \
      '{ok:true, step:$s, status:$st, evidence:$ev}'
    return 0
  elif [ "$rc" -eq 3 ]; then
    bs_emit --arg s "$id" --arg h "$(bs_log_tail_hint)" --arg l "$BS_LOG_FILE" \
      '{ok:false, step:$s, error_code:"needs_guidance", hint:$h, log:$l}'
    exit 3
  else
    bs_emit --arg s "$id" --arg h "$(bs_log_tail_hint)" --arg l "$BS_LOG_FILE" \
      '{ok:false, step:$s, error_code:"step_failed", hint:$h, log:$l}'
    exit 1
  fi
}

# run one step under a booted engine. Done steps are re-verified exactly like
# the main loop: verifier green = no-op success; gone artifacts = re-run.
bs_run_one() {
  bs_engine_boot || return 1
  local id="$1" vfn="step_verify_$1"
  if [ "$(setup_step_status "$id")" = "done" ]; then
    if declare -F "$vfn" >/dev/null 2>&1 && ! "$vfn"; then
      fs_log "step '$id' was done but its artifacts are gone — re-running it"
      setup_mark_pending "$id"
    else
      fs_log "step '$id': done — skipping"
      return 0
    fi
  fi
  "step_run_${id}"
}

bs_cmd_verify() {
  local id="$1"
  bs_captured bs_verify_one "$id"
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    bs_emit --arg s "$id" '{ok:true, step:$s}'
  else
    bs_emit --arg s "$id" --arg l "$BS_LOG_FILE" \
      '{ok:false, step:$s, error_code:"verify_failed", hint:"step artifacts missing or invalid — re-run this step", log:$l}'
    exit 1
  fi
}

bs_verify_one() {
  bs_engine_boot || return 1
  local id="$1" vfn="step_verify_$1"
  [ "$(setup_step_status "$id")" = "done" ] || return 1
  if declare -F "$vfn" >/dev/null 2>&1; then "$vfn"; else return 0; fi
}

bs_cmd_status() {
  local jf="$FLYWHEEL_SETUP_STATE_DIR/setup-state.json"
  if [ ! -f "$jf" ]; then
    bs_emit '{ok:true, version:0, steps:{}, buddy:{}}'
    return 0
  fi
  jq -c '{ok:true, version:(.version // 1),
          steps:(.steps | map_values(.status)),
          buddy:(.buddy // {})}' "$jf" 2>/dev/null \
    || bs_emit_fail 1 corrupt_journal "setup-state.json did not parse — fix or remove it"
}

bs_cmd_state_get() {
  local key="$1"
  local jf="$FLYWHEEL_SETUP_STATE_DIR/setup-state.json"
  local val="null"
  [ -f "$jf" ] && val="$(jq -c --arg k "$key" '.buddy[$k] // null' "$jf" 2>/dev/null || echo null)"
  bs_emit --arg k "$key" --argjson v "$val" '{ok:true, key:$k, value:$v}'
}

bs_cmd_state_set() {
  local key="$1" value="$2"
  printf '%s' "$key" | grep -Eq "$BS_BUDDY_KEY_WHITELIST" \
    || bs_emit_fail 1 key_not_allowed "buddy key '$key' is not in the whitelist"
  scan_string_for_secrets "$value" >/dev/null 2>&1 \
    || bs_emit_fail 1 secret_value_refused "the value for '$key' looks secret-like — buddy state never stores secrets"
  bs_captured bs_state_set_one "$key" "$value"
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    bs_emit --arg k "$key" '{ok:true, key:$k}'
  else
    bs_emit_fail 1 state_write_failed "$(bs_log_tail_hint)" ""
  fi
}

bs_state_set_one() {
  bs_engine_boot || return 1
  local key="$1" value="$2" cur next vjson
  # a value that parses as JSON is stored structured (arrays like
  # connected_systems); anything else is stored as a string.
  if vjson="$(jq -ce . <<<"$value" 2>/dev/null)"; then :; else vjson="$(jq -c --arg v "$value" -n '$v')"; fi
  cur="$(cat "$FS_STATE_FILE")"
  next="$(jq --arg k "$key" --argjson v "$vjson" '.buddy[$k] = $v' <<<"$cur")"
  if [ "$(jq -S . <<<"$cur")" != "$(jq -S . <<<"$next")" ]; then
    printf '%s\n' "$next" | _fs_atomic_write_600 "$FS_STATE_FILE"
  fi
}

bs_cmd_steps() {
  printf '%s\n' "${BS_STEP_IDS[@]}" | jq -Rc . | jq -sc '{ok:true, steps:.}'
}

bs_usage() {
  cat <<'EOF'
Usage: flywheel-buddy-steps.sh [identity-flags] <subcommand>

  Identity flags (mirror flywheel-setup.sh; persisted to buddy.identity,
  journal values fill in whatever a resume invocation omits):
    --project <name> --department <slug> --cos-persona <n> --eng-persona <n>
    --linear-team <KEY> --project-slug <o/r> --skills-repo <slug>
    --state-dir <dir>

  Subcommands (stdout = exactly one JSON line; exit 0 ok / 1 fail / 3 guidance):
    run <step-id>            execute one setup step
    verify <step-id>         re-verify a done step's live artifacts
    status [--json]          {version, steps:{id:status}, buddy:{…}}
    state get <key>          read a buddy-region key
    state set <key> <value>  write a whitelisted, secret-scanned buddy key
    steps                    the buddy step order
EOF
}

bs_main() {
  FS_PROJECT=""; FS_DEPT=""; FS_COS_PERSONA=""; FS_ENG_PERSONA=""
  FS_LINEAR_TEAM=""; FS_PROJECT_SLUG=""; FS_SKILLS_REPO=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project)      FS_PROJECT="${2:?}"; shift 2 ;;
      --department)   FS_DEPT="${2:?}"; shift 2 ;;
      --cos-persona)  FS_COS_PERSONA="${2:?}"; shift 2 ;;
      --eng-persona)  FS_ENG_PERSONA="${2:?}"; shift 2 ;;
      --linear-team)  FS_LINEAR_TEAM="${2:?}"; shift 2 ;;
      --project-slug) FS_PROJECT_SLUG="${2:?}"; shift 2 ;;
      --skills-repo)  FS_SKILLS_REPO="${2:?}"; shift 2 ;;
      --state-dir)    FLYWHEEL_SETUP_STATE_DIR="${2:?}"; shift 2 ;;
      -h|--help)      bs_usage; exit 0 ;;
      *) break ;;
    esac
  done
  bs_resolve_state_dir
  bs_open_log

  local sub="${1:-}"
  case "$sub" in
    run)
      [ -n "${2:-}" ] || bs_emit_fail 1 bad_usage "run requires a <step-id>"
      bs_cmd_run "$2" ;;
    verify)
      [ -n "${2:-}" ] || bs_emit_fail 1 bad_usage "verify requires a <step-id>"
      bs_cmd_verify "$2" ;;
    status)
      bs_cmd_status ;;
    state)
      case "${2:-}" in
        get) [ -n "${3:-}" ] || bs_emit_fail 1 bad_usage "state get requires a <key>"
             bs_cmd_state_get "$3" ;;
        set) { [ -n "${3:-}" ] && [ -n "${4+x}" ]; } || bs_emit_fail 1 bad_usage "state set requires <key> <value>"
             bs_cmd_state_set "$3" "$4" ;;
        *) bs_emit_fail 1 bad_usage "state requires get|set" ;;
      esac ;;
    steps)
      bs_cmd_steps ;;
    "")
      bs_usage >&2
      bs_emit_fail 1 bad_usage "a subcommand is required (run/verify/status/state/steps)" ;;
    *)
      bs_emit_fail 1 bad_usage "unknown subcommand '$sub'" ;;
  esac
}

if [ -z "${FLYWHEEL_BUDDY_STEPS_SOURCED:-}" ]; then
  bs_main "$@"
fi
