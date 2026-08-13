#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGE_DIR="$REPO_ROOT/packages/edge-worker"
TASK_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly1718-push-guard-package.XXXXXX")"
trap 'rm -rf -- "$TASK_TMP_DIR"' EXIT

pnpm --dir "$REPO_ROOT" --filter flywheel-edge-worker build >/dev/null
TARBALL_NAME="$(cd "$PACKAGE_DIR" && npm_config_cache="$TASK_TMP_DIR/npm-cache" npm pack --pack-destination "$TASK_TMP_DIR" --ignore-scripts 2>/dev/null | tail -1)"
TARBALL="$TASK_TMP_DIR/$TARBALL_NAME"

tar -xzf "$TARBALL" -C "$TASK_TMP_DIR"
PACKED="$TASK_TMP_DIR/package"

test -f "$PACKED/dist/WorktreeManager.js"
test -f "$PACKED/dist/index.js"
test -x "$PACKED/assets/push-guard/pre-push"
grep -q 'WorktreeManager' "$PACKED/dist/index.js"
grep -q '../assets/push-guard/pre-push' "$PACKED/dist/WorktreeManager.js"

# Voice Bridge imports the package root and invokes `new WorktreeManager()`.
# These assertions prove that low-level production call shape retains both the
# root export and the asset path it resolves at runtime.
printf 'ok - packed edge-worker exports WorktreeManager with executable push-guard asset\n'
