#!/bin/bash
# FLY-2776: the dev-channels auto-confirm must survive the pane it actually
# runs in, and must stop failing silently.
#
# 2026-09-22: Aunt Cass sat on the dev-channels dialog for ~17 hours across two
# shuttles. The reported cause was "Claude Code upgraded and the dialog text
# changed". It had not: all three fragments the old recognizer required are
# still present verbatim in the 2.1.277 / 2.1.278 / 2.1.280 binaries, and
# 04:18Z matched while 07:02Z did not ON THE SAME BINARY. The real cause is
# that the production Lead pane is 49x16, and at that geometry
#   - the dialog is taller than the viewport, so the title has scrolled out of
#     `capture-pane -p` altogether, and
#   - `Please use --channels to run a list of approved channels.` (56 chars) is
#     soft-wrapped across two physical lines,
# leaving exactly one of three required fragments matchable — the logged
# `match_warning=0 match_local_dev=1 match_channels_hint=0`.
#
# Layers:
#   F*  real tmux + a fake Claude painting the byte-verbatim 49x16 capture.
#       THIS is the layer that gates: CI installs no claude binary, so G below
#       always skips there, and a negative control that never runs protects
#       nothing. Carries the mutations.
#   G*  real tmux + the REAL installed claude, at both geometries (the one that
#       broke and the one that worked) — QA judgement 1. Skips without a
#       binary; its output is recorded in the PR body as acceptance evidence.
#   M*  the same mutation against the real binary, for that same evidence.
#   A*  the drift alert — partial evidence must be loud, exactly once, must not
#       fire on an ordinary conversation, and must never kill the poller.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEAD_SH="$ROOT/packages/teamlead/scripts/claude-lead.sh"
# Short base: a tmux socket path is a unix socket and dies at ~104 bytes, which
# the default per-run TMPDIR on macOS already exceeds.
TMP="$(mktemp -d /tmp/fly2776.XXXXXX)"

SOCKETS=()
cleanup_all() {
  local s
  for s in ${SOCKETS[@]+"${SOCKETS[@]}"}; do
    [ -n "$s" ] || continue
    tmux -S "$s" kill-server >/dev/null 2>&1 || true
  done
  rm -rf "$TMP"
}
trap cleanup_all EXIT

passed=0
failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }

[ -f "$LEAD_SH" ] || { printf 'FAIL: launcher not found: %s\n' "$LEAD_SH"; exit 1; }

# ── Units under test, extracted from production source ──────────────────────
SQUASH_SRC="$(sed -n '/^_dev_channels_squash_ws()/,/^}/p' "$LEAD_SH")"
PREDICATE_SRC="$(sed -n '/^_dev_channels_dialog_present()/,/^}/p' "$LEAD_SH")"
DRIFT_SRC="$(sed -n '/^_dev_channels_drift_alert()/,/^}/p' "$LEAD_SH")"
POLLER_SRC="$(sed -n '/^_poll_dev_channels_dialog_v2()/,/^}/p' "$LEAD_SH")"
for unit in SQUASH_SRC PREDICATE_SRC DRIFT_SRC POLLER_SRC; do
  eval "src=\$$unit"
  if [ -z "$src" ]; then
    printf 'FAIL: production source is missing %s\n' "$unit"
    exit 1
  fi
done

# Materialize one runnable poller. `$1` optionally replaces POLLER-adjacent
# source, which is how the M layer mutates the recognizer without touching the
# repo.
write_poller_script() {
  # write_poller_script <path> <predicate-src>
  local path="$1" predicate="$2"
  cat > "$path" <<SCRIPT
#!/bin/bash
set -euo pipefail
_log_startup() { printf '%s\n' "\$*" >> "\$FLY2776_LOG"; }
${SQUASH_SRC}
${predicate}
${DRIFT_SRC}
${POLLER_SRC}
_poll_dev_channels_dialog_v2 "\${FLY2776_TIMEOUT:-45}"
SCRIPT
  chmod +x "$path"
}

# ═══════════════════════════════════════════════════════════════════════════
# F — real tmux + a fake Claude painting the byte-verbatim 49x16 capture.
#
# This is the layer that GATES. CI installs no `claude` binary, so the G layer
# below is a permanent SKIP there; if the mutation negative control lived only
# in G, nothing would stop a future "simplification" from re-shipping this
# outage with a green suite. tmux IS installed on the shards, so F proves the
# whole path — capture, recognize, send-keys, verify — against real tmux
# rendering, in seconds, everywhere.
#
# House convention: this is the same real-tmux/fake-Claude shape fly1679's E
# layer uses.
# ═══════════════════════════════════════════════════════════════════════════

# The 49x16 capture, byte-for-byte from claude 2.1.280 (see the file header).
read -r -d '' NARROW_SCREEN <<'FIXTURE' || true
  --dangerously-load-development-channels is
  for local channel development only. Do not
  use this option to run channels you have
  downloaded off the internet.

  Please use --channels to run a list of
  approved channels.

  Channels: plugin:discord@flywheel-plugins,
  server:flywheel-inbox

  ❯ 1. I am using this for local development
    2. Exit

  Enter to confirm · Esc to cancel
FIXTURE

