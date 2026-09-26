#!/usr/bin/env bash
# FLY-648 (rev2): flywheel-setup.sh — the ONE-COMMAND setup wizard that turns a
# clean machine into a running Flywheel instance (self-hosted model B).
#
# Shape (plan §3): a step-engine with a resumable journal drives every [AUTO]
# step of the FLY-910 automation boundary table (deps / project skeleton /
# Discord channels / config / services / health), guiding the user through the
# ONLY three hands-on items (① Discord bots — C1 own-portal / C2 pool seam,
# ② Linear credentials, ③ model key / Claude login). The user never sees or
# edits JSON; tokens are read via hidden TTY and never appear in chat, argv,
# logs, or the journal.
#
# Reuse (zero behavior change to the FLY-650 chain): host-config.sh /
# supervisor.sh / platform-deps.sh / provision-fleet-host.sh (called as the
# supply chain: flywheel-home + tokens + launchd phases consume the staging
# fleet artifact this wizard generates internally — the rev1 generator +
# real-loader validation demoted to an internal mechanism, plan WI-B).
#
# RED LINES:
#   - secrets: hidden-TTY input → validate in memory → atomic 0600 write to
#     ~/.flywheel/.env ONLY. Never in argv / history / logs / setup-state.json.
#   - journal safety envelope (R1#6): owner-only state dir, symlink-refused,
#     atomic tmp+rename writes, concurrency lock, step marked done ONLY after
#     its live artifact + validation evidence exist.
#   - fail-closed: a failing step stops the run at that step (journal keeps
#     progress); re-run resumes from the first pending step.
#   - OS-portable (§3.5): platform touched ONLY via the FLY-650 seams — this
#     script contains no launchd/plist literals (guard-tested).
set -uo pipefail

FS_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FS_REPO_ROOT="$(cd "$FS_SCRIPT_DIR/.." && pwd)"

fs_log()  { echo "[flywheel-setup] $*"; }
fs_err()  { echo "[flywheel-setup] ERROR: $*" >&2; }
fs_die()  { fs_err "$*"; exit 1; }

# ═══════════════════════════════════════════════════════════════════════════
# WI-A · step engine + setup-state journal (resumable, fail-closed)
# ═══════════════════════════════════════════════════════════════════════════

# Resolved at engine start (setup_engine_init). Overridable for tests / custom
# state roots; defaults follow the FLY-650 state-dir semantics.
FLYWHEEL_SETUP_STATE_DIR="${FLYWHEEL_SETUP_STATE_DIR:-}"
FS_STATE_FILE=""
FS_LOCK_DIR=""
FS_LOCK_HELD=0

# _fs_perm <path> — octal permission bits (portable stat). GNU form FIRST:
# on Linux, BSD's `stat -f '%Lp'` succeeds but prints filesystem info (the ||
# fallback never fires); on macOS `stat -c` exits non-zero so the BSD form
# takes over.
_fs_perm() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }

# _fs_assert_safe_dir <dir> — the safety envelope for any dir we persist state
# into (journal + .env live under it): must exist, be owned by us, and not be
# group/world-writable (R1#6).
_fs_assert_safe_dir() {
  local d="$1"
  [ -d "$d" ] || fs_die "state dir missing: $d"
  [ -O "$d" ] || fs_die "state dir not owned by current user: $d"
  local p; p="$(_fs_perm "$d")"
  case "$p" in
    *[2367]?|*[2367]) fs_die "state dir is group/world-writable ($p): $d — chmod go-w it first" ;;
  esac
}

# _fs_assert_no_symlink <path> — refuse symlinked state/secret files.
_fs_assert_no_symlink() {
  [ -L "$1" ] && fs_die "refusing symlinked file: $1"
  return 0
}

# _fs_atomic_write_600 <path> — write stdin to <path> atomically with 0600
# (tmp in the same dir + chmod before rename; fsync best-effort via sync -f
# where available is skipped — rename durability is acceptable here).
_fs_atomic_write_600() {
  local path="$1" dir tmp
  _fs_assert_no_symlink "$path"
  dir="$(dirname "$path")"
  _fs_assert_safe_dir "$dir"
  tmp="$(mktemp "$dir/.tmp.XXXXXX")" || fs_die "mktemp failed in $dir"
  cat > "$tmp" || { rm -f "$tmp"; fs_die "write failed: $path"; }
  chmod 600 "$tmp" || { rm -f "$tmp"; fs_die "chmod failed: $path"; }
  mv "$tmp" "$path" || { rm -f "$tmp"; fs_die "rename failed: $path"; }
}

# setup_engine_init — resolve paths, apply the safety envelope, take the lock.
setup_engine_init() {
  [ -n "$FLYWHEEL_SETUP_STATE_DIR" ] || FLYWHEEL_SETUP_STATE_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
  # Tighten permissions only on a dir WE create; a pre-existing unsafe dir is
  # rejected (fail-closed), never silently chmod'ed behind the owner's back.
  if [ ! -d "$FLYWHEEL_SETUP_STATE_DIR" ]; then
    mkdir -p "$FLYWHEEL_SETUP_STATE_DIR" || fs_die "cannot create state dir: $FLYWHEEL_SETUP_STATE_DIR"
    chmod go-w "$FLYWHEEL_SETUP_STATE_DIR" 2>/dev/null || true
  fi
  _fs_assert_safe_dir "$FLYWHEEL_SETUP_STATE_DIR"
  FS_STATE_FILE="$FLYWHEEL_SETUP_STATE_DIR/setup-state.json"
  _fs_assert_no_symlink "$FS_STATE_FILE"
  FS_LOCK_DIR="$FLYWHEEL_SETUP_STATE_DIR/setup.lock.d"
  # mkdir is the portable atomic lock. A second instance fails loud (R1#6).
  if ! mkdir "$FS_LOCK_DIR" 2>/dev/null; then
    fs_die "another flywheel-setup instance appears to be running (lock: $FS_LOCK_DIR). If you are SURE none is, remove that directory and re-run."
  fi
  FS_LOCK_HELD=1
  trap '_fs_release_lock' EXIT
  # initialize an empty journal if absent.
  if [ ! -f "$FS_STATE_FILE" ]; then
    printf '{"version":1,"steps":{}}\n' | _fs_atomic_write_600 "$FS_STATE_FILE"
  fi
  jq empty "$FS_STATE_FILE" 2>/dev/null || fs_die "corrupt journal: $FS_STATE_FILE — fix or remove it, then re-run"
}

_fs_release_lock() {
  [ "$FS_LOCK_HELD" -eq 1 ] && rmdir "$FS_LOCK_DIR" 2>/dev/null
  FS_LOCK_HELD=0
  return 0
}

# setup_step_status <id> — done | pending
setup_step_status() {
  jq -r --arg id "$1" '.steps[$id].status // "pending"' "$FS_STATE_FILE" 2>/dev/null
}

# setup_step_evidence <id> — the step's recorded (non-secret) evidence JSON.
setup_step_evidence() {
  jq -c --arg id "$1" '.steps[$id].evidence // {}' "$FS_STATE_FILE" 2>/dev/null
}

# setup_mark_done <id> <evidence-json> — record completion. Callers must only
# call this AFTER the step's live artifacts + validation evidence exist (the
# engine additionally re-verifies on resume via step_verify_<id>). Evidence is
# structured non-secret metadata ONLY — never token values.
setup_mark_done() {
  local id="$1" evidence="${2:-{\}}"
  jq -e . >/dev/null 2>&1 <<<"$evidence" || fs_die "step '$id': evidence is not valid JSON"
  jq --arg id "$id" --argjson ev "$evidence" \
     '.steps[$id] = {status:"done", evidence:$ev}' "$FS_STATE_FILE" \
    | _fs_atomic_write_600 "$FS_STATE_FILE"
}

# setup_mark_pending <id> — demote a step (used when resume-verification finds
# its live artifacts gone: never trust half-state, R1#6).
setup_mark_pending() {
  local id="$1"
  jq --arg id "$1" 'del(.steps[$id])' "$FS_STATE_FILE" | _fs_atomic_write_600 "$FS_STATE_FILE"
}

# setup_main_loop — run STEP_IDS in order. done steps are re-verified
# (step_verify_<id> when defined; missing verifier = trust the journal) and
# skipped; the first pending step runs; a step failure stops the run at that
# step (fail-closed), keeping the journal for resume.
setup_main_loop() {
  setup_engine_init
  local id fn vfn hfn
  for id in "${STEP_IDS[@]}"; do
    fn="step_run_${id}"
    vfn="step_verify_${id}"
    hfn="step_hydrate_${id}"
    if [ "$(setup_step_status "$id")" = "done" ]; then
      if declare -F "$vfn" >/dev/null 2>&1 && ! "$vfn"; then
        fs_log "step '$id' was done but its artifacts are gone — re-running it"
        setup_mark_pending "$id"
      else
        fs_log "step '$id': done — skipping"
        # rehydrate the FS_* values later steps consume from this step's
        # (non-secret) evidence — a resumed run must see what a fresh run set.
        if declare -F "$hfn" >/dev/null 2>&1; then
          "$hfn" || fs_die "step '$id': evidence rehydration failed (corrupt journal?)"
        fi
        continue
      fi
    fi
    declare -F "$fn" >/dev/null 2>&1 || fs_die "no implementation for step '$id'"
    fs_log "step '$id': running"
    if ! "$fn"; then
      fs_err "step '$id' FAILED — fix the issue above, then re-run flywheel-setup.sh (it resumes from this step; progress is kept in $FS_STATE_FILE)"
      return 1
    fi
    [ "$(setup_step_status "$id")" = "done" ] \
      || fs_die "step '$id' returned success but did not mark itself done (bug)"
  done
  fs_log "all steps complete."
  return 0
}

# ═══════════════════════════════════════════════════════════════════════════
# Guided input (hidden-TTY secrets; env-injectable for automation/tests)
# ═══════════════════════════════════════════════════════════════════════════

