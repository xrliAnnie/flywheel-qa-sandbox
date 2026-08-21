#!/bin/bash
# FLY-1364: link-only deploy must be inert apart from the approved symlinks.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
FIXTURE_ROOT="$(mktemp -d "$ROOT/scripts/__tests__/.tmp-cmux-link-only.XXXXXX")"
trap 'rm -rf "$TEST_ROOT" "$FIXTURE_ROOT"' EXIT

# FLY-1389 refuses any global-bin installer whose source is a linked worktree.
# Build a trusted-root-shaped fixture inside the repository (not /tmp), with
# its files symlinked back to the exact sources under test. The disposable HOME
# keeps every installed link and side effect hermetic.
mkdir -p "$FIXTURE_ROOT/.git" "$FIXTURE_ROOT/scripts/lib"
for path in \
  scripts/flywheel-cmux-install.sh \
  scripts/flywheel-cmux-sync.sh \
  scripts/flywheel-cmux-autostart.sh \
  scripts/lead-alert.sh \
  scripts/meta-alert.sh \
  scripts/flywheel-lead-attach.sh \
  scripts/flywheel-view-attach.sh \
  scripts/flywheel-node-status.sh \
  scripts/lib/cmux-mutator-process-census.sh \
  scripts/lib/flywheel-alert-lib.sh \
  scripts/lib/path-hygiene.sh; do
  ln -s "$ROOT/$path" "$FIXTURE_ROOT/$path"
done

HOME="$TEST_ROOT/home"
export HOME
mkdir -p "$HOME"
printf 'sentinel\n' > "$HOME/.zshrc"

before_zshrc=$(shasum -a 256 "$HOME/.zshrc" | awk '{print $1}')
FLYWHEEL_CMUX_INSTALL_SKIP_LAUNCHCTL=1 \
  /bin/bash "$FIXTURE_ROOT/scripts/flywheel-cmux-install.sh" --link-only >/dev/null
after_zshrc=$(shasum -a 256 "$HOME/.zshrc" | awk '{print $1}')

test "$before_zshrc" = "$after_zshrc"
test ! -e "$HOME/.flywheel/cmux-integration.zsh"
test ! -e "$HOME/Library/LaunchAgents/com.flywheel.cmux-watcher.plist"

assert_link() {
  local name="$1" target="$2"
  test -L "$HOME/.flywheel/bin/$name"
  test "$(readlink "$HOME/.flywheel/bin/$name")" = "$FIXTURE_ROOT/$target"
}

assert_link flywheel-cmux-sync scripts/flywheel-cmux-sync.sh
assert_link flywheel-cmux-autostart scripts/flywheel-cmux-autostart.sh
assert_link cmux-mutator-process-census.sh scripts/lib/cmux-mutator-process-census.sh
assert_link flywheel-alert-lib.sh scripts/lib/flywheel-alert-lib.sh
assert_link lead-alert.sh scripts/lead-alert.sh
assert_link meta-alert.sh scripts/meta-alert.sh
assert_link flywheel-lead-attach.sh scripts/flywheel-lead-attach.sh
assert_link flywheel-view-attach.sh scripts/flywheel-view-attach.sh
assert_link flywheel-node-status.sh scripts/flywheel-node-status.sh

echo "flywheel-cmux-install --link-only: ok"