read -r -d '' CONFIRMED_SCREEN <<'FIXTURE' || true
───────────────────────────────────────────────
❯
───────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
FIXTURE

fake_claude_case() {
  # fake_claude_case <name> <cols> <rows> <predicate-src> <want: confirm|nomatch>
  local name="$1" cols="$2" rows="$3" predicate="$4" want="$5"
  local sock="$TMP/f-$name.sock"
  local slog="$TMP/f-$name-startup.log"
  local script="$TMP/f-$name-poller.sh"
  local child="$TMP/f-$name-child.sh"
  local keys="$TMP/f-$name.keys"
  local first="$TMP/f-$name-first.txt" after="$TMP/f-$name-after.txt"
  local stty_err="$TMP/f-$name.stty" raw_state="$TMP/f-$name.raw"
  SOCKETS+=("$sock")
  : > "$slog"; : > "$keys"; : > "$stty_err"; : > "$raw_state"
  printf '%s
' "$NARROW_SCREEN" > "$first"
  printf '%s
' "$CONFIRMED_SCREEN" > "$after"
  write_poller_script "$script" "$predicate"

  # Fake Claude: paint the screen, then read RAW bytes off the pane tty.
  # `stty -icanon` is what makes this faithful — Ink puts stdin in raw mode,
  # which is exactly why a bare `1` confirms with no Enter. A canonical tty
  # would only ever see input followed by Enter, i.e. it would silently encode
  # the semantics this guard depends on NOT needing.
  #
  # Three states, never two. Some sandboxes deny the tty ioctl; there the pane
  # stays canonical, buffers a bare `1` forever, and F1 fails for a reason that
  # has nothing to do with the recognizer. But "stty failed" on its own is NOT
  # evidence of a host limit — it is equally consistent with a broken or missing
  # stty, and collapsing the two would let an arbitrary harness fault skip this
  # layer green. The child records which of the three it was, and only an
  # affirmative capability denial may skip. Same contract as fly1679's E layer.
  cat > "$child" <<CHILD
#!/bin/bash
if stty -icanon min 1 time 0 -echo </dev/tty 2>"$stty_err"; then
  printf 'ok\n' > "$raw_state"
elif grep -qE 'Operation not permitted|Inappropriate ioctl for device|Not a typewriter' "$stty_err" 2>/dev/null; then
  printf 'denied\n' > "$raw_state"
else
  printf 'error\n' > "$raw_state"
fi
cat "$first"
while true; do
  b="\$(dd bs=1 count=1 2>/dev/null </dev/tty | od -An -c | tr -d ' \n')"
  [ -n "\$b" ] || continue
  printf '%s\n' "\$b" >> "$keys"
  printf '\033[2J\033[H'
  cat "$after"
done
CHILD
  chmod +x "$child"

  tmux -S "$sock" new-session -d -s "f$name" -n main -x "$cols" -y "$rows" \
    -c "$TMP" "$child" >/dev/null 2>&1 || { fail "$name could not start tmux"; return 0; }
  sleep 1

  FLY2776_LOG="$slog" FLY2776_TIMEOUT=6 \
    TMUX="$sock,0,0" TMUX_PANE="%0" "$script" >/dev/null 2>&1 || true

  F_RAW_STATE="$(cat "$raw_state" 2>/dev/null || echo missing)"
  case "$want" in
    confirm)
      if grep -q 'matched dev-channels dialog' "$slog" \
        && grep -q 'confirmed=1' "$slog" \
        && [ "$(wc -l < "$keys" | tr -d ' ')" = "1" ] \
        && grep -q '1' "$keys" \
        && ! grep -q '\\n\|\\r' "$keys"; then
        pass "$name real tmux at ${cols}x${rows}: recognized, confirmed with exactly one '1' and no Enter"
        F_TRANSPORT=ok
        return 0
      fi
      # Exactly three outcomes and only one of them is a skip. `missing` means
      # the child never reached the point of recording its tty capability — a
      # harness/startup fault, not an environment limit; collapsing the two
      # would let a broken tmux report a clean, green, entirely unexecuted F
      # layer.
      case "$F_RAW_STATE" in
        denied)
          # A host may legitimately refuse the tty ioctl — but CI is the ONLY
          # place this layer gates (G/M have no claude binary there), so a
          # denial in CI is not an excuse, it is the loss of the gate. Red it.
          if [ "${CI:-}" = "true" ]; then
            fail "$name raw tty denied in CI, where the F layer is the only gating layer: $(tr -d '\n' < "$stty_err" 2>/dev/null || echo unknown)"
            F_TRANSPORT=broken
          else
            printf 'SKIP: %s — this environment denies raw tty mode (stty: %s); the F layer cannot deliver a keystroke here\n' \
              "$name" "$(tr -d '\n' < "$stty_err" 2>/dev/null || echo unknown)"
            F_TRANSPORT=unavailable
          fi
          ;;
        ok)
          fail "$name at ${cols}x${rows}: raw tty available but the guard did not confirm. keys=[$(cat "$keys")] log=[$(tr '\n' '|' < "$slog")]"
          F_TRANSPORT=broken
          ;;
        error)
          fail "$name unexpected stty failure, not a known capability denial: $(tr -d '\n' < "$stty_err" 2>/dev/null || echo unknown)"
          F_TRANSPORT=broken
          ;;
        *)
          fail "$name harness did not run: no tty-capability record (raw=${F_RAW_STATE}) keys=[$(cat "$keys")] log=[$(tr '\n' '|' < "$slog")]"
          F_TRANSPORT=broken
          ;;
      esac
      ;;
    nomatch)
      # Only meaningful once F1 proved on THIS host that a byte can actually be
      # delivered. Without that, "sent nothing" is indistinguishable from "could
      # not have sent anything", and the negative control would pass vacuously
      # on every sandbox that denies a raw tty.
      if [ "${F_TRANSPORT:-}" != ok ]; then
        printf 'SKIP: %s — keystroke transport unproven on this host (F_TRANSPORT=%s); a negative control would pass vacuously here\n' \
          "$name" "${F_TRANSPORT:-unset}"
        return 0
      fi
      if grep -q 'DEV_CHANNELS_DIALOG_NOT_SEEN' "$slog" \
        && [ ! -s "$keys" ]; then
        pass "$name real tmux at ${cols}x${rows}: mutant misses the dialog and sends nothing (negative control holds)"
      else
        fail "$name at ${cols}x${rows}: the mutant still matched. keys=[$(cat "$keys")] log=[$(tr '\n' '|' < "$slog")]"
      fi
      ;;
  esac
}

