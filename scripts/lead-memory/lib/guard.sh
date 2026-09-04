#!/bin/sh

set -eu

# These two constants are the canonical repository identity consumed by the
# copied bootstrap/README contract even though the rule subcommands need only
# the ownership constants below.
# shellcheck disable=SC2034
REMOTE_URL=https://github.com/xrliAnnie/lead-memory.git
# shellcheck disable=SC2034
MEMORY_PATH=${HOME:?HOME is required}/.claude/agent-memory
OWNER_KEY=Memory-Owner
LEAD_NAME_PATTERN='^[a-z0-9][a-z0-9-]*$'
flywheel_root=${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}
audit_dir=$flywheel_root/state/lead-memory
audit_file=$audit_dir/audit.log
AUDIT_ACTION=guard
AUDIT_ACTOR=${FLYWHEEL_MEMORY_ACTOR:-lead}
AUDIT_OWNER=${FLYWHEEL_LEAD_ID:-unknown}

audit_field() {
	printf '%s' "$1" | tr '\t\r\n' '   '
}

audit_event() {
	outcome=$1
	detail=$2
	action_field=$(audit_field "$AUDIT_ACTION")
	actor_field=$(audit_field "$AUDIT_ACTOR")
	owner_field=$(audit_field "$AUDIT_OWNER")
	detail_field=$(audit_field "$detail")
	outcome_field=$(audit_field "$outcome")
	mkdir -p "$audit_dir" 2>/dev/null &&
		printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
			"$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
			"$action_field" "$actor_field" "$owner_field" "$detail_field" "$outcome_field" \
			>>"$audit_file" 2>/dev/null
}

die() {
	printf 'lead-memory-guard: %s\n' "$1" >&2
	exit 1
}

refuse() {
	audit_event rejected "$1" || true
	die "$1"
}

actor_mode() {
	case ${FLYWHEEL_MEMORY_ACTOR:-lead} in
		lead)
			[ -n "${FLYWHEEL_LEAD_ID:-}" ] || refuse 'refusing commit: FLYWHEEL_LEAD_ID is required'
			printf '%s\n' "$FLYWHEEL_LEAD_ID" | grep -Eq "$LEAD_NAME_PATTERN" ||
				refuse 'refusing commit: invalid FLYWHEEL_LEAD_ID'
			printf 'lead\n'
			;;
		sync | admin)
			printf '%s\n' "$FLYWHEEL_MEMORY_ACTOR"
			;;
		*) refuse "refusing commit: unknown FLYWHEEL_MEMORY_ACTOR ${FLYWHEEL_MEMORY_ACTOR}" ;;
	esac
}

