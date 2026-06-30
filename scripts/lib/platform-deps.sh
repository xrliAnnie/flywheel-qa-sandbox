#!/bin/bash
# FLY-650: platform-deps.sh — per-platform dependency resolution (WI-6).
#
# FLY-519's manifest deps[] is macOS/brew-only. This lib resolves a dep to a
# platform-correct ACTION so the provisioner installs via the right channel on
# Linux (apt/dnf), checks-only deps that arrive via nvm/corepack, and fails loud
# (never silently skips a REQUIRED dep) when an old darwin-only capture is run on
# Linux (Codex R2#4).
#
# Schema (new):
#   {"name","required":bool,"platforms":{"darwin":{"channel","formula"},
#                                        "linux":{"apt","dnf","presentCheck":bool}},
#    "check":{"command","version"}}
# Old single-layer {"channel","formula"} is treated as DARWIN-only (back-compat).
#
# platform_deps_select <manifest-json> <platform:darwin|linux> <pkgmgr:brew|apt|dnf>
#   → one TSV line per dep:  name<TAB>action<TAB>arg
#   actions: install-brew | install-apt | install-dnf | present-check
#          | manual | skip | error-no-linux-mapping
[ -n "${PLATFORM_DEPS_SOURCED:-}" ] && return 0
PLATFORM_DEPS_SOURCED=1

platform_deps_select() {
  local manifest="$1" platform="$2" pkgmgr="$3"
  command -v jq >/dev/null 2>&1 || { echo "[platform-deps] ERROR: jq required" >&2; return 2; }

  local n required has_darwin has_linux channel formula apt dnf presentcheck has_check
  while IFS= read -r dep; do
    [ -z "$dep" ] && continue
    n="$(jq -r '.name // empty' <<<"$dep")"
    [ -z "$n" ] && continue
    required="$(jq -r 'if (.required==true) then "true" else "false" end' <<<"$dep")"
    channel="$(jq -r '.channel // empty' <<<"$dep")"          # old single-layer
    formula="$(jq -r '.formula // empty' <<<"$dep")"          # old single-layer
    has_darwin="$(jq -r 'if (.platforms.darwin) then "y" else "n" end' <<<"$dep")"
    has_linux="$(jq -r 'if (.platforms.linux) then "y" else "n" end' <<<"$dep")"
    apt="$(jq -r '.platforms.linux.apt // empty' <<<"$dep")"
    dnf="$(jq -r '.platforms.linux.dnf // empty' <<<"$dep")"
    presentcheck="$(jq -r 'if (.platforms.linux.presentCheck==true) then "y" else "n" end' <<<"$dep")"
    has_check="$(jq -r 'if (.check) then "y" else "n" end' <<<"$dep")"

    # channel=manual (anywhere) → manual install (AI CLIs, cmux on darwin).
    if [ "$channel" = "manual" ] || \
       { [ "$platform" = "darwin" ] && [ "$(jq -r '.platforms.darwin.channel // empty' <<<"$dep")" = "manual" ]; } || \
       { [ "$platform" = "linux" ]  && [ "$(jq -r '.platforms.linux.channel // empty'  <<<"$dep")" = "manual" ]; }; then
      printf '%s\tmanual\t%s\n' "$n" "$n"
      continue
    fi

    if [ "$platform" = "darwin" ]; then
      # new-schema darwin formula, else old single-layer formula.
      local f
      f="$(jq -r '.platforms.darwin.formula // empty' <<<"$dep")"
      [ -z "$f" ] && f="$formula"
      [ -z "$f" ] && f="$n"
      if [ "$has_darwin" = "y" ] || [ "$channel" = "brew" ]; then
        printf '%s\tinstall-brew\t%s\n' "$n" "$f"
      else
        printf '%s\tmanual\t%s\n' "$n" "$n"
      fi
      continue
    fi

    # platform = linux
    if [ "$has_linux" = "y" ]; then
      if [ "$presentcheck" = "y" ]; then
        printf '%s\tpresent-check\t%s\n' "$n" "$n"
      elif [ "$pkgmgr" = "apt" ] && [ -n "$apt" ]; then
        printf '%s\tinstall-apt\t%s\n' "$n" "$apt"
      elif [ "$pkgmgr" = "dnf" ] && [ -n "$dnf" ]; then
        printf '%s\tinstall-dnf\t%s\n' "$n" "$dnf"
      elif [ -n "$apt" ] || [ -n "$dnf" ]; then
        # has a linux package but not for the detected pkgmgr → present-check
        # fallback so a missing required dep still surfaces (don't silently skip).
        printf '%s\tpresent-check\t%s\n' "$n" "$n"
      else
        # platforms.linux exists but empty → treat as present-check.
        printf '%s\tpresent-check\t%s\n' "$n" "$n"
      fi
      continue
    fi

    # linux + NO linux mapping:
    if [ "$required" = "true" ]; then
      # R2#4: never silently skip a required dep on an old darwin-only capture.
      printf '%s\terror-no-linux-mapping\trecapture with FLY-650 or add platforms.linux\n' "$n"
    else
      printf '%s\tskip\t%s\n' "$n" "$n"
    fi
  done < <(jq -c '.deps[]?' <<<"$manifest" 2>/dev/null)
}
