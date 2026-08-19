#!/usr/bin/env bash
# FLY-1887: atomically vendor the one-shot Codex wrapper + guard into stable
# host state, then converge ~/.local/bin/codex-with-fallback to a thin shim.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_WRAPPER="$SCRIPT_DIR/codex-with-fallback.sh"
SOURCE_GUARD="$SCRIPT_DIR/lib/codex-guard.sh"
STATE_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
GLOBAL_BIN_DIR="${FLYWHEEL_CODEX_GLOBAL_BIN_DIR:-$HOME/.local/bin}"
LIBEXEC_DIR="$STATE_DIR/libexec/codex-guard"
RELEASES_DIR="$LIBEXEC_DIR/releases"
CURRENT_LINK="$LIBEXEC_DIR/current"
GLOBAL_SHIM="$GLOBAL_BIN_DIR/codex-with-fallback"
BACKUP="$GLOBAL_SHIM.bak"

die() { printf '[install-codex-guard] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -f "$SOURCE_WRAPPER" && -f "$SOURCE_GUARD" ]] \
  || die "repo source wrapper/guard is missing"
/bin/bash -n "$SOURCE_WRAPPER" || die "wrapper source failed bash -n"
/bin/bash -n "$SOURCE_GUARD" || die "guard source failed bash -n"

content_hash="$({ shasum -a 256 "$SOURCE_WRAPPER"; shasum -a 256 "$SOURCE_GUARD"; } \
  | shasum -a 256 | awk '{print $1}')"
case "$content_hash" in ''|*[!0-9a-f]*) die "could not derive content hash" ;; esac

mkdir -p "$RELEASES_DIR" "$GLOBAL_BIN_DIR" || die "cannot create install directories"
chmod 700 "$LIBEXEC_DIR" "$RELEASES_DIR" 2>/dev/null || true
release_dir="$RELEASES_DIR/$content_hash"
if [[ ! -d "$release_dir" ]]; then
  stage="$RELEASES_DIR/.stage-$content_hash-$$"
  [[ ! -e "$stage" ]] || die "staging path already exists: $stage"
  mkdir "$stage" || die "cannot create release stage"
  if ! cp "$SOURCE_WRAPPER" "$stage/codex-with-fallback.sh" \
    || ! cp "$SOURCE_GUARD" "$stage/codex-guard.sh"; then
    rm -f "$stage/codex-with-fallback.sh" "$stage/codex-guard.sh" 2>/dev/null || true
    rmdir "$stage" 2>/dev/null || true
    die "cannot stage release"
  fi
  if ! chmod 555 "$stage/codex-with-fallback.sh" "$stage/codex-guard.sh"; then
    rm -f "$stage/codex-with-fallback.sh" "$stage/codex-guard.sh" 2>/dev/null || true
    rmdir "$stage" 2>/dev/null || true
    die "cannot lock release modes"
  fi
  if ! /bin/bash -n "$stage/codex-with-fallback.sh" \
    || ! /bin/bash -n "$stage/codex-guard.sh"; then
    rm -f "$stage/codex-with-fallback.sh" "$stage/codex-guard.sh" 2>/dev/null || true
    rmdir "$stage" 2>/dev/null || true
    die "staged release failed self-check"
  fi
  mv "$stage" "$release_dir" || die "cannot publish release"
fi

link_tmp="$LIBEXEC_DIR/.current-$$"
rm -f "$link_tmp" 2>/dev/null || true
ln -s "releases/$content_hash" "$link_tmp" || die "cannot stage current symlink"
mv -f "$link_tmp" "$CURRENT_LINK" || { rm -f "$link_tmp" 2>/dev/null || true; die "cannot publish current symlink"; }

if [[ ! -e "$BACKUP" && ! -L "$BACKUP" && ( -e "$GLOBAL_SHIM" || -L "$GLOBAL_SHIM" ) ]]; then
  cp -p "$GLOBAL_SHIM" "$BACKUP" || die "cannot preserve original wrapper backup"
fi

shim_tmp="$GLOBAL_BIN_DIR/.codex-with-fallback.tmp.$$"
cat > "$shim_tmp" <<'EOF'
#!/usr/bin/env bash
set -u
state_dir="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
target="$state_dir/libexec/codex-guard/current/codex-with-fallback.sh"
if [[ ! -x "$target" ]]; then
  printf '[codex-guard] INSTALL_ERROR stable wrapper is missing\n' >&2
  exit 125
fi
exec "$target" "$@"
EOF
chmod 555 "$shim_tmp" || { rm -f "$shim_tmp"; die "cannot lock global shim mode"; }
mv -f "$shim_tmp" "$GLOBAL_SHIM" || { rm -f "$shim_tmp"; die "cannot publish global shim"; }

# Keep the current release plus the two newest valid prior releases. Select by
# file mtime without parsing `ls`; a release name is always an exact SHA-256.
[[ -d "$CURRENT_LINK" ]] || die "current release is unreadable"
current_release="$release_dir"
newest_prior=""
second_prior=""
for candidate in "$RELEASES_DIR"/*; do
  [[ -d "$candidate" && ! -L "$candidate" ]] || continue
  candidate_name="${candidate##*/}"
  [[ "${#candidate_name}" -eq 64 ]] || continue
  case "$candidate_name" in *[!0-9a-f]*) continue ;; esac
  [[ "$candidate" != "$current_release" ]] || continue
  if [[ -z "$newest_prior" || "$candidate" -nt "$newest_prior" ]]; then
    second_prior="$newest_prior"
    newest_prior="$candidate"
  elif [[ -z "$second_prior" || "$candidate" -nt "$second_prior" ]]; then
    second_prior="$candidate"
  fi
done
for old_release in "$RELEASES_DIR"/*; do
  [[ -d "$old_release" && ! -L "$old_release" ]] || continue
  old_name="${old_release##*/}"
  [[ "${#old_name}" -eq 64 ]] || continue
  case "$old_name" in *[!0-9a-f]*) continue ;; esac
  [[ "$old_release" != "$current_release" \
    && "$old_release" != "$newest_prior" \
    && "$old_release" != "$second_prior" ]] || continue
  [[ -f "$old_release/codex-with-fallback.sh" && -f "$old_release/codex-guard.sh" ]] || continue
  [[ "$(find "$old_release" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')" == "2" ]] || continue
  rm -f "$old_release/codex-with-fallback.sh" "$old_release/codex-guard.sh" 2>/dev/null || continue
  rmdir "$old_release" 2>/dev/null || true
done

printf '[install-codex-guard] converged release %s\n' "$content_hash"
