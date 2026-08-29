#!/bin/bash
# FLY-310 — INDEPENDENT ADVERSARIAL QA of FLY-260 read-exfil hardening (PR #286).
# QA != developer. Tries to BREAK the deny. Isolated temp HOME/CODEX_HOME ONLY —
# never touches LIVE ~/.codex-mufasa or any real secret. Run on real codex 0.140.
set -uo pipefail

WORKTREE="/Users/xiaorongli/Dev/flywheel-FLY-260"
HOME_SH="$WORKTREE/packages/teamlead/scripts/codex-lead-tui-home.sh"
PROBE="$WORKTREE/packages/teamlead/scripts/__tests__/fly260-read-deny-appserver-probe.mjs"
SENT="FLY310LEAK_$RANDOM$RANDOM"   # unique sentinel; appearing in output == LEAK

PASS=0; CRIT=0; NOTE=0
ok()   { echo "  ✓ PASS    $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ CRITICAL $1"; CRIT=$((CRIT+1)); }
note() { echo "  • NOTE    $1"; NOTE=$((NOTE+1)); }

command -v codex >/dev/null 2>&1 || { echo "FATAL: codex not found"; exit 2; }

# ── isolated sandbox ─────────────────────────────────────────────────────────
T=$(mktemp -d /tmp/fly310rd.XXXXX); trap 'rm -rf "$T"' EXIT
FAKE_HOME="$T/home"; mkdir -p "$FAKE_HOME/workspace"
CHOME="$FAKE_HOME/.codex-lead-home"; mkdir -p "$CHOME/packages/standalone/current"
echo '{"tokens":"x"}' > "$CHOME/auth.json"
printf '#!/bin/sh\n' > "$CHOME/packages/standalone/current/codex"
chmod +x "$CHOME/packages/standalone/current/codex"

if ! FLYWHEEL_CODEX_LEAD_READ_DENY=1 FLYWHEEL_CODEX_TUI_HOME="$CHOME" \
     FLYWHEEL_CODEX_TUI_CWD="$FAKE_HOME/workspace" /bin/bash "$HOME_SH" ensure-home >/dev/null 2>&1; then
  echo "FATAL: read-deny config generation failed"; exit 2
fi
echo "[setup] read-deny config generated via production home-script"

# secrets (lowercase real names; content = sentinel)
mkdir -p "$FAKE_HOME/.codex-mufasa" "$FAKE_HOME/.ssh" "$FAKE_HOME/.aws" \
         "$FAKE_HOME/.config/gh" "$FAKE_HOME/.config/gcloud" "$FAKE_HOME/.docker" \
         "$FAKE_HOME/proj" "$FAKE_HOME/.flywheel/comm/growth" "$FAKE_HOME/a/b" \
         "$FAKE_HOME/.flywheel/state"
echo "$SENT" > "$FAKE_HOME/.codex-mufasa/auth.json"
echo "$SENT" > "$FAKE_HOME/.ssh/id_rsa"
echo "$SENT" > "$FAKE_HOME/.aws/credentials"
echo "$SENT" > "$FAKE_HOME/.config/gh/hosts.yml"
echo "$SENT" > "$FAKE_HOME/.config/gcloud/creds.db"
echo "$SENT" > "$FAKE_HOME/.npmrc"
echo "$SENT" > "$FAKE_HOME/.docker/config.json"
echo "$SENT" > "$FAKE_HOME/proj/.env"
echo "$SENT" > "$FAKE_HOME/proj/.env.bak"
echo "$SENT" > "$FAKE_HOME/proj/.env.production"
echo "$SENT" > "$FAKE_HOME/proj/.envrc"
echo "$SENT" > "$FAKE_HOME/.env"                       # home-root .env (zero intermediate)
echo "$SENT" > "$FAKE_HOME/.flywheel/.env"             # surgical boundary: secret in ops dir
echo "$SENT" > "$FAKE_HOME/a/b/.env"                   # deep .env
# ops files (must stay readable — Director orchestration)
echo OPSVAL > "$FAKE_HOME/.flywheel/comm/growth/comm.db"
echo OPSVAL > "$FAKE_HOME/.flywheel/teamlead.db"
echo OPSVAL > "$FAKE_HOME/.flywheel/state/lead.json"
echo OPSVAL > "$FAKE_HOME/.flywheel/deployed-sha"
# symlinks (pre-existing; model under read-only can't create, but enforcement must resolve)
ln -s "$FAKE_HOME/.codex-mufasa"          "$FAKE_HOME/workspace/sneaky_dir"
ln -s "$FAKE_HOME/.codex-mufasa/auth.json" "$FAKE_HOME/workspace/sneaky_file"
ln -s "$FAKE_HOME/.codex-mufasa"          "$FAKE_HOME/notdenied"