check_staged() {
	AUDIT_ACTION=check-staged
	mode=$(actor_mode)
	AUDIT_ACTOR=$mode
	git diff --cached --quiet --exit-code && refuse 'refusing commit: no staged changes'
	paths=$(git diff --cached --name-only --no-renames)
	[ -n "$paths" ] || refuse 'refusing commit: no staged paths'
	root=
	while IFS= read -r path; do
		[ "$mode" = admin ] && continue
		case $path in
			*/*) path_root=${path%%/*} ;;
			*) refuse "refusing commit: top-level path $path is reserved for admin" ;;
		esac
		printf '%s\n' "$path_root" | grep -Eq "$LEAD_NAME_PATTERN" ||
			refuse "refusing commit: invalid Lead folder $path_root"
		if [ -z "$root" ]; then
			root=$path_root
		elif [ "$root" != "$path_root" ]; then
			refuse 'refusing commit: staged changes span multiple Lead folders'
		fi
		if [ "$mode" = lead ] && [ "$path_root" != "$FLYWHEEL_LEAD_ID" ]; then
			refuse "refusing commit: path outside $FLYWHEEL_LEAD_ID/"
		fi
	done <<EOF
$paths
EOF
	case $mode in
		lead) AUDIT_OWNER=$FLYWHEEL_LEAD_ID ;;
		sync) AUDIT_OWNER=$root ;;
		admin) AUDIT_OWNER='admin' ;;
	esac
	if [ "$mode" = sync ] || [ "$mode" = admin ]; then
		audit_event allowed staged ||
			die 'refusing commit: audit evidence could not be written'
	fi
}

trailer_owner() {
	mode=$1
	case $mode in
		lead) printf '%s\n' "$FLYWHEEL_LEAD_ID" ;;
		admin) printf 'admin\n' ;;
		sync)
			first_path=$(git diff --cached --name-only --no-renames | sed -n '1p')
			printf '%s\n' "${first_path%%/*}"
			;;
	esac
}

add_trailer() {
	message_file=$1
	[ -f "$message_file" ] || refuse "refusing commit: message file not found: $message_file"
	AUDIT_ACTION=trailer
	mode=$(actor_mode)
	AUDIT_ACTOR=$mode
	check_staged
	owner=$(trailer_owner "$mode")
	AUDIT_OWNER=$owner
	git interpret-trailers --in-place \
		--if-exists replace --if-missing add \
		--trailer "$OWNER_KEY: $owner" "$message_file" ||
		refuse 'refusing commit: could not write owner trailer'
}

check_commit() {
	sha=$1
	AUDIT_ACTION=check-range
	AUDIT_OWNER=$sha
	parents=$(git rev-list --parents -n 1 "$sha") ||
		refuse "refusing push: cannot inspect commit $sha"
	# rev-list emits only hexadecimal object IDs separated by spaces.
	# shellcheck disable=SC2086
	set -- $parents
	[ "$#" -le 2 ] || refuse "refusing push: merge commit $sha"

	commit_dir=$(mktemp -d "${TMPDIR:-/tmp}/lead-memory-guard-commit.XXXXXX") ||
		refuse "refusing push: cannot create private workspace for commit $sha"
	paths_file=$commit_dir/paths
	message_file=$commit_dir/message
	trailers_file=$commit_dir/trailers
	git diff-tree --root --no-renames --no-commit-id --name-only -r "$sha" \
		>"$paths_file" || {
		rm -rf "$commit_dir"
		refuse "refusing push: cannot inspect changed paths for $sha"
	}
	if [ ! -s "$paths_file" ]; then
		rm -rf "$commit_dir"
		refuse "refusing push: empty commit $sha"
	fi

	git show -s --format=%B "$sha" >"$message_file" || {
		rm -rf "$commit_dir"
		refuse "refusing push: cannot inspect trailers for $sha"
	}
	git interpret-trailers --parse <"$message_file" >"$trailers_file" || {
		rm -rf "$commit_dir"
		refuse "refusing push: cannot parse trailers for $sha"
	}
	owner_count=$(awk -v key="$OWNER_KEY" '
		BEGIN { key = tolower(key) }
		{
			line = tolower($0)
			if (line ~ ("^" key ":[[:space:]]*")) { count += 1 }
		}
		END { print count + 0 }
	' "$trailers_file")
	if [ "$owner_count" -ne 1 ]; then
		rm -rf "$commit_dir"
		refuse "refusing push: commit $sha must have exactly one $OWNER_KEY trailer"
	fi
	owner=$(awk -v key="$OWNER_KEY" '$0 ~ ("^" key ":[[:space:]]*") { sub("^" key ":[[:space:]]*", ""); print }' "$trailers_file")
	AUDIT_OWNER=$owner
	if [ "$owner" != admin ]; then
		printf '%s\n' "$owner" | grep -Eq "$LEAD_NAME_PATTERN" || {
			rm -rf "$commit_dir"
			refuse "refusing push: invalid owner $owner in commit $sha"
		}
		mismatched_path=
		while IFS= read -r path; do
			case $path in
				"$owner"/*) ;;
				*)
					mismatched_path=$path
					break
					;;
			esac
		done <"$paths_file"
		if [ -n "$mismatched_path" ]; then
			rm -rf "$commit_dir"
			refuse "refusing push: owner $owner does not match path $mismatched_path in commit $sha"
		fi
	fi
	rm -rf "$commit_dir"
}

check_range() {
	range=$1
	AUDIT_ACTION=check-range
	AUDIT_ACTOR=independent
	commits=$(git rev-list --reverse "$range") ||
		refuse "refusing push: invalid commit range $range"
	[ -n "$commits" ] || refuse "refusing push: empty commit range $range"
	for sha in $commits; do
		check_commit "$sha"
	done
}

check_push() {
	AUDIT_ACTION=check-push
	mode=$(actor_mode)
	push_actor=$mode
	AUDIT_ACTOR=$push_actor
	seen=0
	while read -r _local_ref local_sha remote_ref remote_sha; do
		seen=1
		branch=${remote_ref#refs/heads/}
		[ "$remote_ref" = refs/heads/main ] ||
			refuse "refusing push: only refs/heads/main may be pushed"
		if [ "$local_sha" = 0000000000000000000000000000000000000000 ]; then
			refuse "refusing deletion of remote branch $branch"
		fi
		if [ "$remote_sha" = 0000000000000000000000000000000000000000 ]; then
			# A new remote branch has no trusted boundary. Inspect its complete
			# history: local refs/remotes/origin/* are caller-controlled cache
			# entries and must not be allowed to hide commits from validation.
			commits=$(git rev-list --reverse "$local_sha") ||
				refuse "refusing push: cannot enumerate new branch commits"
		else
			git merge-base --is-ancestor "$remote_sha" "$local_sha" >/dev/null 2>&1 ||
				refuse "refusing non-fast-forward update for $branch"
			commits=$(git rev-list --reverse "$remote_sha..$local_sha") ||
				refuse "refusing push: cannot enumerate fast-forward commits"
		fi

		for sha in $commits; do
			AUDIT_ACTOR=$push_actor
			check_commit "$sha"
			commit_owner=$AUDIT_OWNER
			if [ "$push_actor" = lead ] && [ "$commit_owner" != "$FLYWHEEL_LEAD_ID" ]; then
				refuse "refusing push: push actor $FLYWHEEL_LEAD_ID cannot publish owner $commit_owner"
			fi
			if [ "$push_actor" = sync ] && [ "$commit_owner" = admin ]; then
				refuse "refusing push: push actor sync cannot publish owner admin"
			fi
		done
		if [ "$push_actor" = sync ] || [ "$push_actor" = admin ]; then
			AUDIT_ACTION=check-push
			AUDIT_ACTOR=$push_actor
			AUDIT_OWNER=$branch
			audit_event allowed "$local_sha" ||
				die "refusing push: $push_actor audit evidence could not be written"
		fi
	done
	[ "$seen" -eq 1 ] || refuse 'refusing push: no ref updates received'
}

lead_tree() {
	treeish=$1
	AUDIT_ACTION=lead-tree
	tree_dir=$(mktemp -d "${TMPDIR:-/tmp}/lead-memory-tree.XXXXXX") ||
		refuse 'cannot create private lead-tree workspace'
	raw_file=$tree_dir/ls-tree.bin
	mktree_file=$tree_dir/mktree.bin
	mapping_file=$tree_dir/mapping.tsv
	git ls-tree -z "$treeish" >"$raw_file" || {
		rm -rf "$tree_dir"
		refuse "cannot inspect tree $treeish"
	}
	python3 - "$raw_file" "$mktree_file" "$mapping_file" <<'PY' || {
import re
import sys

raw_path, mktree_path, mapping_path = sys.argv[1:]
name_pattern = re.compile(rb"[a-z0-9][a-z0-9-]*")
entries = []
with open(raw_path, "rb") as source:
    records = source.read().split(b"\0")
for record in records:
    if not record:
        continue
    try:
        header, name = record.split(b"\t", 1)
        mode, kind, oid = header.split(b" ", 2)
    except ValueError:
        raise SystemExit("malformed git ls-tree record")
    if mode == b"040000" and kind == b"tree" and name_pattern.fullmatch(name):
        entries.append((name, oid))
entries.sort()
if len(entries) != 12:
    raise SystemExit(f"expected exactly 12 Lead folders, found {len(entries)}")
with open(mktree_path, "wb") as mktree:
    for name, oid in entries:
        mktree.write(b"040000 tree " + oid + b"\t" + name + b"\0")
with open(mapping_path, "wb") as mapping:
    for name, oid in entries:
        mapping.write(b"040000 tree " + oid + b"\t" + name + b"\n")
PY
		status=$?
		rm -rf "$tree_dir"
		refuse "expected exactly 12 Lead folders in $treeish (parser rc $status)"
	}
	synthetic_tree=$(git mktree -z <"$mktree_file") || {
		rm -rf "$tree_dir"
		refuse "cannot reconstruct Lead folder tree for $treeish"
	}
	printf 'tree\t%s\n' "$synthetic_tree"
	cat "$mapping_file"
	rm -rf "$tree_dir"
}

usage() {
	die 'usage: guard.sh check-staged | trailer MSGFILE | check-range RANGE | check-push | lead-tree TREEISH'
}

command=${1:-}
case $command in
	check-staged)
		[ "$#" -eq 1 ] || usage
		check_staged
		;;
	trailer)
		[ "$#" -eq 2 ] || usage
		add_trailer "$2"
		;;
	check-range)
		[ "$#" -eq 2 ] || usage
		check_range "$2"
		;;
	check-push)
		[ "$#" -eq 1 ] || usage
		check_push
		;;
	lead-tree)
		[ "$#" -eq 2 ] || usage
		lead_tree "$2"
		;;
	*) usage ;;
esac
