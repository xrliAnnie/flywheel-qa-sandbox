#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

if [ "$#" -ne 1 ]; then
	printf 'lead-memory-sync: usage: sync-template.sh TARGET\n' >&2
	exit 2
fi

target=$1
[ -d "$target" ] && [ ! -L "$target" ] || {
	printf 'lead-memory-sync: target is not a real directory: %s\n' "$target" >&2
	exit 1
}

preflight_directory() {
	managed_path=$1
	if [ -L "$managed_path" ]; then
		printf 'lead-memory-sync: managed path must not be a symbolic link: %s\n' "$managed_path" >&2
		exit 1
	fi
	if [ -e "$managed_path" ] && [ ! -d "$managed_path" ]; then
		printf 'lead-memory-sync: managed directory has the wrong type: %s\n' "$managed_path" >&2
		exit 1
	fi
}

preflight_file() {
	managed_path=$1
	if [ -L "$managed_path" ]; then
		printf 'lead-memory-sync: managed path must not be a symbolic link: %s\n' "$managed_path" >&2
		exit 1
	fi
	if [ -e "$managed_path" ] && [ ! -f "$managed_path" ]; then
		printf 'lead-memory-sync: managed file has the wrong type: %s\n' "$managed_path" >&2
		exit 1
	fi
}

# Preflight the complete managed surface before the first write. In
# particular, never let mkdir, cp, or chmod follow a repository-controlled
# symlink and modify a path outside the requested target.
for managed_directory in \
	"$target/.githooks" \
	"$target/.githooks/lib" \
	"$target/.github" \
	"$target/.github/workflows"; do
	preflight_directory "$managed_directory"
done
for managed_file in \
	"$target/.githooks/pre-commit" \
	"$target/.githooks/prepare-commit-msg" \
	"$target/.githooks/pre-push" \
	"$target/.githooks/lib/guard.sh" \
	"$target/bootstrap.sh" \
	"$target/write-memory.sh" \
	"$target/README.md" \
	"$target/.gitleaks.toml" \
	"$target/.gitleaksignore" \
	"$target/.gitignore" \
	"$target/.github/workflows/guard.yml" \
	"$target/.github/workflows/remote-observe.yml"; do
	preflight_file "$managed_file"
done

copy_file() {
	source_file=$1
	target_file=$2
	[ -f "$source_file" ] || {
		printf 'lead-memory-sync: source file is missing: %s\n' "$source_file" >&2
		exit 1
	}
	mkdir -p "$(dirname -- "$target_file")"
	cp "$source_file" "$target_file"
}

copy_file "$script_dir/hooks/pre-commit" "$target/.githooks/pre-commit"
copy_file "$script_dir/hooks/prepare-commit-msg" "$target/.githooks/prepare-commit-msg"
copy_file "$script_dir/hooks/pre-push" "$target/.githooks/pre-push"
copy_file "$script_dir/lib/guard.sh" "$target/.githooks/lib/guard.sh"
copy_file "$script_dir/bootstrap.sh" "$target/bootstrap.sh"
copy_file "$script_dir/repo-template/write-memory.sh" "$target/write-memory.sh"
copy_file "$script_dir/repo-template/README.md" "$target/README.md"
copy_file "$script_dir/repo-template/.gitleaks.toml" "$target/.gitleaks.toml"
copy_file "$script_dir/repo-template/.gitleaksignore" "$target/.gitleaksignore"
copy_file "$script_dir/repo-template/.gitignore" "$target/.gitignore"
copy_file "$script_dir/repo-template/.github/workflows/guard.yml" "$target/.github/workflows/guard.yml"
copy_file "$script_dir/repo-template/.github/workflows/remote-observe.yml" "$target/.github/workflows/remote-observe.yml"

chmod 755 \
	"$target/.githooks/pre-commit" \
	"$target/.githooks/prepare-commit-msg" \
	"$target/.githooks/pre-push" \
	"$target/.githooks/lib/guard.sh" \
	"$target/bootstrap.sh" \
	"$target/write-memory.sh"

printf 'lead-memory-sync: repository template synchronized\n'
