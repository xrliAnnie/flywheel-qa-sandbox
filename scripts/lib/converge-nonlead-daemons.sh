#!/usr/bin/env bash
# FLY-1830: idempotent convergence of the NON-Lead flywheel launchd daemons.
# Source-only. macOS Bash 3.2 compatible.
#
# WHY THIS EXISTS
#   A launchd service can leave the user domain (an operator bootout, an aborted
#   install path) while its plist stays on disk and its override entry stays
#   "enabled". Nothing ever put it back. com.flywheel.quota-monitor ran from
#   2026-08-01 10:45 to 2026-08-06 00:17 and then sat unloaded for eleven days,
#   taking automatic Claude account switching offline with it — silently, because
#   the plist on disk still looked installed. Three more labels were in the same
#   state at the same time (updater, bridge-liveness-probe, daily-standup).
#
# SHAPE: CONVERGENCE, NOT DETECTION
#   The obvious patch — a startup self-check that enumerates plists and alerts on
#   the missing ones — is an alarm bolted onto a broken structure, which is the
#   shape Annie ruled out on 2026-08-05 ("先问能不能让它无从发生,检测是退而求其次").
#   So the already-existing full-restart wave reconciles the set on every deploy.
#   No new timer, no new flag, no new daemon: the same event that already
#   replaces the Bridge, the Leads and the cmux watcher now also puts back any
#   non-Lead daemon that fell out of the domain.
#
# ROSTER AUTHORITY: LAUNCHD'S OWN ENABLED BIT
#   A side roster ("register your daemon here") is the every-call-site-must-
#   remember shape that leaks by construction, and a hardcoded label list rots.
#   Instead the declaration already on the machine is the roster: a non-Lead
#   com.flywheel plist that is on disk AND not disabled in the launchd override
#   database AND not in the domain is, by that very declaration, something that
#   is supposed to be running. Absence from the override database means enabled —
#   that is launchd's own default, not an assumption of ours.
#
# THE LEAD FAMILY IS EXCLUDED ON PURPOSE
#   com.flywheel.lead.* carriers are owned by the Lead wave / fleet tooling, and
#   some are deliberately enabled-on-disk while being driven by a different
#   launcher — growth-mufasa-lead runs as a real TUI per FLY-398, so bootstrapping
#   its plist would create a second listener. Excluding the whole family (rather
#   than special-casing one label) keeps that hazard structurally out of reach.
#
# Outcomes (globals, mirroring the restart_cmux_watcher contract):
#   NONLEAD_DAEMON_CONVERGE_STATE   healthy|degraded|unverifiable
#   NONLEAD_DAEMON_CONVERGE_DETAIL  operator-readable evidence

_cnd_log() {
  if declare -F log >/dev/null 2>&1; then
    log "$*"
  else
    echo "[nonlead-daemon-converge] $*" >&2
  fi
}

# Single seam for every launchd call so the suite can drive this library against
# a scripted domain without touching the real one.
_cnd_launchctl() {
  launchctl "$@"
}

_cnd_launch_agents_dir() {
  printf '%s\n' "${HOME}/Library/LaunchAgents"
}

_cnd_units_manifest() {
  local lib_dir
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s\n' "${lib_dir}/../launchd/units.manifest"
}

_cnd_repo_launchd_dir() {
  local lib_dir
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s\n' "${lib_dir}/../launchd"
}

_cnd_domain() {
  printf '%s\n' "gui/$(id -u)"
}

_cnd_set_outcome() {
  NONLEAD_DAEMON_CONVERGE_STATE="$1"
  NONLEAD_DAEMON_CONVERGE_DETAIL="$2"
}

# FLY-1887: this function is already on the unconditional full-restart path,
# including same-SHA waves where build/install is skipped. Keep the global
# one-shot Codex guard converged here so drift cannot survive until a new SHA.
_cnd_converge_codex_guard() {
  local repo_root installer
  repo_root="${FLYWHEEL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
  installer="$repo_root/scripts/install-codex-guard.sh"
  if [[ ! -f "$installer" ]]; then
    _cnd_log "WARNING: codex guard installer missing: $installer"
    return 0
  fi
  if ! /bin/bash "$installer" >/dev/null; then
    _cnd_log "ERROR: codex guard convergence failed; existing install left in place"
  fi
  return 0
}

# The Lead family is out of scope for this convergence (see header).
nonlead_daemon_is_lead_label() {
  case "$1" in
    com.flywheel.lead.*) return 0 ;;
    *) return 1 ;;
  esac
}

_cnd_plutil() {
  plutil "$@"
}

# Read a plist scalar without ever evaluating plist-controlled data. Keep all
# plist access behind this seam so tests can use real XML fixtures while every
# execution decision remains ordinary string validation.
_cnd_plist_scalar() {
  local plist="$1" key="$2" value=""
  if command -v plutil >/dev/null 2>&1; then
    if value="$(_cnd_plutil -extract "$key" raw -o - "$plist" 2>/dev/null)"; then
      printf '%s\n' "$value"
      return 0
    fi
  fi

  # Ubuntu CI has no Apple plutil. Use plistlib as a structure-aware fallback
  # rather than text scraping XML: comments, duplicate-looking tags, and entity
  # encoding must never manufacture a different executable authority. The
  # fallback accepts only the exact string keys used by the resolver.
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$plist" "$key" <<'PY'
import plistlib
import sys

path, key = sys.argv[1:]
try:
    with open(path, "rb") as handle:
        data = plistlib.load(handle)
    if key in {"Program", "BundleProgram"}:
        value = data.get(key)
    elif key.startswith("ProgramArguments."):
        suffix = key[len("ProgramArguments."):]
        if not suffix.isdigit():
            raise ValueError("invalid ProgramArguments index")
        arguments = data.get("ProgramArguments")
        index = int(suffix)
        if not isinstance(arguments, list) or index >= len(arguments):
            raise KeyError(key)
        value = arguments[index]
    else:
        raise KeyError(key)
    if not isinstance(value, str):
        raise TypeError(key)
except (OSError, KeyError, TypeError, ValueError, plistlib.InvalidFileException):
    raise SystemExit(1)
sys.stdout.write(value)
PY
}

_cnd_safe_program_token() {
  local token="$1" segment="" rest=""
  case "$token" in
    /*|"~/"*) ;;
    *) return 1 ;;
  esac
  case "$token" in
    *[!A-Za-z0-9_./~+-]*) return 1 ;;
  esac
  rest="$token"
  while :; do
    segment="${rest%%/*}"
    case "$segment" in .|..) return 1 ;; esac
    [[ "$rest" == */* ]] || break
    rest="${rest#*/}"
  done
  case "$token" in
    "~/"*) printf '%s/%s\n' "$HOME" "${token#\~/}" ;;
    *) printf '%s\n' "$token" ;;
  esac
}

# Validate the complete remainder after a selected shell target. Arguments are
# optional, but every argument must be a whitespace-delimited static literal
# from the same inert charset. This grammar rejects operators, substitutions,
# globs, quotes, redirects, and additional commands without executing content.
_cnd_safe_shell_tail() {
  local rest="$1" trimmed="" token=""
  while [[ -n "$rest" ]]; do
    trimmed="${rest#"${rest%%[![:space:]]*}"}"
    [[ "$trimmed" != "$rest" ]] || return 1
    rest="$trimmed"
    [[ -n "$rest" ]] || return 0
    token="${rest%%[!A-Za-z0-9_./~+-]*}"
    [[ -n "$token" ]] || return 1
    rest="${rest#"$token"}"
  done
  return 0
}

# Count exact shell `exec` words across whitespace and command operators. Strip
# literal quote syntax and one-character backslash escapes first so shell words
# such as `"exec"`, `\exec`, and `e"xe"c` cannot hide a competing target. This
# is deliberately conservative rather than a shell evaluator: an exact word
# used as an argument may make a command unverifiable, but substrings such as
# `executor` and `/path/exec` do not create false targets.
_cnd_shell_exec_token_count() {
  printf '%s\n' "$1" | awk '
    {
      normalized = ""
      record_length = length($0)
      for (position = 1; position <= record_length; position++) {
        character = substr($0, position, 1)
        if (character == "\\") {
          if (position < record_length) {
            position++
            normalized = normalized substr($0, position, 1)
          } else {
            normalized = normalized character
          }
        } else if (character != "\"" && character != "\047") {
          normalized = normalized character
        }
      }
      field_count = split(normalized, fields, /[[:space:];|&(){}]+/)
      for (field_index = 1; field_index <= field_count; field_index++) {
        if (fields[field_index] == "exec") count++
      }
    }
    END { print count + 0 }
  '
}

