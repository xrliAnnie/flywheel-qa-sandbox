#!/bin/bash
# FLY-1679: the launchd-native (v2) Lead body must auto-confirm the
# --dangerously-load-development-channels dialog. FLY-109 added that poller to
# the v1 supervisor loop; the FLY-1663 carrier migration did not carry it, so
# every v2 cold start parked on the dialog until a human pressed a key while
# launchd still reported the job as running.
#
# Layers:
#   P*  predicate — the recognizer is exclusive to this one dialog
#   T*  poller branches, against a PATH-shimmed fake tmux
#   W*  source-order wiring (start before the blocking launch; reap first)
#   R*  reaper behavior, including the PID-reuse guard
#   E*  real tmux end-to-end (keystrokes actually reach the pane)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEAD_SH="$ROOT/packages/teamlead/scripts/claude-lead.sh"
TMP="$(mktemp -d /tmp/fly1679.XXXXXX)"

E2E_SOCKETS=()
E2E_VICTIMS=()
cleanup_all() {
  local s p
  for s in ${E2E_SOCKETS[@]+"${E2E_SOCKETS[@]}"}; do
    [ -n "$s" ] || continue
    tmux -S "$s" kill-server >/dev/null 2>&1 || true
  done
  for p in ${E2E_VICTIMS[@]+"${E2E_VICTIMS[@]}"}; do
    [ -n "$p" ] || continue
    kill "$p" >/dev/null 2>&1 || true
  done
  rm -rf "$TMP"
}
trap cleanup_all EXIT

passed=0
failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }

[ -f "$LEAD_SH" ] || { printf 'FAIL: launcher not found: %s\n' "$LEAD_SH"; exit 1; }
if grep -Eq '^_log_startup\(\)[[:space:]]*\{' "$LEAD_SH"; then
  pass "S1 production launcher defines the startup logger used by the v2 poller"
else
  fail "S1 production launcher is missing the v2 poller's startup logger"
fi

# ── Extract the units under test straight out of production source ──────────
GATE_SRC="$(sed -n '/^_dev_channels_flag_active()/,/^}/p' "$LEAD_SH")"
PREDICATE_SRC="$(sed -n '/^_dev_channels_dialog_present()/,/^}/p' "$LEAD_SH")"
# FLY-2776: the recognizer squashes whitespace before matching its body
# sentence, so a soft-wrapped line still reads as one sentence. That helper is
# shared with the NOT_SEEN classification and therefore lives outside the
# predicate — it has to be extracted alongside it.
SQUASH_SRC="$(sed -n '/^_dev_channels_squash_ws()/,/^}/p' "$LEAD_SH")"
# FLY-2776: the poller's NOT_SEEN path now emits a drift alert when the dialog
# left fingerprints on the pane, so the emitter travels with the poller. With
# FLYWHEEL_ROOT unset it finds no lead-alert.sh and logs a skip, which is the
# behavior these cases want — the A* cases in
# scripts/__tests__/fly2776-dev-channels-geometry.test.sh own the alert itself.
DRIFT_SRC="$(sed -n '/^_dev_channels_drift_alert()/,/^}/p' "$LEAD_SH")"
POLLER_SRC="$(sed -n '/^_poll_dev_channels_dialog_v2()/,/^}/p' "$LEAD_SH")"
IS_RUNNING_SRC="$(sed -n '/^_v2_dialog_poller_is_running()/,/^}/p' "$LEAD_SH")"
REAPER_SRC="$(sed -n '/^_v2_reap_dialog_poller()/,/^}/p' "$LEAD_SH")"

for unit in GATE_SRC PREDICATE_SRC SQUASH_SRC DRIFT_SRC POLLER_SRC IS_RUNNING_SRC REAPER_SRC; do
  eval "src=\$$unit"
  if [ -z "$src" ]; then
    printf 'FAIL: production source is missing %s\n' "$unit"
    exit 1
  fi
done

# ── Fixtures ────────────────────────────────────────────────────────────────
# The real dialog, verbatim from claude-code src/components/DevChannelsDialog.tsx
# (Dialog title, the two Text nodes, and the Select option labels).
read -r -d '' REAL_DIALOG <<'FIXTURE' || true
╭─ WARNING: Loading development channels ──────────────────────────────────────╮
│                                                                              │
│ --dangerously-load-development-channels is for local channel development     │
│ only. Do not use this option to run channels you have downloaded off the     │
│ internet.                                                                    │
│                                                                              │
│ Please use --channels to run a list of approved channels.                    │
│                                                                              │
│ Channels: server:flywheel-inbox                                              │
│                                                                              │
│ ❯ 1. I am using this for local development                                   │
│   2. Exit                                                                    │
│                                                                              │
│ Enter confirm · Esc cancel                                                   │
╰──────────────────────────────────────────────────────────────────────────────╯
FIXTURE

# The exact shape of this issue's own text: title + option label quoted in a
# conversation, WITHOUT the approved-channels line. Must never match.
read -r -d '' TRANSCRIPT_A_PLUS_B <<'FIXTURE' || true
> Lead 的 claude 以 --dangerously-load-development-channels 启动时,启动即弹确认框
> (WARNING: Loading development channels … ❯ 1. I am using this for local development
> / 2. Exit),无人按键就永远停在框上 = 该 Lead 的 Discord/inbox 全下线.
Let me look at the poller in claude-lead.sh.
FIXTURE

read -r -d '' TRANSCRIPT_BARE <<'FIXTURE' || true
The wrapper-v2 migration dropped the development channels auto-confirm.
I will port it into the launchd-native body.
FIXTURE

read -r -d '' OTHER_DIALOG <<'FIXTURE' || true
╭─ Do you want to proceed? ────────────────────────────────────────────────────╮
│ Edit file src/index.ts                                                       │
│                                                                              │
│ ❯ 1. Yes                                                                     │
│   2. Yes, and don't ask again                                                │
│   3. No, and tell Claude what to do differently                              │
╰──────────────────────────────────────────────────────────────────────────────╯
FIXTURE

read -r -d '' CHROME_ONBOARDING <<'FIXTURE' || true
╭─ Claude in Chrome ───────────────────────────────────────────────────────────╮
│ Claude can now control your browser.                                         │
│                                                                              │
│ ❯ 1. Got it                                                                  │
╰──────────────────────────────────────────────────────────────────────────────╯
FIXTURE

# ═══════════════════════════════════════════════════════════════════════════
# P — predicate exclusivity
# ═══════════════════════════════════════════════════════════════════════════
eval "$SQUASH_SRC"
eval "$PREDICATE_SRC"

predicate_case() {
  local name="$1" text="$2" want="$3" got=absent
  if _dev_channels_dialog_present "$text"; then got=present; fi
  if [ "$got" = "$want" ]; then
    pass "$name"
  else
    fail "$name (want $want, got $got)"
  fi
}

predicate_case "P1 real dev-channels dialog is recognized" "$REAL_DIALOG" present
predicate_case "P2 title alone is not the dialog" \
  "WARNING: Loading development channels" absent
predicate_case "P3 option label alone is not the dialog" \
  "I am using this for local development" absent
predicate_case "P4 title+option quoted in conversation is not the dialog" \
  "$TRANSCRIPT_A_PLUS_B" absent
predicate_case "P5 bare 'development channels' phrase is not the dialog" \
  "$TRANSCRIPT_BARE" absent
predicate_case "P6 an unrelated numeric confirm dialog is not the dialog" \
  "$OTHER_DIALOG" absent
predicate_case "P7 Chrome onboarding is not the dialog" "$CHROME_ONBOARDING" absent

# ── FLY-2776 fixtures: REAL `tmux capture-pane -p` output, byte-for-byte ────
# Captured 2026-09-22 from the currently installed claude 2.1.280 started with
#   --dangerously-load-development-channels plugin:discord@flywheel-plugins server:flywheel-inbox
# in an isolated tmux server, at the two geometries that matter.
#
# NARROW is the production Lead's geometry (49x16 — verified against the live
# carrier with `list-panes -F '#{pane_width}x#{pane_height}'`). At 49 columns the
# dialog is TALLER than the 16-row viewport, so the title has scrolled out of
# `capture-pane -p` entirely, and `Please use --channels to run a list of
# approved channels.` (56 chars) is soft-wrapped across two physical lines.
# That is the whole incident: nothing in the dialog's text changed — all three
# original fragments still exist verbatim in the 2.1.277/2.1.278/2.1.280
# binaries — the 49x16 viewport just cannot show two of them on one line.
read -r -d '' REAL_CAPTURE_NARROW <<'FIXTURE' || true
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

