#!/usr/bin/env bash
# Shared, source-only QA teardown finalizer (FLY-1482).
#
# Callers install this behind an EXIT trap after preserving `$?`. The helper
# attempts every supplied slot, caches the aggregate result for repeated trap
# entry, and leaves a durable /tmp receipt whenever teardown fails.

qa_teardown_receipt_nonce() {
  local receipt="$1" bytes nonce
  [[ -f "$receipt" && ! -L "$receipt" ]] || return 1
  bytes=$(wc -c < "$receipt" 2>/dev/null | tr -d ' ') || return 1
  case "$bytes" in ''|*[!0-9]*) return 1 ;; esac
  (( bytes <= 65536 )) || return 1
  nonce=$(sed -n 's/^invocation=//p' "$receipt" 2>/dev/null | head -1) || return 1
  case "$nonce" in ''|*[!A-Za-z0-9_.-]*) return 1 ;; esac
  printf '%s\n' "$nonce"
}

qa_teardown_write_failure_receipt() {
  local receipt="$1" slot="$2" rc="$3" log_file="$4" tmp
  tmp=$(mktemp "${receipt}.tmp.XXXXXX" 2>/dev/null) || return 1
  if ! {
    printf 'invocation=%s\n' "$QA_TEARDOWN_FINALIZER_INVOCATION"
    printf 'timestamp=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'slot=%s\n' "$slot"
    printf 'rc=%s\n' "$rc"
    printf '%s\n' '--- teardown log tail (20 lines) ---'
    tail -20 "$log_file" 2>/dev/null || true
  } > "$tmp"; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  if ! mv -f "$tmp" "$receipt" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
}

qa_finalize_teardown_slots() {
  local log_dir="${1:-}" teardown_script receipt_root slot key already_done
  local log_file receipt old_nonce current_nonce teardown_rc receipt_rc
  [[ -n "$log_dir" && $# -ge 2 ]] || {
    echo "[qa-teardown-finalize] ERROR: usage: qa_finalize_teardown_slots <logdir> <slot>..." >&2
    return 1
  }
  shift

  : "${QA_TEARDOWN_FINALIZER_ACTIVE:=0}"
  : "${QA_TEARDOWN_FINALIZER_RC:=0}"
  if [[ "$QA_TEARDOWN_FINALIZER_ACTIVE" == "1" ]]; then
    echo "[qa-teardown-finalize] ERROR: recursive teardown finalizer entry suppressed" >&2
    return "$QA_TEARDOWN_FINALIZER_RC"
  fi
  QA_TEARDOWN_FINALIZER_ACTIVE=1

  if [[ -z "${QA_TEARDOWN_FINALIZER_INVOCATION:-}" ]]; then
    QA_TEARDOWN_FINALIZER_INVOCATION="$(date -u '+%Y%m%dT%H%M%SZ')-$$-${RANDOM:-0}"
  fi
  teardown_script="${QA_TEARDOWN_SCRIPT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-teardown.sh}"
  receipt_root="${QA_TEARDOWN_RECEIPT_ROOT:-/tmp}"
  if ! mkdir -p "$log_dir" "$receipt_root" 2>/dev/null; then
    echo "[qa-teardown-finalize] ERROR: cannot create log/receipt directory" >&2
    QA_TEARDOWN_FINALIZER_RC=1
    QA_TEARDOWN_FINALIZER_ACTIVE=0
    return 1
  fi

  for slot in "$@"; do
    case "$slot" in
      ''|*[!0-9]*)
        echo "[qa-teardown-finalize] ERROR: invalid teardown slot '$slot'" >&2
        QA_TEARDOWN_FINALIZER_RC=1
        continue
        ;;
    esac
    key="QA_TEARDOWN_FINALIZED_SLOT_${slot}"
    eval "already_done=\${${key}:-0}"
    [[ "$already_done" == "1" ]] && continue
    eval "$key=1"

    log_file="${log_dir}/teardown-slot-${slot}.log"
    receipt="${receipt_root}/flywheel-test-slot-${slot}.teardown-failed"
    old_nonce=$(qa_teardown_receipt_nonce "$receipt" 2>/dev/null || true)
    teardown_rc=0
    if bash "$teardown_script" "$slot" > "$log_file" 2>&1; then
      teardown_rc=0
    else
      teardown_rc=$?
    fi

    if [[ "$teardown_rc" -ne 0 ]]; then
      QA_TEARDOWN_FINALIZER_RC=1
      receipt_rc=0
      qa_teardown_write_failure_receipt "$receipt" "$slot" "$teardown_rc" "$log_file" || receipt_rc=$?
      echo "[qa-teardown-finalize] ERROR: slot $slot teardown failed rc=$teardown_rc log=$log_file receipt=$receipt" >&2
      if [[ "$receipt_rc" -ne 0 ]]; then
        echo "[qa-teardown-finalize] ERROR: could not persist failure receipt for slot $slot" >&2
      fi
      continue
    fi

    # A success may retire only the exact receipt observed before teardown.
    # If another invocation replaced it while teardown ran, preserve it.
    if [[ -n "$old_nonce" ]]; then
      current_nonce=$(qa_teardown_receipt_nonce "$receipt" 2>/dev/null || true)
      if [[ "$current_nonce" == "$old_nonce" ]]; then
        rm -f "$receipt" 2>/dev/null || {
          echo "[qa-teardown-finalize] WARN: successful slot $slot teardown could not clear old receipt $receipt" >&2
          QA_TEARDOWN_FINALIZER_RC=1
        }
      fi
    fi
  done

  QA_TEARDOWN_FINALIZER_ACTIVE=0
  return "$QA_TEARDOWN_FINALIZER_RC"
}
