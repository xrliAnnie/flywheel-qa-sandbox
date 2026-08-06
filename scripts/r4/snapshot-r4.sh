#!/usr/bin/env bash
set -euo pipefail

R4_SNAPSHOT_COMM_ROOT="${R4_SNAPSHOT_COMM_ROOT:-${HOME}/.flywheel/comm}"
R4_SNAPSHOT_OUTPUT="${R4_SNAPSHOT_OUTPUT:-}"
R4_SNAPSHOT_SHARDS=(
    flywheel
    geoforge3d
    growth
    joycon-typeless
    personal-assistant
    sub
    tidal-echo
)

r4_snapshot_mode() {
    stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1" 2>/dev/null
}

r4_snapshot_size() {
    stat -f %z "$1" 2>/dev/null || stat -c %s "$1" 2>/dev/null
}

r4_snapshot_sha256() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        sha256sum "$1" | awk '{print $1}'
    fi
}

r4_snapshot_fsync_dir() {
    python3 - "$1" <<'PY'
import os
import sys

fd = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

r4_snapshot_fsync_tree() {
    python3 - "$1" <<'PY'
import os
import sys

root = sys.argv[1]
for current, dirs, files in os.walk(root, topdown=False):
    for name in files:
        fd = os.open(os.path.join(current, name), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    fd = os.open(current, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
PY
}

r4_snapshot_validate_config() {
    [[ "$R4_SNAPSHOT_COMM_ROOT" == /* && "$R4_SNAPSHOT_COMM_ROOT" != / ]] || {
        echo "snapshot-r4: invalid CommDB root" >&2
        return 1
    }
    [[ "$R4_SNAPSHOT_OUTPUT" == /* && "$R4_SNAPSHOT_OUTPUT" != / ]] || {
        echo "snapshot-r4: R4_SNAPSHOT_OUTPUT must be an absolute non-root path" >&2
        return 1
    }
    [[ ! -e "$R4_SNAPSHOT_OUTPUT" ]] || {
        echo "snapshot-r4: refusing to overwrite existing snapshot: $R4_SNAPSHOT_OUTPUT" >&2
        return 1
    }
}

r4_snapshot_assert_no_holders() {
    local shard db output rc
    for shard in "${R4_SNAPSHOT_SHARDS[@]}"; do
        db="$R4_SNAPSHOT_COMM_ROOT/$shard/comm.db"
        [[ -f "$db" ]] || {
            echo "snapshot-r4: missing canonical DB: $db" >&2
            return 1
        }
        output="$(lsof -t -- "$db" 2>&1)" || rc=$?
        rc=${rc:-0}
        if (( rc == 0 )) && [[ -n "$output" ]]; then
            echo "snapshot-r4: holder present for $db: $output" >&2
            return 1
        fi
        if (( rc != 0 && rc != 1 )); then
            echo "snapshot-r4: holder scan failed for $db: $output" >&2
            return 1
        fi
        rc=0
    done
}

r4_snapshot_copy_tree() {
    local stage="$1" shard source target suffix path ref
    for shard in "${R4_SNAPSHOT_SHARDS[@]}"; do
        source="$R4_SNAPSHOT_COMM_ROOT/$shard"
        target="$stage/$shard"
        mkdir -p "$target"
        for suffix in "" -wal -shm; do
            path="$source/comm.db$suffix"
            [[ -f "$path" ]] && cp -p "$path" "$target/comm.db$suffix"
        done
        if [[ -d "$source/refs" ]]; then
            while IFS= read -r ref; do
                [[ -f "$ref" && ! -L "$ref" ]] || {
                    echo "snapshot-r4: refs must contain only regular files: $ref" >&2
                    return 1
                }
                mkdir -p "$target/refs/$(dirname "${ref#"$source/refs/"}")"
                cp -p "$ref" "$target/refs/${ref#"$source/refs/"}"
            done < <(find "$source/refs" -type f -o -type l | LC_ALL=C sort)
        fi
    done
}

r4_snapshot_write_manifest() {
    local stage="$1" file rel
    local files_root="$stage/files" manifest="$stage/manifest.tsv"
    : > "$manifest"
    while IFS= read -r file; do
        rel="${file#"$files_root/"}"
        printf '%s\t%s\t%s\t%s\n' \
            "$rel" \
            "$(r4_snapshot_size "$file")" \
            "$(r4_snapshot_mode "$file")" \
            "$(r4_snapshot_sha256 "$file")" >> "$manifest"
    done < <(
        find "$files_root" -type f | LC_ALL=C sort
    )
}

r4_snapshot_verify() {
    local stage="$1" shard result count
    count="$(awk 'NF == 4 {n++} END {print n+0}' "$stage/manifest.tsv")"
    (( count >= ${#R4_SNAPSHOT_SHARDS[@]} )) || {
        echo "snapshot-r4: manifest does not cover all shards" >&2
        return 1
    }
    for shard in "${R4_SNAPSHOT_SHARDS[@]}"; do
        result="$(sqlite3 "$stage/files/$shard/comm.db" 'PRAGMA quick_check;' 2>&1 | head -1)"
        [[ "$result" == ok ]] || {
            echo "snapshot-r4: quick_check failed for $shard: $result" >&2
            return 1
        }
        grep -Eq "^${shard}/comm\.db[[:space:]]" "$stage/manifest.tsv" || {
            echo "snapshot-r4: manifest missing $shard/comm.db" >&2
            return 1
        }
    done
}

r4_snapshot_main() {
    r4_snapshot_validate_config
    r4_snapshot_assert_no_holders
    local parent stage
    parent="$(dirname "$R4_SNAPSHOT_OUTPUT")"
    mkdir -p "$parent"
    stage="$(mktemp -d "$parent/.snapshot-r4.XXXXXX")"
    R4_SNAPSHOT_STAGE="$stage"
    trap '[[ -n "${R4_SNAPSHOT_STAGE:-}" ]] && rm -rf "$R4_SNAPSHOT_STAGE"' EXIT
    mkdir -p "$stage/files"
    r4_snapshot_copy_tree "$stage/files"
    r4_snapshot_write_manifest "$stage"
    r4_snapshot_verify "$stage"
    r4_snapshot_fsync_tree "$stage"
    mv "$stage" "$R4_SNAPSHOT_OUTPUT"
    R4_SNAPSHOT_STAGE=""
    trap - EXIT
    r4_snapshot_fsync_dir "$parent"
    printf 'snapshot-r4: verified %s\n' "$R4_SNAPSHOT_OUTPUT"
}

if [[ "${R4_SNAPSHOT_SOURCE_ONLY:-0}" != "1" ]]; then
    r4_snapshot_main "$@"
fi