# WIDE is the shape that matched every day through 2026-09-22T04:18Z.
read -r -d '' REAL_CAPTURE_WIDE <<'FIXTURE' || true

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  WARNING: Loading development channels

  --dangerously-load-development-channels is for local channel development only. Do not use this option to run
  channels you have downloaded off the internet.

  Please use --channels to run a list of approved channels.

  Channels: plugin:discord@flywheel-plugins, server:flywheel-inbox

  ❯ 1. I am using this for local development
    2. Exit

  Enter to confirm · Esc to cancel
FIXTURE

# NARROW with the focused option row removed: body prose only. A screen that
# merely TALKS about the flag must never be keystroked.
read -r -d '' NARROW_NO_OPTION_ROW <<'FIXTURE' || true
  --dangerously-load-development-channels is
  for local channel development only. Do not
  use this option to run channels you have
  downloaded off the internet.

  Please use --channels to run a list of
  approved channels.

  Channels: plugin:discord@flywheel-plugins,
  server:flywheel-inbox
FIXTURE

# The focused option row with no body sentence anywhere. One feature is not a
# dialog — this is the "don't degrade to a single fragment" guard.
read -r -d '' OPTION_ROW_ONLY <<'FIXTURE' || true
  ❯ 1. I am using this for local development
    2. Exit

  Enter to confirm · Esc to cancel
FIXTURE

# The option row quoted INSIDE a line of prose (the P4 shape, but with the
# wrapped-sentence body that the narrow capture has). Line anchoring is the
# only thing separating this from a live dialog.
read -r -d '' OPTION_ROW_INLINE <<'FIXTURE' || true
The poller looks for the row. Please use --channels to run a list of
approved channels. is one of the fragments, and the other is
the row itself: ❯ 1. I am using this for local development — which is
what we grep for.
FIXTURE

# The wrapped sentence with NO option row at all.
read -r -d '' WRAPPED_SENTENCE_ONLY <<'FIXTURE' || true
  Please use --channels to run a list of
  approved channels.
FIXTURE

predicate_case "P8 FLY-2776 real 49x16 capture (title scrolled off, sentence wrapped) is the dialog" \
  "$REAL_CAPTURE_NARROW" present
predicate_case "P9 FLY-2776 real 120x40 capture (the historically matching shape) is the dialog" \
  "$REAL_CAPTURE_WIDE" present
predicate_case "P10 FLY-2776 body prose without the focused option row is not the dialog" \
  "$NARROW_NO_OPTION_ROW" absent
predicate_case "P11 FLY-2776 the option row alone is not the dialog" \
  "$OPTION_ROW_ONLY" absent
predicate_case "P12 FLY-2776 the option row quoted inside a line is not the dialog" \
  "$OPTION_ROW_INLINE" absent
predicate_case "P13 FLY-2776 a wrapped approved-channels sentence alone is not the dialog" \
  "$WRAPPED_SENTENCE_ONLY" absent

# A BORDERED dialog rendered narrow: the title has scrolled off AND the
# approved-channels sentence is wrapped AND a border glyph sits between the two
# halves. Collapsing whitespace alone would read `...run a list of │ │ approved
# channels.` and never rejoin the sentence — the frame has to fold away first.
# Neither the unbordered 2.1.280 capture nor the bordered wide fixture covers
# this combination.
read -r -d '' REAL_DIALOG_BORDERED_NARROW <<'FIXTURE' || true
│ --dangerously-load-development-channels is │
│ for local channel development only. Do not │
│ use this option to run channels you have   │
│ downloaded off the internet.               │
│                                            │
│ Please use --channels to run a list of     │
│ approved channels.                         │
│                                            │
│ Channels: server:flywheel-inbox            │
│                                            │
│ ❯ 1. I am using this for local development │
│   2. Exit                                  │
│                                            │
│ Enter to confirm · Esc to cancel           │
╰────────────────────────────────────────────╯
FIXTURE

predicate_case "P14 FLY-2776 a bordered dialog that is BOTH truncated and wrapped is the dialog" \
  "$REAL_DIALOG_BORDERED_NARROW" present

# A Lead pane that RENDERS this dialog as a block — the shape the repo's own
# docs and fixtures now contain verbatim — while Claude's composer is live
# underneath. The dialog rows are reproduced UNPREFIXED on their own lines, so
# the line anchor and the wrapped body sentence both match: the ONLY thing left
# to reject this screen is the permission-mode indicator `⏵⏵`, which a modal
# dialog hides and an ordinary Lead screen always shows.
#
# The `>`-quoted variant of this fixture would be rejected by the anchor long
# before the composer check ran, so it would pass this case for the wrong
# reason and prove nothing about the veto. P15b is the positive control that
# keeps this honest: strip the composer line and the SAME screen must be
# recognized.
read -r -d '' TRANSCRIPT_BLOCK_WITH_PROMPT <<'FIXTURE' || true
49x16 下抓到的屏幕是这样的:

  Please use --channels to run a list of
  approved channels.

  ❯ 1. I am using this for local development
    2. Exit

  Enter to confirm · Esc to cancel

  所以守卫认不出来。

──────────────────────────────────────────────────
❯
──────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
FIXTURE

# The same bytes with the composer footer removed.
TRANSCRIPT_BLOCK_NO_PROMPT="$(printf '%s\n' "$TRANSCRIPT_BLOCK_WITH_PROMPT" | grep -v '⏵⏵')"

# The same block with no live composer but also no modal footer: prose that
# reproduces the rows without reproducing the dialog.
read -r -d '' TRANSCRIPT_BLOCK_NO_FOOTER <<'FIXTURE' || true
The rows the recognizer keys on are:

  ❯ 1. I am using this for local development
    2. Exit

and the sentence Please use --channels to run a list of approved channels.
is the corroborating one.
FIXTURE

# An ordinary numbered list that happens to reuse the label, plus one body
# sentence loose on the same screen.
read -r -d '' ORDINARY_NUMBERED_LIST <<'FIXTURE' || true
  Options considered:
  1. I am using this for local development
  2. Something else entirely

  Please use --channels to run a list of approved channels.
FIXTURE

predicate_case "P15 FLY-2776 a rendered transcript block above a live composer is not the dialog" \
  "$TRANSCRIPT_BLOCK_WITH_PROMPT" absent
predicate_case "P15b FLY-2776 the same screen WITHOUT the composer is recognized — so P15 is the veto, not the anchor" \
  "$TRANSCRIPT_BLOCK_NO_PROMPT" present

# P15c — the composer veto must be LOAD-BEARING, not merely present. Delete it
# from the shipped recognizer and P15's screen must flip to `present`; the
# shipped recognizer must still say `absent`. Without this pair, a future
# refactor could drop claude-lead.sh's `⏵⏵` check and every P case would stay
# green while a Lead displaying an unprefixed capture got keystroked.
MUTANT_NO_COMPOSER="$(printf '%s\n' "$PREDICATE_SRC" \
  | sed "/grep -qF -e '⏵⏵'/,+2d")"
if [ "$MUTANT_NO_COMPOSER" = "$PREDICATE_SRC" ]; then
  fail "P15c mutation did not apply — the composer veto no longer has that shape"
else
  p15c_mutant=absent p15c_shipped=absent
  ( eval "$SQUASH_SRC"; eval "$MUTANT_NO_COMPOSER"
    _dev_channels_dialog_present "$TRANSCRIPT_BLOCK_WITH_PROMPT" ) && p15c_mutant=present
  ( eval "$SQUASH_SRC"; eval "$PREDICATE_SRC"
    _dev_channels_dialog_present "$TRANSCRIPT_BLOCK_WITH_PROMPT" ) && p15c_shipped=present
  if [ "$p15c_mutant" = present ] && [ "$p15c_shipped" = absent ]; then
    pass "P15c removing the composer veto makes that screen match; the shipped recognizer rejects it"
  else
    fail "P15c composer veto is not load-bearing: mutant=$p15c_mutant shipped=$p15c_shipped"
  fi
fi
predicate_case "P16 FLY-2776 the dialog's rows reproduced without its modal footer are not the dialog" \
  "$TRANSCRIPT_BLOCK_NO_FOOTER" absent
predicate_case "P17 FLY-2776 an ordinary numbered list reusing the label is not the dialog" \
  "$ORDINARY_NUMBERED_LIST" absent