# The mutation: drop the whitespace squashing, i.e. go back to matching the
# body sentence against the raw rendered line. This is the exact regression
# FLY-2776 fixed, and F2 must go red on it.
MUTANT_NO_SQUASH="$(printf '%s\n' "$PREDICATE_SRC" \
  | sed 's/squashed="\$(_dev_channels_squash_ws "\$text")"/squashed="$text"/')"
# The second mutation: drop the line anchoring from the option row. A
# recognizer that accepts the row mid-line would key into a transcript.
MUTANT_NO_ANCHOR="$(printf '%s\n' "$PREDICATE_SRC" \
  | sed "s/^\( *option_row_re='\)\^.*'\$/\1I am using this for local development'/")"

# Set by fake_claude_case: ok / unavailable / broken. Whether this host can put
# a byte into a tmux pane at all is a property of the host, established once by
# F1, and every later keystroke assertion depends on it.
F_TRANSPORT=""

if ! command -v tmux >/dev/null 2>&1; then
  printf 'SKIP: tmux unavailable — F layer not run\n'
else
  fake_claude_case F1 49 16 "$PREDICATE_SRC" confirm
  if [ "$MUTANT_NO_SQUASH" = "$PREDICATE_SRC" ]; then
    fail "F2a mutation did not apply — the recognizer no longer squashes whitespace under that name"
  else
    fake_claude_case F2 49 16 "$MUTANT_NO_SQUASH" nomatch
  fi
  if [ "$MUTANT_NO_ANCHOR" = "$PREDICATE_SRC" ]; then
    fail "F3a mutation did not apply — the option-row regex no longer has that shape"
  else
    # Proving a mutation "applied" proves nothing about whether anything would
    # CATCH it. Run both predicates against the shape the anchor exists to
    # reject: the mutant must wrongly accept it, the real one must reject it.
    # Only the pair makes the anchor load-bearing.
    read -r -d '' F3_INLINE_QUOTE <<'FIXTURE' || true
see (WARNING: Loading development channels … ❯ 1. I am using this for local development
/ 2. Exit) — Enter to confirm · Esc to cancel is the footer it prints.
FIXTURE
    f3_mutant=absent f3_real=absent
    ( eval "$SQUASH_SRC"; eval "$MUTANT_NO_ANCHOR"
      _dev_channels_dialog_present "$F3_INLINE_QUOTE" ) && f3_mutant=present
    ( eval "$SQUASH_SRC"; eval "$PREDICATE_SRC"
      _dev_channels_dialog_present "$F3_INLINE_QUOTE" ) && f3_real=present
    if [ "$f3_mutant" = present ] && [ "$f3_real" = absent ]; then
      pass "F3 dropping the line anchor makes the recognizer accept a mid-line quote; the shipped one rejects it"
    else
      fail "F3 anchor is not load-bearing: mutant=$f3_mutant real=$f3_real"
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# G — real tmux, REAL installed claude, at both geometries
#
# QA judgement 1 (Lead, 2026-09-22): a fixture run does not count. The guard
# has to be proven against the binary that is actually installed, at 49x16
# (the geometry that broke) AND at 120x40 (the geometry that worked), and the
# Lead has to end up at a prompt that can receive messages.
# ═══════════════════════════════════════════════════════════════════════════
CLAUDE_BIN="${FLYWHEEL_CLAUDE_BIN:-}"
if [ -z "$CLAUDE_BIN" ]; then
  # `command -v claude` can resolve to a shell function in an interactive rc;
  # take the real file off PATH instead.
  CLAUDE_BIN="$(PATH="$PATH" /usr/bin/env bash -c 'command -v claude' 2>/dev/null || true)"
fi
DEV_CHANNELS_ARGS=(--dangerously-load-development-channels plugin:discord@flywheel-plugins server:flywheel-inbox)

geometry_case() {
  # geometry_case <name> <cols> <rows> <predicate-src> <want: confirm|nomatch>
  local name="$1" cols="$2" rows="$3" predicate="$4" want="$5"
  local sock="$TMP/g-$name.sock"
  local slog="$TMP/g-$name-startup.log"
  local script="$TMP/g-$name-poller.sh"
  local waited=0 dialog_seen=0 final=""
  SOCKETS+=("$sock")
  : > "$slog"
  write_poller_script "$script" "$predicate"

  tmux -S "$sock" new-session -d -s "fly2776$name" -n main -x "$cols" -y "$rows" \
    -c "$TMP" "$CLAUDE_BIN ${DEV_CHANNELS_ARGS[*]}" >/dev/null 2>&1 || {
      fail "$name could not start a tmux session"; return 0; }

  # Wait for the dialog to actually render before judging the guard. Anchor the
  # wait on the option LABEL (a raw substring), never on the recognizer itself
  # — waiting on the thing under test would make every mutation look like a
  # slow start instead of a miss.
  while [ "$waited" -lt 40 ]; do
    if tmux -S "$sock" capture-pane -t %0 -p 2>/dev/null \
      | LC_ALL=C grep -qF -e 'I am using this for local development'; then
      dialog_seen=1
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if [ "$dialog_seen" -ne 1 ]; then
    fail "$name the real claude never rendered the dev-channels dialog in ${waited}s (cannot judge the guard)"
    return 0
  fi

  FLY2776_LOG="$slog" FLY2776_TIMEOUT=30 \
    TMUX="$sock,0,0" TMUX_PANE="%0" "$script" >/dev/null 2>&1 || true

  sleep 2
  final="$(tmux -S "$sock" capture-pane -t %0 -p 2>/dev/null || true)"

  # "The dialog went away" is not "the Lead can receive". Claude exiting, or
  # parking on some other modal, satisfies the first and not the second. Assert
  # the pane process is still alive AND Claude's live composer is on screen —
  # `⏵⏵` is the permission-mode indicator the modal hides and the prompt shows.
  local pane_alive=0 prompt_up=0
  tmux -S "$sock" display-message -p -t %0 '#{pane_id}' >/dev/null 2>&1 && pane_alive=1
  LC_ALL=C grep -qF -e '⏵⏵' <<<"$final" && prompt_up=1

  case "$want" in
    confirm)
      if grep -q 'matched dev-channels dialog' "$slog" \
        && grep -q 'confirmed=1' "$slog" \
        && [ "$pane_alive" -eq 1 ] \
        && [ "$prompt_up" -eq 1 ] \
        && ! LC_ALL=C grep -qE '^[[:space:]]*(❯[[:space:]]+)?1\.[[:space:]]+I am using this for local development[[:space:]]*$' <<<"$final"; then
        pass "$name real claude at ${cols}x${rows}: matched, confirmed, pane alive and Claude's composer is up"
      else
        fail "$name at ${cols}x${rows} did not reach a receiving prompt (pane_alive=$pane_alive prompt_up=$prompt_up). log=[$(tr '\n' '|' < "$slog")] final=[$(tr '\n' '|' <<<"$final")]"
      fi
      ;;
    nomatch)
      if grep -q 'DEV_CHANNELS_DIALOG_NOT_SEEN' "$slog"; then
        pass "$name real claude at ${cols}x${rows}: mutated recognizer misses the dialog (negative control holds)"
      else
        fail "$name at ${cols}x${rows} the mutant still matched — the test cannot detect this regression. log=[$(tr '\n' '|' < "$slog")]"
      fi
      ;;
  esac
}