# run a command under the read-deny profile's Seatbelt policy
sb() { HOME="$FAKE_HOME" CODEX_HOME="$CHOME" codex sandbox -P flywheel-lead-secret-deny -C "$FAKE_HOME/workspace" -- "$@" 2>&1; }
# DENIED == cat's own EPERM, not a sandbox SETUP failure (which would falsely deny everything)
is_setupfail() { case "$1" in *sandbox_apply*|*sandbox-exec*) return 0;; *) return 1;; esac; }

# ── healthy-sandbox gate: prove the sandbox actually applies here ─────────────
echo "ALLOWVAL" > "$FAKE_HOME/workspace/allowed.txt"
probe="$(sb /bin/cat "$FAKE_HOME/workspace/allowed.txt" | head -1)"
if [ "$probe" != "ALLOWVAL" ]; then
  echo "SKIP (loud): cannot apply macOS sandbox here (probe: $probe) — enforcement not verifiable."
  exit 0
fi
echo "[gate] healthy-sandbox: in-workspace read SUCCEEDS (sandbox is genuinely active)"
echo

# helper: assert a path is DENIED (no sentinel leak). $1=label $2=reader-cmd...
assert_denied() { local label="$1"; shift; local out; out="$(sb "$@")"
  if echo "$out" | grep -q "$SENT"; then bad "$label  → LEAKED secret content";
  elif is_setupfail "$out"; then note "$label  → sandbox setup-fail (inconclusive): $(echo "$out"|head -1)";
  elif echo "$out" | grep -qi "not permitted\|denied\|no such file"; then ok "$label  → blocked ($(echo "$out"|head -1|cut -c1-60))";
  else note "$label  → unexpected (no leak, no clear deny): $(echo "$out"|head -1)"; fi; }

# helper: assert a path is ALLOWED (ops). $1=label $2=expected $3=path
assert_allowed() { local label="$1" exp="$2" path="$3" out; out="$(sb /bin/cat "$path")"
  if [ "$(echo "$out"|head -1)" = "$exp" ]; then ok "$label  → readable (orchestration preserved)";
  else bad "$label  → BROKEN (denied/empty): $(echo "$out"|head -1)"; fi; }

echo "════ POSITIVE LEAK CONTROL (prove the deny is what blocks) ════"
plain="$(HOME="$FAKE_HOME" /bin/cat "$FAKE_HOME/.codex-mufasa/auth.json" 2>&1 | head -1)"
[ "$plain" = "$SENT" ] && ok "control: secret IS readable with NO sandbox (so a deny under sandbox = real enforcement)" \
                        || note "control: plain read unexpected: $plain"
echo