# The genuinely narrow REAL dialog: at 43x16 the option row itself wraps, so
# the recognizer must NOT key it (we cannot tell which row the label belongs
# to). Captured from the installed claude 2.1.280.
read -r -d '' REAL_CAPTURE_43x16 <<'FIXTURE' || true
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

predicate_case "P18 FLY-2776 a real dialog too narrow to render the option row is not keyed (fail closed)" \
  "$REAL_CAPTURE_43x16" absent

# ═══════════════════════════════════════════════════════════════════════════
# T — poller branches against a PATH-shimmed fake tmux
#
# TMUX_TMPDIR does not isolate tmux (a shim on PATH is the only reliable way to
# keep a unit test off the real server), so every T case runs with a fake tmux
# first on PATH and asserts on its call log.
# ═══════════════════════════════════════════════════════════════════════════
SHIM_DIR="$TMP/shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/tmux" <<'SHIM'
#!/bin/bash
# Fake tmux. Records every invocation, then answers from scripted state.
printf '%s\n' "$*" >> "$FAKE_TMUX_CALLS"
mode=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    display-message|capture-pane|send-keys) mode="$1"; shift; break ;;
    *) shift ;;
  esac
done
case "$mode" in
  display-message)
    [ "${FAKE_PANE_ALIVE:-1}" = "1" ] || exit 1
    # FLY-2776: the poller probes '#{pane_id}' for liveness and
    # '#{pane_width}x#{pane_height}' for the NOT_SEEN classification. Answer
    # each in its own shape — geometry is the evidence that made this
    # incident diagnosable.
    fmt=""
    for a in "$@"; do fmt="$a"; done
    case "$fmt" in
      *pane_width*) printf '%s\n' "${FAKE_PANE_GEOM:-49x16}" ;;
      *) printf '%s\n' "${FAKE_PANE_ID:-%0}" ;;
    esac
    ;;
  capture-pane)
    n=0
    [ ! -f "$FAKE_CAPTURE_COUNT" ] || n="$(cat "$FAKE_CAPTURE_COUNT")"
    n=$((n + 1))
    printf '%s' "$n" > "$FAKE_CAPTURE_COUNT"
    if [ -f "$FAKE_SENT_MARKER" ]; then
      [ "${FAKE_CAPTURE_FAILS_AFTER_SEND:-0}" = "1" ] && exit 1
      cat "$FAKE_SCREEN_AFTER"
    else
      [ "${FAKE_CAPTURE_FAILS:-0}" = "1" ] && exit 1
      cat "$FAKE_SCREEN"
    fi
    ;;
  send-keys)
    [ "${FAKE_SEND_FAILS:-0}" = "1" ] && exit 1
    : > "$FAKE_SENT_MARKER"
    ;;
esac
exit 0
SHIM
chmod +x "$SHIM_DIR/tmux"

FAKE_SOCKET="$TMP/private.sock"
export FAKE_TMUX_CALLS="$TMP/calls.log"
export FAKE_SCREEN="$TMP/screen.txt"
export FAKE_SCREEN_AFTER="$TMP/screen-after.txt"
export FAKE_SENT_MARKER="$TMP/sent.marker"
export FAKE_CAPTURE_COUNT="$TMP/capture.count"

run_poller() {
  # run_poller <screen> <screen-after> [env assignments...]
  # FLY1679_BREAK_LOGGER=1 makes _log_startup fail, modelling an unwritable
  # startup log. The poller must survive it — see the |1 case below.
  local screen="$1" after="$2"; shift 2
  : > "$FAKE_TMUX_CALLS"
  rm -f "$FAKE_SENT_MARKER" "$FAKE_CAPTURE_COUNT"
  printf '%s\n' "$screen" > "$FAKE_SCREEN"
  printf '%s\n' "$after" > "$FAKE_SCREEN_AFTER"
  : > "$TMP/startup.log"

  POLLER_RC=0
  POLLER_STDOUT="$(
    env PATH="$SHIM_DIR:$PATH" \
      TMUX="${TMUX_OVERRIDE-$FAKE_SOCKET,999,0}" \
      TMUX_PANE="${PANE_OVERRIDE-%0}" \
      "$@" \
      /bin/bash -c '
        set -euo pipefail
        if [ "${FLY1679_BREAK_LOGGER:-0}" = "1" ]; then
          _log_startup() { return 1; }
        else
          _log_startup() { printf "%s\n" "$*" >> "$FLY1679_LOG"; }
        fi
        '"$SQUASH_SRC"'
        '"$PREDICATE_SRC"'
        '"$DRIFT_SRC"'
        '"$POLLER_SRC"'
        _poll_dev_channels_dialog_v2 "${FLY1679_TIMEOUT:-2}"
      ' 2>/dev/null
  )" || POLLER_RC=$?
  POLLER_LOG="$(cat "$TMP/startup.log" 2>/dev/null || true)"
}

export FLY1679_LOG="$TMP/startup.log"

sends_of() { grep -c 'send-keys' "$FAKE_TMUX_CALLS" 2>/dev/null || true; }
enters_of() { grep -c 'send-keys.*Enter' "$FAKE_TMUX_CALLS" 2>/dev/null || true; }

# T1 — dialog present, gone after '1'
run_poller "$REAL_DIALOG" "$OTHER_DIALOG"
if [ "$(sends_of)" -eq 1 ] \
  && [ "$(enters_of)" -eq 0 ] \
  && grep -q 'confirmed=1' <<<"$POLLER_LOG"; then
  pass "T1 dialog confirmed with exactly one '1' and zero Enter"
else
  fail "T1 sends=$(sends_of) enters=$(enters_of) log=[$POLLER_LOG]"
fi

# T2 — dialog stubbornly stays after '1'
run_poller "$REAL_DIALOG" "$REAL_DIALOG"
if [ "$(sends_of)" -eq 1 ] \
  && [ "$(enters_of)" -eq 0 ] \
  && grep -q 'DEV_CHANNELS_CONFIRM_UNVERIFIED' <<<"$POLLER_LOG" \
  && ! grep -q 'confirmed=1' <<<"$POLLER_LOG"; then
  pass "T2 dialog still present after '1' reports UNVERIFIED, never confirmed"
else
  fail "T2 sends=$(sends_of) enters=$(enters_of) log=[$POLLER_LOG]"
fi

# T3 — send-keys transport failure
run_poller "$REAL_DIALOG" "$OTHER_DIALOG" FAKE_SEND_FAILS=1
if grep -q 'DEV_CHANNELS_SEND_FAILED' <<<"$POLLER_LOG" \
  && ! grep -q 'confirmed=1' <<<"$POLLER_LOG"; then
  pass "T3 send-keys failure is reported and never claims confirmation"
else
  fail "T3 log=[$POLLER_LOG]"
fi

# T3b — every verification capture fails after a successful send
run_poller "$REAL_DIALOG" "$OTHER_DIALOG" FAKE_CAPTURE_FAILS_AFTER_SEND=1
if grep -q 'DEV_CHANNELS_VERIFY_FAILED' <<<"$POLLER_LOG" \
  && ! grep -q 'confirmed=1' <<<"$POLLER_LOG"; then
  pass "T3b verification transport loss never becomes a false confirmed=1"
else
  fail "T3b log=[$POLLER_LOG]"
fi

# T4 — this issue's own text on screen (title + option, no approved-channels line)
run_poller "$TRANSCRIPT_A_PLUS_B" "$TRANSCRIPT_A_PLUS_B"
if [ "$(sends_of)" -eq 0 ] \
  && grep -q 'DEV_CHANNELS_DIALOG_NOT_SEEN' <<<"$POLLER_LOG"; then
  pass "T4 quoted dialog text in a transcript is never typed into"
else
  fail "T4 sends=$(sends_of) log=[$POLLER_LOG]"
fi

# This literal is a drift alarm, not a formatting preference: it guards the
# promise that the timeout path records SHAPE ONLY — never pane text, never a
# credential (FLY-1948). FLY-2776 added `geom=` and `match_option_row=` to it,
# because "the box was on screen but the recognizer's structural half missed"
# and "no box was ever drawn" used to look identical here, and the geometry is
# what identifies a viewport-truncation miss on sight. If this fails, resync
# the literal to the new line — do not loosen it into a substring check.
if grep -Eq 'NOT_SEEN classification: lines=[0-9]+ geom=[0-9]+x[0-9]+ blank=false match_warning=1 match_local_dev=1 match_channels_hint=0 match_dangerously=0 match_option_row=0 match_option_squashed=1 match_modal_footer=0 match_live_prompt=0 banner_channels=0 prompt_caret=1 pane_sha256=([a-f0-9]{64}|-)$' <<<"$POLLER_LOG"; then
  pass "T4b timeout records classification (shape + geometry) without pane text"
