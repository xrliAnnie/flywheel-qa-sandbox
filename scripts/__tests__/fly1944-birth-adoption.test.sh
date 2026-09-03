#!/usr/bin/env bash
# FLY-1944 C2: processTitle is immutable birth ownership, not live content.
# Wrong-title workspaces may be adopted by UUID/surface join; duplicates are
# always judged by current liveness before any close.

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export FLYWHEEL_CMUX_VIEW_HELPER_BIN="$ROOT/scripts/flywheel-view-attach.sh"
export FLYWHEEL_CMUX_LEAD_ATTACH_BIN="$ROOT/scripts/flywheel-lead-attach.sh"
export VIEW_LEDGER="$TMP/ledger"
export CMUX_ADOPT_CAP_STATE="$TMP/adopt-cap"
export FLYWHEEL_CMUX_SESSION_STATE="$TMP/cmux-session.json"
export FLYWHEEL_ENV_FILE="$TMP/flywheel.env"
: > "$FLYWHEEL_ENV_FILE"
# shellcheck source=../flywheel-cmux-sync.sh
source "$ROOT/scripts/flywheel-cmux-sync.sh"
set +e

pass=0; fail=0
ok() { pass=$((pass + 1)); printf 'PASS: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1" >&2; }
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

test_fly2281_pinned_process_title_restores_birth_authority() {
  local tmux_bin="$TMP/fly2281-tmux" title="FLY-2281-implement"
  local target="cmux-FLY-2281-implement" token="fwtok1-22812281228122812281228122812281"
  local workspace_uuid="00000000-0000-4000-8000-000000002281"
  local surface_uuid="00000000-0000-4000-8000-000000012281"
  local raw command rows expected saved_cmux_call
  cp /usr/bin/true "$tmux_bin"
  printf 'FLYWHEEL_CMUX_ATTACH_TMUX_BIN=%s\n' "$tmux_bin" > "$FLYWHEEL_ENV_FILE"
  unset FLYWHEEL_CMUX_ATTACH_TMUX_BIN
  cmux_attach_tmux_bin_cache_prime || {
    bad "persisted attach tmux pin did not prime for birth fixture"
    return
  }
  command=$(build_attach_command "$target" "$token") || {
    bad "pinned birth fixture command did not build"
    return
  }
  python3 - "$CMUX_SESSION_STATE" "$surface_uuid" "$command" <<'PY'
import json,sys
path,surface,command=sys.argv[1:]
with open(path,"w",encoding="utf-8") as out:
    json.dump({"windows":[{"tabManager":{"workspaces":[{
        "focusedPanelId":surface,
        "processTitle":command,
        "panels":[{"type":"terminal","id":surface}],
    }]}}]},out)
PY
  raw=$(python3 - "$workspace_uuid" "$title" <<'PY'
import json,sys
uuid,title=sys.argv[1:]
print(json.dumps({"workspaces":[{"ref":"workspace:2281","id":uuid,"title":title}]}))
PY
  )
  saved_cmux_call=$(declare -f cmux_call)
  cmux_call() {
    printf '{"workspace_id":"%s","surfaces":[{"id":"%s","type":"terminal"}]}\n' \
      "$workspace_uuid" "$surface_uuid"
  }
  rows=$(_cmux_attach_birth_records_uncached "$raw")
  eval "$saved_cmux_call"
  expected="workspace:2281|$workspace_uuid|$(b64 "$title")|$surface_uuid|view|$(b64 "$target")|$token"
  if [[ "$rows" == "$expected" ]]; then
    ok "persisted pinned processTitle reconstructs the exact workspace/surface birth row"
  else
    bad "pinned processTitle birth row mismatch expected=[$expected] actual=[$rows]"
  fi
}

test_fly2281_pinned_process_title_restores_birth_authority

printf '1\n' > "$CMUX_ADOPT_CAP_STATE"
CMUX_ADOPTION_COUNT=0
cmux_adoption_slot_claim
first_cap_rc=$?
cmux_adoption_slot_claim
second_cap_rc=$?
printf 'invalid\n' > "$CMUX_ADOPT_CAP_STATE"
CMUX_ADOPTION_COUNT=0
cmux_adoption_slot_claim
invalid_cap_rc=$?
printf '10\n' > "$CMUX_ADOPT_CAP_STATE"
CMUX_ADOPTION_COUNT=0
if [[ "$first_cap_rc" == 0 && "$second_cap_rc" != 0 && "$invalid_cap_rc" != 0 ]]; then
  ok "per-pass adoption cap defaults fail-closed and enforces the file valve"
else
  bad "adoption cap mismatch first=$first_cap_rc second=$second_cap_rc invalid=$invalid_cap_rc"
fi

cas_uuid=00000000-0000-4000-8000-000000009944
printf '%s\n' \
  'committed|generation-stale|workspace:44|FLY-1944-cas' \
  'committed|generation-current|workspace:44|FLY-1944-cas' > "$VIEW_LEDGER"
saved_lease_assert=$(declare -f assert_or_reuse_owned_lease)
assert_or_reuse_owned_lease() { return 0; }
MUTATOR_LEASE_INCARNATION=test-incarnation
_ledger_upgrade_legacy_uuid generation-current workspace:44 FLY-1944-cas "$cas_uuid"
cas_rc=$?
eval "$saved_lease_assert"
cas_rows=$(cat "$VIEW_LEDGER")
: > "$VIEW_LEDGER"
if [[ "$cas_rc" == 0 \
    && "$cas_rows" == $'committed|generation-stale|workspace:44|FLY-1944-cas\ncommitted|generation-current|workspace:44|FLY-1944-cas|'"$cas_uuid" ]]; then
  ok "legacy UUID upgrade scopes uniqueness to the active generation"
else
  bad "legacy UUID generation CAS mismatch rc=$cas_rc rows=[$cas_rows]"
fi

title=FLY-1944-implement
target=cmux-FLY-1944-implement
TEST_TARGET_B64=$(b64 "$target")
TEST_UUID=00000000-0000-4000-8000-000000001944
TEST_SURFACE_UUID=00000000-0000-4000-8000-000000002944
raw_json='{"workspaces":[{"ref":"workspace:44","id":"00000000-0000-4000-8000-000000001944","title":"~"}]}'
births="workspace:44|$TEST_UUID|$(b64 '~')|$TEST_SURFACE_UUID|view|$TEST_TARGET_B64|fwtok1-0123456789abcdef0123456789abcdef"
normal=$(workspace_title_candidates "$raw_json" "$title" "$(build_attach_command "$target")")
birth_rows=$(workspace_birth_candidate_rows "$raw_json" "$births" view "$TEST_TARGET_B64" "$normal")
if [[ -z "$normal" && "$birth_rows" == 'birth|workspace:44|0|0|44' ]]; then
  ok "UUID/surface birth join discovers a wrong-title workspace without title authority"
else
  bad "birth candidate discovery mismatch normal=[$normal] birth=[$birth_rows]"
fi

shape_json='{"workspaces":[{"ref":"workspace:43","title":"FLY-1944-implement"},{"ref":"workspace:44","id":"00000000-0000-4000-8000-000000001944","title":"~"}]}'
shape=$(workspace_candidate_shape "$shape_json" "$title" "$(build_attach_command "$target")" \
  "$births" view "$TEST_TARGET_B64")
if [[ "$shape" == '1|2|workspace:43' ]]; then
  ok "read-only candidate shape counts a hidden birth-owned duplicate"
else
  bad "birth-aware candidate shape mismatch [$shape]"
fi

workspace_title='~'
surface_title='foreign-editor'
ledger_state=none
ledger_uuid="$TEST_UUID"
BIRTH_KIND=view
BIRTH_TARGET_B64="$TEST_TARGET_B64"
calls="$TMP/calls"; : > "$calls"
cmux_socket_identity() { printf '%s\n' generation-1; }
title_source_authorized() { return 0; }
production_birth_record_fn=$(declare -f cmux_workspace_birth_record)
cmux_workspace_birth_record() {
  local requested_uuid="${2:-}"
  [[ -z "$requested_uuid" || "$requested_uuid" == "$TEST_UUID" ]] || return 1
  printf 'workspace:44|%s|%s|%s|%s|%s|fwtok1-0123456789abcdef0123456789abcdef\n' \
    "$TEST_UUID" "$(b64 "$workspace_title")" "$TEST_SURFACE_UUID" "$BIRTH_KIND" "$BIRTH_TARGET_B64"
}
reused_birth_token=$(workspace_birth_attach_token workspace:44 view "$TEST_TARGET_B64")
wrong_birth_token=$(workspace_birth_attach_token workspace:44 lead "$TEST_TARGET_B64" 2>/dev/null || true)
if [[ "$reused_birth_token" == fwtok1-0123456789abcdef0123456789abcdef \
    && -z "$wrong_birth_token" ]]; then
  ok "heal attribution reuses only the exact birth kind/target token"
else
  bad "birth token reuse mismatch exact=[$reused_birth_token] wrong=[$wrong_birth_token]"
fi
ledger_candidate_receipt_state() { printf '%s\n' "$ledger_state"; }
ledger_exact_receipt_state() { printf '%s\n' "$ledger_state"; }
ledger_exact_receipt_uuid() { printf '%s\n' "$ledger_uuid"; }
_ledger_upsert() {
  ledger_state="$1"
  [[ -z "${5:-}" ]] || ledger_uuid="$5"
  printf 'ledger:%s:%s\n' "$1" "${5:-legacy}" >> "$calls"
}
workspace_title_for_ref() { printf '%s\n' "$workspace_title"; }
workspace_single_surface_title() { printf '%s\n' "$surface_title"; }
cmux_call_guarded() {
  local guard="$1" op="$2"; shift 2
  GUARD_WAS_BLOCKED=0
  "$guard" || { GUARD_WAS_BLOCKED=1; return 1; }
  printf 'cmux:%s\n' "$op" >> "$calls"
  [[ "$op" == rename-workspace ]] && workspace_title="$title"
  [[ "$op" == rename-tab ]] && surface_title="$title"
  return 0
}
adopt_birth_candidate runner-flywheel @44 "$title" generation-1 workspace:44 view "$TEST_TARGET_B64"
adopt_rc=$?
if [[ "$adopt_rc" == 0 && "$workspace_title" == "$title" && "$surface_title" == "$title" \
    && "$ledger_state" == committed \
    && "$(cat "$calls")" == $'ledger:prepared:'"$TEST_UUID"$'\ncmux:rename-workspace\ncmux:rename-tab\nledger:committed:'"$TEST_UUID" ]]; then
  ok "birth adoption renames both faces and commits the exact workspace UUID"
else
  bad "birth adoption transaction rc=$adopt_rc calls=[$(cat "$calls")] titles=[$workspace_title/$surface_title] state=$ledger_state"
fi

# A committed receipt proves ownership, not that both founder-visible titles
# have already converged. Replay must therefore repair drift without minting a
# second prepared row, while still pinning the exact workspace UUID.
workspace_title='~'
surface_title='foreign-editor'
ledger_state=committed
: > "$calls"
adopt_birth_candidate runner-flywheel @44 "$title" generation-1 workspace:44 view "$TEST_TARGET_B64"
committed_rc=$?
if [[ "$committed_rc" == 0 && "$workspace_title" == "$title" && "$surface_title" == "$title" \
    && "$(cat "$calls")" == $'cmux:rename-workspace\ncmux:rename-tab\nledger:committed:'"$TEST_UUID" ]]; then
  ok "committed birth receipt repairs title drift without re-preparing authority"
else
  bad "committed birth replay rc=$committed_rc calls=[$(cat "$calls")] titles=[$workspace_title/$surface_title]"
fi

# The ordinary private-v2 path must never leave the judge with a four-field
# receipt. Existing committed legacy rows are upgraded only after the exact
# generation/ref/title/birth UUID has been re-proved; new rows carry the UUID
# from their first prepared write.
_v2_lead_roster_row_current() { return 0; }
workspace_identity_matches() { [[ "$1|$2|$3" == "workspace:44|$title|$TEST_UUID" ]]; }
_ledger_upgrade_legacy_uuid() {
  ledger_uuid="$4"
  printf 'upgrade:%s\n' "$4" >> "$calls"
}
guard_birth=$(cmux_workspace_birth_record workspace:44 "$TEST_UUID")
guard_ident_calls="$TMP/v2-guard-ident.calls"
printf '0\n' > "$guard_ident_calls"
saved_identity=$(declare -f cmux_socket_identity)
cmux_socket_identity() {
  local count
  count=$(cat "$guard_ident_calls")
  count=$((count + 1))
  printf '%s\n' "$count" > "$guard_ident_calls"
  [[ "$count" == 1 ]] && printf 'generation-1\n' || printf 'generation-2\n'
}
_GUARD_V2_GENERATION=generation-1
_GUARD_V2_REF=workspace:44
_GUARD_V2_TITLE="$title"
_GUARD_V2_SOCKET=/tmp/lead.sock
_GUARD_V2_BIRTH_UUID="$TEST_UUID"
_GUARD_V2_BIRTH_RECORD="$guard_birth"
ledger_state=committed
ledger_uuid="$TEST_UUID"
_v2_lead_birth_guard
v2_guard_flip_rc=$?
eval "$saved_identity"
if [[ "$v2_guard_flip_rc" != 0 && "$(cat "$guard_ident_calls")" == 2 ]]; then
  ok "private-v2 birth guard re-pins generation after its birth RPC"
else
  bad "private-v2 birth guard missed trailing generation flip rc=$v2_guard_flip_rc calls=$(cat "$guard_ident_calls")"
fi
workspace_title="$title"
surface_title="$title"
BIRTH_KIND=lead
BIRTH_TARGET_B64=$(b64 /tmp/lead.sock)
ledger_state=committed
ledger_uuid=__LEGACY__
: > "$calls"
_v2_lead_prepare_and_name generation-1 workspace:44 "$title" /tmp/lead.sock \
  "$(build_lead_attach_command /tmp/lead.sock)" "$TEST_UUID"
legacy_upgrade_rc=$?
legacy_upgrade_calls=$(cat "$calls")

ledger_state=none
ledger_uuid=""
: > "$calls"
_v2_lead_prepare_and_name generation-1 workspace:44 "$title" /tmp/lead.sock \
  "$(build_lead_attach_command /tmp/lead.sock)" "$TEST_UUID"
new_writer_rc=$?
new_writer_calls=$(cat "$calls")
if [[ "$legacy_upgrade_rc" == 0 && "$legacy_upgrade_calls" == "upgrade:$TEST_UUID" \
    && "$new_writer_rc" == 0 \
    && "$new_writer_calls" == $'ledger:prepared:'"$TEST_UUID"$'\nledger:committed:'"$TEST_UUID" ]]; then
  ok "private-v2 writer upgrades legacy receipts and mints new receipts with UUID"
else
  bad "private-v2 UUID writer mismatch legacy_rc=$legacy_upgrade_rc legacy=[$legacy_upgrade_calls] new_rc=$new_writer_rc new=[$new_writer_calls]"
fi

# Some live cmux workspaces do not expose a usable immutable processTitle.
# Missing birth evidence must not wedge the whole private Lead reconcile before
# its heal seam.  The fallback retains the pre-UUID title/variant transaction;
# an explicitly supplied UUID still requires its exact birth proof.
canonical_lead=$(build_lead_attach_command /tmp/lead.sock)
saved_birth_lookup=$(declare -f cmux_workspace_birth_record)
cmux_workspace_birth_record() { return 1; }
workspace_title="$canonical_lead"
surface_title="$canonical_lead"
ledger_state=none
ledger_uuid=""
: > "$calls"
_v2_lead_prepare_and_name generation-1 workspace:44 "$title" /tmp/lead.sock \
  "$canonical_lead"
birthless_prepare_rc=$?
birthless_prepare_calls=$(cat "$calls")

workspace_title="$title"
surface_title="$title"
ledger_state=committed
ledger_uuid=__LEGACY__
: > "$calls"
_v2_lead_prepare_and_name generation-1 workspace:44 "$title" /tmp/lead.sock \
  "$canonical_lead"
birthless_replay_rc=$?
birthless_replay_calls=$(cat "$calls")

: > "$calls"
_v2_lead_prepare_and_name generation-1 workspace:44 "$title" /tmp/lead.sock \
  "$canonical_lead" "$TEST_UUID"
unproved_uuid_rc=$?
unproved_uuid_calls=$(cat "$calls")
eval "$saved_birth_lookup"
if [[ "$birthless_prepare_rc" == 0 \
    && "$birthless_prepare_calls" == $'ledger:prepared:legacy\ncmux:rename-workspace\ncmux:rename-tab\nledger:committed:legacy' \
    && "$birthless_replay_rc" == 0 && -z "$birthless_replay_calls" \
    && "$unproved_uuid_rc" != 0 && -z "$unproved_uuid_calls" ]]; then
  ok "private-v2 birthless fallback keeps naming/heal eligibility without inventing UUID authority"
else
  bad "private-v2 birthless fallback mismatch prepare_rc=$birthless_prepare_rc prepare=[$birthless_prepare_calls] replay_rc=$birthless_replay_rc replay=[$birthless_replay_calls] uuid_rc=$unproved_uuid_rc uuid=[$unproved_uuid_calls]"
fi
BIRTH_KIND=view
BIRTH_TARGET_B64="$TEST_TARGET_B64"
workspace_title="$title"
surface_title="$title"
ledger_state=committed
ledger_uuid=__LEGACY__
: > "$calls"
adopt_birth_candidate runner-flywheel @44 "$title" generation-1 workspace:44 view "$TEST_TARGET_B64"
view_upgrade_rc=$?
view_upgrade_calls=$(cat "$calls")
if [[ "$view_upgrade_rc" == 0 && "$view_upgrade_calls" == "upgrade:$TEST_UUID" ]]; then
  ok "ordinary birth-owned view upgrades its committed legacy receipt by UUID"
else
  bad "ordinary legacy receipt upgrade rc=$view_upgrade_rc calls=[$view_upgrade_calls]"
fi

cache_calls="$TMP/birth-cache.calls"
: > "$cache_calls"
if declare -F cmux_attach_birth_cache_prime >/dev/null \
    && declare -F _cmux_attach_birth_records_uncached >/dev/null; then
  cache_first="$TMP/birth-cache.first"
  cache_second="$TMP/birth-cache.second"
  (
    _cmux_attach_birth_records_uncached() {
      printf 'scan\n' >> "$cache_calls"
      printf '%s\n' "$births"
    }
    CMUX_ATTACH_BIRTH_CACHE_READY=0
    cmux_attach_birth_cache_prime "$raw_json"
    cmux_attach_birth_records "$raw_json" > "$cache_first"
    cmux_attach_birth_records '{"workspaces":[]}' > "$cache_second"
  )
  first_cached=$(cat "$cache_first")
  second_cached=$(cat "$cache_second")
  cache_scan_count=$(wc -l < "$cache_calls" | tr -d ' ')
else
  first_cached=""; second_cached=""; cache_scan_count=missing
fi
if [[ "$first_cached" == "$births" && "$second_cached" == "$births" \
    && "$cache_scan_count" == 1 ]]; then
  ok "one pass-level birth snapshot serves every nested consumer"
else
  bad "birth cache missing or re-scanned count=$cache_scan_count first=[$first_cached] second=[$second_cached]"
fi

targeted_calls="$TMP/birth-targeted.calls"
: > "$targeted_calls"
new_birth="workspace:45|00000000-0000-4000-8000-000000004545|$(b64 new)|00000000-0000-4000-8000-000000005545|view|$TEST_TARGET_B64|fwtok1-fedcba9876543210fedcba9876543210"
if declare -F _cmux_workspace_birth_record_uncached >/dev/null; then
  saved_targeted=$(declare -f _cmux_workspace_birth_record_uncached)
  saved_active_birth_record=$(declare -f cmux_workspace_birth_record)
  _cmux_workspace_birth_record_uncached() {
    printf 'targeted\n' >> "$targeted_calls"
    printf '%s\n' "$new_birth"
  }
  eval "$production_birth_record_fn"
  discovered_after_snapshot=$(cmux_workspace_birth_record workspace:45 \
    00000000-0000-4000-8000-000000004545)
  targeted_count=$(wc -l < "$targeted_calls" | tr -d ' ')
  eval "$saved_active_birth_record"
  eval "$saved_targeted"
else
  discovered_after_snapshot=""; targeted_count=missing
fi
if [[ "$discovered_after_snapshot" == "$new_birth" && "$targeted_count" == 1 ]]; then
  ok "a workspace born after the pass snapshot gets one ref-scoped identity read"
else
  bad "pass cache hid a new workspace result=[$discovered_after_snapshot] reads=$targeted_count"
fi

batch_state="$TMP/session-batch.json"
batch_raw=$(/usr/bin/python3 - "$batch_state" "$FLYWHEEL_CMUX_VIEW_HELPER_BIN" <<'PY'
import json,sys
path,helper=sys.argv[1:]
current=[]; persisted=[]
for n in range(1,25):
    workspace=f"00000000-0000-4000-8000-{n:012d}"
    surface=f"00000000-0000-4000-8000-{1000+n:012d}"
    current.append({"ref":f"workspace:{n}","id":workspace,"title":f"batch-{n}"})
    persisted.append({"focusedPanelId":surface,
                      "processTitle":f"env -u TMUX '{helper}' 'cmux-batch-{n}'",
                      "panels":[{"type":"terminal","id":surface}]})
with open(path,"w",encoding="utf-8") as f:
    json.dump({"windows":[{"tabManager":{"workspaces":persisted}}]},f)
print(json.dumps({"workspaces":current},separators=(",",":")))
PY
)
saved_cmux_call=$(declare -f cmux_call)
saved_session_state="$CMUX_SESSION_STATE"
CMUX_SESSION_STATE="$batch_state"
cmux_call() {
  local ref="" previous="" arg n workspace surface
  for arg in "$@"; do
    [[ "$previous" == --workspace ]] && ref="$arg"
    previous="$arg"
  done
  n="${ref#workspace:}"
  workspace=$(printf '00000000-0000-4000-8000-%012d' "$n")
  surface=$(printf '00000000-0000-4000-8000-%012d' "$((1000 + n))")
  printf '{"workspace_id":"%s","surfaces":[{"id":"%s","type":"terminal"}]}\n' \
    "$workspace" "$surface"
}
batch_python_calls="$TMP/birth-batch-python.calls"
: > "$batch_python_calls"
python3() {
  local last="" arg n
  printf '1\n' >> "$batch_python_calls"
  case "$*" in
    *'if len(terms)!=1: raise SystemExit(2)'*)
      for arg in "$@"; do last="$arg"; done
      n=$((10#${last##*-}))
      printf '00000000-0000-4000-8000-%012d\n' "$((1000 + n))"
      ;;
    *'sys.stdout.write(base64.b64decode(sys.stdin.read(),validate=True).decode())'*)
      /usr/bin/base64 -D
      ;;
    *'helper,lead_helper,tmux_bin,output=sys.argv[1:5]'*)
      /bin/cat >/dev/null
      printf 'view|cmux-batch|\n'
      ;;
    *) /usr/bin/python3 "$@" ;;
  esac
}
batch_rows=$(_cmux_attach_birth_records_uncached "$batch_raw")
batch_rc=$?
batch_python_count=$(wc -l < "$batch_python_calls" | tr -d ' ')
batch_row_count=$(printf '%s\n' "$batch_rows" | grep -c . || true)
unset -f python3
eval "$saved_cmux_call"
CMUX_SESSION_STATE="$saved_session_state"
if [[ "$batch_rc" == 0 && "$batch_row_count" == 24 && "$batch_python_count" -le 3 ]]; then
  ok "host-sized birth inventory uses one bounded join process"
