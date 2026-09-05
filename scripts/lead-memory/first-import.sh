#!/bin/sh
set -eu

umask 077

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
bootstrap=$script_dir/bootstrap.sh
sync_template=$script_dir/sync-template.sh
scan=$script_dir/scan.sh
guard=$script_dir/lib/guard.sh
remote_url=https://github.com/xrliAnnie/lead-memory.git
remote_repo=xrliAnnie/lead-memory
target=${HOME:?HOME is required}/.claude/agent-memory
state_root=${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}
operator_dir=$state_root/state/lead-memory/first-import
prepare_receipt=$operator_dir/prepare.txt
publish_receipt=$operator_dir/publish.txt
lead_names='cos-lead flywheel-cos-lead flywheel-eng-lead flywheel-product-lead joycon-lead ops-lead product-lead rafiki-lead reflection-lead sub-lead tidal-echo-content-lead tidal-echo-cos-lead'

fail() {
	printf 'lead-memory-first-import: %s\n' "$1" >&2
	exit 1
}

usage() {
	printf '%s\n' \
		'lead-memory-first-import: usage: first-import.sh --prepare|--publish' \
		'  --prepare  preflight, initialize exact root, install template, and scan; never commit or push' \
		'  --publish  rescan, require all value-free findings and 36 blob-bound samples reviewed, then commit and push' \
		'' \
		'Rollback before the first successful push:' \
		'  1. Preserve the twelve Lead folders and every memory file.' \
		'  2. Remove only ~/.claude/agent-memory/.git.' \
		'  3. Remove the exact agent-memory/ line from ~/.claude/.gitignore only when prepare.txt says OUTER_IGNORE_PREEXISTING=false.' \
		'  4. The private remote is still empty and may be deleted separately by its GitHub owner.' >&2
	exit 2
}

[ "$#" -eq 1 ] || usage
case $1 in
	--prepare) mode=prepare ;;
	--publish) mode=publish ;;
	*) usage ;;
esac

for source_file in "$bootstrap" "$sync_template" "$scan" "$guard"; do
	[ -x "$source_file" ] || fail "required executable is missing: $source_file"
done
for dependency in git gh python3; do
	command -v "$dependency" >/dev/null 2>&1 || fail "$dependency is required"
done
remote_private=$(gh repo view "$remote_repo" --json isPrivate --jq .isPrivate 2>/dev/null || true)
[ "$remote_private" = true ] || fail "private repository $remote_repo is unavailable"

mkdir -p "$operator_dir" || fail "cannot create private operator state: $operator_dir"
work_dir=$(mktemp -d "$operator_dir/run.XXXXXX") || fail 'cannot create operator workspace'
cleanup() {
	rm -rf -- "$work_dir"
}
trap cleanup EXIT HUP INT TERM