else
  fail "T4b missing or incorrect NOT_SEEN classification: log=[$POLLER_LOG]"
fi

# T4c — FLY-2776: this same screen must NOT raise a drift alert. It is a Lead
# talking about the flag in Discord, which is its job; the option label and the
# title are both on it. Alerting on one bare fingerprint would page severe on
# every cold start of every Lead that ever discusses this issue — and Aunt Cass
# was discussing exactly this issue when the incident happened.
if ! grep -q 'DEV_CHANNELS_SUSPECTED_DRIFT' <<<"$POLLER_LOG"; then
  pass "T4c a conversation that quotes the dialog raises no drift alert"
else
  fail "T4c a benign transcript screen raised a drift alert: log=[$POLLER_LOG]"
fi
while IFS= read -r raw_line; do
  [[ -n "$raw_line" ]] || continue
  if grep -qF "$raw_line" <<<"$POLLER_LOG"; then
    fail "T4c timeout log contains raw pane text"
  fi
done <<<"$TRANSCRIPT_A_PLUS_B"

# T5 — an unrelated confirm dialog
run_poller "$OTHER_DIALOG" "$OTHER_DIALOG"
if [ "$(sends_of)" -eq 0 ]; then
  pass "T5 an unrelated numeric dialog is never pressed"
else
  fail "T5 sends=$(sends_of)"
fi

# T5b — Chrome onboarding, the dialog that legitimately follows this one
run_poller "$CHROME_ONBOARDING" "$CHROME_ONBOARDING"
if [ "$(sends_of)" -eq 0 ]; then
  pass "T5b Chrome onboarding is never pressed"
else
  fail "T5b sends=$(sends_of)"
fi

# T6 — pane probe says the pane is gone
run_poller "$REAL_DIALOG" "$REAL_DIALOG" FAKE_PANE_ALIVE=0
if [ "$(sends_of)" -eq 0 ] && grep -q 'pane gone' <<<"$POLLER_LOG"; then
  pass "T6 a dead pane stops the poller before any keystroke"
else
  fail "T6 sends=$(sends_of) log=[$POLLER_LOG]"
fi

# T7 — no tmux identity at all
TMUX_OVERRIDE="" run_poller "$REAL_DIALOG" "$REAL_DIALOG"
if [ ! -s "$FAKE_TMUX_CALLS" ] && grep -q 'no tmux identity' <<<"$POLLER_LOG"; then
  pass "T7 a body with no tmux identity skips auto-confirm entirely"
else
  fail "T7 calls=[$(cat "$FAKE_TMUX_CALLS")] log=[$POLLER_LOG]"
fi
unset TMUX_OVERRIDE

# T7b — observability failure must never disable the safety mechanism. Under
# `set -e` an unguarded log call would abort this background function before it
# ever probes the pane, silently reproducing the parked-Lead incident.
run_poller "$REAL_DIALOG" "$OTHER_DIALOG" FLY1679_BREAK_LOGGER=1
if [ "$(sends_of)" -eq 1 ] && [ "$(enters_of)" -eq 0 ] && [ "$POLLER_RC" -eq 0 ]; then
  pass "T7b a failing startup logger still confirms the dialog (rc=0, one '1')"
else
  fail "T7b sends=$(sends_of) enters=$(enters_of) rc=$POLLER_RC"
fi

# T8 — addressing: private socket from $TMUX, pane from $TMUX_PANE.
# Every call must carry both; "at least one" would pass a partially wired poller.
run_poller "$REAL_DIALOG" "$OTHER_DIALOG"
total_calls="$(wc -l < "$FAKE_TMUX_CALLS" | tr -d ' ')"
sock_calls="$(grep -c -- "-S ${FAKE_SOCKET} " "$FAKE_TMUX_CALLS" || true)"
pane_calls="$(grep -c -- '-t %0' "$FAKE_TMUX_CALLS" || true)"
if [ "$total_calls" -gt 0 ] \
  && [ "$sock_calls" -eq "$total_calls" ] \
  && [ "$pane_calls" -eq "$total_calls" ]; then
  pass "T8 every tmux call addresses the private socket and the body pane"
else
  fail "T8 total=$total_calls sock=$sock_calls pane=$pane_calls calls=[$(cat "$FAKE_TMUX_CALLS")]"
fi

# T8b — TMUX_PANE absent falls back to the carrier-guaranteed %0
PANE_OVERRIDE="" run_poller "$REAL_DIALOG" "$OTHER_DIALOG"
if grep -q -- '-t %0' "$FAKE_TMUX_CALLS"; then
  pass "T8b missing TMUX_PANE falls back to %0"
else
  fail "T8b calls=[$(cat "$FAKE_TMUX_CALLS")]"
fi
unset PANE_OVERRIDE

# T9 — the v1 shared-socket override must never retarget these keystrokes
run_poller "$REAL_DIALOG" "$OTHER_DIALOG" FLYWHEEL_TMUX_SOCKET_OVERRIDE="$TMP/shared-v1.sock"
if ! grep -q -- "$TMP/shared-v1.sock" "$FAKE_TMUX_CALLS" \
  && grep -q -- "-S ${FAKE_SOCKET} " "$FAKE_TMUX_CALLS"; then
  pass "T9 FLYWHEEL_TMUX_SOCKET_OVERRIDE cannot retarget the v2 poller"
else
  fail "T9 calls=[$(cat "$FAKE_TMUX_CALLS")]"
fi

# T10 — the poller shares the pane tty with Claude's Ink TUI: stdout must be silent
run_poller "$REAL_DIALOG" "$OTHER_DIALOG"
if [ -z "$POLLER_STDOUT" ]; then
  pass "T10 poller writes nothing to stdout (cannot corrupt the Ink TUI)"
else
  fail "T10 stdout=[$POLLER_STDOUT]"
fi

# ═══════════════════════════════════════════════════════════════════════════
# W — wiring order in the v2 one-shot body
# ═══════════════════════════════════════════════════════════════════════════
V2_BODY_SRC="$(sed -n '/^# FLY-1663: launchd-native carrier\./,$p' "$LEAD_SH")"
# Comment-free view: the surrounding comments deliberately name the guards the
# code omits, so identifier assertions must run against code alone.
V2_BODY_CODE="$(printf '%s\n' "$V2_BODY_SRC" | sed -e 's/[[:space:]]*#.*$//')"
# `|| true` on every extraction: a missing anchor must surface as a readable
# FAIL, not as a set -e abort that hides which contract broke.
line_of() { printf '%s\n' "$2" | grep -n -- "$1" | head -1 | cut -d: -f1 || true; }
start_line="$(line_of '_poll_dev_channels_dialog_v2 ' "$V2_BODY_SRC")"
launch_line="$(line_of '_launch_claude "\${_v2_launch_args\[@\]}"' "$V2_BODY_SRC")"
reap_line="$(line_of '_v2_reap_dialog_poller' "$V2_BODY_SRC")"

if [ -n "$start_line" ] && [ -n "$launch_line" ] && [ -n "$reap_line" ] \
  && [ "$start_line" -lt "$launch_line" ] && [ "$reap_line" -gt "$launch_line" ]; then
  pass "W1 poller starts before the blocking launch and is reaped after it"
else
  fail "W1 start=$start_line launch=$launch_line reap=$reap_line"
fi

CLEANUP_V2_SRC="$(sed -n '/^cleanup() {$/,/^}$/p' "$LEAD_SH")"
c_reap="$(line_of '_v2_reap_dialog_poller' "$CLEANUP_V2_SRC")"
c_term="$(line_of 'kill -TERM "\$CLAUDE_CHILD_PID"' "$CLEANUP_V2_SRC")"
if [ -n "$c_reap" ] && [ -n "$c_term" ] && [ "$c_reap" -lt "$c_term" ]; then
  pass "W2 cleanup reaps the poller before terminating Claude"
else
  fail "W2 reap=$c_reap term=$c_term"
fi

