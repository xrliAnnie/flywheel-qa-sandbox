#!/bin/sh
set -eu

umask 077

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
guard=$script_dir/lib/guard.sh
config=$script_dir/repo-template/.gitleaks.toml

fail() {
	printf 'lead-memory-scan: %s\n' "$1" >&2
	exit 1
}

usage() {
	printf 'lead-memory-scan: unknown argument; usage: scan.sh TARGET\n' >&2
	exit 2
}

[ "$#" -eq 1 ] || usage
case $1 in --*) usage ;; esac
target=$1

for dependency in git gitleaks trufflehog python3 tar; do
	command -v "$dependency" >/dev/null 2>&1 || fail "$dependency is required"
done
[ -x "$guard" ] || fail "guard library is not executable: $guard"
[ -f "$config" ] || fail "gitleaks config is missing: $config"
[ -d "$target" ] && [ ! -L "$target" ] || fail "target must be a real directory: $target"
target_physical=$(CDPATH='' cd -- "$target" && pwd -P) || fail "cannot resolve target"
repo_root=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$repo_root" ] || fail "target is not a git repository"
repo_physical=$(CDPATH='' cd -- "$repo_root" && pwd -P) || fail "cannot resolve repository root"
[ "$repo_physical" = "$target_physical" ] || fail "repository root must equal the scan target"

gitleaks_version=$(gitleaks version 2>/dev/null || true)
[ "$gitleaks_version" = 8.30.1 ] ||
	fail "gitleaks 8.30.1 is required (found ${gitleaks_version:-missing})"
trufflehog_version=$(trufflehog --version 2>/dev/null || true)
[ "$trufflehog_version" = 'trufflehog 3.97.2' ] ||
	fail "trufflehog 3.97.2 is required (found ${trufflehog_version:-missing})"
ignore_path=$target_physical/.gitleaksignore
[ -f "$ignore_path" ] || fail "runtime gitleaks ignore file is missing: $ignore_path"

flywheel_root=${FLYWHEEL_STATE_DIR:-${HOME:?HOME is required}/.flywheel}
day=$(date -u '+%Y-%m-%d')
run_id=$(date -u '+%Y%m%dT%H%M%SZ')-$$
run_dir=$flywheel_root/state/lead-memory/scan/$day/$run_id
snapshot=$run_dir/snapshot
controls=$run_dir/positive-controls
[ ! -e "$run_dir" ] || fail "scan run already exists: $run_dir"
mkdir -p "$run_dir" || fail "cannot create private scan run directory"
cleanup_private_inputs() {
	rm -rf -- "$snapshot" "$controls"
}
trap cleanup_private_inputs EXIT HUP INT TERM

# Eight deterministic, format-valid samples. Stable fixtures keep the detector
# self-test reproducible across retries. They never enter source control; their
# reports are removed immediately after the exact file→detector mapping is
# verified.
mkdir -p "$controls"
python3 - "$controls" <<'PY'
import hashlib
import string
import sys
from pathlib import Path

root = Path(sys.argv[1])
alphabet = string.ascii_letters + string.digits
aws_id_alphabet = string.ascii_uppercase + "234567"

def token(label: str, chars: str, length: int) -> str:
    value = []
    counter = 0
    while len(value) < length:
        block = hashlib.sha512(
            f"FLY-2145-positive-control-v1:{label}:{counter}".encode()
        ).digest()
        value.extend(chars[byte % len(chars)] for byte in block)
        counter += 1
    return "".join(value[:length])

