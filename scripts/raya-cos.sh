#!/bin/bash
# FLY-2695: host shim for the Raya CoS business CLI (plan FLY-2680 §6.2, L1).
#
# WHAT: the one stable entry point the Raya persona calls for durable business
# commands — `~/.flywheel/bin/raya-cos.sh <command> [args]` — resolving to
# `node $FLYWHEEL_DIR/packages/raya-cos/dist/cli.js <command> [args]`.
#
# WHY A SHIM (and why a COPY in <state>/bin):
#   • The Lead child PATH (flywheel-lead.sh:8) does not contain ~/.flywheel/bin,
#     and the package ships no linked executable into the business workspace,
#     so the persona needs one absolute path that never moves between deploys.
#   • converge-flywheel-bin.sh installs this file as a checksum-pinned, mode-555
#     copy, so it lives under the same "installed copy == repo source"
#     invariant as every other runtime script. A symlink would bypass both the
#     sha check and host-config's ENV > host.json > default resolution.
#
# INVARIANTS:
#   • No business logic here. cos is cwd-scoped (it reads and writes
#     <cwd>/state/cos/), so this shim never cds and never rewrites argv; the
#     CLI's own exit status passes through `exec` untouched.
#   • Host inputs come only through host-config (ENV > host.json > default).
#     ~/.flywheel/.env is NOT sourced: this is a reader, and a writable file
#     must not be able to redirect which checkout it executes.
#   • Every configuration failure is loud: EX_CONFIG (78), same as
#     flywheel-lead.sh's fail(), never a silent success.
#   • Monorepo hosts only. PO_PACKAGES never ships raya-cos, so the packaged
#     branch of the converger lists this name in RETIRED_FILES and actively
#     removes any copy it finds there.
set -euo pipefail

fail() { printf '[raya-cos.sh] ERROR: %s\n' "$1" >&2; exit "${2:-78}"; }

# Same host-config lookup order as flywheel-lead.sh:42-56 (load_common):
# <state>/bin/lib → next to this script → the checkout. FLYWHEEL_STATE_DIR is
# used only to find the library; host_config_load owns every resolved value.
state="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
lib="$state/bin/lib/host-config.sh"
[ -f "$lib" ] || lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/host-config.sh"
[ -f "$lib" ] || lib="${FLYWHEEL_DIR:-$HOME/Dev/flywheel}/scripts/lib/host-config.sh"
[ -f "$lib" ] || fail "host-config.sh is missing (looked under $state/bin/lib, next to this shim, and the checkout)"
# A present-but-unloadable library (unreadable, syntax error) is a config
# failure too, so it must exit 78 rather than source's own 1/2. errexit is
# lifted around the source itself: macOS /bin/bash 3.2 exits on a failed
# `source` under `set -e` even inside `source … || fail`.
set +e
# shellcheck source=lib/host-config.sh
# shellcheck disable=SC1091
source "$lib"
lib_rc=$?
set -e
[ "$lib_rc" -eq 0 ] || fail "host-config.sh could not be loaded from $lib"
host_config_load >/dev/null || fail "host.json is invalid"

cli="$FLYWHEEL_DIR/packages/raya-cos/dist/cli.js"
[ -f "$cli" ] || fail "Raya CoS CLI is not built at $cli (run pnpm -r build in $FLYWHEEL_DIR)"
command -v node >/dev/null 2>&1 || fail "node is not on PATH"
exec node "$cli" "$@"