# _fs_answer_env <KEY> — automation override: FLYWHEEL_SETUP_ANSWER_<KEY>.
_fs_answer_env() {
  local var="FLYWHEEL_SETUP_ANSWER_$1"
  printf '%s' "${!var:-}"
}

# fs_ask_value <KEY> <prompt> — visible guided input. Never hangs: without a
# TTY and without an env answer it fails loud.
fs_ask_value() {
  local key="$1" prompt="$2" v
  v="$(_fs_answer_env "$key")"
  if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  [ -r /dev/tty ] || fs_die "non-interactive and no FLYWHEEL_SETUP_ANSWER_$key provided (needed: $prompt)"
  printf '%s: ' "$prompt" > /dev/tty
  IFS= read -r v < /dev/tty || fs_die "input aborted for $key"
  printf '%s' "$v"
}

# fs_ask_secret <KEY> <prompt> — hidden input (FLY-510 notion.sh precedent):
# read -s from the TTY, never echoed, never in argv/history.
fs_ask_secret() {
  local key="$1" prompt="$2" v
  v="$(_fs_answer_env "$key")"
  if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  [ -r /dev/tty ] || fs_die "non-interactive and no FLYWHEEL_SETUP_ANSWER_$key provided (needed: $prompt)"
  printf '%s (input hidden): ' "$prompt" > /dev/tty
  IFS= read -rs v < /dev/tty || fs_die "input aborted for $key"
  printf '\n' > /dev/tty
  printf '%s' "$v"
}

# fs_env_upsert <KEY> <value> — atomically merge KEY=value into the state
# root's .env (0600, symlink-refused, safe parent). The .env file IS the
# durable secret store — secrets are persisted the moment they are validated,
# so an interrupted run never loses them into a journal that must stay
# secret-free.
fs_env_upsert() {
  local key="$1" value="$2"
  local envf="$FLYWHEEL_SETUP_STATE_DIR/.env"
  _fs_assert_no_symlink "$envf"
  {
    if [ -f "$envf" ]; then grep -vE "^(export[[:space:]]+)?${key}=" "$envf" || true; fi
    printf '%s=%s\n' "$key" "$value"
  } | _fs_atomic_write_600 "$envf"
}

# ═══════════════════════════════════════════════════════════════════════════
# WI-B · config writer (rev1 generator demoted to an internal mechanism) +
#        pre-write validation gate = the REAL config loader
# ═══════════════════════════════════════════════════════════════════════════

# Inputs (set by arg parsing / steps): FS_PROJECT FS_DEPT FS_COS_PERSONA
# FS_ENG_PERSONA FS_PROJECT_SLUG FS_LINEAR_TEAM FS_SKILLS_REPO, and the values
# steps 4–6 collect: FS_GUILD_ID FS_FOUNDER_ID FS_CHANNEL_{GENERAL,COS,ENG}.
# Values not yet collected hold internal __FILL_...__ placeholders — an
# INTERNAL contract only (the user never sees them); complete-mode generation
# refuses any residue.