(root / "github.txt").write_text(
    f'github_token = "ghp_{token("github", alphabet, 36)}"\n'
)
(root / "aws.txt").write_text(
    f'AWS_ACCESS_KEY_ID="AKIA{token("aws-id", aws_id_alphabet, 16)}"\n'
    f'AWS_SECRET_ACCESS_KEY="{token("aws-secret", alphabet + "/+", 40)}"\n'
)
(root / "anthropic.txt").write_text(
    f'anthropic_api_key = "sk-ant-api03-{token("anthropic", alphabet + "_-", 93)}AA"\n'
)
(root / "slack.txt").write_text(
    f'slack_bot_token = "xoxb-{token("slack-team", string.digits, 12)}-'
    f'{token("slack-app", string.digits, 12)}-'
    f'{token("slack-secret", alphabet, 24)}"\n'
)
(root / "private-key.pem").write_text(
    "-----BEGIN PRIVATE KEY-----\n"
    + token("private-key", alphabet + "+/", 128)
    + "\n-----END PRIVATE KEY-----\n"
)
(root / "generic-api.txt").write_text(
    f'internal_api_key = "{token("generic-api", alphabet, 40)}"\n'
)
(root / "generic-secret.txt").write_text(
    f'internal_secret = "{token("generic-secret", alphabet, 40)}"\n'
)
(root / "generic-token.txt").write_text(
    f'internal_token = "{token("generic-token", alphabet, 40)}"\n'
)
PY

control_gitleaks_tmp=$run_dir/control-gitleaks.json.tmp
control_gitleaks=$run_dir/control-gitleaks.json
if ! gitleaks dir "$controls" \
	--config "$config" \
	--report-format json \
	--report-path "$control_gitleaks_tmp" \
	--exit-code 0 --no-banner; then
	fail "gitleaks positive-control scan failed"
fi
mv "$control_gitleaks_tmp" "$control_gitleaks"
control_trufflehog_tmp=$run_dir/control-trufflehog.jsonl.tmp
control_trufflehog=$run_dir/control-trufflehog.jsonl
if ! trufflehog filesystem "$controls" --json --no-update --fail-on-scan-errors --no-verification \
	>"$control_trufflehog_tmp"; then
	fail "trufflehog positive-control scan failed"
fi
mv "$control_trufflehog_tmp" "$control_trufflehog"

if ! python3 - "$control_gitleaks" "$control_trufflehog" <<'PY'; then
import json
import os
import sys

gitleaks_path, trufflehog_path = sys.argv[1:]
expected_gitleaks = {
    "github.txt": "github-pat",
    "aws.txt": "aws-access-token",
    "anthropic.txt": "anthropic-api-key",
    "slack.txt": "slack-bot-token",
    "private-key.pem": "private-key",
    "generic-api.txt": "generic-api-key",
    "generic-secret.txt": "generic-api-key",
    "generic-token.txt": "generic-api-key",
}
with open(gitleaks_path, encoding="utf-8") as handle:
    gitleaks = json.load(handle)
actual_gitleaks = {
    (os.path.basename(str(item.get("File", ""))), str(item.get("RuleID", "")))
    for item in gitleaks
}
missing_gitleaks = sorted(
    (name, rule)
    for name, rule in expected_gitleaks.items()
    if (name, rule) not in actual_gitleaks
)

expected_trufflehog = {
    "aws.txt": "AWS",
    "anthropic.txt": "Anthropic",
    "github.txt": "Github",
    "slack.txt": "Slack",
}
actual_trufflehog = set()
with open(trufflehog_path, encoding="utf-8") as handle:
    for line in handle:
        if not line.strip():
            continue
        item = json.loads(line)
        path = (
            item.get("SourceMetadata", {})
            .get("Data", {})
            .get("Filesystem", {})
            .get("file", "")
        )
        actual_trufflehog.add((os.path.basename(str(path)), str(item.get("DetectorName", ""))))
missing_trufflehog = sorted(
    (name, detector)
    for name, detector in expected_trufflehog.items()
    if (name, detector) not in actual_trufflehog
)
if missing_gitleaks or missing_trufflehog:
    print(
        "positive-control mapping failed: "
        f"gitleaks_missing={missing_gitleaks}, trufflehog_missing={missing_trufflehog}; "
        f"gitleaks_actual={sorted(actual_gitleaks)}, "
        f"trufflehog_actual={sorted(actual_trufflehog)}",
        file=sys.stderr,
    )
    raise SystemExit(1)
PY
	fail "positive-control mapping failed"
fi
rm -rf -- "$controls" "$control_gitleaks" "$control_trufflehog"

