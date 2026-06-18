#!/bin/bash
# FLY-260 — REAL-MACHINE read-deny enforcement test (committed, reproducible).
#
# Proves the read-deny hardening actually works at the kernel/Seatbelt level — NOT
# just that the config parses. Uses an ISOLATED temp HOME + CODEX_HOME (never touches
# the real ~/.flywheel or ~/.codex*), generates the config through the PRODUCTION
# wiring (the committed fragment via codex-lead-tui-home.sh ensure-home, read-deny
# mode), and then drives `codex sandbox` + a tiny app-server probe.
#
# What it asserts (the issue's "真机验证可行" + the COE Director scope constraint):
#   (a) secrets DENIED       — codex homes / .ssh / .npmrc / .docker / gcloud / .env*
#   (b) Director paths ALLOWED — ~/.flywheel/{teamlead.db,bin,state,comm,deployed-sha}
#   (c) env washed           — printenv a *TOKEN* env var → empty
#   (d) profile active        — app-server thread/start echoes activePermissionProfile
#   (e) negative control      — passing a legacy `sandbox` param → activePermissionProfile:null
#
# SKIPS cleanly (exit 0) if `codex` / `node` is unavailable, so CI without a Codex
# install does not fail — but logs the skip loudly (never silently "passes").

set -uo pipefail
PASS=0; FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"           # .../packages/teamlead/scripts
HOME_SH="$SCRIPT_DIR/codex-lead-tui-home.sh"
PROBE="$(cd "$(dirname "$0")" && pwd)/fly260-read-deny-appserver-probe.mjs"

if ! command -v codex >/dev/null 2>&1; then
  echo "SKIP (loud): codex CLI not found — read-deny ENFORCEMENT not verified here."
  exit 0
fi

T=$(mktemp -d /tmp/fly260rd.XXXXX); trap 'rm -rf "$T"' EXIT
FAKE_HOME="$T/home"; mkdir -p "$FAKE_HOME/workspace"
CHOME="$FAKE_HOME/.codex-lead-home"; mkdir -p "$CHOME/packages/standalone/current"
echo '{"tokens":"x"}' > "$CHOME/auth.json"
printf '#!/bin/sh\n' > "$CHOME/packages/standalone/current/codex"; chmod +x "$CHOME/packages/standalone/current/codex"

# Generate the read-deny config through the PRODUCTION path (fragment + home-script).
if FLYWHEEL_CODEX_LEAD_READ_DENY=1 FLYWHEEL_CODEX_TUI_HOME="$CHOME" FLYWHEEL_CODEX_TUI_CWD="$FAKE_HOME/workspace" \
     /bin/bash "$HOME_SH" ensure-home >/dev/null 2>&1; then
  pass "config generated via home-script read-deny path (production wiring)"
else
  fail "home-script read-deny ensure-home failed"; echo "Results: $PASS passed, $FAIL failed"; exit 1
fi

# Dummy SECRET targets (under the isolated HOME so ~/ globs resolve here).
mkdir -p "$FAKE_HOME/.codex-fake/sub" "$FAKE_HOME/.ssh" "$FAKE_HOME/.docker" "$FAKE_HOME/.config/gcloud" "$FAKE_HOME/proj"
echo SECRET > "$FAKE_HOME/.codex-fake/auth.json"
echo SECRET > "$FAKE_HOME/.codex-fake/sub/deep"
echo SECRET > "$FAKE_HOME/.ssh/id_rsa"
echo SECRET > "$FAKE_HOME/.npmrc"
echo SECRET > "$FAKE_HOME/.docker/config.json"
echo SECRET > "$FAKE_HOME/.config/gcloud/creds.db"
echo SECRET > "$FAKE_HOME/proj/.env"
echo SECRET > "$FAKE_HOME/proj/.env.local"
# Dummy OPERATIONAL targets (COE Director orchestration — must stay readable).
mkdir -p "$FAKE_HOME/.flywheel/bin" "$FAKE_HOME/.flywheel/state" "$FAKE_HOME/.flywheel/comm/growth" "$FAKE_HOME/.flywheel/runner-state" "$FAKE_HOME/.flywheel/manifests"
echo OPS > "$FAKE_HOME/.flywheel/teamlead.db"
echo OPS > "$FAKE_HOME/.flywheel/bin/flywheel-comm"
echo OPS > "$FAKE_HOME/.flywheel/state/lead.json"
echo OPS > "$FAKE_HOME/.flywheel/comm/growth/comm.db"
echo OPS > "$FAKE_HOME/.flywheel/runner-state/r.json"
echo OPS > "$FAKE_HOME/.flywheel/manifests/m.json"
echo OPS > "$FAKE_HOME/.flywheel/deployed-sha"