_fs_upper_env() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr '-' '_'; }
_fs_lower_id()  { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# fs_derive_identity — validate inputs + derive the identity contract:
#   CoS agentId is LITERALLY "cos-lead" (claude-lead.sh only loads the CoS rule
#   surface for that id — or a FLYWHEEL_LEAD_ROLE=cos env the Linux systemd
#   wrapper does NOT inject); the persona only names the display/env side.
fs_derive_identity() {
  printf '%s' "$FS_PROJECT" | grep -Eq '^[a-z0-9][a-z0-9-]*$' \
    || fs_die "project \"$FS_PROJECT\" must match ^[a-z0-9][a-z0-9-]*\$"
  printf '%s' "$FS_DEPT" | grep -Eq '^[a-z0-9-]+$' \
    || fs_die "department \"$FS_DEPT\" must match ^[a-z0-9-]+\$"
  local p
  for p in "$FS_COS_PERSONA" "$FS_ENG_PERSONA"; do
    printf '%s' "$p" | grep -Eq '^[A-Za-z][A-Za-z0-9-]*$' \
      || fs_die "persona \"$p\" must match ^[A-Za-z][A-Za-z0-9-]*\$"
  done
  FS_COS_ENV="$(_fs_upper_env "$FS_COS_PERSONA")_BOT_TOKEN"
  FS_ENG_ENV="$(_fs_upper_env "$FS_ENG_PERSONA")_BOT_TOKEN"
  [ "$FS_COS_ENV" != "$FS_ENG_ENV" ] \
    || fs_die "--cos-persona and --eng-persona derive the same env name ($FS_COS_ENV) — pick distinct personas"
  FS_COS_ID="cos-lead"
  FS_ENG_ID="$(_fs_lower_id "$FS_ENG_PERSONA")-eng-lead"
  printf '%s' "$FS_ENG_ID" | grep -Eq '^[a-z0-9][a-z0-9-]*$' \
    || fs_die "derived eng agentId \"$FS_ENG_ID\" violates ^[a-z0-9][a-z0-9-]*\$"
  # Routing label: project name, first letter capitalized (production
  # convention, e.g. project "flywheel" → label "Flywheel").
  FS_PROJECT_LABEL="$(printf '%s' "$FS_PROJECT" | awk '{ print toupper(substr($0,1,1)) substr($0,2) }')"
  # projectRoot: resolved ABSOLUTE at generation time. The wizard runs ON the
  # target machine, so $HOME is the target semantics; loadProjects never
  # expands '~' and materialize treats non-absolute as $HOME-relative (R1#3).
  FS_PROJECT_ROOT="$HOME/Dev/$FS_PROJECT"
  return 0
}

# fs_validate_projects <file> — the AUTHORITATIVE schema layer: the built
# validate-projects CLI runs the SAME parseAndValidateProjects the Bridge
# boots with. Fail-closed when the dist is missing — never a weaker jq check.
fs_validate_projects() {
  local file="$1"
  local validator="$FS_REPO_ROOT/packages/teamlead/dist/bin/validate-projects.js"
  if [ ! -f "$validator" ]; then
    fs_err "built validator missing: $validator"
    fs_err "run: pnpm install && pnpm -C packages/teamlead build (fail-closed)"
    return 1
  fi
  node "$validator" "$file"
}

# fs_generate_fleet_artifact <out-dir> <complete:0|1> — write the internal
# staging fleet artifact (manifest.json / projects.json / host.json /
# env.example) the UNCHANGED provision-fleet-host.sh consumes. Deterministic
# (no timestamps), always regenerated from current values (steps refresh it),
# zero secrets. complete=1 additionally enforces: no internal placeholder
# residue + the real-loader gate + the secret scan.
fs_generate_fleet_artifact() {
  local out="$1" complete="${2:-0}"
  mkdir -p "$out" || fs_die "cannot create artifact dir: $out"
  # values not yet collected default to INTERNAL placeholders (never
  # user-facing; complete-mode refuses residue). Keeps pre-collection
  # regeneration (e.g. the preflight step's manifest) safe under set -u.
  FS_GUILD_ID="${FS_GUILD_ID:-__FILL_DISCORD_GUILD_ID__}"
  FS_FOUNDER_ID="${FS_FOUNDER_ID:-__FILL_DISCORD_USER_ID_FOUNDER__}"
  FS_CHANNEL_GENERAL="${FS_CHANNEL_GENERAL:-__FILL_DISCORD_CHANNEL_ID_GENERAL__}"
  FS_CHANNEL_COS="${FS_CHANNEL_COS:-__FILL_DISCORD_CHANNEL_ID_COS__}"
  FS_CHANNEL_ENG="${FS_CHANNEL_ENG:-__FILL_DISCORD_CHANNEL_ID_ENG__}"
  FS_LINEAR_TEAM="${FS_LINEAR_TEAM:-__FILL_LINEAR_TEAM_KEY__}"

  # 1. projects.json — every rev1 schema fix preserved: CoS agentId literal
  #    cos-lead; Triage ⇒ explicit canSpawnRunners:false (loader-enforced);
  #    eng lead carries an EXPLICIT department (else resolveLeadDepartment
  #    falls back to labels[0] and doc-flow/dispatch key off the project name).
  jq -n \
    --arg pname "$FS_PROJECT" \
    --arg proot "$FS_PROJECT_ROOT" \
    --arg pslug "${FS_PROJECT_SLUG:-}" \
    --arg plabel "$FS_PROJECT_LABEL" \
    --arg dept "$FS_DEPT" \
    --arg cosEnv "$FS_COS_ENV" \
    --arg engEnv "$FS_ENG_ENV" \
    --arg engId "$FS_ENG_ID" \
    --arg team "$FS_LINEAR_TEAM" \
    --arg general "$FS_CHANNEL_GENERAL" \
    --arg cosCh "$FS_CHANNEL_COS" \
    --arg engCh "$FS_CHANNEL_ENG" \
    --arg founder "$FS_FOUNDER_ID" \
    '[
      {
        projectName: $pname,
        projectRoot: $proot,
        generalChannel: $general,
        memoryAllowedUsers: [$founder],
        # full ProjectLinearBinding: the runtime only auto-associates the
        # Linear project + appends the scope label when the binding carries
        # project/label (bridge/linear-scope.ts) — team alone loses both
        # (Codex R1 MEDIUM). project = the Linear Project NAME (the wizard
        # creates it with the flywheel project name); label = routing label.
        linear: { team: $team, project: $pname, label: $plabel },
        leads: [
          {
            agentId: "cos-lead",
            chatChannel: $cosCh,
            match: { labels: ["Triage"] },
            botTokenEnv: $cosEnv,
            canSpawnRunners: false
          },
          {
            agentId: $engId,
            chatChannel: $engCh,
            match: { labels: [$plabel] },
            department: $dept,
            botTokenEnv: $engEnv
          }
        ]
      }
      | (if $pslug != "" then . + {projectRepo: $pslug} else . end)
    ]' > "$out/projects.json" || fs_die "projects.json generation failed"

  # 2. env.example — the token-gate reference. EXACT required key set (R1#5):
  #    secret keys EMPTY (validate_tokens enforces them on the live .env,
  #    which this wizard fills the moment each secret is validated); required
  #    non-secret IDs carry their collected values. NO optional secret-named
  #    keys (they would trip validate_tokens); an explicit API-key path
  #    appends to the live .env only, never here.
  cat > "$out/env.example" <<EOF
# Flywheel fresh-instance env — generated by flywheel-setup.sh (FLY-648).
# provision-fleet-host.sh validates the live ~/.flywheel/.env against the keys
# here. Secret values live ONLY in the live .env (written by the wizard via
# hidden input) — never in this artifact.
${FS_COS_ENV}=
${FS_ENG_ENV}=
LINEAR_API_KEY=
DISCORD_GUILD_ID=${FS_GUILD_ID}
DISCORD_OWNER_USER_ID=${FS_FOUNDER_ID}
LINEAR_WORKSPACE_SLUG=${FS_LINEAR_WORKSPACE_SLUG:-__FILL_LINEAR_WORKSPACE_SLUG__}
EOF

  # 3. manifest.json — deps[] mirrors fleet-capture.sh's DEPS_JSON verbatim
  #    (platform-keyed, linux mappings validated by FLY-650); minimal aux job
  #    set (linux derives units from _fleet_linux_specs, darwin narrates);
  #    NO timestamp (deterministic regeneration).
  # FLY-1062: a PREBUILT tree (FS_REPO_ROOT carries .flywheel-prebuilt) needs
  # NO pnpm (nothing is built on the customer machine) and gains a linux
  # compiler-toolchain fallback entry (`cc` → build-essential) for the
  # better-sqlite3 prebuilt-binary gap. The monorepo deps list below stays
  # byte-identical (reverse-compat sentinel: setup-prebuilt.test.sh).
  local fs_prebuilt=0
  [ -f "$FS_REPO_ROOT/.flywheel-prebuilt" ] && fs_prebuilt=1
  local deps_json
  if [ "$fs_prebuilt" -eq 1 ]; then
    deps_json='[
    {"name":"homebrew","required":false,"platforms":{"darwin":{"channel":"installer"}}},
    {"name":"node","required":true,"platforms":{"darwin":{"channel":"brew","formula":"node"},"linux":{"presentCheck":true}},"check":{"command":"node"}},
    {"name":"tmux","required":true,"platforms":{"darwin":{"channel":"brew","formula":"tmux"},"linux":{"apt":"tmux","dnf":"tmux"}},"check":{"command":"tmux"}},
    {"name":"gh","required":true,"platforms":{"darwin":{"channel":"brew","formula":"gh"},"linux":{"apt":"gh","dnf":"gh"}},"check":{"command":"gh"}},
    {"name":"jq","required":true,"platforms":{"darwin":{"channel":"brew","formula":"jq"},"linux":{"apt":"jq","dnf":"jq"}},"check":{"command":"jq"}},
    {"name":"git","required":true,"platforms":{"darwin":{"channel":"brew","formula":"git"},"linux":{"apt":"git","dnf":"git"}},"check":{"command":"git"}},
    {"name":"cc","required":false,"platforms":{"linux":{"apt":"build-essential","dnf":"gcc-c++"}},"note":"prebuilt mode: native-module build fallback (better-sqlite3)"},
    {"name":"cmux","required":false,"platforms":{"darwin":{"channel":"manual"}},"note":"darwin-only viewer; cmux app + flywheel-cmux-install.sh"},
    {"name":"codex","required":false,"channel":"manual","note":"OpenAI Codex CLI"},
    {"name":"claude","required":false,"channel":"manual","note":"Claude Code CLI"},
    {"name":"kimi","required":false,"channel":"manual","note":"Kimi Code CLI (brew kimi-code)"},
    {"name":"agy","required":false,"channel":"manual","note":"Antigravity CLI"}
  ]'
  else
    deps_json='[
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
  fi
  # FLY-1062: on a prebuilt tree the flywheel runtime is the installed payload —
  # customer manifests must NOT carry the private repo slug (zero-repo-access
  # invariant; the provisioner skips the flywheel entry in prebuilt mode anyway).
  local fs_flywheel_slug="xrliAnnie/flywheel"
  [ "$fs_prebuilt" -eq 1 ] && fs_flywheel_slug=""
  jq -n \
    --arg pname "$FS_PROJECT" \
    --arg pslug "${FS_PROJECT_SLUG:-}" \
    --arg skrepo "$FS_SKILLS_REPO" \
    --arg fslug "$fs_flywheel_slug" \
    --argjson deps "$deps_json" \
    '{
      schemaVersion: 1,
      meta: { tool: "flywheel-setup.sh" },
      deps: $deps,
      repos: [
        { name: "flywheel", slug: (if $fslug=="" then null else $fslug end), targetDir: "Dev/flywheel" },
        { name: $pname, slug: (if $pslug=="" then null else $pslug end), targetDir: ("Dev/" + $pname) }
      ],
      launchdJobs: [
        { label: "com.flywheel.bridge", kind: "aux" },
        { label: "com.flywheel.updater", kind: "aux" },
        { label: "com.flywheel.daily-standup", kind: "aux" }
      ],
      skills: {
        skillsSyncPresent: false,
        skillsUpdatePlistPresent: false,
        canonicalRepo: $skrepo
      }
    }' > "$out/manifest.json" || fs_die "manifest.json generation failed"

  # 4. host.json — portable fields only; the target derives platform from uname.
  #    FLY-1062: prebuilt installs run out of the stable runtime symlink —
  #    flywheelDir points every wrapper/launcher at ~/.flywheel/runtime/current
  #    (FLY-650 host.json seam; zero wrapper changes). Monorepo output is
  #    byte-identical (no flywheelDir key).
  if [ "$fs_prebuilt" -eq 1 ]; then
    jq -n --arg repo "$FS_SKILLS_REPO" \
      '{ schemaVersion: 1, skillsRepo: $repo, flywheelDir: "~/.flywheel/runtime/current" }' \
      > "$out/host.json" || fs_die "host.json generation failed"
  else
    jq -n --arg repo "$FS_SKILLS_REPO" \
      '{ schemaVersion: 1, skillsRepo: $repo }' > "$out/host.json" || fs_die "host.json generation failed"
  fi

  # 5. complete-mode gates: placeholder residue, the REAL loader, secret scan.
  if [ "$complete" = "1" ]; then
    local residue
    residue="$(grep -rn '__FILL_[A-Z0-9_]*__' "$out/projects.json" "$out/env.example" "$out/manifest.json" "$out/host.json" 2>/dev/null || true)"
    if [ -n "$residue" ]; then
      fs_err "internal placeholder residue — a collection step did not run:"
      printf '%s\n' "$residue" >&2
      return 1
    fi
    fs_validate_projects "$out/projects.json" \
      || { fs_err "projects.json REJECTED by the real loader"; return 1; }
    # shellcheck source=lib/fleet-sanitize.sh
    source "$FS_SCRIPT_DIR/lib/fleet-sanitize.sh"
    scan_for_secrets "$out" \
      || { fs_err "secret-like content detected in the staging artifact"; return 1; }
  fi
  return 0
}

# ═══════════════════════════════════════════════════════════════════════════
# WI-C · bot-provisioning seam (C1 own-portal / C2 pool-invite, default C1)
# ═══════════════════════════════════════════════════════════════════════════

# Discord permission bits — SINGLE POINT of truth for what the invite grants.
# MANAGE_CHANNELS is required because the wizard CREATES the channels via the
# bot (setup-mirror-channel.sh precedent lacked it and forced manual creation).
FS_PERM_MANAGE_CHANNELS=16
FS_PERM_ADD_REACTIONS=64
FS_PERM_VIEW_CHANNEL=1024
FS_PERM_SEND_MESSAGES=2048
FS_PERM_EMBED_LINKS=16384
FS_PERM_ATTACH_FILES=32768
FS_PERM_READ_MESSAGE_HISTORY=65536
FS_PERM_CREATE_PUBLIC_THREADS=$(( 1 << 35 ))
FS_PERM_SEND_MESSAGES_IN_THREADS=$(( 1 << 38 ))
FS_BOT_PERMISSIONS=$(( FS_PERM_MANAGE_CHANNELS + FS_PERM_ADD_REACTIONS \
  + FS_PERM_VIEW_CHANNEL + FS_PERM_SEND_MESSAGES + FS_PERM_EMBED_LINKS \
  + FS_PERM_ATTACH_FILES + FS_PERM_READ_MESSAGE_HISTORY \
  + FS_PERM_CREATE_PUBLIC_THREADS + FS_PERM_SEND_MESSAGES_IN_THREADS ))

FS_DISCORD_API="https://discord.com/api/v10"

# fs_bot_invite_url <application-id> — the invite URL a user opens to pull a
# bot into their server, carrying the single-point permission set.
fs_bot_invite_url() {
  printf 'https://discord.com/oauth2/authorize?client_id=%s&scope=bot&permissions=%s' \
    "$1" "$FS_BOT_PERMISSIONS"
}