if ! command -v tmux >/dev/null 2>&1; then
  printf 'SKIP: tmux unavailable — G/M layers (real claude end-to-end) not run\n'
elif [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  printf 'SKIP: no executable claude on PATH (set FLYWHEEL_CLAUDE_BIN) — G/M layers not run\n'
elif [ "${F_TRANSPORT:-}" != ok ]; then
  # G's whole assertion is "the guard pressed the key and the dialog went
  # away". On a host that cannot deliver a keystroke into a pane at all, a
  # failure here says nothing about the recognizer — and F1 has just measured
  # exactly that capability on this host. Without it, do not run and do not
  # pretend.
  printf 'SKIP: keystroke transport unproven on this host (F_TRANSPORT=%s) — G/M layers not run\n' \
    "${F_TRANSPORT:-unset}"
else
  printf 'claude under test: %s (%s)\n' "$CLAUDE_BIN" "$("$CLAUDE_BIN" --version 2>/dev/null | head -1)"
  geometry_case G1 49 16 "$PREDICATE_SRC" confirm
  geometry_case G2 120 40 "$PREDICATE_SRC" confirm

  # M — the same mutation against the REAL binary. F2 already gates this in CI;
  # this repeats it against the shipped claude so the acceptance evidence in
  # the PR body shows the negative control holding on the real renderer too.
  #
  # Only the 49x16 case can carry it: at 120x40 the title is on screen and
  # unwrapped, so the mutant still matches there — which is precisely why the
  # original bug was invisible to anyone testing on a normal terminal.
  if [ "$MUTANT_NO_SQUASH" = "$PREDICATE_SRC" ]; then
    fail "M0 mutation did not apply — the recognizer no longer squashes whitespace under that name"
  else
    pass "M0 mutation applied (whitespace squashing removed from the recognizer)"
    geometry_case M1 49 16 "$MUTANT_NO_SQUASH" nomatch
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# A — the drift alert (QA judgement 4)
#
# A NOT_SEEN that still carries this dialog's fingerprints is not "no dialog
# appeared", it is "the dialog appeared and we did not recognize it". Those two
# shared one silent exit before this issue. They must never share one again —
# and the noisy half must not fire for the nine Leads that genuinely had no
# dialog.
# ═══════════════════════════════════════════════════════════════════════════
SHIM_DIR="$TMP/shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/tmux" <<'SHIM'
#!/bin/bash
mode=""
fmt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    display-message|capture-pane|send-keys) mode="$1"; shift; break ;;
    *) shift ;;
  esac
