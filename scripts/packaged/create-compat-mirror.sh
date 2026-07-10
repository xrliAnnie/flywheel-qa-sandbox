#!/usr/bin/env bash
# FLY-1062 P0/§0 layout contract: packages/ compatibility mirror.
#
# The payload physically places every workspace package at
# node_modules/<npm-name>/ (the canonical location for bare-specifier
# resolution). The existing monorepo path contracts, however, address them as
# $FLYWHEEL_DIR/packages/<dir>/... (claude-lead.sh, flywheel-lead-wrapper.sh,
# flywheel-comm callers, validate-projects, ...). This script creates the
# RELATIVE symlink mirror  packages/<dir> → node_modules/<npm-name>  inside an
# installed PKG_ROOT so those contracts hold verbatim.
#
# Created at INSTALL time (not pack time): npm pack's handling of symlinks is
# not a contract we want to depend on (design §0). The mirror set is the
# `flywheelPackagesMirror` map the packaging pipeline wrote into the payload
# package.json — the audit table's single source of truth for the mirror.
#
# Usage: create-compat-mirror.sh [PKG_ROOT]   (default: this script's tree root)
# Idempotent: correct existing links are left alone; wrong links are replaced.
# Runs with node only (jq is NOT yet installed at first-install time).
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="${1:-$(cd "$SELF_DIR/../.." && pwd)}"

err() { echo "[compat-mirror] ERROR: $*" >&2; }

[ -f "$PKG_ROOT/package.json" ] || { err "no package.json at $PKG_ROOT"; exit 1; }
[ -f "$PKG_ROOT/.flywheel-prebuilt" ] || { err "not a packaged tree (no .flywheel-prebuilt): $PKG_ROOT"; exit 1; }

# dir<TAB>npm-name pairs from the payload manifest (fail-closed on absence).
PAIRS="$(node -e '
  const fs = require("node:fs");
  const pj = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const m = pj.flywheelPackagesMirror;
  if (!m || typeof m !== "object" || Object.keys(m).length === 0) {
    console.error("payload package.json has no flywheelPackagesMirror map");
    process.exit(1);
  }
  for (const [dir, name] of Object.entries(m)) console.log(`${dir}\t${name}`);
' "$PKG_ROOT/package.json")" || exit 1

# ── prune npm's unreified nested-dep husks ──────────────────────────────────
# npm's tree planner may place a nested dep INSIDE the bundled payload tree
# (peer/hoist conflict at the install prefix) and then fail to reify it there —
# it leaves an EMPTY directory (observed with @anthropic-ai/sdk when mem0ai's
# peer claims the flat slot). An existing dir terminates ESM walk-up
# resolution, so the empty husk SHADOWS the flat-installed copy. Only EMPTY
# dirs are removed — real content is never touched.
find "$PKG_ROOT/node_modules" -mindepth 2 -maxdepth 2 -path "$PKG_ROOT/node_modules/@*/*" -type d -empty -delete 2>/dev/null
find "$PKG_ROOT/node_modules" -mindepth 1 -maxdepth 1 -type d -empty -delete 2>/dev/null

# ── vendored nested deps: vendor/<npm-name>/… → node_modules/<npm-name>/node_modules/ ──
# npm pack cannot ship node_modules nested inside bundled deps, so the payload
# stages the registered disjoint-version closures under vendor/ and this step
# COPIES them into place (real files — no symlink/realpath resolution caveats).
if [ -d "$PKG_ROOT/vendor" ]; then
  for vdir in "$PKG_ROOT/vendor"/*; do
    [ -d "$vdir" ] || continue
    vname="$(basename "$vdir")"
    if [ ! -d "$PKG_ROOT/node_modules/$vname" ]; then
      err "vendor target package missing: node_modules/$vname"
      exit 1
    fi
    mkdir -p "$PKG_ROOT/node_modules/$vname/node_modules"
    cp -Rf "$vdir/." "$PKG_ROOT/node_modules/$vname/node_modules/" \
      || { err "vendored nested copy failed for $vname"; exit 1; }
    echo "[compat-mirror] vendored nested deps installed for $vname"
  done
fi

mkdir -p "$PKG_ROOT/packages"
rc=0
while IFS=$'\t' read -r dir name; do
  [ -z "$dir" ] && continue
  target="../node_modules/$name"
  link="$PKG_ROOT/packages/$dir"
  if [ ! -d "$PKG_ROOT/node_modules/$name" ]; then
    err "mirror target missing: node_modules/$name"
    rc=1
    continue
  fi
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "$target" ] && continue
    rm -f "$link"
  elif [ -e "$link" ]; then
    err "packages/$dir exists and is not a symlink — refusing to replace"
    rc=1
    continue
  fi
  ln -s "$target" "$link" || { err "cannot link packages/$dir"; rc=1; }
done <<<"$PAIRS"

if [ "$rc" -eq 0 ]; then
  echo "[compat-mirror] ok: packages/ mirror in place at $PKG_ROOT"
fi
exit "$rc"