# Report whether a shell word in command position is built from parameter or
# command expansion. The lexer recognizes word/control boundaries without
# expanding content, and ignores expansion markers in ordinary arguments.
_cnd_shell_dynamic_command_word() {
  printf '%s\n' "$1" | awk '
    function clear_word() {
      word = ""
      word_dynamic = 0
      word_quoted = 0
      in_word = 0
    }
    function finish_word() {
      if (!in_word) return
      if (command_start) {
        if (word ~ /^[A-Za-z_][A-Za-z0-9_]*=/) {
          # Assignment words precede the command word.
        } else if (!word_quoted && word ~ /^(if|then|elif|else|while|until|do|for|select|time|coproc|!)$/) {
          # These control words are followed by a command-position word.
        } else {
          # Shell command forwarders can execute a later argument as a command
          # after quote removal/expansion. Treat bare and path-qualified
          # forwarders as unverifiable in command position; otherwise
          # `/usr/bin/env "$x" ...` could hide a first target while a later
          # literal exec appears safe.
          if (word_dynamic || word ~ /(^|\/)(command|builtin|env|eval)$/) found = 1
          command_start = 0
        }
      }
      clear_word()
    }
    BEGIN {
      command_start = 1
      clear_word()
    }
    {
      record_length = length($0)
      for (position = 1; position <= record_length; position++) {
        character = substr($0, position, 1)

        if (substitution_depth > 0) {
          if (character == "\\") {
            if (position < record_length) position++
          } else if (character == "(") {
            substitution_depth++
          } else if (character == ")") {
            substitution_depth--
          }
          continue
        }
        if (parameter_depth > 0) {
          if (character == "\\") {
            if (position < record_length) position++
          } else if (character == "{") {
            parameter_depth++
          } else if (character == "}") {
            parameter_depth--
          }
          continue
        }
        if (backtick_quote) {
          if (character == "\\") {
            if (position < record_length) position++
          } else if (character == "`") {
            backtick_quote = 0
          }
          continue
        }
        if (single_quote) {
          if (character == "\047") {
            single_quote = 0
          } else {
            word = word character
          }
          continue
        }
        if (double_quote) {
          if (character == "\\") {
            if (position < record_length) {
              position++
              word = word substr($0, position, 1)
            }
            continue
          }
          if (character == "\"") {
            double_quote = 0
            continue
          }
          if (character == "`") {
            word_dynamic = 1
            backtick_quote = 1
            continue
          }
          if (character == "$") {
            following = substr($0, position + 1, 1)
            if (following == "(") {
              word_dynamic = 1
              substitution_depth = 1
              position++
              continue
            }
            if (following == "{") {
              word_dynamic = 1
              parameter_depth = 1
              position++
              continue
            }
            if (following ~ /^[A-Za-z_0-9@*#?!$-]$/) word_dynamic = 1
          }
          word = word character
          continue
        }

        if (character ~ /[[:space:]]/) {
          finish_word()
          continue
        }
        if (character ~ /[;|&(){}]/) {
          finish_word()
          command_start = 1
          continue
        }
        in_word = 1
        if (character == "\\") {
          if (position < record_length) {
            position++
            word = word substr($0, position, 1)
          }
          continue
        }
        if (character == "\047") {
          word_quoted = 1
          single_quote = 1
          continue
        }
        if (character == "\"") {
          word_quoted = 1
          double_quote = 1
          continue
        }
        if (character == "`") {
          word_dynamic = 1
          backtick_quote = 1
          continue
        }
        if (character == "$") {
          following = substr($0, position + 1, 1)
          if (following == "(") {
            word_dynamic = 1
            substitution_depth = 1
            position++
            continue
          }
          if (following == "{") {
            word_dynamic = 1
            parameter_depth = 1
            position++
            continue
          }
          if (following ~ /^[A-Za-z_0-9@*#?!$-]$/) word_dynamic = 1
        }
        word = word character
      }
      finish_word()
    }
    END { print found ? 1 : 0 }
  '
}

# Detect redirection syntax without attempting to model shell redirection
# grammar. Quoted or backslash-escaped angle brackets are literal arguments.
_cnd_shell_unquoted_redirection() {
  printf '%s\n' "$1" | awk '
    {
      record_length = length($0)
      for (position = 1; position <= record_length; position++) {
        character = substr($0, position, 1)
        if (single_quote) {
          if (character == "\047") single_quote = 0
          continue
        }
        if (double_quote) {
          if (character == "\\") {
            if (position < record_length) position++
          } else if (character == "\"") {
            double_quote = 0
          }
          continue
        }
        if (character == "\\") {
          if (position < record_length) position++
        } else if (character == "\047") {
          single_quote = 1
        } else if (character == "\"") {
          double_quote = 1
        } else if (character == "<" || character == ">") {
          found = 1
        }
      }
    }
    END { print found ? 1 : 0 }
  '
}

# Resolve the executable script selected by ProgramArguments without sourcing,
# evaling, or executing any plist content.
#
# Results are deliberately tri-state:
#   resolved       LAUNCHD_PROGRAM_TARGET is one safe absolute path
#   not-applicable the plist has no ProgramArguments file payload
#   unknown        ProgramArguments exists but its selection is unsafe/ambiguous
launchd_plist_program_target() {
  local plist="$1" interpreter="" arg1="" command="" token="" resolved=""
  local index=0 value="" exec_tokens="" exec_count=0 exec_invalid=0 segment="" trimmed="" remainder=""
  local possible_exec_count="" dynamic_command_word="" unquoted_redirection=""
  local has_extended_shell_quote=false
  local exec_segment_seen=false
  local -a args=()

  LAUNCHD_PROGRAM_STATE="unknown"
  LAUNCHD_PROGRAM_TARGET=""

  # Program and BundleProgram create a second executable authority. Even when
  # ProgramArguments also looks safe, selecting between them would be guessing.
  if _cnd_plist_scalar "$plist" Program >/dev/null 2>&1 \
    || _cnd_plist_scalar "$plist" BundleProgram >/dev/null 2>&1; then
    return 0
  fi

  while value="$(_cnd_plist_scalar "$plist" "ProgramArguments.${index}")"; do
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || return 0
    args+=("$value")
    index=$((index + 1))
  done
  if (( ${#args[@]} == 0 )); then
    LAUNCHD_PROGRAM_STATE="not-applicable"
    return 0
  fi
  (( ${#args[@]} >= 2 )) || return 0

  interpreter="${args[0]}"
  arg1="${args[1]}"
  case "$interpreter" in
    /bin/bash|/bin/sh)
      if [[ "$arg1" != "-c" ]]; then
        resolved="$(_cnd_safe_program_token "$arg1")" || return 0
        LAUNCHD_PROGRAM_STATE="resolved"
        LAUNCHD_PROGRAM_TARGET="$resolved"
        return 0
      fi
      (( ${#args[@]} >= 3 )) || return 0
      command="${args[2]}"

      dynamic_command_word="$(_cnd_shell_dynamic_command_word "$command")" || return 0
      case "$dynamic_command_word" in
        0) ;;
        1) return 0 ;;
        *) return 0 ;;
      esac

      # Selection below only recognizes the two approved execution shapes.
      # First census every exact exec word, including ones hidden behind && or
      # shell control words, so a later syntactically simple target cannot mask
      # an earlier possible target.
      possible_exec_count="$(_cnd_shell_exec_token_count "$command")" || return 0
      case "$possible_exec_count" in
        ''|*[!0-9]*) return 0 ;;
      esac
      (( possible_exec_count <= 1 )) || return 0
      unquoted_redirection="$(_cnd_shell_unquoted_redirection "$command")" || return 0
      case "$unquoted_redirection" in
        0) ;;
        1)
          if (( possible_exec_count > 0 )); then
            return 0
          fi
          ;;
        *) return 0 ;;
      esac
      case "$command" in
        *"\$'"*|*'$"'*) has_extended_shell_quote=true ;;
      esac
      if [[ "$has_extended_shell_quote" == true ]] \
        && (( possible_exec_count > 0 )); then
        return 0
      fi

      # Shape 1: after optional whitespace, the command begins with a literal
      # safe path token. A later exec target is counted below too, so competing
      # selection shapes fail closed as ambiguous.
      trimmed="${command#"${command%%[![:space:]]*}"}"
      token="${trimmed%%[!A-Za-z0-9_./~+-]*}"
      if [[ -n "$token" ]]; then
        remainder="${trimmed#"$token"}"
        resolved="$(_cnd_safe_program_token "$token")" || resolved=""
        if [[ -n "$resolved" ]]; then
          if _cnd_safe_shell_tail "$remainder"; then
            exec_count=1
            exec_tokens="$resolved"
          else
            exec_invalid=1
          fi
        fi
      fi

      # Shape 2: one command-boundary segment begins with `exec SAFE_PATH`.
      # Count every such selected target; two targets are ambiguous even when
      # both are independently safe.
      while IFS= read -r segment; do
        trimmed="${segment#"${segment%%[![:space:]]*}"}"
        if [[ "$exec_segment_seen" == true && -n "$trimmed" ]]; then
          exec_invalid=1
        fi
        case "$trimmed" in
          exec[[:space:]]*)
            trimmed="${trimmed#exec}"
            trimmed="${trimmed#"${trimmed%%[![:space:]]*}"}"
            token="${trimmed%%[!A-Za-z0-9_./~+-]*}"
            if [[ -z "$token" ]]; then
              exec_invalid=1
              continue
            fi
            if ! resolved="$(_cnd_safe_program_token "$token")"; then
              exec_invalid=1
              continue
            fi
            remainder="${trimmed#"$token"}"
            if ! _cnd_safe_shell_tail "$remainder"; then
              exec_invalid=1
              continue
            fi
            exec_count=$((exec_count + 1))
            exec_tokens="$resolved"
            exec_segment_seen=true
            ;;
        esac
      done < <(printf '%s\n' "$command" | tr ';' '\n')
      if (( exec_count == 1 && exec_invalid == 0 )); then
        LAUNCHD_PROGRAM_STATE="resolved"
        LAUNCHD_PROGRAM_TARGET="$exec_tokens"
      fi
      return 0
      ;;
    node|*/node|nodejs|*/nodejs|python|*/python|python[0-9]|*/python[0-9]|python[0-9].[0-9]|*/python[0-9].[0-9])
      case "$arg1" in -*) return 0 ;; esac
      resolved="$(_cnd_safe_program_token "$arg1")" || return 0
      LAUNCHD_PROGRAM_STATE="resolved"
      LAUNCHD_PROGRAM_TARGET="$resolved"
      return 0
      ;;
    *) return 0 ;;
  esac
}

