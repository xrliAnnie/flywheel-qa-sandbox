#!/usr/bin/env bash
# FLY-1887: atomically vendor the one-shot Codex wrapper + guard into stable
# host state, then converge ~/.local/bin/codex-with-fallback to a thin shim.
# Emergency disable: touch ~/.flywheel/libexec/codex-guard/DISABLED, rerun this
# installer, and smoke-test the wrapper. Re-enable only by removing that exact
# sentinel, rerunning this installer, and verifying `readlink .../current`.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_WRAPPER="$SCRIPT_DIR/codex-with-fallback.sh"
SOURCE_GUARD="$SCRIPT_DIR/lib/codex-guard.sh"
GLOBAL_BIN_DIR="${FLYWHEEL_CODEX_GLOBAL_BIN_DIR:-$HOME/.local/bin}"
LIBEXEC_DIR="${FLYWHEEL_CODEX_GUARD_INSTALL_ROOT:-$HOME/.flywheel/libexec/codex-guard}"
RELEASES_DIR="$LIBEXEC_DIR/releases"
CURRENT_LINK="$LIBEXEC_DIR/current"
GLOBAL_SHIM="$GLOBAL_BIN_DIR/codex-with-fallback"
BACKUP="$GLOBAL_SHIM.bak"
DISABLE_SENTINEL="$LIBEXEC_DIR/DISABLED"
MANAGED_SHIM_SENTINEL="# FLYWHEEL_CODEX_GUARD_MANAGED_SHIM=1"

die() { printf '[install-codex-guard] ERROR: %s\n' "$*" >&2; exit 1; }

shim_file_is_managed() {
  local candidate="$1"
  [[ -f "$candidate" && ! -L "$candidate" ]] || return 1
  grep -Fxq "$MANAGED_SHIM_SENTINEL" "$candidate" 2>/dev/null && return 0
  # Recognize the unmarked shim emitted by the pre-fix installer too. This
  # keeps a host that already ran those bytes from preserving the guard as its
  # own "legacy" rollback on the first fixed convergence.
  # shellcheck disable=SC2016
  grep -Fq '[codex-guard] INSTALL_ERROR stable wrapper is missing' "$candidate" 2>/dev/null \
    && grep -Fq 'exec "$target" "$@"' "$candidate" 2>/dev/null
}

global_shim_is_managed() {
  shim_file_is_managed "$GLOBAL_SHIM"
}

publish_current_symlink() {
  local staged="$1" target="$2"
  [[ ! -e "$target" || -L "$target" ]] \
    || die "current target is not a symlink: $target"

  # GNU mv needs -T to replace a destination symlink instead of treating its
  # referent as a directory. BSD/macOS mv spells the same no-follow contract
  # -h. Both forms call rename(2), so current never has an unlink gap.
  /bin/mv -fT "$staged" "$target" 2>/dev/null && return 0
  /bin/mv -fh "$staged" "$target" 2>/dev/null && return 0
  return 1
}