# `codex sandbox` runs a command under the profile's Seatbelt policy. HOME drives ~/
# expansion; CODEX_HOME holds the generated profile config.
sb() { HOME="$FAKE_HOME" CODEX_HOME="$CHOME" codex sandbox -P flywheel-lead-secret-deny -C "$FAKE_HOME/workspace" -- /bin/cat "$1" 2>&1 | head -1; }
# A real per-file denial is the `cat` command's own "Operation not permitted" — NOT a
# `sandbox_apply` / `sandbox-exec` SETUP failure (which would also contain "not
# permitted" and make EVERY read look denied → false positives). Codex R1#3.
denied() { case "$1" in *sandbox_apply*|*sandbox-exec*) return 1;; *"not permitted"*) return 0;; *) return 1;; esac; }

# HEALTHY-SANDBOX GATE (Codex R1#3): before trusting any "denied" result, prove the
# sandbox actually APPLIED — an in-workspace read must SUCCEED. If the sandbox can't
# initialize here (managed/CI envs deny `sandbox_apply`), every read fails setup and
# secret-denied assertions would be FALSE POSITIVES → skip LOUDLY instead.
echo ALLOWVAL > "$FAKE_HOME/workspace/allowed.txt"
probe="$(sb "$FAKE_HOME/workspace/allowed.txt")"
if [ "$probe" != "ALLOWVAL" ]; then
  case "$probe" in
    *sandbox_apply*|*sandbox-exec*|*"not permitted"*)
      echo "SKIP (loud): this environment cannot apply the macOS sandbox (probe: $probe)."
      echo "  read-deny ENFORCEMENT not verifiable here — run on an unrestricted machine."
      exit 0 ;;
    *)
      fail "healthy-sandbox probe returned unexpected output: $probe"
      echo "Results: $PASS passed, $FAIL failed"; exit 1 ;;
  esac
fi
pass "healthy-sandbox gate: in-workspace read SUCCEEDS (sandbox applied)"

# (a) secrets DENIED
for f in .codex-fake/auth.json .codex-fake/sub/deep .ssh/id_rsa .npmrc .docker/config.json .config/gcloud/creds.db proj/.env proj/.env.local; do
  if denied "$(sb "$FAKE_HOME/$f")"; then pass "secret DENIED: ~/$f"; else fail "secret NOT denied (FAKE HARDENING): ~/$f"; fi
done

# (b) Director orchestration paths ALLOWED
for f in .flywheel/teamlead.db .flywheel/bin/flywheel-comm .flywheel/state/lead.json .flywheel/comm/growth/comm.db .flywheel/runner-state/r.json .flywheel/manifests/m.json .flywheel/deployed-sha; do
  out="$(sb "$FAKE_HOME/$f")"
  if [ "$out" = "OPS" ]; then pass "Director path ALLOWED: ~/$f"; else fail "Director path BROKEN (denied): ~/$f → $out"; fi
done

# (c) env washed: a *TOKEN* env var must not be visible to the exec shell
tokenval="$(HOME="$FAKE_HOME" CODEX_HOME="$CHOME" FLY260_FAKE_TOKEN=LEAKME codex sandbox -P flywheel-lead-secret-deny -C "$FAKE_HOME/workspace" -- /usr/bin/printenv FLY260_FAKE_TOKEN 2>/dev/null)"
if [ -z "$tokenval" ]; then pass "env washed: FLY260_FAKE_TOKEN hidden from exec shell"; else fail "env LEAK: token visible ($tokenval)"; fi
normalval="$(HOME="$FAKE_HOME" CODEX_HOME="$CHOME" FLY260_NORMAL=ok codex sandbox -P flywheel-lead-secret-deny -C "$FAKE_HOME/workspace" -- /usr/bin/printenv FLY260_NORMAL 2>/dev/null)"
if [ "$normalval" = "ok" ]; then pass "env wash is surgical: non-token env still visible"; else fail "env wash too broad: FLY260_NORMAL hidden"; fi

# (d)+(e) app-server: profile active (no sandbox param) + negative control (legacy param → null)
if command -v node >/dev/null 2>&1 && [ -f "$PROBE" ]; then
  active="$(HOME="$FAKE_HOME" CODEX_HOME="$CHOME" node "$PROBE" "$FAKE_HOME/workspace" no-sandbox 2>/dev/null)"
  [ "$active" = "flywheel-lead-secret-deny" ] && pass "app-server: activePermissionProfile active (no sandbox param)" || fail "app-server: profile not active (got: $active)"
  neg="$(HOME="$FAKE_HOME" CODEX_HOME="$CHOME" node "$PROBE" "$FAKE_HOME/workspace" legacy-sandbox 2>/dev/null)"
  [ "$neg" = "null" ] && pass "app-server negative control: legacy sandbox param → activePermissionProfile:null (Gotcha A)" || fail "app-server negative control unexpected (got: $neg)"
else
  echo "  (skip app-server probe: node or probe missing — kernel-level deny above is the load-bearing proof)"
fi

echo "────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