# fs_discord_api <METHOD> <path> <token> [json-body] — Discord REST call.
# The token travels via a curl CONFIG ON STDIN (never argv/ps/history —
# FLY-510 notion.sh precedent). Prints the response body.
# Returns: 0 = 2xx · 3 = 403 (permission fallback signal) · 1 = other.
fs_discord_api() {
  local method="$1" path="$2" token="$3" body="${4:-}"
  local out http
  if [ -n "$body" ]; then
    out="$(printf 'header = "Authorization: Bot %s"\nheader = "Content-Type: application/json"\n' "$token" \
      | curl -sS -K - -X "$method" -d "$body" -w '\n%{http_code}' "$FS_DISCORD_API$path" 2>/dev/null)"
  else
    out="$(printf 'header = "Authorization: Bot %s"\n' "$token" \
      | curl -sS -K - -X "$method" -w '\n%{http_code}' "$FS_DISCORD_API$path" 2>/dev/null)"
  fi
  http="$(printf '%s' "$out" | tail -1)"
  printf '%s\n' "$out" | sed '$d'
  case "$http" in
    2??) return 0 ;;
    403) return 3 ;;
    *)   fs_err "Discord API $method $path → HTTP ${http:-?}"; return 1 ;;
  esac
}

# _fs_bot_validate <leadId> <token> <envName> — shared C1/C2 validation:
# identity (/users/@me) + guild membership (/users/@me/guilds). On success
# persists the token to .env and emits a BotProvisionResult JSON line
# {leadId, botUserId, tokenEnvName, guildId, guildMembershipProof}.
_fs_bot_validate() {
  local lead_id="$1" token="$2" env_name="$3"
  local me bot_user_id guilds n guild_id
  me="$(fs_discord_api GET /users/@me "$token")" || { fs_err "bot token for $lead_id failed identity check"; return 1; }
  bot_user_id="$(jq -r '.id // empty' <<<"$me")"
  [ -n "$bot_user_id" ] || { fs_err "no bot id in /users/@me response for $lead_id"; return 1; }
  guilds="$(fs_discord_api GET /users/@me/guilds "$token")" || { fs_err "cannot list guilds for $lead_id"; return 1; }
  n="$(jq 'length' <<<"$guilds" 2>/dev/null || echo 0)"
  if [ "${n:-0}" -eq 0 ]; then
    fs_err "the $lead_id bot is not in any server yet — open its invite URL, add it to YOUR server, then re-run"
    return 1
  elif [ "$n" -eq 1 ]; then
    guild_id="$(jq -r '.[0].id' <<<"$guilds")"
  else
    fs_log "the $lead_id bot is in $n servers:" >&2
    jq -r '.[] | "  \(.id)  \(.name)"' <<<"$guilds" >&2
    guild_id="$(fs_ask_value "GUILD_ID" "Enter the server (guild) ID to use")"
    jq -e --arg g "$guild_id" 'any(.[]; .id == $g)' <<<"$guilds" >/dev/null \
      || { fs_err "guild $guild_id is not among the bot's servers"; return 1; }
  fi
  fs_env_upsert "$env_name" "$token"
  jq -nc --arg l "$lead_id" --arg b "$bot_user_id" --arg e "$env_name" --arg g "$guild_id" \
    '{leadId:$l, botUserId:$b, tokenEnvName:$e, guildId:$g, guildMembershipProof:"users/@me/guilds"}'
}

# bot_provision_c1 <leadKey:COS|ENG> <leadId> <persona> <envName> — DEFAULT
# path: guide the user through creating their OWN Discord application/bot in
# the Developer Portal, invite it, then hidden-read + validate the token.
# Interactive validation failures re-ask in place (up to 3 tries); in
# non-interactive/automation mode a failure fails the step (the journal makes
# the re-run resume exactly here — that IS the retry).
bot_provision_c1() {
  local lead_key="$1" lead_id="$2" persona="$3" env_name="$4"
  cat >&2 <<GUIDE
[flywheel-setup] ── Discord bot for $persona ($lead_id) — create it yourself ──
  1. Open https://discord.com/developers/applications → New Application
     (name it "$persona").
  2. Bot tab → Reset Token → COPY the token (you paste it here in a moment).
  3. Bot tab → enable "MESSAGE CONTENT INTENT" and "SERVER MEMBERS INTENT".
  4. Copy the Application ID from General Information.
GUIDE
  local app_id token result attempt
  app_id="$(fs_ask_value "BOT_APP_ID_${lead_key}" "Application ID for $persona")" || return 1
  fs_log "5. Open this invite URL and add the bot to YOUR server:" >&2
  fs_log "   $(fs_bot_invite_url "$app_id")" >&2
  fs_ask_value "BOT_INVITED_${lead_key}" "Press Enter once the bot is in your server (y)" >/dev/null || return 1
  for attempt in 1 2 3; do
    token="$(fs_ask_secret "BOT_TOKEN_${lead_key}" "Paste the $persona bot token")" || return 1
    if result="$(_fs_bot_validate "$lead_id" "$token" "$env_name")"; then
      printf '%s\n' "$result"
      return 0
    fi
    # retry in place only when a human can supply a DIFFERENT answer.
    if [ -n "$(_fs_answer_env "BOT_TOKEN_${lead_key}")" ] || [ ! -r /dev/tty ]; then
      return 1
    fi
    fs_log "validation failed (attempt $attempt/3) — check the token and try again" >&2
  done
  return 1
}

# bot_provision_c2 <leadKey> <leadId> <persona> <envName> — OPTIONAL pool path
# (FLY-882): the bot apps already exist in the Flywheel-managed pool; the user
# only clicks an invite URL per bot. Tokens are HELD BY THE OPERATOR side and
# injected via env (FLYWHEEL_SETUP_POOL_TOKEN_<KEY>) — honestly annotated as a
# semi-managed convenience (the pool operator can post as these bots).
bot_provision_c2() {
  local lead_key="$1" lead_id="$2" persona="$3" env_name="$4"
  fs_log "── Discord bot for $persona ($lead_id) — pool path (semi-managed / 半托管) ──" >&2
  fs_log "NOTE: pool bot identities are operated by the Flywheel side; their tokens" >&2
  fs_log "are injected by the pool operator and never typed by you. This is a" >&2
  fs_log "semi-managed convenience — use the default own-bot path for full control." >&2
  local app_id token pool_var
  app_id="$(fs_ask_value "POOL_APP_ID_${lead_key}" "Pool application ID for $persona (from the operator)")" || return 1
  fs_log "Open this invite URL and add the pool bot to YOUR server:" >&2
  fs_log "   $(fs_bot_invite_url "$app_id")" >&2
  fs_ask_value "BOT_INVITED_${lead_key}" "Press Enter once the bot is in your server (y)" >/dev/null || return 1
  pool_var="FLYWHEEL_SETUP_POOL_TOKEN_${lead_key}"
  token="${!pool_var:-}"
  [ -n "$token" ] || token="$(fs_ask_secret "POOL_TOKEN_${lead_key}" "Pool bot token for $persona (operator-provided)")" || return 1
  _fs_bot_validate "$lead_id" "$token" "$env_name"
}

# step: bots — run the selected strategy for BOTH leads (v1 topology = two
# bots: the runtime is per-Lead — ProjectConfig validates lead.botTokenEnv per
# lead and the lead wrapper resolves it into that Lead's DISCORD_BOT_TOKEN),
# then require both to land in the SAME guild.
step_run_bots() {
  local path="${FLYWHEEL_SETUP_BOT_PATH:-c1}"
  local fn
  case "$path" in
    c1) fn=bot_provision_c1 ;;
    c2) fn=bot_provision_c2 ;;
    *) fs_err "unknown bot path '$path' (c1|c2)"; return 1 ;;
  esac
  local cos_res eng_res
  cos_res="$("$fn" COS "$FS_COS_ID" "$FS_COS_PERSONA" "$FS_COS_ENV")" || return 1
  eng_res="$("$fn" ENG "$FS_ENG_ID" "$FS_ENG_PERSONA" "$FS_ENG_ENV")" || return 1
  local g1 g2
  g1="$(jq -r '.guildId' <<<"$cos_res")"
  g2="$(jq -r '.guildId' <<<"$eng_res")"
  if [ "$g1" != "$g2" ]; then
    fs_err "the two bots resolved DIFFERENT guilds ($g1 vs $g2) — both must be invited into the SAME server"
    return 1
  fi
  FS_GUILD_ID="$g1"
  fs_env_upsert DISCORD_GUILD_ID "$FS_GUILD_ID"
  setup_mark_done bots "$(jq -nc --arg p "$path" --arg g "$FS_GUILD_ID" \
    --argjson cos "$cos_res" --argjson eng "$eng_res" \
    '{path:$p, guildId:$g, results:[$cos,$eng]}')"
}

# resume verification: both tokens + the guild id still present in .env.
step_verify_bots() {
  local envf="$FLYWHEEL_SETUP_STATE_DIR/.env"
  [ -f "$envf" ] || return 1
  grep -Eq "^${FS_COS_ENV}=.+" "$envf" && grep -Eq "^${FS_ENG_ENV}=.+" "$envf" \
    && grep -Eq "^DISCORD_GUILD_ID=.+" "$envf"
}

step_hydrate_bots() {
  FS_GUILD_ID="$(setup_step_evidence bots | jq -r '.guildId // empty')"
  [ -n "$FS_GUILD_ID" ]
}

# ═══════════════════════════════════════════════════════════════════════════
# WI-D · Discord [AUTO]: channels find-or-create (403 → guided fallback),
#        per-bot read+post+delete probes, founder-ID acquisition
# ═══════════════════════════════════════════════════════════════════════════

# fs_env_get <KEY> — read a value back from the live .env (e.g. a bot token
# persisted by step 4). Kept in memory only.
fs_env_get() {
  local envf="$FLYWHEEL_SETUP_STATE_DIR/.env"
  [ -f "$envf" ] || return 1
  local v
  v="$(grep -E "^(export[[:space:]]+)?$1=" "$envf" | tail -1 | sed -E "s/^(export[[:space:]]+)?$1=//")"
  [ -n "$v" ] || return 1
  printf '%s' "$v"
}

# _fs_find_channel <channels-json> <name> — channel id by exact name, empty if none.
_fs_find_channel() {
  jq -r --arg n "$2" '[.[] | select(.name == $n and .type == 0)][0].id // empty' <<<"$1"
}