lead_metrics() {
	python3 - "$target" "$lead_names" <<'PY'
import hashlib
import os
import stat
import sys

root = os.path.abspath(sys.argv[1])
expected = set(sys.argv[2].split())
if not os.path.isdir(root) or os.path.islink(root):
    raise SystemExit(f"target must be a real directory: {root}")
actual = {
    entry.name
    for entry in os.scandir(root)
    if entry.is_dir(follow_symlinks=False) and not entry.name.startswith(".")
}
if actual != expected:
    raise SystemExit(
        f"expected exact Lead folders; missing={sorted(expected - actual)} "
        f"unexpected={sorted(actual - expected)}"
    )
digest = hashlib.sha256()
file_count = 0
byte_count = 0
for lead in sorted(expected):
    lead_root = os.path.join(root, lead)
    for current_root, directories, files in os.walk(lead_root, followlinks=False):
        directories.sort()
        files.sort()
        for name in directories + files:
            path = os.path.join(current_root, name)
            if stat.S_ISLNK(os.lstat(path).st_mode):
                raise SystemExit(f"symbolic links are not allowed: {path}")
        for name in files:
            path = os.path.join(current_root, name)
            relative = os.path.relpath(path, root).encode("utf-8", errors="surrogateescape")
            content_hash = hashlib.sha256()
            size = 0
            with open(path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    content_hash.update(chunk)
                    size += len(chunk)
            digest.update(len(relative).to_bytes(8, "big"))
            digest.update(relative)
            digest.update(content_hash.digest())
            file_count += 1
            byte_count += size
print(f"files={file_count} bytes={byte_count} sha256={digest.hexdigest()}")
PY
}

remote_main() {
	if ! git ls-remote --heads "$remote_url" refs/heads/main >"$work_dir/remote-main"; then
		fail "cannot inspect remote main at $remote_url"
	fi
	awk 'NR == 1 { print $1 }' "$work_dir/remote-main"
}

verify_exact_repo() {
	[ -d "$target/.git" ] && [ ! -L "$target/.git" ] ||
		fail "target-owned .git directory is missing: $target"
	target_physical=$(CDPATH='' cd -- "$target" && pwd -P) || fail 'cannot resolve target'
	top=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null || true)
	top_physical=$(CDPATH='' cd -- "$top" 2>/dev/null && pwd -P) || top_physical=
	[ "$top_physical" = "$target_physical" ] || fail 'repository root is not the exact memory path'
	[ "$(git -C "$target" symbolic-ref --quiet --short HEAD 2>/dev/null || true)" = main ] ||
		fail 'repository branch must be main'
	[ "$(git -C "$target" config --local --get remote.origin.url 2>/dev/null || true)" = "$remote_url" ] ||
		fail "origin is not $remote_url"
	[ -z "$(git -C "$target" config --get-all remote.origin.pushurl 2>/dev/null || true)" ] ||
		fail 'origin push URL must not be configured separately'
	[ "$(git -C "$target" config --local --get core.hooksPath 2>/dev/null || true)" = .githooks ] ||
		fail 'core.hooksPath is not .githooks'
}

validate_ledger() {
	ledger_path=$1
	python3 - "$ledger_path" "$lead_names" <<'PY'
import collections
import re
import sys

path = sys.argv[1]
expected_leads = set(sys.argv[2].split())
with open(path, encoding="utf-8") as handle:
    lines = [line.rstrip("\n") for line in handle]
if "- status: PASS" not in lines:
    raise SystemExit("terminal scan status is not PASS")
if any("| PENDING |" in line for line in lines):
    raise SystemExit("finding disposition is still PENDING")
manual_header = "| Path | Blob OID | Disposition | Reviewer | Date |"
try:
    start = lines.index(manual_header) + 2
except ValueError:
    raise SystemExit("manual sample table is missing")
rows = []
for line in lines[start:]:
    if not line.startswith("|"):
        break
    columns = [column.strip() for column in line.split("|")[1:-1]]
    if len(columns) != 5:
        raise SystemExit("malformed manual sample row")
    sample, blob_oid, disposition, reviewer, reviewed_date = columns
    sample = sample.strip("`")
    blob_oid = blob_oid.strip("`")
    if not re.fullmatch(r"[0-9a-f]{40,64}", blob_oid):
        raise SystemExit(f"invalid sample blob OID: {sample}")
    if not disposition.startswith("reviewed:") or not reviewer:
        raise SystemExit(f"manual sample review is incomplete: {sample}")
    if not re.fullmatch(r"20[0-9]{2}-[0-9]{2}-[0-9]{2}", reviewed_date):
        raise SystemExit(f"manual sample review date is invalid: {sample}")
    lead = sample.split("/", 1)[0]
    rows.append((sample, blob_oid, lead))
if len(rows) != 36 or len({(path, oid) for path, oid, _ in rows}) != 36:
    raise SystemExit("manual sample review is incomplete: expected 36 unique rows")
counts = collections.Counter(lead for _, _, lead in rows)
if set(counts) != expected_leads or any(counts[lead] != 3 for lead in expected_leads):
    raise SystemExit("manual sample review is incomplete: expected three rows per Lead")
PY
}