done
case "$mode" in
  display-message)
    # The poller probes '#{pane_id}' for liveness and '#{pane_width}x#{pane_height}'
    # for the NOT_SEEN classification; answer each in its own shape.
    for a in "$@"; do fmt="$a"; done
    case "$fmt" in
      *pane_width*) printf '%s\n' "${FAKE_PANE_GEOM:-49x16}" ;;
      *) printf '%s\n' "%0" ;;
    esac
    ;;
  capture-pane) cat "$FAKE_SCREEN" ;;
  send-keys) : ;;
esac
exit 0
SHIM
chmod +x "$SHIM_DIR/tmux"

cat > "$SHIM_DIR/lead-alert.sh" <<'ALERT'
#!/bin/bash
printf '%s\n' "$*" >> "$FAKE_ALERT_CALLS"
# --strict-delivery contract: exactly one machine-readable verdict on stdout.
# The real script prints its own chatter on stderr, so the caller must not
# conflate the two.
printf 'lead-alert chatter that must never be parsed as a verdict\n' >&2
[ -n "${FAKE_ALERT_VERDICT:-}" ] && printf '%s\n' "$FAKE_ALERT_VERDICT"
exit "${FAKE_ALERT_RC:-0}"
ALERT
chmod +x "$SHIM_DIR/lead-alert.sh"
# _dev_channels_drift_alert resolves "${FLYWHEEL_ROOT}/scripts/lead-alert.sh".
mkdir -p "$TMP/fakeroot/scripts"
cp "$SHIM_DIR/lead-alert.sh" "$TMP/fakeroot/scripts/lead-alert.sh"

export FAKE_SCREEN="$TMP/a-screen.txt"
export FAKE_ALERT_CALLS="$TMP/a-alert.log"

run_alert_case() {
  # run_alert_case <screen> [env assignments...]
  # Defaults to the happy verdict; cases override FAKE_ALERT_VERDICT/_RC.
  local screen="$1"; shift
  local script="$TMP/a-poller.sh"
  : > "$FAKE_ALERT_CALLS"
  : > "$TMP/a-startup.log"
  printf '%s\n' "$screen" > "$FAKE_SCREEN"
  write_poller_script "$script" "$PREDICATE_SRC"
  A_RC=0
  env PATH="$SHIM_DIR:$PATH" \
    FLYWHEEL_ROOT="$TMP/fakeroot" \
    FAKE_ALERT_VERDICT="sent" \
    LEAD_ID="flywheel-cos-lead" PROJECT_NAME="flywheel" \
    FLY2776_LOG="$TMP/a-startup.log" FLY2776_TIMEOUT=2 \
    TMUX="$TMP/fake.sock,999,0" TMUX_PANE="%0" \
    "$@" "$script" >/dev/null 2>&1 || A_RC=$?
  A_LOG="$(cat "$TMP/a-startup.log" 2>/dev/null || true)"
  A_ALERTS="$(grep -c 'kind' "$FAKE_ALERT_CALLS" 2>/dev/null || true)"
  A_ALERTS="${A_ALERTS:-0}"
}

# The 49x16 capture with the focused option row removed: the dialog's prose is
# on screen but the thing we key off is not. This is the "partial match" the
# issue asks to make loud.
read -r -d '' PARTIAL_SCREEN <<'FIXTURE' || true
  --dangerously-load-development-channels is
  for local channel development only. Do not
  use this option to run channels you have
  downloaded off the internet.

  Please use --channels to run a list of
  approved channels.

  Channels: plugin:discord@flywheel-plugins,
  server:flywheel-inbox
FIXTURE

# A Lead discussing this very flag in Discord. Carries the option LABEL and the
# title, carries no live dialog. This is fly1679's TRANSCRIPT_A_PLUS_B shape.
read -r -d '' TRANSCRIPT_SCREEN <<'FIXTURE' || true
> Lead 的 claude 以 --dangerously-load-development-channels 启动时,启动即弹确认框
> (WARNING: Loading development channels … ❯ 1. I am using this for local development
> / 2. Exit),无人按键就永远停在框上 = 该 Lead 的 Discord/inbox 全下线.
Let me look at the poller in claude-lead.sh.
FIXTURE

read -r -d '' BENIGN_SCREEN <<'FIXTURE' || true
╭──────────────────────────────────────────────╮
│ >                                            │
╰──────────────────────────────────────────────╯
  ? for shortcuts
FIXTURE