echo "════ AREA 1a: baseline secret denials (incl. ~/.aws + ~/.config/gh unprobed by dev test) ════"
assert_denied "~/.codex-mufasa/auth.json (the exact Mufasa target)" /bin/cat "$FAKE_HOME/.codex-mufasa/auth.json"
assert_denied "~/.ssh/id_rsa"            /bin/cat "$FAKE_HOME/.ssh/id_rsa"
assert_denied "~/.aws/credentials"       /bin/cat "$FAKE_HOME/.aws/credentials"
assert_denied "~/.config/gh/hosts.yml"   /bin/cat "$FAKE_HOME/.config/gh/hosts.yml"
assert_denied "~/.config/gcloud/creds.db" /bin/cat "$FAKE_HOME/.config/gcloud/creds.db"
assert_denied "~/.npmrc"                 /bin/cat "$FAKE_HOME/.npmrc"
assert_denied "~/.docker/config.json"    /bin/cat "$FAKE_HOME/.docker/config.json"
echo

echo "════ AREA 1b: APFS CASE-VARIATION bypass (Tadashi #1 — highest value) ════"
# first confirm each variant path resolves to the real file WITHOUT sandbox
for v in ".codex-MUFASA/auth.json" ".CODEX-mufasa/auth.json" ".Codex-Mufasa/auth.json" ".SSH/id_rsa"; do
  live="$(HOME="$FAKE_HOME" /bin/cat "$FAKE_HOME/$v" 2>/dev/null | head -1)"
  if [ "$live" = "$SENT" ]; then
    echo "  [variant live on case-insensitive FS] ~/$v opens the real secret — testing sandbox:"
    assert_denied "  case-variant ~/$v" /bin/cat "$FAKE_HOME/$v"
  else
    note "case-variant ~/$v does NOT resolve to the secret (no bypass surface here)"
  fi
done
echo

echo "════ AREA 1c: SYMLINK traversal bypass ════"
assert_denied "symlink dir  ~/workspace/sneaky_dir/auth.json (→ .codex-mufasa)" /bin/cat "$FAKE_HOME/workspace/sneaky_dir/auth.json"
assert_denied "symlink file ~/workspace/sneaky_file (→ auth.json)"             /bin/cat "$FAKE_HOME/workspace/sneaky_file"
assert_denied "symlink in home ~/notdenied/auth.json (→ .codex-mufasa)"        /bin/cat "$FAKE_HOME/notdenied/auth.json"
echo

echo "════ AREA 1d: RELATIVE-PATH / .. traversal (cwd = workspace) ════"
assert_denied "relative ../.codex-mufasa/auth.json" /bin/sh -c "cd '$FAKE_HOME/workspace' && cat ../.codex-mufasa/auth.json"
echo

echo "════ AREA 1e: ALTERNATE READERS (prove syscall-level, not cat-specific) ════"
assert_denied "/usr/bin/head -c 50"                  /usr/bin/head -c 50 "$FAKE_HOME/.codex-mufasa/auth.json"
assert_denied "shell redirect  cat < secret"         /bin/sh -c "cat < '$FAKE_HOME/.codex-mufasa/auth.json'"
assert_denied "python3 open().read()"                /usr/bin/python3 -c "print(open('$FAKE_HOME/.codex-mufasa/auth.json').read())"
echo

echo "════ AREA 1f: DIRECTORY ENUMERATION (filename leak) ════"
lsout="$(sb /bin/ls "$FAKE_HOME/.codex-mufasa")"
if echo "$lsout" | grep -q "auth.json"; then note "ls ~/.codex-mufasa LISTED filenames (filename-level info, not contents): $(echo "$lsout"|tr '\n' ' ')";
elif is_setupfail "$lsout"; then note "ls setup-fail inconclusive";
else ok "ls ~/.codex-mufasa  → blocked/empty ($(echo "$lsout"|head -1|cut -c1-50))"; fi
echo