lead_names=$run_dir/lead-names
python3 - "$target_physical" "$lead_names" <<'PY'
import os
import re
import sys

root, destination = sys.argv[1:]
pattern = re.compile(r"[a-z0-9][a-z0-9-]*")
names = sorted(
    entry.name
    for entry in os.scandir(root)
    if entry.is_dir(follow_symlinks=False) and pattern.fullmatch(entry.name)
)
if len(names) != 12:
    raise SystemExit(f"expected exactly 12 Lead folders, found {len(names)}")
with open(destination, "w", encoding="utf-8") as handle:
    handle.write("\n".join(names) + "\n")
PY

set --
while IFS= read -r lead_name; do
	set -- "$@" "$lead_name"
done <"$lead_names"
git -C "$target_physical" add -- "$@" || fail "could not stage the twelve Lead folders"
candidate_tree=$(git -C "$target_physical" write-tree) || fail "could not write candidate tree"
lead_tree_output=$run_dir/lead-tree.tsv
(
	cd "$target_physical"
	"$guard" lead-tree "$candidate_tree"
) >"$lead_tree_output" || fail "could not reconstruct the Lead tree"
scanned_tree=$(awk -F '\t' 'NR == 1 && $1 == "tree" { print $2 }' "$lead_tree_output")
[ -n "$scanned_tree" ] || fail "lead-tree returned no synthetic tree OID"

mkdir -p "$snapshot"
git -C "$target_physical" archive "$scanned_tree" | tar -x -C "$snapshot" ||
	fail "could not materialize immutable scan snapshot"
scanned_files=$run_dir/scanned-files.bin
git -C "$target_physical" ls-tree -rz --full-tree "$scanned_tree" >"$scanned_files" ||
	fail "could not enumerate immutable scan tree"
python3 - "$scanned_files" <<'PY'
import sys

with open(sys.argv[1], "rb") as source:
    records = source.read().split(b"\0")
for record in records:
    if not record:
        continue
    header, _ = record.split(b"\t", 1)
    mode, kind, _ = header.split(b" ", 2)
    if kind != b"blob" or mode not in {b"100644", b"100755"}:
        raise SystemExit(
            f"scan tree contains unsupported entry mode={mode.decode()} kind={kind.decode()}"
        )
PY
scan_bytes=$(python3 - "$snapshot" <<'PY'
import os
import sys
total = 0
for root, _, files in os.walk(sys.argv[1]):
    for name in files:
        total += os.path.getsize(os.path.join(root, name))
print(total)
PY
)

gitleaks_tmp=$run_dir/gitleaks.json.tmp
gitleaks_report=$run_dir/gitleaks.json
if ! gitleaks dir "$snapshot" \
	--config "$config" \
	--gitleaks-ignore-path "$ignore_path" \
	--report-format json \
	--report-path "$gitleaks_tmp" \
	--exit-code 0 --no-banner; then
	fail "gitleaks full scan failed"
fi
mv "$gitleaks_tmp" "$gitleaks_report"

trufflehog_tmp=$run_dir/trufflehog.jsonl.tmp
trufflehog_report=$run_dir/trufflehog.jsonl
if ! trufflehog filesystem "$snapshot" --json --no-update --fail-on-scan-errors --no-verification \
	>"$trufflehog_tmp"; then
	fail "trufflehog full scan failed"
fi
mv "$trufflehog_tmp" "$trufflehog_report"
sample_file=$run_dir/manual-samples.tsv
python3 - "$snapshot" "$scanned_files" "$sample_file" <<'PY'
import os
import re
import sys

root, scanned_files_path, destination = sys.argv[1:]
lead_pattern = re.compile(r"[a-z0-9][a-z0-9-]*")
blob_oids = {}
with open(scanned_files_path, "rb") as source:
    for record in source.read().split(b"\0"):
        if not record:
            continue
        header, raw_path = record.split(b"\t", 1)
        _, kind, raw_oid = header.split(b" ", 2)
        if kind == b"blob":
            blob_oids[os.fsdecode(raw_path)] = raw_oid.decode("ascii")