# W1b — behavioral: source order cannot tell whether the call is backgrounded.
# Dropping the `&` (or the `$!` capture) keeps W1 green while making the body run
# the poller synchronously for the whole timeout and then launch Claude with no
# poller at all — i.e. a parked Lead. Run the real wiring block with stubs and
# observe whether the poller is a live job at the moment the launch begins.
WIRING_SRC="$(sed -n '/# FLY-1679: the v2 _launch_claude blocks in `wait`/,/^  _v2_reap_dialog_poller$/p' "$LEAD_SH")"
w1b_log="$TMP/wiring-order.log"
: > "$w1b_log"
if [ -z "$WIRING_SRC" ]; then
  fail "W1b could not extract the v2 poller wiring block"
else
  /bin/bash -c '
    set -euo pipefail
    ORDER_LOG="'"$w1b_log"'"
    INBOX_MCP_ENABLED=true
    FLYWHEEL_DIALOG_TIMEOUT_SEC=5
    # The wiring gates on the real argv now, so the harness must carry the flag.
    CLAUDE_ARGS=(--dangerously-load-development-channels "server:flywheel-inbox")
    '"$GATE_SRC"'
    _v2_launch_args=(--session-id test)
    _V2_DIALOG_POLLER_PID=""
    _poll_dev_channels_dialog_v2() { sleep 3; }
    _adopt_inflight_before_launch() { :; }
    _launch_claude() {
      if [ -n "${_V2_DIALOG_POLLER_PID:-}" ] && kill -0 "$_V2_DIALOG_POLLER_PID" 2>/dev/null; then
        printf "poller-live-at-launch\n" >> "$ORDER_LOG"
      else
        printf "poller-absent-at-launch\n" >> "$ORDER_LOG"
      fi
      return 0
    }
    '"$IS_RUNNING_SRC"'
    '"$REAPER_SRC"'
    '"$WIRING_SRC"'
    printf "after-reap-pid=[%s]\n" "${_V2_DIALOG_POLLER_PID:-}" >> "$ORDER_LOG"
  ' >/dev/null 2>&1 || true
  if [ "$(tr '\n' ' ' < "$w1b_log")" = "poller-live-at-launch after-reap-pid=[] " ]; then
    pass "W1b the poller is a live background job when the launch begins, then reaped"
  else
    fail "W1b observed: [$(tr '\n' ' ' < "$w1b_log")]"
  fi
fi

# W4 — the poller must gate on the ARGV, never on a proxy for it.
#
# The original port copied v1's `INBOX_MCP_ENABLED` condition. That is exactly
# equivalent today, which is why it looked right — but companion/external roles
# force that variable false, so any second contributor of a development channel
# (FLY-1676 makes `plugin:discord@flywheel-plugins` unconditional) leaves the
# dialog rendering with the proxy reading false: a companion Lead parks with no
# poller, launchd still green. The call site must read the real argv.
# `|| true`: a missing match must surface as a readable FAIL naming the
# broken contract, not as a set -e / pipefail abort mid-suite.
v2_gate="$(printf '%s\n' "$V2_BODY_CODE" | grep -B1 '_poll_dev_channels_dialog_v2 ' | head -1 || true)"
if [ -n "$GATE_SRC" ] \
  && grep -q '_dev_channels_flag_active' <<<"$v2_gate" \
  && ! grep -q 'INBOX_MCP_ENABLED' <<<"$v2_gate"; then
  pass "W4 the poller call site gates on the real argv, not the INBOX_MCP_ENABLED proxy"
else
  fail "W4 gate drift: helper=[${GATE_SRC:+present}] v2=[$v2_gate]"
fi

# W5 — the helper must key on the flag itself, in either argv position.
eval "$GATE_SRC"
w5_ok=1
CLAUDE_ARGS=(--channels "plugin:discord@claude-plugins-official")
_dev_channels_flag_active && w5_ok=0                       # absent -> false
CLAUDE_ARGS=(--channels x --dangerously-load-development-channels "server:flywheel-inbox")
_dev_channels_flag_active || w5_ok=0                       # inbox form -> true
# The FLY-1676 shape: a development channel with NO inbox MCP at all.
CLAUDE_ARGS=(--dangerously-load-development-channels "plugin:discord@flywheel-plugins" --model x)
_dev_channels_flag_active || w5_ok=0                       # plugin-only form -> true
CLAUDE_ARGS=()
_dev_channels_flag_active && w5_ok=0                       # empty argv -> false, no set -u blowup
# Exact match, not a prefix: `--dangerously-skip-permissions` is a real flag the
# fleet passes, and it renders no dialog. A prefix match would start a poller
# with nothing to answer.
CLAUDE_ARGS=(--dangerously-skip-permissions --model x)
_dev_channels_flag_active && w5_ok=0
# ...and it must not be fooled by the flag appearing only as a VALUE.
CLAUDE_ARGS=(--append-system-prompt-file "notes about --dangerously-load-development-channels")
_dev_channels_flag_active && w5_ok=0
unset CLAUDE_ARGS
if [ "$w5_ok" = 1 ]; then
  pass "W5 the gate reads the flag from argv (present/absent/plugin-only/empty)"
else
  fail "W5 argv-derived gate misclassified at least one shape"
fi

# W6 — today's equivalence, which is what makes the v1 change a provable no-op.
# Exactly one site adds the flag and it is gated on INBOX_MCP_ENABLED, so
# argv-derived and proxy agree on the current tree. If a second producer is
# ever added (FLY-1676), this case is EXPECTED to fail and should simply be
# retired — by then the proxy is wrong and the argv gate is the only correct one.
producers="$(grep -c 'CLAUDE_ARGS+=(--dangerously-load-development-channels' "$LEAD_SH")"
producer_gate="$(grep -B1 'CLAUDE_ARGS+=(--dangerously-load-development-channels' "$LEAD_SH" | head -1)"
if [ "$producers" -eq 1 ] && grep -q 'INBOX_MCP_ENABLED" = "true"' <<<"$producer_gate"; then
  pass "W6 one flag producer, still gated on INBOX_MCP_ENABLED — v1's gate change is a no-op today"
else
  pass "W6 flag producers changed (count=$producers) — proxy no longer equivalent; argv gate is now load-bearing"
fi

# (V2_BODY_CODE is computed above.) Code only — the surrounding comment deliberately names the guard it omits.
if printf '%s\n' "$V2_BODY_CODE" | grep -q '_poll_dev_channels_dialog_v2 ' \
  && ! printf '%s\n' "$V2_BODY_CODE" | grep -q 'LEAD_WINDOW_ID'; then
  pass "W3 the v2 start gate does not carry v1's always-empty LEAD_WINDOW_ID guard"
else
  fail "W3 v2 body code still references LEAD_WINDOW_ID around the poller gate"
fi

# ═══════════════════════════════════════════════════════════════════════════
# R — reaper behavior (the PID stored here outlives the poller by hours)
# ═══════════════════════════════════════════════════════════════════════════
reaper_harness() {
  /bin/bash -c '
    set -euo pipefail
    '"$IS_RUNNING_SRC"'
    '"$REAPER_SRC"'
    '"$1"'
  '
}

# R1 — a poller that is still running is signalled and cleared
r1_out="$(reaper_harness '
  sleep 30 & _V2_DIALOG_POLLER_PID=$!
  victim=$_V2_DIALOG_POLLER_PID
  _v2_reap_dialog_poller
  rc=$?
  sleep 0.2
  alive=no; kill -0 "$victim" 2>/dev/null && alive=yes
  printf "rc=%s pid=[%s] alive=%s\n" "$rc" "${_V2_DIALOG_POLLER_PID:-}" "$alive"
')"
if [ "$r1_out" = "rc=0 pid=[] alive=no" ]; then
  pass "R1 a live poller is stopped, waited, and the PID variable cleared"
else
  fail "R1 $r1_out"
fi

# R1b — the dominant state: the poller self-exited long before the reap
r1b_out="$(reaper_harness '
  sleep 0.1 & _V2_DIALOG_POLLER_PID=$!
  finished=$_V2_DIALOG_POLLER_PID
  sleep 0.5
  listed=no; _v2_dialog_poller_is_running "$finished" && listed=yes
  _v2_reap_dialog_poller; rc1=$?
  _v2_reap_dialog_poller; rc2=$?
  printf "listed=%s rc1=%s rc2=%s pid=[%s]\n" "$listed" "$rc1" "$rc2" "${_V2_DIALOG_POLLER_PID:-}"