# _fs_channel_probe <token> <channel-id> <who> — prove the bot can READ
# history and POST in its channel (the runtime's two load-bearing needs).
# The probe message is deleted right after (best-effort — a failed delete
# only leaves one visible setup line, not a failed setup).
_fs_channel_probe() {
  local token="$1" chan="$2" who="$3" msg mid
  fs_discord_api GET "/channels/$chan/messages?limit=1" "$token" >/dev/null \
    || { fs_err "$who bot cannot READ message history in channel $chan"; return 1; }
  msg="$(fs_discord_api POST "/channels/$chan/messages" "$token" \
    '{"content":"flywheel-setup probe — safe to ignore (auto-deleted)"}')" \
    || { fs_err "$who bot cannot POST in channel $chan"; return 1; }
  mid="$(jq -r '.id // empty' <<<"$msg")"
  [ -n "$mid" ] && fs_discord_api DELETE "/channels/$chan/messages/$mid" "$token" >/dev/null 2>&1
  return 0
}

# step: channels — find-or-create #cos-chat/#eng-chat/#general with the CoS
# bot (MANAGE_CHANNELS is in the invite permission set); a 403 on create
# switches IN-STEP to the guided path (the user creates the channels in the
# Discord UI, we re-list and verify). Then probe each bot on its channel and
# acquire the founder's user ID (paste primary; bot-reads-a-message fallback).
step_run_channels() {
  local cos_token eng_token
  cos_token="$(fs_env_get "$FS_COS_ENV")" || { fs_err "no $FS_COS_ENV in .env (bots step incomplete?)"; return 1; }
  eng_token="$(fs_env_get "$FS_ENG_ENV")" || { fs_err "no $FS_ENG_ENV in .env (bots step incomplete?)"; return 1; }
  [ -n "${FS_GUILD_ID:-}" ] || { fs_err "no guild id (bots step incomplete?)"; return 1; }

  local channels name id created_403=0
  channels="$(fs_discord_api GET "/guilds/$FS_GUILD_ID/channels" "$cos_token")" \
    || { fs_err "cannot list channels in guild $FS_GUILD_ID"; return 1; }
  local -a wanted=(cos-chat eng-chat general)
  for name in "${wanted[@]}"; do
    id="$(_fs_find_channel "$channels" "$name")"
    if [ -z "$id" ]; then
      local resp rc
      resp="$(fs_discord_api POST "/guilds/$FS_GUILD_ID/channels" "$cos_token" \
        "$(jq -nc --arg n "$name" '{name:$n, type:0}')")"
      rc=$?
      if [ "$rc" -eq 3 ]; then created_403=1; break
      elif [ "$rc" -ne 0 ]; then fs_err "creating #$name failed"; return 1
      fi
    fi
  done
  if [ "$created_403" -eq 1 ]; then
    # Guided fallback: the bot lacks MANAGE_CHANNELS here (e.g. invited with an
    # older/narrower permission set). The user creates the channels manually;
    # we re-list and VERIFY — never proceed unverified.
    fs_log "the bot is not allowed to create channels in your server (403)." >&2
    fs_log "Please create these text channels yourself in the Discord UI:" >&2
    fs_log "   #cos-chat   #eng-chat   #general" >&2
    fs_ask_value "CHANNELS_CREATED_MANUALLY" "Press Enter once the three channels exist (y)" >/dev/null || return 1
    channels="$(fs_discord_api GET "/guilds/$FS_GUILD_ID/channels" "$cos_token")" || return 1
  else
    # refresh the list so created channels are visible.
    channels="$(fs_discord_api GET "/guilds/$FS_GUILD_ID/channels" "$cos_token")" || return 1
  fi
  FS_CHANNEL_COS="$(_fs_find_channel "$channels" cos-chat)"
  FS_CHANNEL_ENG="$(_fs_find_channel "$channels" eng-chat)"
  FS_CHANNEL_GENERAL="$(_fs_find_channel "$channels" general)"
  for name in COS ENG GENERAL; do
    local var="FS_CHANNEL_$name"
    [ -n "${!var}" ] || { fs_err "channel for $name still missing after create/fallback"; return 1; }
  done

  # per-bot probes on their assigned channels (read history + post; probe
  # message auto-deleted).
  _fs_channel_probe "$cos_token" "$FS_CHANNEL_COS" "CoS" || return 1
  _fs_channel_probe "$eng_token" "$FS_CHANNEL_ENG" "eng" || return 1

  # founder user ID — paste primary; 'read' (or empty) = fallback where the
  # founder posts any message in #general and the bot reads the author.
  local fid
  fid="$(fs_ask_value "FOUNDER_USER_ID" "Your own Discord user ID (Developer Mode → right-click your name → Copy User ID; type 'read' to let the bot read it from a #general message instead)")" || return 1
  if [ -z "$fid" ] || [ "$fid" = "read" ]; then
    fs_log "Post any message in #general now (as YOURSELF, not a bot)." >&2
    fs_ask_value "FOUNDER_MESSAGE_POSTED" "Press Enter once posted (y)" >/dev/null || return 1
    local msgs
    msgs="$(fs_discord_api GET "/channels/$FS_CHANNEL_GENERAL/messages?limit=1" "$cos_token")" || return 1
    fid="$(jq -r '[.[] | select(.author.bot != true)][0].author.id // empty' <<<"$msgs")"
    [ -n "$fid" ] || { fs_err "no non-bot message found in #general — post one and re-run"; return 1; }
  else
    fs_discord_api GET "/users/$fid" "$cos_token" >/dev/null \
      || { fs_err "user id $fid did not validate against Discord"; return 1; }
  fi
  FS_FOUNDER_ID="$fid"
  fs_env_upsert DISCORD_OWNER_USER_ID "$FS_FOUNDER_ID"

  setup_mark_done channels "$(jq -nc \
    --arg cos "$FS_CHANNEL_COS" --arg eng "$FS_CHANNEL_ENG" --arg gen "$FS_CHANNEL_GENERAL" \
    --arg fid "$FS_FOUNDER_ID" \
    '{channels:{cos:$cos, eng:$eng, general:$gen}, probes:"read+post+delete (both bots)", founderId:$fid}')"
}

step_verify_channels() {
  local ev
  ev="$(setup_step_evidence channels)"
  [ -n "$(jq -r '.channels.cos // empty' <<<"$ev")" ] \
    && [ -n "$(jq -r '.founderId // empty' <<<"$ev")" ] \
    && grep -Eq '^DISCORD_OWNER_USER_ID=.+' "$FLYWHEEL_SETUP_STATE_DIR/.env" 2>/dev/null
}

step_hydrate_channels() {
  local ev
  ev="$(setup_step_evidence channels)"
  FS_CHANNEL_COS="$(jq -r '.channels.cos // empty' <<<"$ev")"
  FS_CHANNEL_ENG="$(jq -r '.channels.eng // empty' <<<"$ev")"
  FS_CHANNEL_GENERAL="$(jq -r '.channels.general // empty' <<<"$ev")"
  FS_FOUNDER_ID="$(jq -r '.founderId // empty' <<<"$ev")"
  [ -n "$FS_CHANNEL_COS" ] && [ -n "$FS_CHANNEL_ENG" ] \
    && [ -n "$FS_CHANNEL_GENERAL" ] && [ -n "$FS_FOUNDER_ID" ]
}

# ═══════════════════════════════════════════════════════════════════════════
# WI-E · Linear: key validation → team/label/project find-or-create with
#        explicit-consent reuse + permission-denied guided fallback (a–e)
# ═══════════════════════════════════════════════════════════════════════════

FS_LINEAR_API="https://api.linear.app/graphql"

# fs_linear_api <graphql-body-json> <api-key> — Linear GraphQL call; the key
# travels via the curl config on stdin (personal API keys go RAW in the
# Authorization header). Prints the body.
# Returns: 0 = ok · 3 = permission-denied (guided-fallback signal) · 1 = other.
fs_linear_api() {
  local body="$1" key="$2" out http resp
  out="$(printf 'header = "Authorization: %s"\nheader = "Content-Type: application/json"\n' "$key" \
    | curl -sS -K - -X POST -d "$body" -w '\n%{http_code}' "$FS_LINEAR_API" 2>/dev/null)"
  http="$(printf '%s' "$out" | tail -1)"
  resp="$(printf '%s\n' "$out" | sed '$d')"
  printf '%s\n' "$resp"
  case "$http" in
    2??) ;;
    *) fs_err "Linear API → HTTP ${http:-?}"; return 1 ;;
  esac
  # GraphQL errors ride HTTP 200 — classify permission-ish ones for fallback.
  if jq -e '.errors and (.errors | length > 0)' >/dev/null 2>&1 <<<"$resp"; then
    if jq -e '[.errors[].message] | any(test("permission|forbidden|not allowed|access"; "i"))' >/dev/null 2>&1 <<<"$resp"; then
      return 3
    fi
    fs_err "Linear API error: $(jq -r '[.errors[].message] | join("; ")' <<<"$resp" 2>/dev/null)"
    return 1
  fi
  return 0
}