# Persistent rollback: restoring .bak by hand is not enough because this
# installer runs on every same-SHA convergence wave. The sentinel makes the
# rollback durable until an operator explicitly removes it and reruns install.
if [[ -e "$DISABLE_SENTINEL" || -L "$DISABLE_SENTINEL" ]]; then
  [[ -f "$DISABLE_SENTINEL" && ! -L "$DISABLE_SENTINEL" ]] \
    || die "disable sentinel is not a regular file: $DISABLE_SENTINEL"
  mkdir -p "$GLOBAL_BIN_DIR" || die "cannot create global bin directory"
  disabled_tmp="$GLOBAL_BIN_DIR/.codex-with-fallback.disabled.$$"
  publish_passthrough=0
  if [[ -f "$BACKUP" && ! -L "$BACKUP" ]] \
    && ! shim_file_is_managed "$BACKUP"; then
    cp -p "$BACKUP" "$disabled_tmp" \
      || { rm -f "$disabled_tmp" 2>/dev/null || true; die "cannot stage disabled wrapper"; }
    disabled_source="$BACKUP"
  elif [[ -f "$BACKUP" && ! -L "$BACKUP" ]]; then
    publish_passthrough=1
    disabled_source="direct codex passthrough (managed backup ignored)"
  elif [[ -e "$BACKUP" || -L "$BACKUP" ]]; then
    die "guard backup exists but is not a regular file: $BACKUP"
  else
    publish_passthrough=1
    disabled_source="direct codex passthrough (no legacy backup existed)"
  fi
  if [[ "$publish_passthrough" == "1" ]]; then
    {
      printf '#!/usr/bin/env bash\n'
      printf '%s\n' "$MANAGED_SHIM_SENTINEL"
      printf 'set -u\n'
      # shellcheck disable=SC2016
      printf '%s\n' 'exec codex "$@"'
    } > "$disabled_tmp" \
      || { rm -f "$disabled_tmp" 2>/dev/null || true; die "cannot stage disabled passthrough"; }
    chmod 555 "$disabled_tmp" \
      || { rm -f "$disabled_tmp" 2>/dev/null || true; die "cannot lock disabled passthrough mode"; }
  fi
  mv -f "$disabled_tmp" "$GLOBAL_SHIM" \
    || { rm -f "$disabled_tmp" 2>/dev/null || true; die "cannot publish disabled wrapper"; }
  printf '[install-codex-guard] disabled; published %s\n' "$disabled_source"
  exit 0
fi

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
publish_current_symlink "$link_tmp" "$CURRENT_LINK" \
  || { rm -f "$link_tmp" 2>/dev/null || true; die "cannot publish current symlink"; }

if [[ ! -e "$BACKUP" && ! -L "$BACKUP" \
  && ( -e "$GLOBAL_SHIM" || -L "$GLOBAL_SHIM" ) ]] \
  && ! global_shim_is_managed; then
  cp -p "$GLOBAL_SHIM" "$BACKUP" || die "cannot preserve original wrapper backup"
fi

shim_tmp="$GLOBAL_BIN_DIR/.codex-with-fallback.tmp.$$"
{
  printf '#!/usr/bin/env bash\n'
  printf '%s\n' "$MANAGED_SHIM_SENTINEL"
  printf 'set -u\n'
  # Resolve once at install time. A generic ambient FLYWHEEL_STATE_DIR has a
  # different meaning in other packages and must never redirect this machine-
  # global executable.
  printf 'target=%q\n' "$CURRENT_LINK/codex-with-fallback.sh"
  # shellcheck disable=SC2016
  printf '%s\n' 'if [[ ! -x "$target" ]]; then'
  printf '%s\n' "  printf '[codex-guard] INSTALL_ERROR stable wrapper is missing\\n' >&2"
  printf '%s\n' '  exit 125'
  printf '%s\n' 'fi'
  # shellcheck disable=SC2016
  printf '%s\n' 'exec "$target" "$@"'
} > "$shim_tmp" || { rm -f "$shim_tmp" 2>/dev/null || true; die "cannot stage global shim"; }
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
  [[ -f "$old_release/codex-with-fallback.sh" \
    && ! -L "$old_release/codex-with-fallback.sh" \
    && -f "$old_release/codex-guard.sh" \
    && ! -L "$old_release/codex-guard.sh" ]] || continue
  entry_count="$(find "$old_release" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
  residue_count="$(find "$old_release" -mindepth 1 -maxdepth 1 \
    -type l -name '.current-*' | wc -l | tr -d ' ')"
  [[ "$entry_count" == "$(( 2 + residue_count ))" ]] || continue
  rm -f "$old_release/codex-with-fallback.sh" "$old_release/codex-guard.sh" 2>/dev/null || continue
  for current_residue in "$old_release"/.current-*; do
    [[ -L "$current_residue" ]] || continue
    rm -f "$current_residue" 2>/dev/null || true
  done
  rmdir "$old_release" 2>/dev/null || true
done

printf '[install-codex-guard] converged release %s\n' "$content_hash"