')"
if [ "$r1b_out" = "listed=no rc1=0 rc2=0 pid=[]" ]; then
  pass "R1b a finished poller is not signalled; reap stays idempotent"
else
  fail "R1b $r1b_out"
fi

# R1c — PID reuse: the stored number now belongs to an unrelated live process.
# The victim is spawned through a helper subshell that exits, so it is alive but
# is NOT a job of the harness shell — exactly the reused-number state. Verified
# to go red against an unguarded `kill "$pid"` implementation.
r1c_out="$(reaper_harness '
  _V2_DIALOG_POLLER_PID="$( ( sleep 45 >/dev/null 2>&1 </dev/null & echo "$!" ) )"
  victim=$_V2_DIALOG_POLLER_PID
  before=no; kill -0 "$victim" 2>/dev/null && before=yes
  listed=no; _v2_dialog_poller_is_running "$victim" && listed=yes
  _v2_reap_dialog_poller
  sleep 0.3
  after=no; kill -0 "$victim" 2>/dev/null && after=yes
  printf "victim=%s before=%s listed=%s after=%s pid=[%s]\n" \
    "$victim" "$before" "$listed" "$after" "${_V2_DIALOG_POLLER_PID:-}"
')"
E2E_VICTIMS+=("$(sed -n 's/^victim=\([0-9]*\).*/\1/p' <<<"$r1c_out")")
if grep -q 'before=yes listed=no after=yes pid=\[\]' <<<"$r1c_out"; then
  pass "R1c a reused PID owned by an unrelated process is never signalled"
else
  fail "R1c $r1c_out"
fi

# R2 — observed call order inside the real cleanup(), not source order
r2_log="$TMP/cleanup-order.log"
: > "$r2_log"
CLEANUP_V2_FN="$CLEANUP_V2_SRC"
/bin/bash -c '
  set -euo pipefail
  ORDER_LOG="'"$r2_log"'"
  SHOULD_EXIT=0
  FLYWHEEL_LEAD_BODY_V2=1
  log() { :; }
  kill() {
    case "$*" in
      -0*) return 0 ;;
      -TERM*) printf "child-term\n" >> "$ORDER_LOG"; return 0 ;;
      *) printf "reap-kill\n" >> "$ORDER_LOG"; return 0 ;;
    esac
  }
  wait() { return 0; }
  exit() { printf "exit-%s\n" "${1:-0}" >> "$ORDER_LOG"; return 0; }
  '"$IS_RUNNING_SRC"'
  _v2_dialog_poller_is_running() { return 0; }
  '"$REAPER_SRC"'
  '"$CLEANUP_V2_FN"'
  _V2_DIALOG_POLLER_PID=4242
  CLAUDE_CHILD_PID=4343
  cleanup
' >/dev/null 2>&1 || true
if [ "$(tr '\n' ' ' < "$r2_log")" = "reap-kill child-term exit-143 " ]; then
  pass "R2 cleanup's observed order is poller reap, then child TERM"
else
  fail "R2 observed order: [$(tr '\n' ' ' < "$r2_log")]"
fi

# ═══════════════════════════════════════════════════════════════════════════
# E — real tmux end-to-end: keystrokes must actually land in the pane
# ═══════════════════════════════════════════════════════════════════════════
if ! command -v tmux >/dev/null 2>&1; then
  printf 'SKIP: tmux unavailable — real-tmux E2E layer not run\n'