# step: linear — substeps (R1#2), each independently resumable within the
# step because every lookup is a find-first:
#   (a) API key: hidden input (reused from .env on re-entry) + viewer check →
#       LINEAR_API_KEY + LINEAR_WORKSPACE_SLUG persisted
#   (b) team find-or-create by key; an EXISTING team is only adopted with the
#       user's explicit consent; create permission-denied → guided UI path
#   (c) routing label + project find-or-create on that team
#   (e) runtime-consumed values written: config.yaml linear.team_id here;
#       the projects.json linear binding lands at the config step (validated
#       there by the real loader)
step_run_linear() {
  # (a) credentials
  local key
  key="$(fs_env_get LINEAR_API_KEY 2>/dev/null || true)"
  if [ -z "$key" ]; then
    fs_log "Linear: Settings → Security & access → Personal API keys → New key" >&2
    key="$(fs_ask_secret "LINEAR_API_KEY_INPUT" "Paste your Linear personal API key")" || return 1
  fi
  local viewer slug
  viewer="$(fs_linear_api '{"query":"{ viewer { id name } organization { urlKey name } }"}' "$key")" \
    || { fs_err "Linear API key failed validation"; return 1; }
  slug="$(jq -r '.data.organization.urlKey // empty' <<<"$viewer")"
  [ -n "$slug" ] || { fs_err "could not read the workspace from Linear"; return 1; }
  FS_LINEAR_WORKSPACE_SLUG="$slug"
  fs_env_upsert LINEAR_API_KEY "$key"
  fs_env_upsert LINEAR_WORKSPACE_SLUG "$slug"

  # (b) team find-or-create by key
  if [ -z "${FS_LINEAR_TEAM:-}" ] || [ "$FS_LINEAR_TEAM" = "__FILL_LINEAR_TEAM_KEY__" ]; then
    FS_LINEAR_TEAM="$(fs_ask_value "LINEAR_TEAM_KEY" "Linear team key to use (e.g. HUS — short, UPPERCASE)")" || return 1
  fi
  printf '%s' "$FS_LINEAR_TEAM" | grep -Eq '^[A-Z][A-Z0-9]*$' \
    || { fs_err "team key \"$FS_LINEAR_TEAM\" must match ^[A-Z][A-Z0-9]*\$"; return 1; }
  local teams team_id team_name
  _fs_linear_find_team() {
    teams="$(fs_linear_api '{"query":"{ teams { nodes { id key name } } }"}' "$key")" || return 1
    team_id="$(jq -r --arg k "$FS_LINEAR_TEAM" '.data.teams.nodes[] | select(.key == $k) | .id' <<<"$teams" | head -1)"
    team_name="$(jq -r --arg k "$FS_LINEAR_TEAM" '.data.teams.nodes[] | select(.key == $k) | .name' <<<"$teams" | head -1)"
    return 0
  }
  _fs_linear_find_team || return 1
  if [ -n "$team_id" ]; then
    # never silently adopt an existing team — it may belong to other work.
    local use
    use="$(fs_ask_value "LINEAR_USE_EXISTING_TEAM" "Team '$team_name' (key $FS_LINEAR_TEAM) already exists — use it for this Flywheel instance? (y/n)")" || return 1
    case "$use" in
      y|Y|yes) ;;
      *) fs_err "declined to reuse team $FS_LINEAR_TEAM — pick a different key (--linear-team) and re-run"; return 1 ;;
    esac
  else
    local created rc
    created="$(fs_linear_api "$(jq -nc --arg n "$FS_PROJECT" --arg k "$FS_LINEAR_TEAM" \
      '{query:"mutation TeamCreate($input: TeamCreateInput!) { teamCreate(input: $input) { success team { id key name } } }", variables:{input:{name:$n, key:$k}}}')" "$key")"
    rc=$?
    if [ "$rc" -eq 3 ]; then
      # guided fallback: the key cannot create teams — the user does it in the UI.
      fs_log "your Linear key is not allowed to create teams (permission denied)." >&2
      fs_log "Please create the team yourself in the Linear UI:" >&2
      fs_log "   Workspace settings → Teams → Add team → name it and set its key to '$FS_LINEAR_TEAM'" >&2
      fs_ask_value "LINEAR_TEAM_CREATED_MANUALLY" "Press Enter once the team exists (y)" >/dev/null || return 1
      _fs_linear_find_team || return 1
      [ -n "$team_id" ] || { fs_err "team with key $FS_LINEAR_TEAM still not found — create it, then re-run"; return 1; }
    elif [ "$rc" -ne 0 ]; then
      return 1
    else
      team_id="$(jq -r '.data.teamCreate.team.id // empty' <<<"$created")"
      [ -n "$team_id" ] || { fs_err "teamCreate returned no team"; return 1; }
    fi
  fi

  # (c) routing label find-or-create on the team (stable name = project label)
  local labels label_id resp rc
  labels="$(fs_linear_api "$(jq -nc --arg t "$team_id" \
    '{query:"query Labels($teamId: String!) { issueLabels(filter: { team: { id: { eq: $teamId } } }) { nodes { id name } } }", variables:{teamId:$t}}')" "$key")" || return 1
  label_id="$(jq -r --arg n "$FS_PROJECT_LABEL" '.data.issueLabels.nodes[] | select(.name == $n) | .id' <<<"$labels" | head -1)"
  if [ -z "$label_id" ]; then
    resp="$(fs_linear_api "$(jq -nc --arg t "$team_id" --arg n "$FS_PROJECT_LABEL" \
      '{query:"mutation LabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }", variables:{input:{teamId:$t, name:$n}}}')" "$key")"
    rc=$?
    if [ "$rc" -eq 3 ]; then
      fs_log "cannot create labels — create a label named '$FS_PROJECT_LABEL' on the team in the Linear UI." >&2
      fs_ask_value "LINEAR_LABEL_CREATED_MANUALLY" "Press Enter once the label exists (y)" >/dev/null || return 1
      labels="$(fs_linear_api "$(jq -nc --arg t "$team_id" \
        '{query:"query Labels($teamId: String!) { issueLabels(filter: { team: { id: { eq: $teamId } } }) { nodes { id name } } }", variables:{teamId:$t}}')" "$key")" || return 1
      label_id="$(jq -r --arg n "$FS_PROJECT_LABEL" '.data.issueLabels.nodes[] | select(.name == $n) | .id' <<<"$labels" | head -1)"
      [ -n "$label_id" ] || { fs_err "label '$FS_PROJECT_LABEL' still not found"; return 1; }
    elif [ "$rc" -ne 0 ]; then
      return 1
    else
      label_id="$(jq -r '.data.issueLabelCreate.issueLabel.id // empty' <<<"$resp")"
    fi
  fi

  # (c) project find-or-create
  local projects project_id
  projects="$(fs_linear_api '{"query":"{ projects { nodes { id name } } }"}' "$key")" || return 1
  project_id="$(jq -r --arg n "$FS_PROJECT" '.data.projects.nodes[] | select(.name == $n) | .id' <<<"$projects" | head -1)"
  if [ -z "$project_id" ]; then
    resp="$(fs_linear_api "$(jq -nc --arg t "$team_id" --arg n "$FS_PROJECT" \
      '{query:"mutation ProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name } } }", variables:{input:{name:$n, teamIds:[$t]}}}')" "$key")"
    rc=$?
    if [ "$rc" -eq 3 ]; then
      fs_log "cannot create projects — create a project named '$FS_PROJECT' in the Linear UI." >&2
      fs_ask_value "LINEAR_PROJECT_CREATED_MANUALLY" "Press Enter once the project exists (y)" >/dev/null || return 1
      projects="$(fs_linear_api '{"query":"{ projects { nodes { id name } } }"}' "$key")" || return 1
      project_id="$(jq -r --arg n "$FS_PROJECT" '.data.projects.nodes[] | select(.name == $n) | .id' <<<"$projects" | head -1)"
      [ -n "$project_id" ] || { fs_err "project '$FS_PROJECT' still not found"; return 1; }
    elif [ "$rc" -ne 0 ]; then
      return 1
    else
      project_id="$(jq -r '.data.projectCreate.project.id // empty' <<<"$resp")"
    fi
  fi

  # (e) write the runtime-consumed team key into the skeleton config.yaml
  # (the projects.json linear binding is written + loader-validated at the
  # config step). Idempotent in-place replace of the scaffolded value.
  local cfg="$FS_PROJECT_ROOT/.flywheel/config.yaml"
  if [ -f "$cfg" ]; then
    local tmp="$cfg.tmp.$$"
    if ! { sed -E "s/^([[:space:]]*team_id:).*/\1 $FS_LINEAR_TEAM/" "$cfg" > "$tmp" && mv "$tmp" "$cfg"; }; then
      rm -f "$tmp"; fs_err "failed updating $cfg"; return 1
    fi
  else
    fs_log "no $cfg (skeleton step skipped?) — team_id not stamped" >&2
  fi

  setup_mark_done linear "$(jq -nc \
    --arg slug "$FS_LINEAR_WORKSPACE_SLUG" --arg tid "$team_id" --arg tkey "$FS_LINEAR_TEAM" \
    --arg pid "$project_id" --arg lid "$label_id" --arg lname "$FS_PROJECT_LABEL" \
    '{workspaceSlug:$slug, teamId:$tid, teamKey:$tkey, projectId:$pid, labelId:$lid, labelName:$lname}')"
}

step_verify_linear() {
  grep -Eq '^LINEAR_API_KEY=.+' "$FLYWHEEL_SETUP_STATE_DIR/.env" 2>/dev/null \
    && grep -Eq '^LINEAR_WORKSPACE_SLUG=.+' "$FLYWHEEL_SETUP_STATE_DIR/.env" 2>/dev/null \
    && [ -n "$(setup_step_evidence linear | jq -r '.teamId // empty')" ]
}

step_hydrate_linear() {
  local ev
  ev="$(setup_step_evidence linear)"
  FS_LINEAR_TEAM="$(jq -r '.teamKey // empty' <<<"$ev")"
  FS_LINEAR_WORKSPACE_SLUG="$(jq -r '.workspaceSlug // empty' <<<"$ev")"
  [ -n "$FS_LINEAR_TEAM" ] && [ -n "$FS_LINEAR_WORKSPACE_SLUG" ]
}

# ═══════════════════════════════════════════════════════════════════════════
# WI-F · remaining steps (preflight / skeleton / model_key / config /
#        services / finish / digest) — the FLY-650 supply chain is called as
#        SUBPROCESSES with zero behavior change; darwin/linux divergence
#        lives entirely inside those seams (no launchd literals here, §3.5)
# ═══════════════════════════════════════════════════════════════════════════