_cnd_manifest_reject() {
  _CND_MANIFEST_VALID=false
  _CND_MANIFEST_ERROR="$1"
  return 1
}

# Parse the authoritative five-field TSV into newline-delimited globals. Bash
# 3.2 has no associative arrays, so uniqueness is checked against exact-line
# sets and consumers stream the validated rows.
_cnd_load_manifest() {
  local manifest="$1" line="" line_no=0 fields=0
  local label="" source="" policy="" exits="" note=""
  local host_prefix="" host_count=0 scope="" scope_count=0
  local seen_labels="" seen_sources="" seen_scopes=""

  _CND_MANIFEST_VALID=false
  _CND_MANIFEST_ERROR=""
  _CND_MANIFEST_ROWS=""
  _CND_MANIFEST_SCOPES=""
  _CND_MANIFEST_HOST_PREFIX=""
  if [[ ! -f "$manifest" || ! -r "$manifest" ]]; then
    _cnd_manifest_reject "units manifest unreadable: $manifest"
    return 1
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_no=$((line_no + 1))
    [[ "$line" != *$'\r'* ]] || {
      _cnd_manifest_reject "units manifest malformed at line ${line_no}: CR byte"
      return 1
    }
    [[ -n "$line" ]] || continue
    if [[ "$line" == \#* ]]; then
      case "$line" in
        "# host-prefix: "*)
          host_prefix="${line#\# host-prefix: }"
          host_count=$((host_count + 1))
          if (( host_count != 1 )) \
            || ! printf '%s\n' "$host_prefix" | grep -Eq '^/([A-Za-z0-9._+-]+/)+$' \
            || [[ "$host_prefix" == *'/../'* || "$host_prefix" == *'/./'* || "$host_prefix" == *'//'* ]]; then
            _cnd_manifest_reject "units manifest malformed at line ${line_no}: invalid host-prefix"
            return 1
          fi
          ;;
        "# census-scope: "*)
          scope="${line#\# census-scope: }"
          if ! printf '%s\n' "$scope" | grep -Eq '^[A-Za-z][A-Za-z0-9.-]*$' \
            || [[ "$scope" != *.* || "$scope" == *'..'* || "$scope" == *- ]]; then
            _cnd_manifest_reject "units manifest malformed at line ${line_no}: invalid census-scope"
            return 1
          fi
          if printf '%s\n' "$seen_scopes" | grep -Fxq "$scope"; then
            _cnd_manifest_reject "units manifest malformed at line ${line_no}: duplicate census-scope"
            return 1
          fi
          seen_scopes="${seen_scopes}${seen_scopes:+$'\n'}${scope}"
          _CND_MANIFEST_SCOPES="${_CND_MANIFEST_SCOPES}${_CND_MANIFEST_SCOPES:+$'\n'}${scope}"
          scope_count=$((scope_count + 1))
          ;;
        "# host-prefix"*|"# census-scope"*)
          _cnd_manifest_reject "units manifest malformed at line ${line_no}: malformed header"
          return 1
          ;;
        *) : ;;
      esac
      continue
    fi

    fields="$(printf '%s\n' "$line" | awk -F '\t' '{print NF}')"
    if [[ "$fields" != 5 ]]; then
      _cnd_manifest_reject "units manifest malformed at line ${line_no}: expected exactly 5 TSV fields"
      return 1
    fi
    IFS=$'\t' read -r label source policy exits note <<EOF
$line
EOF
    if [[ -z "$label" || -z "$source" || -z "$policy" || -z "$exits" || -z "$note" ]]; then
      _cnd_manifest_reject "units manifest malformed at line ${line_no}: empty field"
      return 1
    fi
    if ! printf '%s\n' "$label" | grep -Eq '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' \
      || [[ "$label" != *.* || "$label" == *'..'* ]] \
      || nonlead_daemon_is_lead_label "$label"; then
      _cnd_manifest_reject "units manifest malformed at line ${line_no}: invalid label $label"
      return 1
    fi
    if [[ "$source" != "-" ]] \
      && ! printf '%s\n' "$source" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9.-]*\.plist$'; then
      _cnd_manifest_reject "units manifest malformed at line ${line_no}: invalid source $source"
      return 1
    fi
    case "$policy" in
      copy)
        [[ "$source" != "-" ]] || {
          _cnd_manifest_reject "units manifest malformed at line ${line_no}: copy source is missing"
          return 1
        }
        ;;
      setup|managed|hold) ;;
      external)
        if [[ "$source" != "-" || "$exits" != "*" ]]; then
          _cnd_manifest_reject "units manifest malformed at line ${line_no}: external requires source - and exits *"
          return 1
        fi
        ;;
      *)
        _cnd_manifest_reject "units manifest malformed at line ${line_no}: unknown policy $policy"
        return 1
        ;;
    esac
    if [[ "$policy" != external ]]; then
      if ! printf '%s\n' "$exits" | grep -Eq '^(0|[1-9][0-9]*)(,(0|[1-9][0-9]*))*$' \
        || ! printf ',%s,' "$exits" | grep -Fq ',0,'; then
        _cnd_manifest_reject "units manifest malformed at line ${line_no}: invalid allowed exits $exits"
        return 1
      fi
    fi
    if printf '%s\n' "$seen_labels" | grep -Fxq "$label"; then
      _cnd_manifest_reject "units manifest malformed at line ${line_no}: duplicate label $label"
      return 1
    fi
    if [[ "$source" != "-" ]] && printf '%s\n' "$seen_sources" | grep -Fxq "$source"; then
      _cnd_manifest_reject "units manifest malformed at line ${line_no}: duplicate source $source"
      return 1
    fi
    seen_labels="${seen_labels}${seen_labels:+$'\n'}${label}"
    [[ "$source" == "-" ]] || seen_sources="${seen_sources}${seen_sources:+$'\n'}${source}"
    _CND_MANIFEST_ROWS="${_CND_MANIFEST_ROWS}${_CND_MANIFEST_ROWS:+$'\n'}${line}"
  done < "$manifest"

  if (( host_count != 1 || scope_count == 0 )); then
    _cnd_manifest_reject "units manifest malformed: requires one host-prefix and at least one census-scope"
    return 1
  fi
  _CND_MANIFEST_HOST_PREFIX="$host_prefix"
  _CND_MANIFEST_VALID=true
  return 0
}

_cnd_manifest_has_label() {
  local wanted="$1" row_label="" rest=""
  while IFS=$'\t' read -r row_label rest; do
    [[ "$row_label" == "$wanted" ]] && return 0
  done <<EOF
${_CND_MANIFEST_ROWS:-}
EOF
  return 1
}

_cnd_plist_is_active() {
  local plist="$1" base=""
  [[ -f "$plist" && ! -L "$plist" ]] || return 1
  base="$(basename "$plist")"
  case "$base" in
    *.bak*|*.backup*|*.pre-*|*-staged*|*retired*|*.decommissioned-*) return 1 ;;
  esac
  return 0
}