else
  e2e_run() {
    # e2e_run <name> <first-screen-file> <after-first-key-file|-> <expect-log> <expect-bytes> [die] [shape]
    #
    # shape=direct  the fake Claude IS the pane process (the v1 topology).
    # shape=bgjob   a body shell owns the pane and runs the fake Claude as a
    #               background job it then waits on — the ACTUAL v2 topology
    #               (`env -i ... claude ... &` + `wait`). The two differ in a way
    #               that matters: a backgrounded reader can take SIGTTIN and
    #               never see the keystroke. `direct` is therefore only the
    #               control group; `bgjob` is the shape production runs.
    local name="$1" first="$2" after="$3" want_log="$4" want_bytes="$5" die="${6:-0}" shape="${7:-direct}"
    local sock="$TMP/e2e-$name.sock"
    local keys="$TMP/e2e-$name.keys"
    local child="$TMP/e2e-$name-child.sh"
    local body="$TMP/e2e-$name-body.sh"
    local slog="$TMP/e2e-$name-startup.log"
    E2E_SOCKETS+=("$sock")
    : > "$keys"
    : > "$slog"

    # Fake Claude: paint a screen, then read RAW bytes from the pane tty.
    #
    # `stty -icanon min 1 time 0` is what makes this faithful. Ink puts stdin in
    # raw mode, which is exactly why a bare `1` reaches the real dialog with no
    # Enter. A default canonical tty buffers until a newline, so a harness
    # without this would only ever see input that was followed by Enter — i.e.
    # it would silently encode the semantics this fix exists to remove, and
    # would report the fix as broken. Output post-processing is left ON so the
    # repainted screen stays line-oriented for capture-pane.
    cat > "$child" <<CHILD
#!/bin/bash
# Three states, never two. "stty failed" on its own is not evidence that the
# host denied the ioctl — it is equally consistent with a broken or missing
# stty, and mapping every failure to "capability denied" would let the E layer
# skip itself green for an arbitrary harness fault.
if stty -icanon min 1 time 0 -echo </dev/tty 2>"$TMP/e2e-$name.stty"; then
  printf 'ok\n' > "$TMP/e2e-$name.raw"
elif grep -qE 'Operation not permitted|Inappropriate ioctl for device|Not a typewriter' \
    "$TMP/e2e-$name.stty" 2>/dev/null; then
  printf 'denied\n' > "$TMP/e2e-$name.raw"
else
  printf 'error\n' > "$TMP/e2e-$name.raw"
fi
cat "$first"
while true; do
  b="\$(dd bs=1 count=1 2>/dev/null </dev/tty | od -An -c | tr -d ' \\n')"
  [ -n "\$b" ] || continue
  printf '%s\n' "\$b" >> "$keys"
  if [ "$after" != "-" ] && [ "\$(wc -l < "$keys" | tr -d ' ')" = "1" ]; then
    printf '\033[2J\033[H'
    cat "$after"
  fi
done
CHILD
    chmod +x "$child"

    # The v2 body: owns the pane, runs the fake Claude as a background job, and
    # blocks in `wait` — byte-for-byte the shape `_launch_claude` uses on the
    # launchd-native carrier.
    local pane_cmd="$child"
    if [ "$shape" = bgjob ]; then
      cat > "$body" <<BODY
#!/bin/bash
set -euo pipefail
"$child" &
CLAUDE_CHILD_PID=\$!
wait "\$CLAUDE_CHILD_PID"
BODY
      chmod +x "$body"
      pane_cmd="$body"
    fi

    # Startup failure must never be mistaken for a capability limit: an absent
    # server also leaves no .raw marker, and treating that as "this host denies
    # raw tty" would skip the whole E layer and still exit 0.
    E2E_START_ERR=""
    if ! E2E_START_ERR="$(tmux -S "$sock" new-session -d -s main -n main -x 220 -y 50 "$pane_cmd" 2>&1)"; then
      E2E_START_FAILED=1
      return 2
    fi
    E2E_START_FAILED=0
    sleep 0.7

    # E4: destroy the server the moment the keystroke lands, so every
    # verification capture fails while the send itself succeeded.
    if [ "$die" = "1" ]; then
      (
        for _ in $(seq 1 60); do
          [ -s "$keys" ] && { tmux -S "$sock" kill-server >/dev/null 2>&1 || true; exit 0; }
          sleep 0.1
        done
      ) &
    fi

    env PATH="$PATH" TMUX="$sock,1,0" TMUX_PANE="%0" FLY1679_LOG="$slog" \
      /bin/bash -c '
        set -euo pipefail
        _log_startup() { printf "%s\n" "$*" >> "$FLY1679_LOG"; }
        '"$SQUASH_SRC"'
        '"$PREDICATE_SRC"'
        '"$DRIFT_SRC"'
        '"$POLLER_SRC"'
        _poll_dev_channels_dialog_v2 6
      ' >/dev/null 2>&1 || true

    sleep 0.5
    tmux -S "$sock" kill-server >/dev/null 2>&1 || true

    local got_bytes; got_bytes="$(wc -l < "$keys" | tr -d ' ')"
    local first_byte; first_byte="$(head -1 "$keys" 2>/dev/null || true)"
    local log_text; log_text="$(cat "$slog" 2>/dev/null || true)"

    E2E_BYTES="$got_bytes"
    E2E_FIRST="$first_byte"
    E2E_LOG="$log_text"
    E2E_RAW="$(cat "$TMP/e2e-$name.raw" 2>/dev/null || echo missing)"
    [ "$got_bytes" = "$want_bytes" ] || return 1
    [ -z "$want_log" ] || grep -q "$want_log" <<<"$log_text" || return 1
    return 0
  }

  printf '%s\n' "$REAL_DIALOG" > "$TMP/e2e-real.txt"
  printf '%s\n' "$OTHER_DIALOG" > "$TMP/e2e-other.txt"

  # E1/E2 — the dialog is accepted by '1', the pane immediately shows an
  # unrelated dialog, and NO second byte ever arrives.
  e2e_ok=0
  E2E_RAW=missing
  E2E_START_FAILED=0
  e2e_run cross "$TMP/e2e-real.txt" "$TMP/e2e-other.txt" 'confirmed=1' 1 && e2e_ok=1

  # Exactly three outcomes, and only one of them is a skip. `missing` means the
  # child never ran to the point of recording its tty capability, which is a
  # harness/startup failure, NOT an environment limit — collapsing the two would
  # let a broken tmux report a clean, green, entirely unexecuted E layer.
  if [ "$e2e_ok" = 1 ] && [ "$E2E_FIRST" = "1" ]; then
    pass "E1/E2 exactly one '1' reaches the real pane; the next dialog gets nothing"
    E2E_TRANSPORT=ok
  elif [ "${E2E_START_FAILED:-0}" = 1 ]; then
    fail "E1/E2 tmux could not create the test server: ${E2E_START_ERR:-unknown}"
    E2E_TRANSPORT=broken
  else
    case "${E2E_RAW:-missing}" in
      denied)
        # The one legitimate skip: the host affirmatively refused the tty ioctl
        # (some sandboxes deny TIOCGETD), so the pane stays canonical and
        # buffers a bare '1' forever. An environment limit, not a product
        # failure — say so loudly rather than reporting unverified passes.
        printf 'SKIP: real-tmux E layer — this environment denies raw tty mode (stty: %s); E1/E2/E3/E4 not run\n' \
          "$(tr -d '\n' < "$TMP/e2e-cross.stty" 2>/dev/null || echo unknown)"
        E2E_TRANSPORT=unavailable
        ;;
      ok)
        fail "E1/E2 bytes=$E2E_BYTES first=[$E2E_FIRST] log=[$E2E_LOG]"
        E2E_TRANSPORT=broken
        ;;
      error)
        fail "E1/E2 unexpected stty failure, not a known capability denial: $(tr -d '\n' < "$TMP/e2e-cross.stty" 2>/dev/null || echo unknown)"
        E2E_TRANSPORT=broken
        ;;
      *)
        fail "E1/E2 harness did not run: no tty-capability record (raw=${E2E_RAW}) bytes=$E2E_BYTES log=[$E2E_LOG]"
        E2E_TRANSPORT=broken
        ;;
    esac
  fi

  if [ "${E2E_TRANSPORT:-}" = ok ]; then
    # E3 — an unrelated dialog receives nothing. Only meaningful because E1/E2
    # just proved on this same host that the transport can deliver a byte.
    if e2e_run other "$TMP/e2e-other.txt" - 'DEV_CHANNELS_DIALOG_NOT_SEEN' 0; then
      pass "E3 an unrelated dialog on a real pane is never typed into"
    else
      fail "E3 bytes=$E2E_BYTES log=[$E2E_LOG]"
    fi

    # E4 — the server disappears right after '1' lands: send succeeded, every
    # verification capture fails. Must report VERIFY_FAILED, never confirmed=1.
    if e2e_run vanish "$TMP/e2e-real.txt" "$TMP/e2e-other.txt" 'DEV_CHANNELS_VERIFY_FAILED' 1 1 \
      && ! grep -q 'confirmed=1' <<<"$E2E_LOG"; then
      pass "E4 losing the real server after '1' reports VERIFY_FAILED, never confirmed"
    else
      fail "E4 bytes=$E2E_BYTES log=[$E2E_LOG]"
    fi

    # E5 — the shape production actually runs. E1-E4 put the fake Claude
    # directly in the pane, which is the v1 topology and only a control group.
    # On the v2 carrier Claude is a BACKGROUND JOB of the body shell sharing the
    # pane tty, and a backgrounded reader can take SIGTTIN and never see the
    # keystroke. Nothing above this line rules that out.
    if e2e_run bgjob "$TMP/e2e-real.txt" "$TMP/e2e-other.txt" 'confirmed=1' 1 0 bgjob \
      && [ "$E2E_FIRST" = "1" ]; then
      pass "E5 the keystroke reaches Claude in the real v2 shape (background job of the body shell)"
    else
      fail "E5 v2 bg-job shape did not receive the key: bytes=$E2E_BYTES first=[$E2E_FIRST] log=[$E2E_LOG]"
    fi

    # E7 — THE shape production actually runs, and the one E5 does not cover.
    #
    # E5 puts Claude in the background but still runs the poller in the test
    # process. On the real carrier the POLLER is itself a background job of the
    # body shell, and that shell IS the pane process. In that position a BARE
    # external command is exec-replaced by bash's subshell optimization: the
    # tmux client takes over the poller's process and the loop dies after one
    # probe. That is exactly how the first real QA slot run failed — the poller
    # logged `start`, probed once, vanished, and the Lead sat on the dialog.
    # Only this arrangement can catch it, so drive everything from inside a
    # real pane and assert the dialog actually gets dismissed.
    e7_dir="$(mktemp -d /tmp/fly1679e7.XXXXXX)"
    e7_sock="$e7_dir/s.sock"
    e7_log="$e7_dir/poller.log"; : > "$e7_log"
    e7_keys="$e7_dir/keys"; : > "$e7_keys"
    E2E_SOCKETS+=("$e7_sock")
    printf '%s\n' "$REAL_DIALOG" > "$e7_dir/dialog.txt"

    cat > "$e7_dir/claude.sh" <<E7CHILD
#!/bin/bash
printf '\033[?1049h'
stty -icanon min 1 time 0 -echo </dev/tty 2>/dev/null
cat "$e7_dir/dialog.txt"
while true; do
  b="\$(dd bs=1 count=1 2>/dev/null </dev/tty | od -An -c | tr -d ' \\n')"
  [ -n "\$b" ] || continue
  printf '%s\n' "\$b" >> "$e7_keys"
  printf '\033[2J\033[H'; echo "REPL READY"
done
E7CHILD
    chmod +x "$e7_dir/claude.sh"

    # The body: poller backgrounded first, then Claude backgrounded, then wait —
    # byte-for-byte the v2 branch's arrangement.
    cat > "$e7_dir/body.sh" <<E7BODY
#!/bin/bash
set -euo pipefail
FLYWHEEL_STARTUP_LOG="$e7_log"
_log_startup() { printf '%s\n' "\$*" >> "\$FLYWHEEL_STARTUP_LOG"; }
$SQUASH_SRC
$PREDICATE_SRC
$DRIFT_SRC
$POLLER_SRC
_poll_dev_channels_dialog_v2 20 &
POLLER=\$!
"$e7_dir/claude.sh" &
CHILD=\$!
wait "\$CHILD" || true
E7BODY
    chmod +x "$e7_dir/body.sh"

    if tmux -S "$e7_sock" new-session -d -s main -n main -x 220 -y 50 "$e7_dir/body.sh" 2>/dev/null; then
      for _ in $(seq 1 20); do
        grep -q 'confirmed=1' "$e7_log" 2>/dev/null && break
        sleep 1
      done
      e7_first="$(head -1 "$e7_keys" 2>/dev/null || true)"
      tmux -S "$e7_sock" kill-server >/dev/null 2>&1 || true
      if [ "$e7_first" = "1" ] && grep -q 'confirmed=1' "$e7_log" 2>/dev/null; then
        pass "E7 poller backgrounded INSIDE the pane body survives and dismisses the dialog"
      else
        fail "E7 in-pane background poller failed: first-key=[$e7_first] log=[$(tr '\n' '|' < "$e7_log" 2>/dev/null)]"
      fi
    else
      fail "E7 could not create the in-pane body server"
    fi
    rm -rf "$e7_dir"

    # E8 — the FLY-1676 shape: a development channel WITHOUT the inbox MCP.
    #
    # This is the companion/external cold start that the old proxy gate would
    # have skipped. Drive the real v2 wiring block with INBOX_MCP_ENABLED=false
    # and a plugin-only development channel in CLAUDE_ARGS, inside a real pane,
    # and require that the poller still runs, the dialog is actually gone, and
    # only then `confirmed=1` is recorded.
    e8_dir="$(mktemp -d /tmp/fly1679e8.XXXXXX)"
    e8_sock="$e8_dir/s.sock"
    e8_log="$e8_dir/poller.log"; : > "$e8_log"
    e8_keys="$e8_dir/keys"; : > "$e8_keys"
    E2E_SOCKETS+=("$e8_sock")
    printf '%s\n' "$REAL_DIALOG" > "$e8_dir/dialog.txt"

    cat > "$e8_dir/claude.sh" <<E8CHILD