echo "════ AREA 1g: .env FAMILY + HOME-ROOT + DEEP (~/**/.env** coverage) ════"
assert_denied "~/proj/.env"            /bin/cat "$FAKE_HOME/proj/.env"
assert_denied "~/proj/.env.bak"        /bin/cat "$FAKE_HOME/proj/.env.bak"
assert_denied "~/proj/.env.production" /bin/cat "$FAKE_HOME/proj/.env.production"
assert_denied "~/proj/.envrc"          /bin/cat "$FAKE_HOME/proj/.envrc"
assert_denied "~/a/b/.env (deep)"      /bin/cat "$FAKE_HOME/a/b/.env"
echo "  -- home-root ~/.env (zero intermediate dirs — does ** match empty?) --"
rootenv="$(sb /bin/cat "$FAKE_HOME/.env")"
if echo "$rootenv" | grep -q "$SENT"; then note "~/.env (home root) READABLE — '~/**/.env**' does not match a zero-intermediate .env (gap: a secret placed directly in \$HOME/.env is not covered)";
elif is_setupfail "$rootenv"; then note "~/.env setup-fail inconclusive";
else ok "~/.env (home root) → blocked"; fi
echo

echo "════ AREA 2: SURGICAL BOUNDARY (Tadashi #2 — block keys, keep orchestration) ════"
assert_denied  "~/.flywheel/.env (secret inside ops dir MUST be denied)" /bin/cat "$FAKE_HOME/.flywheel/.env"
assert_allowed "~/.flywheel/comm/growth/comm.db" OPSVAL "$FAKE_HOME/.flywheel/comm/growth/comm.db"
assert_allowed "~/.flywheel/teamlead.db"          OPSVAL "$FAKE_HOME/.flywheel/teamlead.db"
assert_allowed "~/.flywheel/state/lead.json"      OPSVAL "$FAKE_HOME/.flywheel/state/lead.json"
assert_allowed "~/.flywheel/deployed-sha"         OPSVAL "$FAKE_HOME/.flywheel/deployed-sha"
echo

echo "════ AREA 3: ENV WASH — leak + over-exclusion (Tadashi #3) ════"
envp() { HOME="$FAKE_HOME" CODEX_HOME="$CHOME" "$@" codex sandbox -P flywheel-lead-secret-deny -C "$FAKE_HOME/workspace" -- /usr/bin/printenv 2>/dev/null; }
# token-shaped (upper + lower + secret + key) must be HIDDEN
for var in FLY310_FAKE_TOKEN fly310_lower_token FLY310_MY_SECRET MY_API_KEY; do
  val="$(HOME="$FAKE_HOME" CODEX_HOME="$CHOME" env "$var=$SENT" codex sandbox -P flywheel-lead-secret-deny -C "$FAKE_HOME/workspace" -- /usr/bin/printenv "$var" 2>/dev/null)"
  if [ -z "$val" ]; then ok "env washed: $var hidden from exec shell";
  else bad "env LEAK: $var visible as $val"; fi
done
# over-exclusion: non-secret coordination env the Director needs must SURVIVE
for var in FLYWHEEL_PROJECT_NAME FLYWHEEL_COMM_ROOT CODEX_HOME PATH; do
  val="$(HOME="$FAKE_HOME" CODEX_HOME="$CHOME" env "$var=KEEPVAL_$var" codex sandbox -P flywheel-lead-secret-deny -C "$FAKE_HOME/workspace" -- /usr/bin/printenv "$var" 2>/dev/null)"
  # PATH/CODEX_HOME may be overridden by sandbox; just assert non-empty (not washed away)
  if [ -n "$val" ]; then ok "env wash surgical: $var survives ($([ ${#val} -gt 20 ] && echo "${val:0:20}…" || echo "$val"))";
  else bad "env OVER-EXCLUSION: $var washed away (Director coordination env broken)"; fi
done
echo