apply_private_review_receipt() {
	ledger_path=$1
	review_receipt=$state_root/state/lead-memory/preflight/manual-review.tsv
	[ -f "$review_receipt" ] || return 0
	destination=$work_dir/ledger-with-private-review
	python3 - "$ledger_path" "$review_receipt" "$destination" <<'PY'
import re
import sys

ledger_path, receipt_path, destination = sys.argv[1:]
reviews = {}
with open(receipt_path, encoding="utf-8") as receipt:
    for line_number, raw_line in enumerate(receipt, 1):
        if not raw_line.strip() or raw_line.startswith("#"):
            continue
        columns = raw_line.rstrip("\n").split("\t")
        if len(columns) != 5:
            raise SystemExit(f"malformed private review receipt line {line_number}")
        path, blob_oid, disposition, reviewer, reviewed_date = columns
        if any(character in path for character in "`|\n\r"):
            raise SystemExit(f"unsafe reviewed path on line {line_number}")
        if not re.fullmatch(r"[0-9a-f]{40,64}", blob_oid):
            raise SystemExit(f"invalid reviewed blob OID on line {line_number}")
        if not disposition.startswith("reviewed:") or not reviewer:
            raise SystemExit(f"incomplete private review on line {line_number}")
        if "|" in disposition or "|" in reviewer:
            raise SystemExit(f"unsafe review text on line {line_number}")
        if not re.fullmatch(r"20[0-9]{2}-[0-9]{2}-[0-9]{2}", reviewed_date):
            raise SystemExit(f"invalid review date on line {line_number}")
        key = (path, blob_oid)
        if key in reviews:
            raise SystemExit(f"duplicate private review on line {line_number}")
        reviews[key] = (disposition, reviewer, reviewed_date)
if len(reviews) != 36:
    raise SystemExit(f"expected 36 private sample reviews, found {len(reviews)}")

with open(ledger_path, encoding="utf-8") as ledger:
    lines = ledger.readlines()
inside = False
matched = set()
output_lines = []
for raw_line in lines:
    line = raw_line.rstrip("\n")
    if line == "| Path | Blob OID | Disposition | Reviewer | Date |":
        inside = True
        output_lines.append(raw_line)
        continue
    if inside and line.startswith("| `"):
        columns = [column.strip() for column in line.split("|")[1:-1]]
        if len(columns) == 5:
            path = columns[0].strip("`")
            blob_oid = columns[1].strip("`")
            key = (path, blob_oid)
            if key not in reviews:
                raise SystemExit(f"private review does not match current blob: {path}")
            disposition, reviewer, reviewed_date = reviews[key]
            output_lines.append(
                f"| `{path}` | `{blob_oid}` | {disposition} | {reviewer} | {reviewed_date} |\n"
            )
            matched.add(key)
            continue
    elif inside and matched:
        inside = False
    output_lines.append(raw_line)
if matched != set(reviews):
    raise SystemExit("private review receipt contains rows absent from current scan ledger")
with open(destination, "w", encoding="utf-8", newline="\n") as output:
    output.writelines(output_lines)
PY
	mv "$destination" "$ledger_path" || fail 'could not atomically apply private review receipt'
	printf 'lead-memory-first-import: applied 36 blob-matched private sample reviews\n'
}