else
  bad "birth inventory process fan-out rc=$batch_rc rows=$batch_row_count python_calls=$batch_python_count"
fi

workspace_terminal_surface_ref() { printf '%s\n' surface:44; }
PROBE_MODE=live
surface_looks_like_bare_shell() {
  case "$PROBE_MODE" in
    live) SURFACE_LAST_SCREEN='Claude is working'; return 1 ;;
    dead) SURFACE_LAST_SCREEN='server exited'; return 1 ;;
    bare) SURFACE_LAST_SCREEN='host %'; return 0 ;;
    *) return 2 ;;
  esac
}
PROBE_MODE=live; live=$(workspace_attach_liveness workspace:44 view "$TEST_TARGET_B64")
PROBE_MODE=dead; dead=$(workspace_attach_liveness workspace:44 view "$TEST_TARGET_B64")
PROBE_MODE=bare; bare=$(workspace_attach_liveness workspace:44 view "$TEST_TARGET_B64")
PROBE_MODE=unknown; unknown=$(workspace_attach_liveness workspace:44 view "$TEST_TARGET_B64")
if [[ "$live|$dead|$bare|$unknown" == 'live|dead|bare|inconclusive' ]]; then
  ok "current screen liveness is independent from the persisted birth title"
else
  bad "liveness classifier mismatch [$live|$dead|$bare|$unknown]"