selected = []
for lead in sorted(os.listdir(root)):
    lead_root = os.path.join(root, lead)
    if not lead_pattern.fullmatch(lead) or not os.path.isdir(lead_root):
        continue
    paths = []
    for current_root, _, files in os.walk(lead_root):
        for name in files:
            relative = os.path.relpath(os.path.join(current_root, name), root)
            paths.append(relative)
    markdown = sorted(path for path in paths if path.lower().endswith(".md"))
    candidates = markdown if len(markdown) >= 3 else sorted(paths)
    if len(candidates) < 3:
        raise SystemExit(f"Lead folder {lead} has fewer than three reviewable files")
    indexes = (0, len(candidates) // 2, len(candidates) - 1)
    lead_samples = []
    for index in indexes:
        candidate = candidates[index]
        if candidate not in lead_samples:
            lead_samples.append(candidate)
    if len(lead_samples) != 3:
        raise SystemExit(f"Lead folder {lead} did not yield three distinct samples")
    selected.extend((sample, blob_oids[sample]) for sample in lead_samples)
if len(selected) != 36:
    raise SystemExit(f"expected 36 manual-review samples, found {len(selected)}")
with open(destination, "w", encoding="utf-8") as output:
    for path, blob_oid in selected:
        output.write(f"{path}\t{blob_oid}\n")
PY
rm -rf -- "$snapshot"

ledger=$target_physical/SCAN-LEDGER.md
ledger_tmp=$target_physical/.SCAN-LEDGER.md.tmp.$$
status_file=$run_dir/status
python3 - \
	"$ledger" "$ledger_tmp" "$gitleaks_report" "$trufflehog_report" \
	"$lead_tree_output" "$sample_file" "$snapshot" "$scanned_tree" "$scan_bytes" "$run_id" "$status_file" <<'PY'
import hashlib
import json
import os
import sys
from datetime import date

(
    ledger_path,
    destination,
    gitleaks_path,
    trufflehog_path,
    mapping_path,
    sample_path,
    snapshot_path,
    scanned_tree,
    scan_bytes,
    run_id,
    status_path,
) = sys.argv[1:]

prior = {}
prior_samples = {}
if os.path.isfile(ledger_path):
    with open(ledger_path, encoding="utf-8") as handle:
        for line in handle:
            if not line.startswith("| `"):
                continue
            columns = [column.strip() for column in line.strip().split("|")[1:-1]]
            key = columns[0].strip("`")
            if len(columns) == 4 and key.startswith(("gitleaks:", "trufflehog:")):
                prior[key] = tuple(columns[1:])
            elif len(columns) == 5 and "/" in key:
                blob_oid = columns[1].strip("`")
                prior_samples[(key, blob_oid)] = tuple(columns[2:])

def relative_path(path: str) -> str:
    normalized = os.path.normpath(path)
    snapshot_normalized = os.path.normpath(snapshot_path)
    if normalized.startswith(snapshot_normalized + os.sep):
        return os.path.relpath(normalized, snapshot_normalized)
    return path.lstrip("./")

def fingerprint(tool: str, rule: str, path: str, value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8", errors="surrogatepass")).hexdigest()[:12]
    return f"{tool}:{rule}:{relative_path(path)}:{digest}"

with open(gitleaks_path, encoding="utf-8") as handle:
    gitleaks_items = json.load(handle)
current_gitleaks = []
for item in gitleaks_items:
    current_gitleaks.append(
        fingerprint(
            "gitleaks",
            str(item.get("RuleID", "unknown")),
            str(item.get("File", "unknown")),
            str(item.get("Secret", "")),
        )
    )

current_trufflehog = []
with open(trufflehog_path, encoding="utf-8") as handle:
    for line in handle:
        if not line.strip():
            continue
        item = json.loads(line)
        path = (
            item.get("SourceMetadata", {})
            .get("Data", {})
            .get("Filesystem", {})
            .get("file", "unknown")
        )
        current_trufflehog.append(
            fingerprint(
                "trufflehog",
                str(item.get("DetectorName", "unknown")),
                str(path),
                str(item.get("Raw", "")),
            )
        )

all_fingerprints = sorted(set(prior) | set(current_gitleaks) | set(current_trufflehog))
rows = {}
for item in all_fingerprints:
    disposition, reviewer, reviewed_date = prior.get(item, ("PENDING", "", ""))
    if not disposition or not reviewer or not reviewed_date:
        disposition, reviewer, reviewed_date = "PENDING", "", ""
    rows[item] = (disposition, reviewer, reviewed_date)

open_historical = [item for item, row in rows.items() if row[0] == "PENDING"]
open_trufflehog = []
for item in current_trufflehog:
    disposition, reviewer, reviewed_date = rows[item]
    if not (
        reviewer
        and reviewed_date
        and disposition.startswith(("false-positive:", "non-secret:"))
    ):
        open_trufflehog.append(item)
terminal = not current_gitleaks and not open_trufflehog and not open_historical

with open(mapping_path, encoding="utf-8") as handle:
    mapping_lines = [line.rstrip("\n") for line in handle.readlines()[1:]]
with open(sample_path, encoding="utf-8") as handle:
    sample_rows = [tuple(line.rstrip("\n").split("\t", 1)) for line in handle if line.strip()]

with open(destination, "w", encoding="utf-8", newline="\n") as output:
    output.write("# Lead memory first-import secret scan ledger\n\n")
    output.write(f"Run-ID: `{run_id}`\n")
    output.write(f"Scanned-Tree: `{scanned_tree}`\n")
    output.write("Gitleaks: `8.30.1`\n")
    output.write("TruffleHog: `3.97.2` (`--no-verification`)\n")
    output.write(f"Scanned-Bytes: `{scan_bytes}`\n")
    output.write("Positive-Controls: `8/8 gitleaks mappings; 4/4 trufflehog mappings`\n\n")
    output.write("## Twelve Lead folder mappings\n\n")
    output.write("| Git tree entry |\n| --- |\n")
    for mapping in mapping_lines:
        output.write(f"| `{mapping}` |\n")
    output.write("\n## Finding dispositions\n\n")
    output.write("| Fingerprint | Disposition | Reviewer | Date |\n")
    output.write("| --- | --- | --- | --- |\n")
    for item in all_fingerprints:
        disposition, reviewer, reviewed_date = rows[item]
        output.write(f"| `{item}` | {disposition} | {reviewer} | {reviewed_date} |\n")
    output.write("\n## Manual sample review (three files per Lead)\n\n")
    output.write("| Path | Blob OID | Disposition | Reviewer | Date |\n")
    output.write("| --- | --- | --- | --- | --- |\n")
    for sample, blob_oid in sample_rows:
        disposition, reviewer, reviewed_date = prior_samples.get(
            (sample, blob_oid), ("REVIEW_REQUIRED", "", "")
        )
        if not disposition or not reviewer or not reviewed_date:
            disposition, reviewer, reviewed_date = "REVIEW_REQUIRED", "", ""
        output.write(
            f"| `{sample}` | `{blob_oid}` | {disposition} | {reviewer} | {reviewed_date} |\n"
        )
    output.write("\n## Terminal scan\n\n")
    output.write(f"- gitleaks raw findings: {len(current_gitleaks)}\n")
    output.write(f"- trufflehog findings: {len(current_trufflehog)}\n")
    output.write(f"- status: {'PASS' if terminal else 'PENDING'}\n")

with open(status_path, "w", encoding="utf-8") as status:
    status.write("pass\n" if terminal else "pending\n")
PY

mv "$ledger_tmp" "$ledger" || fail "could not atomically publish scan ledger"
if [ "$(cat "$status_file")" != pass ]; then
	printf 'lead-memory-scan: open findings require disposition; review %s\n' "$ledger" >&2
	exit 3
fi

printf 'lead-memory-scan: PASS tree=%s bytes=%s ledger=%s\n' \
	"$scanned_tree" "$scan_bytes" "$ledger"