# _fs_provision <args...> — the unchanged provisioner against the wizard's
# internal staging artifact. FLY-954: the provisioner (a WRITER) now IGNORES
# an inherited FLYWHEEL_STATE_DIR — the state root goes in explicitly via
# --state-dir (same state root the wizard's .env/journal live in; R1#7
# "consistent HOME/--home/state-dir"). The env PIN is kept as documentation
# of intent but no longer carries the value.
_fs_provision() {
  FLYWHEEL_STATE_DIR="$FLYWHEEL_SETUP_STATE_DIR" \
    bash "$FS_SCRIPT_DIR/provision-fleet-host.sh" \
    --fleet-dir "$FS_FLEET_DIR" --home "$HOME" --repo-root "$FS_REPO_ROOT" \
    --state-dir "$FLYWHEEL_SETUP_STATE_DIR" "$@"
}

# step: preflight — dependencies FIRST, then the hard gate.
# The deps phase (provisioner, platform-keyed brew/apt/dnf/present-check)
# runs BEFORE linux-preflight.sh --check: --check counts a missing required
# command as a hard blocker, so gating first would dead-end a clean host on
# exactly the tools the deps phase is about to install (Codex R1 HIGH; the
# plan's contract is "installed and STILL missing" — 装后仍缺). Present-check
# deps (node/pnpm via nvm/corepack) are the user's prerequisite per runbook
# §F.2 and correctly still hard-block.
step_run_preflight() {
  command -v jq >/dev/null 2>&1 || { fs_err "jq is required to run flywheel-setup"; return 1; }
  # staging manifest must exist for the deps phase (regenerated; values may
  # still be internal placeholders at this point — that is fine pre-config).
  fs_generate_fleet_artifact "$FS_FLEET_DIR" 0 || return 1
  local platform
  platform="${FLYWHEEL_PLATFORM:-}"
  if [ -z "$platform" ]; then
    case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) platform=unknown ;; esac
  fi
  _fs_provision --apply --skip-token-check --only deps \
    || { fs_err "dependency installation failed"; return 1; }
  if [ "$platform" = "linux" ]; then
    bash "$FS_SCRIPT_DIR/linux-preflight.sh" --check \
      || { fs_err "linux preflight found hard blockers AFTER dependency install (see the report above)"; return 1; }
  fi
  setup_mark_done preflight "$(jq -nc --arg p "$platform" '{platform:$p, deps:"provision deps phase", gate:"linux-preflight --check after deps"}')"
}

step_verify_preflight() { command -v jq >/dev/null 2>&1 && command -v git >/dev/null 2>&1; }

# step: skeleton — the user-project repo (setup-new-project.sh, local git
# only — NO GitHub create/push, boundary table A/B#1-2), with the FLY-648
# lead-id overrides so .lead/<id>/ matches the runtime agentIds (R1#3).
step_run_skeleton() {
  [ -x "$FS_SCRIPT_DIR/setup-new-project.sh" ] || { fs_err "setup-new-project.sh missing"; return 1; }
  "$FS_SCRIPT_DIR/setup-new-project.sh" "$FS_PROJECT" "$FS_DEPT" \
    --target "$FS_PROJECT_ROOT" --team "${FS_LINEAR_TEAM:-__FILL_LINEAR_TEAM_KEY__}" \
    --two-layer --cos-id "$FS_COS_ID" --dept-id "$FS_ENG_ID" \
    --cos-persona "$FS_COS_PERSONA" --dept-persona "$FS_ENG_PERSONA" >&2 \
    || { fs_err "project skeleton failed"; return 1; }
  [ -f "$FS_PROJECT_ROOT/.lead/$FS_COS_ID/identity.md" ] \
    && [ -f "$FS_PROJECT_ROOT/.lead/$FS_ENG_ID/identity.md" ] \
    || { fs_err "skeleton identity dirs missing"; return 1; }
  setup_mark_done skeleton "$(jq -nc --arg t "$FS_PROJECT_ROOT" --arg c "$FS_COS_ID" --arg e "$FS_ENG_ID" \
    '{target:$t, cosId:$c, engId:$e}')"
}

step_verify_skeleton() {
  [ -f "$FS_PROJECT_ROOT/.lead/$FS_COS_ID/identity.md" ] \
    && [ -f "$FS_PROJECT_ROOT/.lead/$FS_ENG_ID/identity.md" ]
}

# step: model_key [GUIDED] — Claude Code login with the instance owner's OWN
# subscription (a CLI login, not an env key). The API-key path is explicit
# opt-in; that key is appended to the LIVE .env only (never env.example —
# it would trip the token gate as a required key, §3.4).
#
# FLY-1023 M1 (opt-in, default byte-identical): under
# FLYWHEEL_AGENT_CLI_ORCHESTRATE=1 the guided confirmation upgrades to full
# AgentCliProvider orchestration (detect → install → login_guide → smoke)
# driven by the buddy layer; evidence records {provider, version} — never a
# key. Without the env var the original guided body runs unchanged.
_fs_model_key_orchestrated() {
  local pid="${FLYWHEEL_AGENT_CLI:-claude}"
  local mod="$FS_SCRIPT_DIR/lib/agent-cli-providers/${pid}.sh"
  [ -f "$mod" ] || { fs_err "unknown agent CLI provider '$pid' (no $mod)"; return 1; }
  # shellcheck disable=SC1090
  source "$mod" || { fs_err "provider module failed to load: $mod"; return 1; }
  local det ver rc
  if ! det="$(provider_detect)"; then
    fs_log "agent CLI '$pid' not found — installing" >&2
    det="$(provider_install)"
    rc=$?
    [ "$rc" -eq 0 ] || { fs_err "provider install did not complete: $det"; return "$rc"; }
  fi
  ver="$(jq -r '.version // "unknown"' <<<"$det" 2>/dev/null)"
  provider_login_guide >/dev/null || { fs_err "agent CLI login did not complete"; return 3; }
  # a stale CLI state dir can pass the login heuristic while the real auth is
  # broken — a failed smoke gets ONE repair pass (re-drives the login flow)
  # before this step fails (Codex R1#5).
  if ! provider_smoke >/dev/null; then
    fs_log "agent CLI smoke call failed — attempting login repair" >&2
    provider_repair >/dev/null \
      || { fs_err "agent CLI smoke call failed and the login repair did not recover it"; return 1; }
  fi
  setup_mark_done model_key "$(jq -nc --arg p "$pid" --arg v "$ver" \
    '{mode:"agent-cli", provider:$p, version:$v}')"
}

step_run_model_key() {
  if [ "${FLYWHEEL_AGENT_CLI_ORCHESTRATE:-0}" = "1" ]; then
    _fs_model_key_orchestrated
    return $?
  fi
  fs_log "── Model access ──" >&2
  fs_log "Flywheel Leads/Runners use Claude Code. Log in with YOUR subscription:" >&2
  fs_log "   run: claude   (first run opens the login flow; on WSL2 run it INSIDE the WSL shell)" >&2
  local mode
  mode="$(fs_ask_value "MODEL_AUTH_MODE" "Model auth: 'login' = Claude CLI login done (default) / 'api-key' = use an Anthropic API key")" || return 1
  case "$mode" in
    api-key)
      local akey
      akey="$(fs_ask_secret "ANTHROPIC_API_KEY_INPUT" "Anthropic API key")" || return 1
      fs_env_upsert ANTHROPIC_API_KEY "$akey"
      setup_mark_done model_key '{"mode":"api-key"}'
      ;;
    *)
      if command -v claude >/dev/null 2>&1 && [ -d "$HOME/.claude" ]; then
        fs_log "claude CLI + ~/.claude present — login looks done" >&2
      else
        fs_ask_value "CLAUDE_LOGIN_CONFIRMED" "Press Enter once 'claude' login is complete (y)" >/dev/null || return 1
      fi
      setup_mark_done model_key '{"mode":"claude-login"}'
      ;;
  esac
}

# step: config — the COMPLETE staging artifact (every collected value, gated
# by the real loader + secret scan), then the unchanged provisioner lands it:
# flywheel-home (projects.json/host.json/bin) + tokens (the ORIGINAL token
# gate — .env written by earlier steps must satisfy env.example, no skip).
step_run_config() {
  fs_generate_fleet_artifact "$FS_FLEET_DIR" 1 || return 1
  # the wizard owns this state root (guard at engine start); --force lets a
  # RE-run refresh our own previously-landed projects.json with new values.
  local force=""
  [ -f "$FLYWHEEL_SETUP_STATE_DIR/projects.json" ] && force="--force"
  _fs_provision --apply --skip-token-check --only flywheel-home $force \
    || { fs_err "provision flywheel-home failed"; return 1; }
  _fs_provision --apply --only tokens \
    || { fs_err "token gate failed — a required secret is missing from $FLYWHEEL_SETUP_STATE_DIR/.env"; return 1; }
  setup_mark_done config "$(jq -nc --arg a "$FS_FLEET_DIR" '{artifact:$a, loader:"parseAndValidateProjects", tokenGate:"passed"}')"
}

step_verify_config() {
  [ -f "$FLYWHEEL_SETUP_STATE_DIR/projects.json" ] \
    && fs_validate_projects "$FLYWHEEL_SETUP_STATE_DIR/projects.json" >/dev/null 2>&1
}

# step: services — the provisioner's supervisor phase (token gate enforced
# again inside it): linux = linger + materialize manifests + systemd units
# via the supervisor seam; darwin = narrated operator bring-up (the FLY-650
# decision — launchd activation is operator-run, see runbook §B).
step_run_services() {
  _fs_provision --apply --only launchd \
    || { fs_err "service bring-up failed"; return 1; }
  local backend="${FLYWHEEL_SUPERVISOR_BACKEND:-}"
  [ -n "$backend" ] || case "$(uname -s)" in Darwin) backend=launchd ;; Linux) backend=systemd-user ;; esac
  setup_mark_done services "$(jq -nc --arg b "$backend" '{supervisor:$b}')"
}