fi

birth_lookup_calls="$TMP/birth-lookup.calls"
: > "$birth_lookup_calls"
saved_birth_lookup=$(declare -f cmux_workspace_birth_record)
cmux_workspace_birth_record() {
  printf 'lookup\n' >> "$birth_lookup_calls"
  return 1
}
PROBE_MODE=live
cached_live=$(workspace_attach_liveness workspace:44 view "$TEST_TARGET_B64" "$births")
cached_lookup_count=$(wc -l < "$birth_lookup_calls" | tr -d ' ')
eval "$saved_birth_lookup"
if [[ "$cached_live" == live && "$cached_lookup_count" == 0 ]]; then
  ok "liveness consumes the caller's birth snapshot without a nested fleet sweep"
else
  bad "liveness ignored cached birth evidence result=$cached_live lookups=$cached_lookup_count"
fi

# A single dead/live screen sample is observational only. Duplicate promotion
# stays report-only until a distinct-round activity proof exists.
: > "$calls"
saved_alert=$(declare -f _alert_cmux_cleanup)
_alert_cmux_cleanup() { :; }
close_ledger_workspace_ref() { printf 'close:%s\n' "$2" >> "$calls"; return 0; }
adopt_birth_candidate() { printf 'adopt:%s\n' "$5" >> "$calls"; return 0; }
promote_live_duplicate runner-flywheel @44 "$title" generation-1 workspace:44 workspace:45 "$TEST_TARGET_B64"
promote_rc=$?
if [[ "$promote_rc" != 0 && ! -s "$calls" ]]; then
  ok "view duplicate reversal is report-only on a single liveness sample"