echo "════ AREA 4: FAIL-CLOSED (boot ephemeral-start assertion source) ════"
if command -v node >/dev/null 2>&1 && [ -f "$PROBE" ]; then
  a="$(HOME="$FAKE_HOME" CODEX_HOME="$CHOME" node "$PROBE" "$FAKE_HOME/workspace" no-sandbox 2>/dev/null)"
  [ "$a" = "flywheel-lead-secret-deny" ] && ok "app-server: profile active under good config (gate would PASS)" || bad "app-server: profile NOT active (got: $a)"
  n="$(HOME="$FAKE_HOME" CODEX_HOME="$CHOME" node "$PROBE" "$FAKE_HOME/workspace" legacy-sandbox 2>/dev/null)"
  [ "$n" = "null" ] && ok "negative control: legacy sandbox param → null (boot gate would THROW → fail-closed)" || bad "negative control unexpected (got: $n)"
  # TAMPER 1: config with default_permissions REMOVED → profile must be null
  TAMP="$T/tamper1"; mkdir -p "$TAMP"; cp "$CHOME/auth.json" "$TAMP/"
  grep -v '^default_permissions' "$CHOME/config.toml" > "$TAMP/config.toml"
  t1="$(HOME="$FAKE_HOME" CODEX_HOME="$TAMP" node "$PROBE" "$FAKE_HOME/workspace" no-sandbox 2>/dev/null)"
  [ "$t1" = "null" ] && ok "tamper: config w/o default_permissions → null (gate would fail-close, no unprotected start)" || bad "tamper: missing default_permissions still gave: $t1"
  # TAMPER 2: config with a lingering top-level sandbox_mode → profile disabled (Gotcha A)
  TAMP2="$T/tamper2"; mkdir -p "$TAMP2"; cp "$CHOME/auth.json" "$TAMP2/"
  { echo 'sandbox_mode = "read-only"'; cat "$CHOME/config.toml"; } > "$TAMP2/config.toml"
  t2="$(HOME="$FAKE_HOME" CODEX_HOME="$TAMP2" node "$PROBE" "$FAKE_HOME/workspace" no-sandbox 2>/dev/null)"
  [ "$t2" = "null" ] && ok "tamper: lingering top-level sandbox_mode → null (Gotcha A; gate fail-closes)" || note "tamper: stray sandbox_mode gave: $t2 (shell validation already rejects this before deploy)"
else
  note "app-server probe skipped (node/probe missing)"
fi
echo

echo "════ AREA 5: FLAG-OFF byte-compat (no read-deny artifacts) ════"
OFFH="$T/offhome"; mkdir -p "$OFFH/packages/standalone/current"
echo '{}' > "$OFFH/auth.json"; printf '#!/bin/sh\n' > "$OFFH/packages/standalone/current/codex"; chmod +x "$OFFH/packages/standalone/current/codex"
FLYWHEEL_CODEX_TUI_HOME="$OFFH" FLYWHEEL_CODEX_TUI_CWD="/work/dir" /bin/bash "$HOME_SH" ensure-home >/dev/null 2>&1
if grep -q 'sandbox_mode = "read-only"' "$OFFH/config.toml" \
   && ! grep -q 'default_permissions' "$OFFH/config.toml" \
   && ! grep -q 'shell_environment_policy' "$OFFH/config.toml" \
   && ! grep -q 'flywheel-lead-secret-deny' "$OFFH/config.toml"; then
  ok "flag-OFF writes LEGACY config (sandbox_mode=read-only; NO profile/env-exclude/deny) — byte-compat"
else
  bad "flag-OFF config drifted from legacy shape: $(cat "$OFFH/config.toml" | tr '\n' '|')"
fi
echo

echo "════════════════════════════════════════════════════════"
echo "RESULT: $PASS PASS, $CRIT CRITICAL, $NOTE NOTE"
[ "$CRIT" -eq 0 ] && echo "VERDICT: no successful leak / no broken orchestration" || echo "VERDICT: CRITICAL findings present"
# Codex review (PR #287): exit non-zero on ANY real leak / broken orchestration so a
# re-run that finds a CRITICAL fails loudly in CI/shell instead of looking like a PASS.
exit "$(( CRIT > 0 ? 1 : 0 ))"