step_verify_services() {
  [ -f "$FLYWHEEL_SETUP_STATE_DIR/manifests/${FS_PROJECT}-${FS_COS_ID}.json" ]
}

# step: finish — Bridge health + the Aha handoff (copy stub; final wording is
# the upper product layer's).
step_run_finish() {
  local url="${FLYWHEEL_BRIDGE_URL:-http://127.0.0.1:9876}"
  local tries="${FLYWHEEL_SETUP_HEALTH_TRIES:-12}" i ok=0
  for (( i=1; i<=tries; i++ )); do
    if curl -fsS -m 5 "$url/api/runs/active" >/dev/null 2>&1; then ok=1; break; fi
    sleep "${FLYWHEEL_SETUP_HEALTH_SLEEP:-5}"
  done
  if [ "$ok" -ne 1 ]; then
    fs_err "Bridge not answering at $url/api/runs/active."
    fs_err "linux: systemctl --user status flywheel-bridge.service; darwin: bring services up per runbook §B, then re-run flywheel-setup.sh (it resumes here)."
    return 1
  fi
  setup_mark_done finish "$(jq -nc --arg u "$url" '{bridge:$u, health:"2xx"}')"
  cat >&2 <<AHA

[flywheel-setup] 🎁 你的 Flywheel 装好了。
[flywheel-setup]    打开 Discord,到 #cos-chat 跟你的经理($FS_COS_PERSONA)打个招呼 —
[flywheel-setup]    从现在起,活儿在 Discord 里派、在 Discord 里批。
AHA
}

# step: digest — the FLY-727 deploy-report hook is already scaffolded into
# the project skeleton; wiring it into the project's deploy point is a
# per-project cutover step. Informational; skippable via --no-digest.
step_run_digest() {
  if [ "${FLYWHEEL_SETUP_NO_DIGEST:-0}" = "1" ]; then
    setup_mark_done digest '{"enabled":false}'
    return 0
  fi
  fs_log "daily-digest hook scaffolded at $FS_PROJECT_ROOT/.flywheel/hooks/report-deployment.sh — wire it into your deploy point when you have one" >&2
  setup_mark_done digest '{"enabled":true}'
}

# ═══════════════════════════════════════════════════════════════════════════
# main
# ═══════════════════════════════════════════════════════════════════════════

fs_usage() {
  cat <<EOF
Usage: flywheel-setup.sh [options]           # the one-command setup wizard

  --project <name>       project name        (^[a-z0-9][a-z0-9-]*\$; default: myproject)
  --department <slug>    department          (default: engineering)
  --cos-persona <name>   CoS display name    (default: Cos)
  --eng-persona <name>   eng lead display name (default: Eng)
  --linear-team <KEY>    Linear team key     (default: asked during the Linear step)
  --project-slug <o/r>   GitHub slug of the project repo (optional)
  --skills-repo <slug>   skills repo         (default: xrliAnnie/flywheel-skills)
  --bot-path <c1|c2>     Discord bot path: c1 = create your own (default) /
                         c2 = Flywheel pool invite (semi-managed)
  --state-dir <dir>      state root          (default: ~/.flywheel)
  --bridge-url <url>     Bridge health URL   (default: http://127.0.0.1:9876)
  --until <step>         stop after <step>   (staged runs / debugging)
  --no-digest            skip the digest hook step
  --status               print journal status and exit
  -h, --help             this help

Steps: preflight skeleton model_key bots channels linear config services finish digest
Re-running resumes from the first incomplete step (journal: <state-dir>/setup-state.json).
EOF
}

# _fs_bootstrap_jq — the wizard's OWN runtime dependency (journal/evidence
# jq ops) must exist BEFORE the engine or the deps phase can run — on a clean
# Ubuntu/WSL2 jq is absent, and waiting for the deps phase is a chicken-egg
# (Codex R2 HIGH). Install it directly via the platform package manager;
# no manager → fail-closed with the exact command to run.
_fs_bootstrap_jq() {
  command -v jq >/dev/null 2>&1 && return 0
  fs_log "jq (the wizard's own JSON tool) is missing — installing it first"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get install -y jq || fs_die "could not install jq — run: sudo apt-get install -y jq, then re-run"
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y jq || fs_die "could not install jq — run: sudo dnf install -y jq, then re-run"
  elif command -v brew >/dev/null 2>&1; then
    brew install jq || fs_die "could not install jq — run: brew install jq, then re-run"
  else
    fs_die "jq is required and no package manager was found — install jq, then re-run"
  fi
  command -v jq >/dev/null 2>&1 || fs_die "jq still missing after install — fix PATH, then re-run"
}

fs_main() {
  FS_PROJECT="myproject"; FS_DEPT="engineering"
  FS_COS_PERSONA="Cos"; FS_ENG_PERSONA="Eng"
  FS_LINEAR_TEAM=""; FS_PROJECT_SLUG=""
  FS_SKILLS_REPO="xrliAnnie/flywheel-skills"
  local until_step="" show_status=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project)      FS_PROJECT="${2:?}"; shift 2 ;;
      --department)   FS_DEPT="${2:?}"; shift 2 ;;
      --cos-persona)  FS_COS_PERSONA="${2:?}"; shift 2 ;;
      --eng-persona)  FS_ENG_PERSONA="${2:?}"; shift 2 ;;
      --linear-team)  FS_LINEAR_TEAM="${2:?}"; shift 2 ;;
      --project-slug) FS_PROJECT_SLUG="${2:?}"; shift 2 ;;
      --skills-repo)  FS_SKILLS_REPO="${2:?}"; shift 2 ;;
      --bot-path)     export FLYWHEEL_SETUP_BOT_PATH="${2:?}"; shift 2 ;;
      --state-dir)    FLYWHEEL_SETUP_STATE_DIR="${2:?}"; shift 2 ;;
      --bridge-url)   export FLYWHEEL_BRIDGE_URL="${2:?}"; shift 2 ;;
      --until)        until_step="${2:?}"; shift 2 ;;
      --no-digest)    export FLYWHEEL_SETUP_NO_DIGEST=1; shift ;;
      --status)       show_status=1; shift ;;
      -h|--help)      fs_usage; exit 0 ;;
      *) fs_err "unknown option: $1"; fs_usage >&2; exit 2 ;;
    esac
  done

  # jq bootstrap AFTER arg parsing (so --help works on a jq-less host) but
  # BEFORE anything that touches the journal/evidence machinery.
  _fs_bootstrap_jq
  fs_derive_identity
  [ -n "$FLYWHEEL_SETUP_STATE_DIR" ] || FLYWHEEL_SETUP_STATE_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
  FS_FLEET_DIR="$FLYWHEEL_SETUP_STATE_DIR/setup-fleet"

  # values collected by steps 4–6 start as INTERNAL placeholders (never
  # user-facing); complete-mode generation at the config step refuses residue.
  FS_GUILD_ID="${FS_GUILD_ID:-__FILL_DISCORD_GUILD_ID__}"
  FS_FOUNDER_ID="${FS_FOUNDER_ID:-__FILL_DISCORD_USER_ID_FOUNDER__}"
  FS_CHANNEL_GENERAL="${FS_CHANNEL_GENERAL:-__FILL_DISCORD_CHANNEL_ID_GENERAL__}"
  FS_CHANNEL_COS="${FS_CHANNEL_COS:-__FILL_DISCORD_CHANNEL_ID_COS__}"
  FS_CHANNEL_ENG="${FS_CHANNEL_ENG:-__FILL_DISCORD_CHANNEL_ID_ENG__}"

  if [ "$show_status" -eq 1 ]; then
    local sf="$FLYWHEEL_SETUP_STATE_DIR/setup-state.json"
    if [ -f "$sf" ]; then jq '{steps: (.steps | map_values(.status))}' "$sf"; else echo "no setup journal yet"; fi
    exit 0
  fi

  # wizard-level live-fleet guard (WI-H negative case): NEVER touch a state
  # root that already hosts a fleet we did not set up (a fresh journal +
  # populated projects.json with leads = someone else's live fleet).
  local pj="$FLYWHEEL_SETUP_STATE_DIR/projects.json"
  local sf="$FLYWHEEL_SETUP_STATE_DIR/setup-state.json"
  if [ -f "$pj" ] && [ ! -f "$sf" ]; then
    local nleads
    nleads="$(jq '[.[].leads[]?] | length' "$pj" 2>/dev/null || echo 0)"
    if [ "${nleads:-0}" -gt 0 ]; then
      fs_die "this machine already hosts a live fleet ($nleads leads in $pj) that flywheel-setup did not create — refusing to touch it. Use the migration path (runbook §A-§C) instead."
    fi
  fi

  # honest notices (boundary table F — copy stubs; wording is the upper layer's)
  cat >&2 <<'NOTICE'
[flywheel-setup] Before we start, four honest notes:
[flywheel-setup]   · Discord bot creation cannot be automated by API — I will guide you through it.
[flywheel-setup]   · Account sign-ups (Discord/Linear/GitHub/Claude) are yours to do — I hand you links.
[flywheel-setup]   · This machine should stay ON 24/7 to host your team.
[flywheel-setup]   · Model usage runs on YOUR subscription/keys and is your cost.
NOTICE

  STEP_IDS=(preflight skeleton model_key bots channels linear config services finish digest)
  if [ -n "$until_step" ]; then
    local -a upto=()
    local s
    for s in "${STEP_IDS[@]}"; do
      upto+=("$s")
      [ "$s" = "$until_step" ] && break
    done
    [ "${upto[${#upto[@]}-1]}" = "$until_step" ] || fs_die "--until: unknown step '$until_step'"
    STEP_IDS=("${upto[@]}")
  fi

  setup_main_loop
}

if [ -z "${FLYWHEEL_SETUP_SOURCED:-}" ]; then
  fs_main "$@"
fi
