#!/bin/sh
set -eu

remote_url=https://github.com/xrliAnnie/lead-memory.git
remote_repo=xrliAnnie/lead-memory
target=${HOME:?HOME is required}/.claude/agent-memory
target_parent=$HOME/.claude

fail() {
	printf 'lead-memory-bootstrap: %s\n' "$1" >&2
	exit 1
}

usage() {
	printf 'lead-memory-bootstrap: unknown argument; usage: bootstrap.sh --init|--clone\n' >&2
	exit 2
}

[ "$#" -eq 1 ] || usage
case $1 in
	--init) mode=init ;;
	--clone) mode=clone ;;
	*) usage ;;
esac

# Every check above this line and through preflight_target is read-only. A
# failed preflight must leave both the live memory directory and its enclosing
# ~/.claude repository byte-for-byte unchanged.
for dependency in git gh gitleaks python3; do
	command -v "$dependency" >/dev/null 2>&1 || fail "$dependency is required"
done
gitleaks_version=$(gitleaks version 2>/dev/null || true)
[ "$gitleaks_version" = 8.30.1 ] ||
	fail "gitleaks 8.30.1 is required (found ${gitleaks_version:-missing})"
remote_private=$(gh repo view "$remote_repo" --json isPrivate --jq .isPrivate 2>/dev/null || true)
[ "$remote_private" = true ] || fail "private repository $remote_repo is unavailable"
[ -d "$target_parent" ] || fail "target parent does not exist: $target_parent"
[ ! -L "$target" ] || fail "target must not be a symbolic link: $target"
ignore_file=$target_parent/.gitignore
[ ! -L "$ignore_file" ] || fail "enclosing .gitignore must not be a symbolic link: $ignore_file"
if [ -e "$ignore_file" ] && [ ! -f "$ignore_file" ]; then
	fail "enclosing .gitignore must be a regular file: $ignore_file"
fi