run_alert_case "$PARTIAL_SCREEN"
if grep -q 'DEV_CHANNELS_SUSPECTED_DRIFT' <<<"$A_LOG" && [ "$A_ALERTS" -eq 1 ]; then
  pass "A1 a partial match logs suspected drift and alerts exactly once"
else
  fail "A1 alerts=$A_ALERTS log=[$A_LOG]"
fi

if grep -q 'match_option_row=0' <<<"$A_LOG" \
  && grep -q 'match_channels_hint=1' <<<"$A_LOG" \
  && grep -q 'match_dangerously=1' <<<"$A_LOG" \
  && grep -q 'match_live_prompt=0' <<<"$A_LOG" \
  && grep -q 'geom=49x16' <<<"$A_LOG"; then
  pass "A1b the classification separates the structural miss from the semantic hits, and reports geometry"
else
  fail "A1b classification did not carry the new evidence: log=[$A_LOG]"
fi

# The kind matters as much as the text. `permission_blocked` is in
# AlertChannelHub's LEAD_KINDS, where every reconcile tick re-classifies the
# Lead pane with a /permission.*(required|denied)/i probe a dev-channels dialog
# can never satisfy — so on the queue-drain path the Hub would resolve the
# ticket as "recovered" while the Lead is still parked on the dialog. And
# `severe` is recorded into alert_version_observations BEFORE dedup, where
# severeHold=1 freezes the release soak on a diagnostic signal.
if grep -q 'kind external_config_error' "$FAKE_ALERT_CALLS" \
  && grep -q 'severity warning' "$FAKE_ALERT_CALLS" \
  && ! grep -q 'permission_blocked' "$FAKE_ALERT_CALLS" \
  && ! grep -q 'severity severe' "$FAKE_ALERT_CALLS"; then
  pass "A1c the alert uses a kind that cannot self-resolve, and a severity whose hold threshold is 5 rather than severe's 1"
else
  fail "A1c alert kind/severity wrong: [$(cat "$FAKE_ALERT_CALLS")]"
fi

# The dedup signature is the failure SHAPE, not a screen digest. alert_claims
# has no pruner, so a digest key would mint a fresh permanent mute on every
# cold start — an alert storm now and silence later.
# The signature is the failure SHAPE plus a UTC-day bucket. A screen digest
# would mint a fresh signature every cold start (storm); a bare shape would be
# a permanent, unclearable mute, because alert_claims has no pruner and a
# `sent` receipt short-circuits forever — so the same Lead stuck the same way
# next month would be silent.
if grep -qE "signature dev-channels-drift-[01]{7}-$(date -u '+%Y%m%d')( |\$)" "$FAKE_ALERT_CALLS" \
  && ! grep -qE 'signature dev-channels-drift-[a-f0-9]{16}' "$FAKE_ALERT_CALLS"; then
  pass "A1d the dedup signature is the failure shape plus a UTC-day bucket (bounded storm, no permanent mute)"
else
  fail "A1d signature wrong: [$(cat "$FAKE_ALERT_CALLS")]"
fi

if grep -qF -e '--strict-delivery' "$FAKE_ALERT_CALLS"; then
  pass "A1f the alert asks for a machine-readable delivery verdict"
else
  fail "A1f --strict-delivery not passed: [$(cat "$FAKE_ALERT_CALLS")]"
fi

if ! grep -q 'downloaded off the internet' "$FAKE_ALERT_CALLS" \
  && ! grep -q 'server:flywheel-inbox' "$FAKE_ALERT_CALLS" \
  && grep -q 'geom=49x16' "$FAKE_ALERT_CALLS"; then
  pass "A1e the alert body carries geometry and shape, never pane text"
else
  fail "A1e alert body leaked pane text or lost geometry: [$(cat "$FAKE_ALERT_CALLS")]"
fi

# The narrowest real dialog, captured from the installed claude 2.1.280 at
# 43x16. Here the option ROW wraps too, so the recognizer correctly declines to
# key it — but that must not be silent, or this is the 17-hour park again one
# column narrower. Only the wrapped-label + modal-footer clause catches it:
# match_option_row=0 and exactly ONE body sentence survives.
read -r -d '' NARROW_43_SCREEN <<'FIXTURE' || true
  Do not use this option to run channels
  you have downloaded off the internet.

  Please use --channels to run a list of
  approved channels.

  Channels:
  plugin:discord@flywheel-plugins,
  server:flywheel-inbox

  ❯ 1. I am using this for local
       development
    2. Exit

  Enter to confirm · Esc to cancel
FIXTURE

# Narrower still: 30x16, byte-verbatim from the installed 2.1.280. Here the
# option row AND the modal footer both wrap, and only one body sentence is left
# on screen. Squashing rejoins both, which is the whole point.
read -r -d '' NARROW_30_SCREEN <<'FIXTURE' || true

  Please use --channels to
  run a list of approved
  channels.

  Channels: plugin:discord@f
  lywheel-plugins,
  server:flywheel-inbox

  ❯ 1. I am using this for
       local development
    2. Exit

  Enter to confirm · Esc to
  cancel
FIXTURE

# The screen that must NOT page anyone: a Lead RENDERING the dialog capture —
# which this repo's own exploration.md and fixtures now contain verbatim —
# while its composer is live underneath. The composer is decisive: a modal
# hides it, so a pane showing it is receiving, not parked.
read -r -d '' TRANSCRIPT_BLOCK_SCREEN <<'FIXTURE' || true
> 49x16 抓到的屏幕:
>
>   ❯ 1. I am using this for local development
>     2. Exit
>
>   Enter to confirm · Esc to cancel