extract_ledger_tree() {
	ledger_path=$1
	destination=$2
	python3 - "$ledger_path" "$destination" "$lead_names" <<'PY'
import re
import sys

ledger_path, destination = sys.argv[1:3]
expected = set(sys.argv[3].split())
tree = None
mappings = []
with open(ledger_path, encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.rstrip("\n")
        match = re.fullmatch(r"Scanned-Tree: `([0-9a-f]{40,64})`", line)
        if match:
            tree = match.group(1)
        match = re.fullmatch(
            r"\| `040000 tree ([0-9a-f]{40,64})\t([a-z0-9][a-z0-9-]*)` \|",
            line,
        )
        if match:
            mappings.append((match.group(2), match.group(1)))
if tree is None or len(mappings) != 12 or {name for name, _ in mappings} != expected:
    raise SystemExit("ledger tree identity is incomplete")
with open(destination, "w", encoding="utf-8", newline="\n") as output:
    output.write(f"tree\t{tree}\n")
    for name, oid in sorted(mappings):
        output.write(f"040000 tree {oid}\t{name}\n")
PY
}

verify_staged_scope() {
	git -C "$target" ls-files -s -z >"$work_dir/index.bin" || fail 'cannot inspect staged files'
	python3 - "$work_dir/index.bin" "$lead_names" <<'PY'
import sys

index_path = sys.argv[1]
leads = set(sys.argv[2].split())
required_top = {
    ".githooks/lib/guard.sh",
    ".githooks/pre-commit",
    ".githooks/pre-push",
    ".githooks/prepare-commit-msg",
    ".github/workflows/guard.yml",
    ".github/workflows/remote-observe.yml",
    ".gitleaks.toml",
    ".gitleaksignore",
    ".gitignore",
    "README.md",
    "SCAN-LEDGER.md",
    "bootstrap.sh",
    "write-memory.sh",
}
seen_top = set()
seen_leads = set()
with open(index_path, "rb") as handle:
    records = handle.read().split(b"\0")
for record in records:
    if not record:
        continue
    header, raw_path = record.split(b"\t", 1)
    mode, _, stage = header.split(b" ", 2)
    path = raw_path.decode("utf-8", errors="surrogateescape")
    if stage != b"0" or mode not in {b"100644", b"100755"}:
        raise SystemExit(f"unsupported staged entry: {path}")
    root = path.split("/", 1)[0]
    if root in leads and "/" in path:
        seen_leads.add(root)
    elif path in required_top:
        seen_top.add(path)
    else:
        raise SystemExit(f"unexpected staged path: {path}")
if seen_top != required_top:
    raise SystemExit(f"missing repository files: {sorted(required_top - seen_top)}")
if seen_leads != leads:
    raise SystemExit(f"missing Lead folders: {sorted(leads - seen_leads)}")
PY
}

verify_committed_scope() {
	treeish=$1
	git -C "$target" ls-tree -rz --full-tree "$treeish" >"$work_dir/committed-tree.bin" ||
		fail "cannot inspect committed tree $treeish"
	python3 - "$work_dir/committed-tree.bin" "$lead_names" <<'PY'
import sys

tree_path = sys.argv[1]
leads = set(sys.argv[2].split())
required_top = {
    ".githooks/lib/guard.sh",
    ".githooks/pre-commit",
    ".githooks/pre-push",
    ".githooks/prepare-commit-msg",
    ".github/workflows/guard.yml",
    ".github/workflows/remote-observe.yml",
    ".gitleaks.toml",
    ".gitleaksignore",
    ".gitignore",
    "README.md",
    "SCAN-LEDGER.md",
    "bootstrap.sh",
    "write-memory.sh",
}
seen_top = set()
seen_leads = set()
with open(tree_path, "rb") as handle:
    records = handle.read().split(b"\0")
for record in records:
    if not record:
        continue
    header, raw_path = record.split(b"\t", 1)
    mode, kind, _ = header.split(b" ", 2)
    path = raw_path.decode("utf-8", errors="surrogateescape")
    if kind != b"blob" or mode not in {b"100644", b"100755"}:
        raise SystemExit(f"unsupported committed entry: {path}")
    root = path.split("/", 1)[0]
    if root in leads and "/" in path:
        seen_leads.add(root)
    elif path in required_top:
        seen_top.add(path)
    else:
        raise SystemExit(f"unexpected committed path: {path}")
if seen_top != required_top or seen_leads != leads:
    raise SystemExit("committed first-import scope is incomplete")
PY
}

validate_import_commit() {
	import_commit=$1
	[ "$(git -C "$target" rev-list --parents -n 1 "$import_commit" | wc -w | tr -d ' ')" -eq 1 ] ||
		fail 'local first-import commit is not a root commit'
	[ "$(git -C "$target" show -s --format=%s "$import_commit")" = 'chore: first import of 12 Lead memory folders (FLY-2145)' ] ||
		fail 'local commit is not the expected first-import commit'
	[ "$(git -C "$target" show -s --format='%(trailers:key=Memory-Owner,valueonly)' "$import_commit")" = admin ] ||
		fail 'local first-import commit is missing the admin ownership trailer'
	verify_committed_scope "$import_commit"
	git -C "$target" show "$import_commit:SCAN-LEDGER.md" >"$work_dir/committed-ledger"
	validate_ledger "$work_dir/committed-ledger" ||
		fail 'manual sample review is incomplete or committed scan ledger invalid'
	extract_ledger_tree "$work_dir/committed-ledger" "$work_dir/expected-tree"
	(
		cd "$target"
		"$guard" lead-tree "$import_commit^{tree}"
	) >"$work_dir/actual-tree"
	cmp -s "$work_dir/expected-tree" "$work_dir/actual-tree" ||
		fail 'first-import commit does not match its terminal scanned tree'
}

verify_default_and_privacy() {
	gh repo edit "$remote_repo" --default-branch main >/dev/null 2>&1 ||
		fail 'could not set GitHub default branch to main after the first push'
	default_branch=$(gh repo view "$remote_repo" --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || true)
	[ "$default_branch" = main ] || fail 'GitHub default branch is not main'
	remote_private=$(gh repo view "$remote_repo" --json isPrivate --jq .isPrivate 2>/dev/null || true)
	[ "$remote_private" = true ] || fail 'GitHub repository is no longer private'
}

write_publish_receipt() {
	import_sha=$1
	scanned_tree=$2
	metrics_before=$3
	metrics_after=$4
	status_path=$work_dir/post-commit-status
	git -C "$target" status --porcelain=v1 >"$status_path"
	{
		printf 'PUBLISHED_AT=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
		printf 'REPOSITORY=%s\n' "$remote_repo"
		printf 'PRIVATE=true\n'
		printf 'DEFAULT_BRANCH=main\n'
		printf 'IMPORT_SHA=%s\n' "$import_sha"
		printf 'REMOTE_MAIN=%s\n' "$(remote_main)"
		printf 'SCANNED_TREE=%s\n' "$scanned_tree"
		printf 'LEAD_METRICS_BEFORE=%s\n' "$metrics_before"
		printf 'LEAD_METRICS_AFTER=%s\n' "$metrics_after"
		printf 'POST_COMMIT_STATUS_BEGIN\n'
		cat "$status_path"
		printf 'POST_COMMIT_STATUS_END\n'
	} >"$publish_receipt"
	cat "$publish_receipt"
}

if [ "$mode" = prepare ]; then
	[ -z "$(remote_main)" ] || fail 'remote main already exists; refusing a new first import'
	metrics_before=$(lead_metrics) || fail 'Lead-folder preflight failed'
	if [ ! -f "$prepare_receipt" ]; then
		if [ -f "$HOME/.claude/.gitignore" ] && grep -Fxq 'agent-memory/' "$HOME/.claude/.gitignore"; then
			ignore_preexisting=true
		else
			ignore_preexisting=false
		fi
		{
			printf 'PREPARED_AT=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
			printf 'OUTER_IGNORE_PREEXISTING=%s\n' "$ignore_preexisting"
			printf 'LEAD_METRICS_BEFORE=%s\n' "$metrics_before"
		} >"$prepare_receipt"
	fi
	"$bootstrap" --init
	"$sync_template" "$target"
	verify_exact_repo
	if "$scan" "$target"; then
		scan_status=0
	else
		scan_status=$?
		metrics_after=$(lead_metrics) || metrics_after=unavailable
		printf 'LEAD_METRICS_BEFORE=%s\nLEAD_METRICS_AFTER=%s\n' "$metrics_before" "$metrics_after"
		printf 'PREPARE_RECEIPT=%s\n' "$prepare_receipt"
		printf 'ROLLBACK=remove only %s/.git; consult OUTER_IGNORE_PREEXISTING in prepare receipt\n' "$target"
		[ "$scan_status" -eq 3 ] || exit "$scan_status"
		printf 'MANUAL_REVIEW=required; resolve every value-free finding, then rerun --prepare\n' >&2
		exit 3
	fi
	metrics_after=$(lead_metrics) || fail 'Lead-folder post-scan verification failed'
	printf 'LEAD_METRICS_BEFORE=%s\nLEAD_METRICS_AFTER=%s\n' "$metrics_before" "$metrics_after"
	printf 'PREPARE_RECEIPT=%s\n' "$prepare_receipt"
	printf 'SCAN_LEDGER=%s/SCAN-LEDGER.md\n' "$target"
	printf 'REMOTE_MAIN=absent\n'
	printf 'MANUAL_REVIEW=required; fill reviewer/date and a reviewed: disposition for all 36 blob-bound samples\n'
	printf 'ROLLBACK=remove only %s/.git; consult OUTER_IGNORE_PREEXISTING in prepare receipt\n' "$target"
	exit 0
fi

[ -f "$prepare_receipt" ] || fail 'run --prepare before --publish'
verify_exact_repo
metrics_before=$(lead_metrics) || fail 'Lead-folder pre-publish verification failed'
current_remote=$(remote_main)
local_head=$(git -C "$target" rev-parse --verify HEAD 2>/dev/null || true)
if [ -n "$current_remote" ]; then
	[ -n "$local_head" ] && [ "$current_remote" = "$local_head" ] ||
		fail 'remote main already exists at a different commit'
	validate_import_commit "$local_head"
	verify_default_and_privacy
	scanned_tree=$(awk -F '\t' 'NR == 1 { print $2 }' "$work_dir/expected-tree")
	write_publish_receipt "$local_head" "$scanned_tree" "$metrics_before" "$metrics_before"
	exit 0
fi

if [ -n "$local_head" ]; then
	validate_import_commit "$local_head"
	env FLYWHEEL_MEMORY_ACTOR=admin git -C "$target" push -u origin main
	verify_default_and_privacy
	metrics_after=$(lead_metrics) || fail 'Lead-folder post-push verification failed'
	write_publish_receipt "$local_head" "$(awk -F '\t' 'NR == 1 { print $2 }' "$work_dir/expected-tree")" "$metrics_before" "$metrics_after"
	exit 0
fi

"$sync_template" "$target"
if "$scan" "$target"; then
	:
else
	scan_status=$?
	[ "$scan_status" -eq 3 ] &&
		fail 'secret findings remain open; review the value-free ledger and rerun --publish'
	exit "$scan_status"
fi
ledger=$target/SCAN-LEDGER.md
apply_private_review_receipt "$ledger" ||
	fail 'private manual-review receipt does not match the current scan'
validate_ledger "$ledger" || fail 'manual sample review is incomplete or scan ledger invalid'

# Scan stages the twelve Lead folders. Add only the explicit repository-owned
# files; an unknown top-level file can never hitchhike in the admin import.
# shellcheck disable=SC2086
git -C "$target" add -- $lead_names \
	.githooks/lib/guard.sh \
	.githooks/pre-commit \
	.githooks/pre-push \
	.githooks/prepare-commit-msg \
	.github/workflows/guard.yml \
	.github/workflows/remote-observe.yml \
	.gitleaks.toml .gitleaksignore .gitignore \
	README.md SCAN-LEDGER.md bootstrap.sh write-memory.sh
verify_staged_scope || fail 'staged first-import scope is invalid'
candidate_tree=$(git -C "$target" write-tree) || fail 'cannot write candidate import tree'
extract_ledger_tree "$ledger" "$work_dir/expected-tree"
(
	cd "$target"
	"$guard" lead-tree "$candidate_tree"
) >"$work_dir/actual-tree"
cmp -s "$work_dir/expected-tree" "$work_dir/actual-tree" ||
	fail 'staged Lead folders do not match the terminal scanned tree; rerun --publish'

[ -z "$(remote_main)" ] || fail 'remote main appeared during preparation; refusing to commit'
env FLYWHEEL_MEMORY_ACTOR=admin git -C "$target" commit \
	-m 'chore: first import of 12 Lead memory folders (FLY-2145)'
import_sha=$(git -C "$target" rev-parse HEAD)
env FLYWHEEL_MEMORY_ACTOR=admin git -C "$target" push -u origin main
[ "$(remote_main)" = "$import_sha" ] || fail 'remote main does not equal the first-import commit'
verify_default_and_privacy
metrics_after=$(lead_metrics) || fail 'Lead-folder post-push verification failed'
scanned_tree=$(awk -F '\t' 'NR == 1 { print $2 }' "$work_dir/expected-tree")
write_publish_receipt "$import_sha" "$scanned_tree" "$metrics_before" "$metrics_after"