else
  bad "view duplicate reversal crossed report-only fence rc=$promote_rc calls=[$(cat "$calls")]"
fi

: > "$calls"
_v2_lead_adopt_birth() { printf 'v2-adopt:%s\n' "$2" >> "$calls"; return 0; }
_v2_lead_promote_live_duplicate generation-1 workspace:44 "$title" /tmp/lead.sock workspace:45 "$TEST_TARGET_B64"
v2_flip_rc=$?
if [[ "$v2_flip_rc" != 0 && ! -s "$calls" ]]; then
  ok "private-v2 duplicate reversal is report-only on a single liveness sample"
else
  bad "private-v2 duplicate reversal crossed report-only fence rc=$v2_flip_rc calls=[$(cat "$calls")]"
fi
eval "$saved_alert"

: > "$calls"
get_tmux_agent_windows() {
  printf 'runner-flywheel|@1|%s\nrunner-flywheel|@2|%s\n' "$title" "$title"
}
window_source_pane_alive() { [[ "$2" == @2 ]]; }
tmux() {
  [[ "$1" == select-window ]] && printf '%s\n' "$3" >> "$calls"
  return 0
}
select_live_view_window "$title" "$target"
select_rc=$?
if [[ "$select_rc" == 0 && "$(cat "$calls")" == "=$target:@2" ]]; then
  ok "view selection reuses the canonical source-pane liveness predicate"
else
  bad "view selection race seam rc=$select_rc calls=[$(cat "$calls")]"
fi

cmux_wal_title_blocked() { return 1; }
cmux_socket_identity() { printf 'generation-1\n'; }
ledger_refs_for_title() { return 0; }
_restored_parse_records() { return 0; }
get_cmux_workspaces_json() { printf '%s\n' '{"workspaces":[]}'; }
workspace_title_candidates() { return 1; }
_alert_cmux_cleanup() { :; }
dismantle_view_display FLY-1944-unparseable test >/dev/null 2>&1
dismantle_parse_rc=$?
if [[ "$dismantle_parse_rc" != 0 && "$DISMANTLE_REASON" == workspace-json-unparseable ]]; then
  ok "dismantle preserves unledgered workspaces when candidate parsing fails"
else
  bad "dismantle swallowed candidate parser failure rc=$dismantle_parse_rc reason=[$DISMANTLE_REASON]"
fi

printf '\nFLY-1944 birth adoption: %s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