──────────────────────────────────────────────────
❯
──────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
FIXTURE

run_alert_case "$NARROW_43_SCREEN" FAKE_PANE_GEOM=43x16
if grep -q 'DEV_CHANNELS_SUSPECTED_DRIFT' <<<"$A_LOG" \
  && [ "$A_ALERTS" -eq 1 ] \
  && grep -q 'match_option_row=0' <<<"$A_LOG" \
  && grep -q 'match_option_squashed=1' <<<"$A_LOG" \
  && grep -q 'match_modal_footer=1' <<<"$A_LOG" \
  && grep -q 'geom=43x16' <<<"$A_LOG"; then
  pass "A1g a real dialog too narrow to key is not keyed, and is not silent either"
else
  fail "A1g the 43x16 real dialog was silently abandoned: alerts=$A_ALERTS log=[$A_LOG]"
fi

run_alert_case "$NARROW_30_SCREEN" FAKE_PANE_GEOM=30x16
if grep -q 'DEV_CHANNELS_SUSPECTED_DRIFT' <<<"$A_LOG" \
  && [ "$A_ALERTS" -eq 1 ] \
  && grep -q 'match_option_row=0' <<<"$A_LOG" \
  && grep -q 'match_modal_footer=1' <<<"$A_LOG"; then
  pass "A1h at 30x16 the option row and the footer both wrap, and the Lead still does not go silent"
else
  fail "A1h the 30x16 real dialog was silently abandoned: alerts=$A_ALERTS log=[$A_LOG]"
fi

run_alert_case "$TRANSCRIPT_BLOCK_SCREEN"
if grep -q 'DEV_CHANNELS_DIALOG_NOT_SEEN' <<<"$A_LOG" \
  && grep -q 'match_live_prompt=1' <<<"$A_LOG" \
  && ! grep -q 'DEV_CHANNELS_SUSPECTED_DRIFT' <<<"$A_LOG" \
  && [ "$A_ALERTS" -eq 0 ]; then
  pass "A2c a Lead RENDERING the dialog capture with its composer live is receiving, and is not paged"
else
  fail "A2c rendering the capture paged the on-call: alerts=$A_ALERTS log=[$A_LOG]"
fi

run_alert_case "$BENIGN_SCREEN"
if grep -q 'DEV_CHANNELS_DIALOG_NOT_SEEN' <<<"$A_LOG" \
  && ! grep -q 'DEV_CHANNELS_SUSPECTED_DRIFT' <<<"$A_LOG" \
  && [ "$A_ALERTS" -eq 0 ]; then
  pass "A2 a Lead that simply had no dialog stays quiet (no fleet-wide noise)"
else
  fail "A2 alerts=$A_ALERTS log=[$A_LOG]"
fi

# The false positive that actually matters: a Lead DISCUSSING this flag. The
# option label and the title are both on screen; neither is evidence of a live
# dialog. Aunt Cass was in exactly this state while reporting the incident.
run_alert_case "$TRANSCRIPT_SCREEN"
if grep -q 'DEV_CHANNELS_DIALOG_NOT_SEEN' <<<"$A_LOG" \
  && grep -q 'match_local_dev=1' <<<"$A_LOG" \
  && grep -q 'match_option_squashed=1' <<<"$A_LOG" \
  && grep -q 'match_modal_footer=0' <<<"$A_LOG" \
  && ! grep -q 'DEV_CHANNELS_SUSPECTED_DRIFT' <<<"$A_LOG" \
  && [ "$A_ALERTS" -eq 0 ]; then
  pass "A2b a Lead talking about this flag raises no drift alert — the wrapped label alone is not enough, the modal footer is what gates it"
else
  fail "A2b a benign transcript alerted: alerts=$A_ALERTS log=[$A_LOG]"
fi

run_alert_case "$PARTIAL_SCREEN" FAKE_ALERT_VERDICT=config_error FAKE_ALERT_RC=1
if [ "$A_RC" -eq 0 ] && grep -q 'DRIFT_ALERT_UNSENT verdict=config_error' <<<"$A_LOG"; then
  pass "A3 an unsendable alert is named in the startup log and never takes the poller down"
else
  fail "A3 rc=$A_RC log=[$A_LOG]"
fi

# rc=2 is BOTH "durably queued, the drain will deliver it" and "dead-lettered,
# nobody will ever see it". Only the --strict-delivery verdict separates them,
# and getting it wrong misreports the exact path where the alert failed — the
# one where accurate logging matters most.
run_alert_case "$PARTIAL_SCREEN" FAKE_ALERT_VERDICT=queued_transient FAKE_ALERT_RC=2
if [ "$A_RC" -eq 0 ] && grep -q 'DRIFT_ALERT_SENT verdict=queued_transient' <<<"$A_LOG"; then
  pass "A4 rc=2 + queued_transient is recorded as deliverable, not as a failure"
else
  fail "A4 rc=$A_RC log=[$A_LOG]"
fi