target_exists=0
target_repo=0
if [ -e "$target" ]; then
	target_exists=1
	[ -d "$target" ] || fail "target is not a directory: $target"
	if [ -e "$target/.git" ] || [ -L "$target/.git" ]; then
		[ ! -L "$target/.git" ] && [ -d "$target/.git" ] ||
			fail "target .git must be a directory owned by the target repository"
		top=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null || true)
		[ -n "$top" ] || fail "target .git is not a usable repository"
		top_physical=$(CDPATH='' cd -- "$top" 2>/dev/null && pwd -P) ||
			fail "cannot resolve target repository root"
		target_physical=$(CDPATH='' cd -- "$target" 2>/dev/null && pwd -P) ||
			fail "cannot resolve target path"
		[ "$top_physical" = "$target_physical" ] ||
			fail "target repository root is not the exact memory path"
		target_repo=1
		existing_origin=$(git -C "$target" config --local --get remote.origin.url 2>/dev/null || true)
		if [ -n "$existing_origin" ] && [ "$existing_origin" != "$remote_url" ]; then
			fail "origin does not match $remote_url"
		fi
		existing_pushurl=$(git -C "$target" config --get-all remote.origin.pushurl 2>/dev/null || true)
		[ -z "$existing_pushurl" ] ||
			fail 'origin push URL must not be configured separately'
		if git -C "$target" rev-parse --verify HEAD >/dev/null 2>&1; then
			existing_branch=$(git -C "$target" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
			[ "$existing_branch" = main ] || fail "existing repository branch must be main"
		fi
	fi
fi

ensure_outer_ignore() {
	if [ -f "$ignore_file" ] && grep -Fxq 'agent-memory/' "$ignore_file"; then
		return
	fi
	if [ -s "$ignore_file" ] && [ -n "$(tail -c 1 "$ignore_file")" ]; then
		printf '\nagent-memory/\n' >>"$ignore_file" || fail "could not update $ignore_file"
	else
		printf 'agent-memory/\n' >>"$ignore_file" || fail "could not update $ignore_file"
	fi
}

trees_match_without_root_git() {
	python3 - "$1" "$2" <<'PY'
import hashlib
import os
import stat
import sys


def snapshot(root):
    entries = []
    pending = [("", root)]
    while pending:
        relative_parent, directory = pending.pop()
        with os.scandir(directory) as iterator:
            children = sorted(iterator, key=lambda entry: os.fsencode(entry.name), reverse=True)
        for entry in children:
            if not relative_parent and entry.name == ".git":
                continue
            relative = entry.name if not relative_parent else relative_parent + "/" + entry.name
            metadata = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(metadata.st_mode):
                entries.append(("directory", relative))
                pending.append((relative, entry.path))
            elif stat.S_ISREG(metadata.st_mode):
                digest = hashlib.sha256()
                with open(entry.path, "rb") as handle:
                    for block in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(block)
                entries.append(("file", relative, bool(metadata.st_mode & 0o111), digest.digest()))
            elif stat.S_ISLNK(metadata.st_mode):
                entries.append(("symlink", relative, os.readlink(entry.path)))
            else:
                entries.append(("special", relative, stat.S_IFMT(metadata.st_mode)))
    return entries


try:
    matches = snapshot(sys.argv[1]) == snapshot(sys.argv[2])
except OSError:
    sys.exit(2)
sys.exit(0 if matches else 1)
PY
}

require_replacement_confirmation_if_divergent() {
	existing_target=$1
	validated_clone=$2
	preserved_target=$3
	if trees_match_without_root_git "$existing_target" "$validated_clone"; then
		return
	else
		compare_status=$?
	fi
	if [ "$compare_status" -ne 1 ]; then
		rm -rf -- "$validated_clone"
		fail "could not compare existing memory with the repository snapshot"
	fi
	printf '%s\n' \
		'lead-memory-bootstrap: WARNING: existing memory differs from the repository snapshot and may contain newer live state' \
		"lead-memory-bootstrap: replacement will preserve the current directory at $preserved_target" \
		'lead-memory-bootstrap: type REPLACE to continue' >&2
	confirmation=
	if IFS= read -r confirmation; then :; fi
	if [ "$confirmation" != REPLACE ]; then
		rm -rf -- "$validated_clone"
		fail "replacement cancelled; original directory was not changed"
	fi
}

if [ "$mode" = init ]; then
	[ "$target_exists" -eq 1 ] || fail "--init requires an existing memory directory"
	if [ "$target_repo" -eq 0 ]; then
		git init -q -b main "$target" || fail "git init failed"
	else
		git -C "$target" symbolic-ref HEAD refs/heads/main || fail "could not select main"
	fi
	current_origin=$(git -C "$target" config --local --get remote.origin.url 2>/dev/null || true)
	if [ -z "$current_origin" ]; then
		git -C "$target" remote add origin "$remote_url" || fail "could not add origin"
	fi
	git -C "$target" config --local core.hooksPath .githooks || fail "could not configure hooks"
	ensure_outer_ignore
	printf 'lead-memory-bootstrap: initialized %s\n' "$target"
	exit 0
fi

run_id=$(date -u '+%Y%m%dT%H%M%SZ')-$$
clone_dir=$target_parent/agent-memory.clone-$run_id
backup_dir=$target_parent/agent-memory.pre-clone-$run_id
[ ! -e "$clone_dir" ] && [ ! -e "$backup_dir" ] || fail "clone workspace already exists"

if ! git clone -q "$remote_url" "$clone_dir"; then
	rm -rf -- "$clone_dir"
	fail "clone failed; original directory was not changed"
fi
clone_top=$(git -C "$clone_dir" rev-parse --show-toplevel 2>/dev/null || true)
clone_physical=$(CDPATH='' cd -- "$clone_dir" 2>/dev/null && pwd -P) || clone_physical=
clone_top_physical=$(CDPATH='' cd -- "$clone_top" 2>/dev/null && pwd -P) || clone_top_physical=
if [ -z "$clone_physical" ] || [ "$clone_top_physical" != "$clone_physical" ]; then
	rm -rf -- "$clone_dir"
	fail "clone did not produce an exact-root repository"
fi
clone_origin=$(git -C "$clone_dir" config --local --get remote.origin.url 2>/dev/null || true)
if [ "$clone_origin" != "$remote_url" ]; then
	rm -rf -- "$clone_dir"
	fail "cloned origin does not match $remote_url"
fi
for hook in pre-commit prepare-commit-msg pre-push lib/guard.sh; do
	if [ ! -f "$clone_dir/.githooks/$hook" ]; then
		rm -rf -- "$clone_dir"
		fail "clone is missing required hook .githooks/$hook"
	fi
done
git -C "$clone_dir" config --local core.hooksPath .githooks || {
	rm -rf -- "$clone_dir"
	fail "could not configure cloned hooks"
}

if [ "$target_exists" -eq 1 ]; then
	require_replacement_confirmation_if_divergent "$target" "$clone_dir" "$backup_dir"
fi

if [ "$target_exists" -eq 1 ]; then
	if ! mv "$target" "$backup_dir"; then
		rm -rf -- "$clone_dir"
		fail "could not preserve original directory before swap"
	fi
	if ! mv "$clone_dir" "$target"; then
		if mv "$backup_dir" "$target"; then
			rm -rf -- "$clone_dir"
			fail "swap failed; original directory restored"
		fi
		fail "swap failed and original directory could not be restored from $backup_dir"
	fi
else
	if ! mv "$clone_dir" "$target"; then
		rm -rf -- "$clone_dir"
		fail "swap failed for absent target"
	fi
fi

ensure_outer_ignore
printf 'lead-memory-bootstrap: cloned %s\n' "$target"
if [ "$target_exists" -eq 1 ]; then
	printf 'lead-memory-bootstrap: previous directory preserved at %s\n' "$backup_dir"
fi