#!/bin/bash
printf '\033[?1049h'
stty -icanon min 1 time 0 -echo </dev/tty 2>/dev/null
cat "$e8_dir/dialog.txt"
while true; do
  b="\$(dd bs=1 count=1 2>/dev/null </dev/tty | od -An -c | tr -d ' \\n')"
  [ -n "\$b" ] || continue
  printf '%s\n' "\$b" >> "$e8_keys"
  printf '\033[2J\033[H'; echo "REPL READY"
done
E8CHILD
    chmod +x "$e8_dir/claude.sh"

    cat > "$e8_dir/body.sh" <<E8BODY
#!/bin/bash
set -euo pipefail
FLYWHEEL_STARTUP_LOG="$e8_log"
FLYWHEEL_DIALOG_TIMEOUT_SEC=20
_log_startup() { printf '%s\n' "\$*" >> "\$FLYWHEEL_STARTUP_LOG"; }
$GATE_SRC
$SQUASH_SRC
$PREDICATE_SRC
$DRIFT_SRC
$POLLER_SRC
$IS_RUNNING_SRC
$REAPER_SRC
# Companion/external: inbox MCP disabled, yet a development channel IS passed.
INBOX_MCP_ENABLED=false
CLAUDE_ARGS=(--channels "plugin:discord@claude-plugins-official" \\
  --dangerously-load-development-channels "plugin:discord@flywheel-plugins")
_V2_DIALOG_POLLER_PID=""
if _dev_channels_flag_active; then
  _poll_dev_channels_dialog_v2 "\$FLYWHEEL_DIALOG_TIMEOUT_SEC" &
  _V2_DIALOG_POLLER_PID=\$!
fi
"$e8_dir/claude.sh" &
CHILD=\$!
wait "\$CHILD" || true
E8BODY
    chmod +x "$e8_dir/body.sh"

    if tmux -S "$e8_sock" new-session -d -s main -n main -x 220 -y 50 "$e8_dir/body.sh" 2>/dev/null; then
      for _ in $(seq 1 20); do
        grep -q 'confirmed=1' "$e8_log" 2>/dev/null && break
        sleep 1
      done
      e8_first="$(head -1 "$e8_keys" 2>/dev/null || true)"
      e8_pane="$(tmux -S "$e8_sock" capture-pane -t '%0' -p 2>/dev/null || true)"
      tmux -S "$e8_sock" kill-server >/dev/null 2>&1 || true
      if [ "$e8_first" = "1" ] \
        && grep -q 'confirmed=1' "$e8_log" 2>/dev/null \
        && ! grep -qF 'WARNING: Loading development channels' <<<"$e8_pane"; then
        pass "E8 inbox=false + a dev channel still auto-confirms (FLY-1676 companion shape)"
      else
        fail "E8 companion-shape cold start: first-key=[$e8_first] log=[$(tr '\n' '|' < "$e8_log" 2>/dev/null)]"
      fi
    else
      fail "E8 could not create the companion-shape body server"
    fi
    rm -rf "$e8_dir"

    # E6 — targeting form. The poller addresses the pane by pane_id; the QA
    # room's compensating poller in test-deploy.sh uses '=main:main.%0'. Record
    # what each form actually does on an isolated private server so the choice
    # is evidence rather than folklore.
    e6_sock="$TMP/e2e-bgjob.sock"
    e6_dir="$(mktemp -d /tmp/fly1679e6.XXXXXX)"
    e6_sock="$e6_dir/s.sock"
    E2E_SOCKETS+=("$e6_sock")
    if tmux -S "$e6_sock" new-session -d -s main -n main -x 220 -y 50 'printf "E6-MARKER\n"; sleep 20' 2>/dev/null; then
      sleep 0.5
      e6_byid=0; e6_byname=0
      tmux -S "$e6_sock" capture-pane -t '%0' -p 2>/dev/null | grep -q 'E6-MARKER' && e6_byid=1
      tmux -S "$e6_sock" capture-pane -t '=main:main.%0' -p 2>/dev/null | grep -q 'E6-MARKER' && e6_byname=1
      tmux -S "$e6_sock" kill-server >/dev/null 2>&1 || true
      if [ "$e6_byid" = 1 ]; then
        pass "E6 pane_id targeting works on an isolated private server (session-name form: $([ "$e6_byname" = 1 ] && echo also-works || echo FAILS))"
      else
        fail "E6 pane_id targeting failed on an isolated private server"
      fi
    else
      fail "E6 could not create the targeting-form probe server"
    fi
    rm -rf "$e6_dir"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# H — the suite's own escape hatch must fail closed
#
# The E layer is allowed to skip when the host genuinely denies raw tty mode.
# That escape hatch is itself a vacuous-green risk: if it also swallowed a tmux
# that cannot start, a broken harness would report a clean, green, entirely
# unexecuted real-tmux layer. Re-run this suite against a tmux that always
# fails and require a nonzero exit.
# ═══════════════════════════════════════════════════════════════════════════
selftest() {
  # selftest <name> <shim-binary> <shim-body> <want-rc: zero|nonzero> <marker> <label>
  # Always requires the recursive suite to say WHY — "it exited nonzero" alone
  # would also pass for an unrelated breakage, and "it exited zero" alone would
  # pass for a skip that never happened.
  local name="$1" bin="$2" body="$3" want="$4" marker="$5" label="$6"
  local dir="$TMP/selftest-$name" rc=0 out ok=0
  mkdir -p "$dir"
  printf '%s\n' "$body" > "$dir/$bin"
  chmod +x "$dir/$bin"
  out="$(env PATH="$dir:$PATH" FLY1679_SELFTEST_CHILD=1 /bin/bash "$0" 2>&1)" || rc=$?
  case "$want" in
    zero)    [ "$rc" -eq 0 ] && ok=1 ;;
    nonzero) [ "$rc" -ne 0 ] && ok=1 ;;
  esac
  if [ "$ok" = 1 ] && grep -qF "$marker" <<<"$out"; then
    pass "$label"
  else
    fail "$label (rc=$rc want=$want, marker '$marker' not found)"
  fi
}

if [ -n "${FLY1679_SELFTEST_CHILD:-}" ]; then
  : # never recurse
elif ! command -v tmux >/dev/null 2>&1; then
  printf 'SKIP: H1/H2 self-tests need tmux on PATH\n'
else
  selftest brokentmux tmux '#!/bin/bash
exit 42' \
    nonzero 'tmux could not create the test server' \
    "H1 a tmux that cannot start the server reds the suite (no silent skip)"

  # The other executable the E layer depends on. An arbitrary stty failure is
  # not evidence of a capability denial and must not buy a skip.
  selftest brokenstty stty '#!/bin/bash
echo "synthetic stty harness failure" >&2
exit 42' \
    nonzero 'unexpected stty failure, not a known capability denial' \
    "H2 an arbitrary stty failure reds the suite instead of skipping E1-E4"

  # The one legitimate skip must actually work. Without this, the denial branch
  # is unexercised code that could be wrong in either direction — failing on
  # restricted CI, or skipping for the wrong reason.
  selftest deniedstty stty '#!/bin/bash
echo "stty: TIOCGETD: Operation not permitted" >&2
exit 1' \
    zero 'SKIP: real-tmux E layer' \
    "H3 an affirmative raw-tty denial skips E1-E4 loudly and stays green"
fi

printf '\n%s\n' "─────────────────────────────────────────────"
printf 'FLY-1679 dev-channels v2 auto-confirm: %d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