run_alert_case "$PARTIAL_SCREEN" FAKE_ALERT_VERDICT=dead_lettered FAKE_ALERT_RC=2
if [ "$A_RC" -eq 0 ] \
  && grep -q 'DRIFT_ALERT_UNSENT verdict=dead_lettered' <<<"$A_LOG" \
  && ! grep -q 'DRIFT_ALERT_SENT' <<<"$A_LOG"; then
  pass "A4b rc=2 + dead_lettered is recorded as UNSENT — the same exit code, the opposite outcome"
else
  fail "A4b a dead-lettered alert was logged as sent: rc=$A_RC log=[$A_LOG]"
fi

# An old lead-alert.sh, a crash before it printed, or the bounding timeout.
# Absence of evidence is never evidence of delivery.
run_alert_case "$PARTIAL_SCREEN" FAKE_ALERT_VERDICT= FAKE_ALERT_RC=0
if [ "$A_RC" -eq 0 ] && grep -q 'DRIFT_ALERT_UNSENT verdict=<unparseable>' <<<"$A_LOG"; then
  pass "A4c a missing delivery receipt is never reported as sent, even on exit 0"
else
  fail "A4c rc=$A_RC log=[$A_LOG]"
fi

# The alert script may be absent entirely (a partial install). That must be a
# named log line, not a silent no-op — a silent no-op is this whole issue.
run_alert_case "$PARTIAL_SCREEN" FLYWHEEL_ROOT="$TMP/nonexistent"
if [ "$A_RC" -eq 0 ] && grep -q 'DRIFT_ALERT_UNSENT no executable lead-alert.sh' <<<"$A_LOG"; then
  pass "A5 a missing lead-alert.sh is named in the startup log, never silently skipped"
else
  fail "A5 rc=$A_RC log=[$A_LOG]"
fi

# ═══════════════════════════════════════════════════════════════════════════
# H — the F layer's skip path must itself be honest.
#
# F1 is allowed exactly one skip: an affirmative raw-tty denial by the host.
# That escape hatch is the most dangerous line in this file — if it widened to
# "stty failed for any reason", an arbitrary harness fault would report a
# clean, green, entirely unexecuted F layer, which is precisely the
# fail-silently shape FLY-2776 exists to remove. So: shim `stty` and prove both
# edges.
# ═══════════════════════════════════════════════════════════════════════════
if ! command -v tmux >/dev/null 2>&1; then
  printf 'SKIP: tmux unavailable — H layer not run\n'
else
  h_case() {
    # h_case <name> <stty-shim-body>
    local name="$1" body="$2" h_ci="${3:-}"
    local dir="$TMP/h-$name"
    mkdir -p "$dir"
    printf '%s\n' '#!/bin/bash' "$body" > "$dir/stty"
    chmod +x "$dir/stty"
    # A subshell so the shimmed PATH and the pass/fail counters stay contained;
    # the parent grades the captured output instead. `CI` is set explicitly by
    # each case, never inherited: H1 exercises the local-host branch and H3 the
    # CI branch, and on a real CI runner an inherited CI=true would silently
    # turn H1 into a test of the wrong branch — which is exactly what reds this
    # suite on the shard while passing on every laptop.
    ( PATH="$dir:$PATH"; F_TRANSPORT=""; export CI="$h_ci"
      fake_claude_case "$name" 49 16 "$PREDICATE_SRC" confirm ) 2>&1
    tmux -S "$TMP/f-$name.sock" kill-server >/dev/null 2>&1 || true
  }

  h1_out="$(h_case H1 'echo "stty: TIOCGETD: Operation not permitted" >&2
exit 1' '')"
  if grep -q 'SKIP: H1 — this environment denies raw tty mode' <<<"$h1_out" \
    && ! grep -q '^PASS: H1' <<<"$h1_out" \
    && ! grep -q '^FAIL: H1' <<<"$h1_out"; then
    pass "H1 an affirmative raw-tty denial skips the F layer, and says so"
  else
    fail "H1 denial was not reported as a skip: [$h1_out]"
  fi

  h2_out="$(h_case H2 'echo "synthetic harness failure" >&2
exit 42' '')"
  if grep -q 'FAIL: H2 unexpected stty failure' <<<"$h2_out" \
    && ! grep -q '^SKIP: H2' <<<"$h2_out"; then
    pass "H2 an arbitrary stty failure reds the F layer instead of skipping it green"
  else
    fail "H2 an unknown stty failure did not red the suite: [$h2_out]"
  fi

  # H3 — the one allowed skip must NOT be allowed in CI, where F is the only
  # layer that gates. Without this the suite could go permanently, silently
  # unexecuted on the shard and nobody would learn it from a green run.
  h3_out="$(h_case H3 'echo "stty: TIOCGETD: Operation not permitted" >&2
exit 1' 'true')"
  if grep -q 'FAIL: H3 raw tty denied in CI' <<<"$h3_out" \
    && ! grep -q '^SKIP: H3' <<<"$h3_out"; then
    pass "H3 in CI a raw-tty denial reds the suite rather than silently removing the only gate"
  else
    fail "H3 a CI raw-tty denial was allowed to skip: [$h3_out]"
  fi
fi

printf '\n%s\n' "─────────────────────────────────────────────"
printf 'FLY-2776 dev-channels geometry + drift: %d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