_cnd_find_installed_plist() {
  local agents_dir="$1" wanted="$2" plist="" label=""
  if _cnd_plist_is_active "$agents_dir/${wanted}.plist"; then
    printf '%s\n' "$agents_dir/${wanted}.plist"
    return 0
  fi
  for plist in "$agents_dir"/*.plist; do
    _cnd_plist_is_active "$plist" || continue
    label="$(nonlead_daemon_plist_label "$plist" 2>/dev/null || true)"
    if [[ "$label" == "$wanted" ]]; then
      printf '%s\n' "$plist"
      return 0
    fi
  done
  return 1
}

_cnd_copy_plist_preflight() {
  local plist="$1" expected_label="$2" label=""
  _CND_COPY_PREFLIGHT_ERROR=""
  if [[ ! -f "$plist" || -L "$plist" ]]; then
    _CND_COPY_PREFLIGHT_ERROR="plist missing or unsafe"
    return 1
  fi
  label="$(nonlead_daemon_plist_label "$plist" 2>/dev/null || true)"
  if [[ "$label" != "$expected_label" ]]; then
    _CND_COPY_PREFLIGHT_ERROR="Label mismatch"
    return 1
  fi
  launchd_plist_program_target "$plist"
  if [[ "$LAUNCHD_PROGRAM_STATE" != resolved ]]; then
    _CND_COPY_PREFLIGHT_ERROR="program target ${LAUNCHD_PROGRAM_STATE}"
    return 1
  fi
  if [[ ! -f "$LAUNCHD_PROGRAM_TARGET" ]]; then
    _CND_COPY_PREFLIGHT_ERROR="program target missing"
    return 1
  fi
  return 0
}

# Atomic same-directory publication for never-installed copy rows. The caller
# proves the target absent first; this helper validates the staged payload, then
# uses a same-directory hard link as an atomic create-if-absent publication.
_cnd_install_plist() {
  local source="$1" destination="$2" expected_label="$3"
  local destination_dir="" stage=""
  [[ -f "$source" && ! -L "$source" && ! -e "$destination" ]] || return 1
  destination_dir="$(dirname "$destination")"
  stage="$(mktemp "${destination_dir}/.${expected_label}.stage.XXXXXX")" || return 1
  if ! cp "$source" "$stage" \
    || ! chmod 0644 "$stage" \
    || ! _cnd_copy_plist_preflight "$stage" "$expected_label" \
    || ! ln "$stage" "$destination" 2>/dev/null; then
    rm -f "$stage" 2>/dev/null || true
    return 1
  fi
  if ! _cnd_copy_plist_preflight "$destination" "$expected_label"; then
    if [[ -e "$destination" && "$destination" -ef "$stage" ]]; then
      rm -f "$destination" 2>/dev/null || true
    fi
    rm -f "$stage" 2>/dev/null || true
    return 1
  fi
  rm -f "$stage" 2>/dev/null || true
  return 0
}

# Print the Label DECLARED INSIDE the plist. This — not the file name — is the
# identity launchd registers the job under, so it is the only identity the Lead
# exclusion and the domain lookups may use. A file called anything at all can
# declare `com.flywheel.lead.growth-mufasa-lead` and would otherwise sail past a
# filename-only exclusion straight into a second Mufasa listener.
# Returns 1 when no plausible Label can be read; the caller must then skip the
# file and say so rather than fall back to the file name.
nonlead_daemon_plist_label() {
  local plist="$1" label=""
  if command -v plutil >/dev/null 2>&1; then
    label=$(_cnd_plutil -extract Label raw -o - "$plist" 2>/dev/null) || label=""
  fi
  if [[ -z "$label" ]]; then
    # Portable XML fallback (also the path CI takes, where plutil does not
    # exist): the first <string> that comes AFTER <key>Label</key>. Scanning the
    # whole Label line from column 0 would happily pick up a <string> belonging
    # to an earlier key on the same line, which is a way to smuggle a Lead label
    # past this function.
    label=$(awk '
      !seen {
        pos = index($0, "<key>Label</key>")
        if (pos == 0) next
        seen = 1
        rest = substr($0, pos + length("<key>Label</key>"))
        # An empty remainder means the key ended the line; continue on the NEXT
        # line. It must never fall back to re-scanning this one, which would put
        # an earlier key'"'"'s <string> back in play.
        if (match(rest, /<string>[^<]*<\/string>/)) {
          print substr(rest, RSTART + 8, RLENGTH - 17)
          exit
        }
        next
      }
      {
        if (match($0, /<string>[^<]*<\/string>/)) {
          print substr($0, RSTART + 8, RLENGTH - 17)
          exit
        }
      }
    ' "$plist" 2>/dev/null)
  fi
  label="${label%%$'\n'*}"
  case "$label" in
    ""|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
  printf '%s\n' "$label"
}

# Print the labels launchd currently holds DISABLED in the given domain, one per
# line. Returns 1 when the override database cannot be read OR cannot be parsed
# with certainty — the caller must then converge nothing, because without it
# "enabled" is not knowable and a deliberately disabled daemon would be started
# against its operator's intent. An exit code of 0 is not enough: an entry whose
# value we do not recognise would silently read as enabled.
nonlead_daemon_disabled_labels() {
  local domain="$1" raw="" line="" body=""
  raw=$(_cnd_launchctl print-disabled "$domain" 2>/dev/null) || return 1
  # Shape:   disabled services = {
  #                  "com.flywheel.growth-learn" => disabled
  #          }
  printf '%s\n' "$raw" | grep -q 'disabled services = {' || return 1
  body=$(printf '%s\n' "$raw" | sed -n '/disabled services = {/,/^[[:space:]]*}[[:space:]]*$/p')
  [[ -n "$body" ]] || return 1
  # sed's range runs to end-of-input when the closing brace never arrives, so an
  # unterminated listing would otherwise parse as a complete one.
  printf '%s\n' "$body" | grep -Eq '^[[:space:]]*\}[[:space:]]*$' || return 1
  while IFS= read -r line; do
    # Skip ONLY the two framing lines and blanks. Anything else has to parse:
    # a line that merely contains a brace (`"x" => disabled } junk`) must not be
    # waved through, or a disabled label silently becomes an enabled one.
    case "$line" in
      '') continue ;;
    esac
    if printf '%s\n' "$line" | grep -Eq '^[[:space:]]*disabled services = \{[[:space:]]*$'; then
      continue
    fi
    if printf '%s\n' "$line" | grep -Eq '^[[:space:]]*\}[[:space:]]*$'; then
      continue
    fi
    if printf '%s\n' "$line" | grep -Eq '^[[:space:]]*"[^"]+"[[:space:]]*=>[[:space:]]*disabled[[:space:]]*$'; then
      printf '%s\n' "$line" | sed -E 's/^[[:space:]]*"([^"]+)".*$/\1/'
    elif printf '%s\n' "$line" | grep -Eq '^[[:space:]]*"[^"]+"[[:space:]]*=>[[:space:]]*enabled[[:space:]]*$'; then
      : # explicitly enabled — nothing to record
    else
      # An entry we cannot classify. Fail closed rather than guess "enabled".
      return 1
    fi
  done <<EOF
$body
EOF
  return 0
}

# Tri-state domain lookup: loaded | missing | error.
# "launchctl print failed" is NOT the same claim as "the service is absent" — a
# permissions or IPC failure would otherwise be read as absence and provoke a
# bootstrap of something that is already running. Only launchd's verbatim
# not-found message counts as absence.
nonlead_daemon_domain_state() {
  local domain="$1" label="$2" out="" rc=0
  out=$(_cnd_launchctl print "${domain}/${label}" 2>&1) || rc=$?
  if (( rc == 0 )); then
    printf 'loaded\n'
    return 0
  fi
  # The message must name the label we actually asked about. An unrelated
  # failure that happens to quote some other service's not-found text is not
  # evidence about ours. (macOS returns rc 113 here; the rc is deliberately NOT
  # required, because binding to it would silently disable convergence on any
  # OS release that renumbers it — and that failure direction is the damaging
  # one, whereas a stray false "missing" costs at most one refused bootstrap.)
  case "$out" in
    *"Could not find service \"${label}\""*) printf 'missing\n' ;;
    *) printf 'error\n' ;;
  esac
  return 0
}

converge_nonlead_daemons() {
  local domain agents_dir manifest repo_launchd disabled_labels plist label file_label state
  local row_label row_source row_policy row_exits row_note source_path destination target_state
  local row_disabled=false
  local considered=0 already=0 converged=0 failed=0 skipped_disabled=0 hold=0
  local needs_setup=0 managed_loaded=0 drift=0 manifest_ok=false
  local converged_names="" failed_names="" disabled_names="" hold_names=""
  local setup_names="" managed_names="" drift_names="" processed_labels=""

  _cnd_converge_codex_guard
  _cnd_set_outcome unverifiable "convergence did not run"
  domain=$(_cnd_domain)
  agents_dir=$(_cnd_launch_agents_dir)
  manifest=$(_cnd_units_manifest)
  repo_launchd=$(_cnd_repo_launchd_dir)

  if [[ ! -d "$agents_dir" ]]; then
    _cnd_set_outcome unverifiable "LaunchAgents directory missing: $agents_dir"
    _cnd_log "WARNING: ${NONLEAD_DAEMON_CONVERGE_DETAIL}"
    return 0
  fi

  if _cnd_load_manifest "$manifest"; then
    manifest_ok=true
  else
    failed=$((failed + 1))
    failed_names="${_CND_MANIFEST_ERROR}"
    _cnd_log "ERROR: ${_CND_MANIFEST_ERROR}; skipping manifest install branch but retaining installed-disk convergence"
  fi

  if ! disabled_labels=$(nonlead_daemon_disabled_labels "$domain"); then
    _cnd_set_outcome unverifiable \
      "launchctl print-disabled failed for ${domain}; converged nothing (enabled/disabled is unknowable)"
    _cnd_log "ERROR: ${NONLEAD_DAEMON_CONVERGE_DETAIL}"
    return 0
  fi

  # Manifest side of the union. Every manifest label passes the disabled gate
  # before install or bootstrap, including labels with no plist on disk yet.
  if [[ "$manifest_ok" == true ]]; then
    while IFS=$'\t' read -r row_label row_source row_policy row_exits row_note; do
      [[ -n "$row_label" ]] || continue
      processed_labels="${processed_labels}${processed_labels:+$'\n'}${row_label}"
      row_disabled=false

      if printf '%s\n' "$disabled_labels" | grep -Fxq "$row_label"; then
        skipped_disabled=$((skipped_disabled + 1))
        disabled_names="${disabled_names}${disabled_names:+,}${row_label}"
        row_disabled=true
      fi

      # Managed jobs are forbidden in the domain even when disabled. Disabled
      # suppresses mutation; it does not suppress visibility of a loaded job.
      if [[ "$row_policy" == managed ]]; then
        state="$(nonlead_daemon_domain_state "$domain" "$row_label")"
        if [[ "$state" == loaded ]]; then
          managed_loaded=$((managed_loaded + 1))
          failed=$((failed + 1))
          managed_names="${managed_names}${managed_names:+,}${row_label}"
        elif [[ "$state" == error ]]; then
          failed=$((failed + 1))
          failed_names="${failed_names:+${failed_names},}${row_label}(probe error)"
        fi
        continue
      fi
      [[ "$row_disabled" == false ]] || continue
      if [[ "$row_policy" == hold ]]; then
        hold=$((hold + 1))
        hold_names="${hold_names}${hold_names:+,}${row_label}"
        continue
      fi

      plist="$(_cnd_find_installed_plist "$agents_dir" "$row_label" 2>/dev/null || true)"
      state="$(nonlead_daemon_domain_state "$domain" "$row_label")"

      if [[ -z "$plist" && "$row_policy" == copy ]]; then
        source_path="${repo_launchd}/${row_source}"
        destination="${agents_dir}/${row_label}.plist"
        if ! _cnd_copy_plist_preflight "$source_path" "$row_label"; then
          failed=$((failed + 1))
          failed_names="${failed_names:+${failed_names},}${row_label}(${_CND_COPY_PREFLIGHT_ERROR})"
          continue
        fi
        if ! _cnd_install_plist "$source_path" "$destination" "$row_label"; then
          failed=$((failed + 1))
          failed_names="${failed_names:+${failed_names},}${row_label}(install failed)"
          continue
        fi
        plist="$destination"
      fi

      if [[ -z "$plist" ]]; then
        case "$row_policy" in
          setup)
            needs_setup=$((needs_setup + 1))
            failed=$((failed + 1))
            setup_names="${setup_names}${setup_names:+,}${row_label}"
            ;;
          external) : ;; # missing external units are informational only
        esac
        continue
      fi

      label="$(nonlead_daemon_plist_label "$plist" 2>/dev/null || true)"
      if [[ "$label" != "$row_label" ]]; then
        failed=$((failed + 1))
        failed_names="${failed_names:+${failed_names},}${row_label}(installed Label mismatch)"
        continue
      fi

      if [[ "$row_policy" == copy ]]; then
        source_path="${repo_launchd}/${row_source}"
        if ! _cnd_copy_plist_preflight "$source_path" "$row_label"; then
          failed=$((failed + 1))
          failed_names="${failed_names:+${failed_names},}${row_label}(source ${_CND_COPY_PREFLIGHT_ERROR})"
          continue
        fi
        if ! _cnd_copy_plist_preflight "$plist" "$row_label"; then
          failed=$((failed + 1))
          failed_names="${failed_names:+${failed_names},}${row_label}(installed ${_CND_COPY_PREFLIGHT_ERROR})"
          continue
        fi
        if ! cmp -s "$source_path" "$plist"; then
          drift=$((drift + 1))
          failed=$((failed + 1))
          drift_names="${drift_names}${drift_names:+,}${row_label}"
        fi
      fi

      considered=$((considered + 1))
      state="$(nonlead_daemon_domain_state "$domain" "$row_label")"
      if [[ "$state" == loaded ]]; then
        already=$((already + 1))
        continue
      fi
      if [[ "$state" != missing ]]; then
        failed=$((failed + 1))
        failed_names="${failed_names:+${failed_names},}${row_label}(probe error)"
        continue
      fi
      _cnd_log "converging manifest non-Lead daemon back into launchd: $row_label"
      if _cnd_launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1 \
        && [[ "$(nonlead_daemon_domain_state "$domain" "$row_label")" == loaded ]]; then
        converged=$((converged + 1))
        converged_names="${converged_names:+${converged_names},}${row_label}"
      else
        failed=$((failed + 1))
        failed_names="${failed_names:+${failed_names},}${row_label}"
      fi
    done <<EOF
${_CND_MANIFEST_ROWS}
EOF
  fi

  # Installed-disk side of the union. With a valid manifest this preserves the
  # v1 behavior for unmanaged installed com.flywheel jobs; with an invalid or
  # unreadable manifest it is the complete fallback path.
  for plist in "$agents_dir"/com.flywheel.*.plist; do
    # An unmatched glob yields the literal pattern; a symlinked plist is refused
    # rather than followed.
    _cnd_plist_is_active "$plist" || continue

    file_label="$(basename "$plist" .plist)"
    # No file-name shortcut in either direction: the declared Label is the whole
    # identity. A cheap "looks like a Lead" pre-filter would silently drop a
    # non-Lead daemon that merely happens to sit in a Lead-shaped file.
    if ! label="$(nonlead_daemon_plist_label "$plist")"; then
      failed=$((failed + 1))
      failed_names="${failed_names:+${failed_names},}${file_label}(unreadable Label)"
      _cnd_log "ERROR: cannot read the Label declared in ${plist}; refusing to guess it from the file name"
      continue
    fi

    # The declared Label is the identity that matters. A non-Lead file name that
    # declares a Lead label must not slip through, and a flywheel-named file must
    # not smuggle a service from someone else's namespace into the domain.
    if nonlead_daemon_is_lead_label "$label"; then
      continue
    fi
    case "$label" in
      com.flywheel.*) ;;
      *)
        failed=$((failed + 1))
        failed_names="${failed_names:+${failed_names},}${file_label}(foreign label ${label})"
        _cnd_log "ERROR: ${plist} declares ${label}, outside the com.flywheel namespace; refusing"
        continue
        ;;
    esac

    if [[ "$manifest_ok" == true ]] \
      && printf '%s\n' "$processed_labels" | grep -Fxq "$label"; then
      continue
    fi

    if printf '%s\n' "$disabled_labels" | grep -Fxq "$label"; then
      skipped_disabled=$((skipped_disabled + 1))
      disabled_names="${disabled_names}${disabled_names:+,}${label}"
      continue
    fi

    considered=$((considered + 1))
    state="$(nonlead_daemon_domain_state "$domain" "$label")"
    if [[ "$state" == "loaded" ]]; then
      already=$((already + 1))
      continue
    fi
    if [[ "$state" != "missing" ]]; then
      failed=$((failed + 1))
      failed_names="${failed_names:+${failed_names},}${label}(probe error)"
      _cnd_log "ERROR: domain probe for ${domain}/${label} failed for a reason other than absence; not bootstrapping"
      continue
    fi

    _cnd_log "converging non-Lead daemon back into launchd: $label"
    if _cnd_launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1 \
      && [[ "$(nonlead_daemon_domain_state "$domain" "$label")" == "loaded" ]]; then
      converged=$((converged + 1))
      converged_names="${converged_names:+${converged_names},}${label}"
    else
      failed=$((failed + 1))
      failed_names="${failed_names:+${failed_names},}${label}"
      _cnd_log "ERROR: could not converge ${domain}/${label} back into launchd"
    fi
  done

  local detail="enabled=${considered} already_loaded=${already} converged=${converged} failed=${failed} skipped_disabled=${skipped_disabled} hold=${hold} needs_setup=${needs_setup} managed_loaded=${managed_loaded} drift=${drift}"
  [[ -n "$converged_names" ]] && detail="${detail}; converged: ${converged_names}"
  [[ -n "$failed_names" ]] && detail="${detail}; failed: ${failed_names}"
  [[ -n "$disabled_names" ]] && detail="${detail}; skipped_disabled: ${disabled_names}"
  [[ -n "$hold_names" ]] && detail="${detail}; hold: ${hold_names}"
  [[ -n "$setup_names" ]] && detail="${detail}; needs_setup: ${setup_names}"
  [[ -n "$managed_names" ]] && detail="${detail}; managed_loaded: ${managed_names}"
  [[ -n "$drift_names" ]] && detail="${detail}; drift: ${drift_names}"

  if (( failed > 0 )); then
    _cnd_set_outcome degraded "$detail"
    _cnd_log "WARNING: non-Lead daemon convergence degraded — $detail"
  else
    _cnd_set_outcome healthy "$detail"
    _cnd_log "non-Lead daemon convergence: $detail"
  fi
  return 0
}

_cnd_launchctl_list_rows() {
  local raw="" rc=0 line="" pid="" last_exit="" label="" extra=""
  _CND_LIST_ROWS=""
  raw="$(_cnd_launchctl list 2>/dev/null)" || rc=$?
  (( rc == 0 )) || return 1
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if printf '%s\n' "$line" | grep -Eq '^[[:space:]]*PID[[:space:]]+Status[[:space:]]+Label[[:space:]]*$'; then
      continue
    fi
    pid=""; last_exit=""; label=""; extra=""
    read -r pid last_exit label extra <<EOF
$line
EOF
    [[ -z "$extra" && ( "$pid" == "-" || "$pid" =~ ^[0-9]+$ ) \
      && "$last_exit" =~ ^-?[0-9]+$ && -n "$label" ]] || return 1
    if [[ ! "$label" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
      # Strict validation is an ownership boundary, not a global launchctl
      # grammar. Ignore an unrelated Homebrew-style label, but fail closed for
      # malformed rows in a manifest census scope.
      if _cnd_label_in_census_scope "$label"; then
        return 1
      fi
      continue
    fi
    _CND_LIST_ROWS="${_CND_LIST_ROWS}${_CND_LIST_ROWS:+$'\n'}${label}"$'\t'"${pid}"$'\t'"${last_exit}"
  done <<EOF
$raw
EOF
  return 0
}

_cnd_list_row() {
  local wanted="$1" label="" pid="" last_exit=""
  while IFS=$'\t' read -r label pid last_exit; do
    if [[ "$label" == "$wanted" ]]; then
      printf '%s\t%s\n' "$pid" "$last_exit"
      return 0
    fi
  done <<EOF
${_CND_LIST_ROWS:-}
EOF
  return 1
}

_cnd_label_in_census_scope() {
  local label="$1" scope=""
  while IFS= read -r scope; do
    [[ -n "$scope" ]] || continue
    case "$label" in "$scope"*) return 0 ;; esac
  done <<EOF
${_CND_MANIFEST_SCOPES:-}
EOF
  return 1
}

_cnd_collect_lead_candidates() {
  local out_file="$1"
  if ! declare -F lead_restart_collect_candidates >/dev/null 2>&1; then
    : > "$out_file"
    return 1
  fi
  lead_restart_collect_candidates \
    "${HOME}/.flywheel/manifests" \
    "${HOME}/Library/LaunchAgents" \
    "${HOME}/.flywheel/projects.json" \
    "$out_file"
}

_cnd_exit_allowed() {
  local allowed="$1" actual="$2"
  [[ "$allowed" == "*" ]] && return 0
  printf ',%s,' "$allowed" | grep -Fq ",${actual},"
}

# Shared admission predicate for both Lead candidate sources. Callers inspect
# _CND_LEAD_EXCLUSION to distinguish invalid evidence from intentional QA or
# disabled exclusions, then de-duplicate only admitted labels.
_cnd_lead_candidate_is_expected() {
  local label="$1" lead_id="$2" classification="$3"
  local disabled_ok="$4" disabled_labels="$5"
  _CND_LEAD_EXCLUSION=""
  if ! printf '%s\n' "$label" \
      | grep -Eq '^com\.flywheel\.lead\.[A-Za-z0-9][A-Za-z0-9._-]*$' \
    || [[ "$label" == *'..'* ]] \
    || ! printf '%s\n' "$lead_id" | grep -Eq '^(-|[A-Za-z0-9][A-Za-z0-9._-]*)$'; then
    _CND_LEAD_EXCLUSION="invalid"
    return 1
  fi
  case "$classification" in
    restart|manifestless|config-drift|probe-error|skip-test|plist-complement) ;;
    *) _CND_LEAD_EXCLUSION="invalid"; return 1 ;;
  esac
  case "${label}|${lead_id}|${classification}" in
    *flywheel-test-*|*.qa*|*test-slot*|*skip-test*)
      _CND_LEAD_EXCLUSION="qa"
      return 1
      ;;
  esac
  if [[ "$disabled_ok" == true ]] \
    && printf '%s\n' "$disabled_labels" | grep -Fxq "$label"; then
    _CND_LEAD_EXCLUSION="disabled"
    return 1
  fi
  return 0
}

_cnd_emit_anomaly_key_rows() {
  local category="$1" names="$2" name=""
  while IFS= read -r name; do
    [[ -n "$name" ]] && printf '%s:%s\n' "$category" "$name"
  done < <(printf '%s\n' "$names" | tr ',' '\n')
  return 0
}

# Read-only, bidirectional fleet census. This function never invokes bootstrap,
# enable, bootout, or any other mutating launchctl verb.
census_launchd_fleet() {
  local domain agents_dir manifest repo_launchd disabled_labels="" disabled_ok=true list_ok=true
  local row_label row_source row_policy row_exits row_note plist source_path label basename
  local row_disabled=false
  local list_row pid last_exit state target_state key project lead_id lead_manifest classification sources
  local expected=0 loaded=0 converged=0 skipped_disabled=0 hold=0 drift=0 zombie=0
  local unverifiable=0 live_failure=0 managed_loaded=0 expected_unloaded=0 unmanaged=0
  local informational_exit=0
  local instrument_suspect=0 manifestless=0 lead_disabled=0 lead_expected=0 lead_loaded=0 lead_unloaded=0
  local enabled_manifest=0 list_manifest_seen=0 anomalies=0 manifest_ok=false
  local expected_unloaded_names="" drift_names="" zombie_names="" unverifiable_names=""
  local live_failure_names="" managed_names="" unmanaged_names="" disabled_names="" hold_names=""
  local informational_exit_names="" lead_unloaded_names="" lead_labels="" lead_seen_all="" lead_candidates=""
  local lead_excluded_seen="" candidate_line="" candidate_fields=0
  local informational_labels=""

  LAUNCHD_CENSUS_STATE="unverifiable"
  LAUNCHD_CENSUS_SUMMARY=""
  LAUNCHD_CENSUS_DETAIL=""
  LAUNCHD_CENSUS_ALERT_KEY=""
  LAUNCHD_CENSUS_ANOMALY=1

  domain="$(_cnd_domain)"
  agents_dir="$(_cnd_launch_agents_dir)"
  manifest="$(_cnd_units_manifest)"
  repo_launchd="$(_cnd_repo_launchd_dir)"
  if _cnd_load_manifest "$manifest"; then
    manifest_ok=true
  else
    unverifiable=$((unverifiable + 1))
    unverifiable_names="${_CND_MANIFEST_ERROR}"
  fi

  if ! disabled_labels="$(nonlead_daemon_disabled_labels "$domain")"; then
    disabled_ok=false
    instrument_suspect=1
    unverifiable=$((unverifiable + 1))
    unverifiable_names="${unverifiable_names:+${unverifiable_names},}print-disabled"
  fi
  if ! _cnd_launchctl_list_rows; then
    list_ok=false
    instrument_suspect=1
    unverifiable=$((unverifiable + 1))
    unverifiable_names="${unverifiable_names:+${unverifiable_names},}launchctl-list"
  fi

  if [[ "$manifest_ok" == true ]]; then
    while IFS=$'\t' read -r row_label row_source row_policy row_exits row_note; do
      [[ -n "$row_label" ]] || continue
      row_disabled=false
      if [[ "$disabled_ok" == true ]] \
        && printf '%s\n' "$disabled_labels" | grep -Fxq "$row_label"; then
        skipped_disabled=$((skipped_disabled + 1))
        disabled_names="${disabled_names}${disabled_names:+,}${row_label}"
        informational_labels="${informational_labels}${informational_labels:+$'\n'}${row_label}"
        row_disabled=true
      fi

      plist="$(_cnd_find_installed_plist "$agents_dir" "$row_label" 2>/dev/null || true)"
      list_row="$(_cnd_list_row "$row_label" 2>/dev/null || true)"
      if [[ "$row_policy" == managed ]]; then
        if [[ -n "$list_row" ]]; then
          managed_loaded=$((managed_loaded + 1))
          managed_names="${managed_names}${managed_names:+,}${row_label}"
        fi
        continue
      fi
      [[ "$row_disabled" == false ]] || continue
      if [[ "$row_policy" == hold ]]; then
        hold=$((hold + 1))
        hold_names="${hold_names}${hold_names:+,}${row_label}"
        informational_labels="${informational_labels}${informational_labels:+$'\n'}${row_label}"
        continue
      fi
      if [[ "$row_policy" == external && -z "$plist" ]]; then
        continue
      fi

      expected=$((expected + 1))
      enabled_manifest=$((enabled_manifest + 1))
      if [[ -n "$list_row" ]]; then
        loaded=$((loaded + 1))
        list_manifest_seen=$((list_manifest_seen + 1))
      fi

      if [[ "$row_policy" == copy ]]; then
        source_path="${repo_launchd}/${row_source}"
        if [[ -n "$plist" && -f "$source_path" && ! -L "$source_path" ]]; then
          if ! cmp -s "$source_path" "$plist"; then
            drift=$((drift + 1))
            drift_names="${drift_names}${drift_names:+,}${row_label}"
          fi
        elif [[ -n "$plist" && ! -f "$source_path" ]]; then
          unverifiable=$((unverifiable + 1))
          unverifiable_names="${unverifiable_names:+${unverifiable_names},}${row_label}(repo source missing)"
        fi
      fi

      if [[ -n "$list_row" ]]; then
        IFS=$'\t' read -r pid last_exit <<EOF
$list_row
EOF
        if [[ "$pid" == "-" ]]; then
          if [[ "$row_exits" == "*" && "$last_exit" != 0 ]]; then
            informational_exit=$((informational_exit + 1))
            informational_exit_names="${informational_exit_names}${informational_exit_names:+,}${row_label}(exit=${last_exit})"
          elif [[ "$row_exits" != "*" ]] \
            && ! _cnd_exit_allowed "$row_exits" "$last_exit"; then
            live_failure=$((live_failure + 1))
            live_failure_names="${live_failure_names}${live_failure_names:+,}${row_label}(exit=${last_exit})"
          fi
        fi
      fi
    done <<EOF
${_CND_MANIFEST_ROWS}
EOF
  fi

  if [[ "$list_ok" == true && "$disabled_ok" == true \
    && "$enabled_manifest" -gt 0 && "$list_manifest_seen" -eq 0 ]]; then
    instrument_suspect=1
    unverifiable=$((unverifiable + 1))
    unverifiable_names="${unverifiable_names:+${unverifiable_names},}launchctl-list-zero-positive-control"
  fi

  if (( instrument_suspect == 0 )) && [[ "$manifest_ok" == true ]]; then
    while IFS=$'\t' read -r row_label row_source row_policy row_exits row_note; do
      [[ -n "$row_label" ]] || continue
      if [[ "$disabled_ok" == true ]] \
        && printf '%s\n' "$disabled_labels" | grep -Fxq "$row_label"; then
        continue
      fi
      case "$row_policy" in hold|managed) continue ;; esac
      plist="$(_cnd_find_installed_plist "$agents_dir" "$row_label" 2>/dev/null || true)"
      [[ "$row_policy" != external || -n "$plist" ]] || continue
      if ! _cnd_list_row "$row_label" >/dev/null 2>&1; then
        expected_unloaded=$((expected_unloaded + 1))
        expected_unloaded_names="${expected_unloaded_names}${expected_unloaded_names:+,}${row_label}"
      fi
    done <<EOF
${_CND_MANIFEST_ROWS}
EOF
  fi

  # Reverse inventory: exact active regular plists only, with ownership derived
  # from manifest census-scope headers. Exit history for rows without a manifest
  # contract is informational, but resolved missing targets remain actionable.
  for plist in "$agents_dir"/*.plist; do
    _cnd_plist_is_active "$plist" || continue
    basename="$(basename "$plist" .plist)"
    label="$(nonlead_daemon_plist_label "$plist" 2>/dev/null || true)"
    if [[ -z "$label" ]]; then
      if [[ "$manifest_ok" == true ]] && _cnd_label_in_census_scope "$basename"; then
        unverifiable=$((unverifiable + 1))
        unverifiable_names="${unverifiable_names:+${unverifiable_names},}${basename}(Label unreadable)"
      fi
      continue
    fi
    nonlead_daemon_is_lead_label "$label" && continue
    [[ "$manifest_ok" == true ]] || continue
    _cnd_label_in_census_scope "$label" || continue

    # Disabled and hold rows are informational by contract. Their installed
    # payload state cannot turn them into zombie/unverifiable anomalies.
    if printf '%s\n' "$informational_labels" | grep -Fxq "$label"; then
      continue
    fi

    if ! _cnd_manifest_has_label "$label"; then
      unmanaged=$((unmanaged + 1))
      unmanaged_names="${unmanaged_names}${unmanaged_names:+,}${label}"
      list_row="$(_cnd_list_row "$label" 2>/dev/null || true)"
      if [[ -n "$list_row" ]]; then
        IFS=$'\t' read -r pid last_exit <<EOF
$list_row
EOF
        if [[ "$pid" == "-" && "$last_exit" != 0 ]]; then
          informational_exit=$((informational_exit + 1))
          informational_exit_names="${informational_exit_names}${informational_exit_names:+,}${label}(exit=${last_exit})"
        fi
      fi
    fi
    launchd_plist_program_target "$plist"
    target_state="$LAUNCHD_PROGRAM_STATE"
    case "$target_state" in
      resolved)
        if [[ ! -f "$LAUNCHD_PROGRAM_TARGET" ]]; then
          zombie=$((zombie + 1))
          zombie_names="${zombie_names}${zombie_names:+,}${label}"
        fi
        ;;
      unknown)
        unverifiable=$((unverifiable + 1))
        unverifiable_names="${unverifiable_names:+${unverifiable_names},}${label}"
        ;;
      not-applicable) : ;;
    esac
  done

  # Lead denominator: the restart lifecycle authority is primary, then active
  # plist names add the unloaded plist-only records the primary collector drops.
  lead_candidates="$(mktemp "${TMPDIR:-/tmp}/launchd-census-leads.XXXXXX")" || lead_candidates=""
  if [[ -z "$lead_candidates" ]] || ! _cnd_collect_lead_candidates "$lead_candidates"; then
    unverifiable=$((unverifiable + 1))
    unverifiable_names="${unverifiable_names:+${unverifiable_names},}lead-candidates"
  else
    while IFS= read -r candidate_line; do
      [[ -n "$candidate_line" ]] || continue
      candidate_fields="$(printf '%s\n' "$candidate_line" | awk -F '\t' '{print NF}')"
      key=""; project=""; lead_id=""; lead_manifest=""; classification=""; sources=""
      IFS=$'\t' read -r key project lead_id lead_manifest classification sources <<EOF
$candidate_line
EOF
      label="com.flywheel.lead.${key}"
      if [[ "$candidate_fields" != 6 || -z "$key" || -z "$project" \
        || -z "$lead_id" || -z "$lead_manifest" || -z "$classification" || -z "$sources" ]]; then
        unverifiable=$((unverifiable + 1))
        unverifiable_names="${unverifiable_names:+${unverifiable_names},}lead-candidate-invalid"
        continue
      fi
      if ! _cnd_lead_candidate_is_expected \
          "$label" "$lead_id" "$classification" "$disabled_ok" "$disabled_labels"; then
        if [[ "$_CND_LEAD_EXCLUSION" == invalid ]]; then
          unverifiable=$((unverifiable + 1))
          unverifiable_names="${unverifiable_names:+${unverifiable_names},}lead-candidate-invalid"
        elif [[ "$_CND_LEAD_EXCLUSION" == disabled ]] \
          && ! printf '%s\n' "$lead_excluded_seen" | grep -Fxq "$label"; then
          lead_excluded_seen="${lead_excluded_seen}${lead_excluded_seen:+$'\n'}${label}"
          lead_disabled=$((lead_disabled + 1))
        fi
        continue
      fi
      if printf '%s\n' "$lead_seen_all" | grep -Fxq "$label"; then
        continue
      fi
      lead_seen_all="${lead_seen_all}${lead_seen_all:+$'\n'}${label}"
      lead_labels="${lead_labels}${lead_labels:+$'\n'}${label}"
      lead_expected=$((lead_expected + 1))
      [[ "$classification" == manifestless ]] && manifestless=$((manifestless + 1))
    done < "$lead_candidates"
  fi
  [[ -z "$lead_candidates" ]] || rm -f "$lead_candidates" 2>/dev/null || true

  for plist in "$agents_dir"/com.flywheel.lead.*.plist; do
    _cnd_plist_is_active "$plist" || continue
    basename="$(basename "$plist" .plist)"
    label="$(nonlead_daemon_plist_label "$plist" 2>/dev/null || true)"
    [[ "$label" == "$basename" ]] || continue
    nonlead_daemon_is_lead_label "$label" || continue
    lead_id="${label#com.flywheel.lead.}"
    if ! _cnd_lead_candidate_is_expected \
        "$label" "$lead_id" plist-complement "$disabled_ok" "$disabled_labels"; then
      if [[ "$_CND_LEAD_EXCLUSION" == invalid ]]; then
        unverifiable=$((unverifiable + 1))
        unverifiable_names="${unverifiable_names:+${unverifiable_names},}lead-plist-invalid"
      elif [[ "$_CND_LEAD_EXCLUSION" == disabled ]] \
        && ! printf '%s\n' "$lead_excluded_seen" | grep -Fxq "$label"; then
        lead_excluded_seen="${lead_excluded_seen}${lead_excluded_seen:+$'\n'}${label}"
        lead_disabled=$((lead_disabled + 1))
      fi
      continue
    fi
    if printf '%s\n' "$lead_seen_all" | grep -Fxq "$label"; then
      continue
    fi
    lead_seen_all="${lead_seen_all}${lead_seen_all:+$'\n'}${label}"
    lead_labels="${lead_labels}${lead_labels:+$'\n'}${label}"
    lead_expected=$((lead_expected + 1))
  done

  while IFS= read -r label; do
    [[ -n "$label" ]] || continue
    state="$(nonlead_daemon_domain_state "$domain" "$label")"
    if [[ "$state" == loaded ]]; then
      lead_loaded=$((lead_loaded + 1))
    elif [[ "$state" == missing ]]; then
      if (( instrument_suspect == 0 )); then
        lead_unloaded=$((lead_unloaded + 1))
        lead_unloaded_names="${lead_unloaded_names}${lead_unloaded_names:+,}${label}"
      fi
    else
      unverifiable=$((unverifiable + 1))
      unverifiable_names="${unverifiable_names:+${unverifiable_names},}${label}(probe error)"
    fi
  done <<EOF
$lead_labels
EOF

  converged="$(printf '%s\n' "${NONLEAD_DAEMON_CONVERGE_DETAIL:-}" \
    | sed -n 's/.*converged=\([0-9][0-9]*\).*/\1/p' | head -1)"
  [[ "$converged" =~ ^[0-9]+$ ]] || converged=0

  anomalies=$((expected_unloaded + managed_loaded + drift + zombie + unverifiable + live_failure + lead_unloaded))
  if (( instrument_suspect > 0 )); then
    LAUNCHD_CENSUS_STATE="unverifiable"
  elif (( anomalies > 0 )); then
    LAUNCHD_CENSUS_STATE="degraded"
  else
    LAUNCHD_CENSUS_STATE="healthy"
  fi
  if (( anomalies > 0 )); then LAUNCHD_CENSUS_ANOMALY=1; else LAUNCHD_CENSUS_ANOMALY=0; fi

  LAUNCHD_CENSUS_SUMMARY="expected=${expected} loaded=${loaded} converged=${converged} skipped_disabled=${skipped_disabled} hold=${hold} drift=${drift} zombie=${zombie} unverifiable=${unverifiable} live_failure=${live_failure} informational_exit=${informational_exit} lead=${lead_loaded}/${lead_expected} manifestless=${manifestless} lead_disabled=${lead_disabled} expected_unloaded=${expected_unloaded} managed_loaded=${managed_loaded} unmanaged=${unmanaged} instrument_suspect=${instrument_suspect}"
  [[ -n "$expected_unloaded_names" ]] && LAUNCHD_CENSUS_DETAIL="expected_unloaded: ${expected_unloaded_names}"
  [[ -n "$managed_names" ]] && LAUNCHD_CENSUS_DETAIL="${LAUNCHD_CENSUS_DETAIL}${LAUNCHD_CENSUS_DETAIL:+; }managed_loaded: ${managed_names}"
  [[ -n "$drift_names" ]] && LAUNCHD_CENSUS_DETAIL="${LAUNCHD_CENSUS_DETAIL}${LAUNCHD_CENSUS_DETAIL:+; }drift: ${drift_names}"
  [[ -n "$zombie_names" ]] && LAUNCHD_CENSUS_DETAIL="${LAUNCHD_CENSUS_DETAIL}${LAUNCHD_CENSUS_DETAIL:+; }zombie: ${zombie_names}"
  [[ -n "$unverifiable_names" ]] && LAUNCHD_CENSUS_DETAIL="${LAUNCHD_CENSUS_DETAIL}${LAUNCHD_CENSUS_DETAIL:+; }unverifiable: ${unverifiable_names}"
  [[ -n "$live_failure_names" ]] && LAUNCHD_CENSUS_DETAIL="${LAUNCHD_CENSUS_DETAIL}${LAUNCHD_CENSUS_DETAIL:+; }live_failure: ${live_failure_names}"
  [[ -n "$informational_exit_names" ]] && LAUNCHD_CENSUS_DETAIL="${LAUNCHD_CENSUS_DETAIL}${LAUNCHD_CENSUS_DETAIL:+; }informational_exit: ${informational_exit_names}"
  [[ -n "$lead_unloaded_names" ]] && LAUNCHD_CENSUS_DETAIL="${LAUNCHD_CENSUS_DETAIL}${LAUNCHD_CENSUS_DETAIL:+; }lead_unloaded: ${lead_unloaded_names}"
  [[ -n "$disabled_names" ]] && LAUNCHD_CENSUS_DETAIL="${LAUNCHD_CENSUS_DETAIL}${LAUNCHD_CENSUS_DETAIL:+; }skipped_disabled: ${disabled_names}"
  [[ -n "$hold_names" ]] && LAUNCHD_CENSUS_DETAIL="${LAUNCHD_CENSUS_DETAIL}${LAUNCHD_CENSUS_DETAIL:+; }hold: ${hold_names}"
  [[ -n "$unmanaged_names" ]] && LAUNCHD_CENSUS_DETAIL="${LAUNCHD_CENSUS_DETAIL}${LAUNCHD_CENSUS_DETAIL:+; }unmanaged: ${unmanaged_names}"
  [[ -n "$LAUNCHD_CENSUS_DETAIL" ]] || LAUNCHD_CENSUS_DETAIL="healthy"

  # Alert identity contains only the canonical set of actionable category/name
  # pairs. Sorting makes the key independent of inventory traversal order, so
  # all lifecycle anchors dedupe the same set while a newly missing unit gets a
  # distinct delivery receipt on the same UTC day.
  LAUNCHD_CENSUS_ALERT_KEY="$({
    _cnd_emit_anomaly_key_rows expected_unloaded "$expected_unloaded_names"
    _cnd_emit_anomaly_key_rows managed_loaded "$managed_names"
    _cnd_emit_anomaly_key_rows drift "$drift_names"
    _cnd_emit_anomaly_key_rows zombie "$zombie_names"
    _cnd_emit_anomaly_key_rows unverifiable "$unverifiable_names"
    _cnd_emit_anomaly_key_rows live_failure "$live_failure_names"
    _cnd_emit_anomaly_key_rows lead_unloaded "$lead_unloaded_names"
  } | LC_ALL=C sort -u | paste -sd ';' -)"
  if (( anomalies > 0 )) && [[ -z "$LAUNCHD_CENSUS_ALERT_KEY" ]]; then
    LAUNCHD_CENSUS_ALERT_KEY="census-state:${LAUNCHD_CENSUS_STATE}"
  fi
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "converge-nonlead-daemons.sh is source-only; source it and call converge_nonlead_daemons or census_launchd_fleet" >&2
  exit 64
fi
