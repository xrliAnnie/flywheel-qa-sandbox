#!/usr/bin/env bash
# FLY-1877: skip heavy CI only when the PR's entire merge-base diff touches
# inert documentation. Anything else, including uncertainty, runs the full suite.
set -uo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

fail_closed() {
  printf 'ci-classify: fail-closed: %s\n' "$1" >&2
  printf 'no_code=false\n' >>"$GITHUB_OUTPUT"
  exit 0
}

[[ "${HEAD_SHA:-}" =~ ^[0-9a-fA-F]{40}$ ]] || fail_closed "invalid_input"
[[ "${BASE_SHA:-}" =~ ^[0-9a-fA-F]{40}$ ]] || fail_closed "invalid_input"

head_sha="$(printf '%s' "$HEAD_SHA" | tr '[:upper:]' '[:lower:]')"
base_sha="$(printf '%s' "$BASE_SHA" | tr '[:upper:]' '[:lower:]')"

git cat-file -e "$head_sha^{commit}" 2>/dev/null || fail_closed "head_commit_missing"
git cat-file -e "$base_sha^{commit}" 2>/dev/null || fail_closed "base_commit_missing"

merge_bases="$(git merge-base --all "$base_sha" "$head_sha" 2>/dev/null)" ||
  fail_closed "merge_base_unresolvable"
merge_base_count="$(printf '%s\n' "$merge_bases" | grep -cE '^[0-9a-f]{40}$')"
[[ "$merge_base_count" -ge 1 ]] || fail_closed "merge_base_unresolvable"
[[ "$merge_base_count" -eq 1 ]] || fail_closed "merge_base_ambiguous"
merge_base="$(printf '%s\n' "$merge_bases" | grep -E '^[0-9a-f]{40}$' | head -1)"

python3 - "$merge_base" "$head_sha" <<'PY' || fail_closed "diff_not_inert"
import subprocess
import sys

base, head = sys.argv[1:]
try:
    raw = subprocess.run(
        ["git", "diff", "--raw", "-z", "--no-renames", f"{base}..{head}"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ).stdout
except (OSError, subprocess.CalledProcessError):
    raise SystemExit(2)

tokens = raw.split(b"\0")
if tokens and tokens[-1] == b"":
    tokens.pop()
if len(tokens) % 2 != 0:
    raise SystemExit(2)

allowed_prefixes = (b"doc/", b"product/doc/", b"engineering/doc/", b"content/doc/")
allowed_suffixes = (
    b".md",
    b".markdown",
    b".mmd",
    b".html",
    b".htm",
    b".svg",
    b".png",
    b".jpg",
    b".jpeg",
    b".gif",
    b".webp",
    b".avif",
    b".pdf",
    b".txt",
    b".csv",
    b".log",
    b".out",
    b".jsonl",
    b".wav",
    b".mp3",
    b".m4a",
    b".ogg",
    b".mp4",
    b".webm",
    b".vtt",
    b".srt",
)
# FLY-2001: exact doc paths consumed by no_code-gated CI tests. Keep this
# bounded list in sync with the always-on structure guard; do not widen it to
# directory prefixes, which would send verified-inert files back to full CI.
known_ci_consumed_doc_paths = (
    b"doc/engineer/implementation/FLY-222-a0-a10-runbook.md",
    b"doc/qa/framework/529-room-playbook.md",
    b"engineering/doc/FLY-1775-529-generalized-dag-room/plan.md",
    b"engineering/doc/FLY-1062-npm-distribution/packaged-path-audit.md",
    b"engineering/doc/FLY-1648-hot-loop-closeout/runbook.md",
    b"engineering/doc/FLY-2166-pre-cutover-audit-fix/g2-runbook.md",
    b"doc/engineer/implementation/flag-authoring-runbook.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/exploration.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/research.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/plan.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/progress.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/fixtures/README.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round1.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round2.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round3.md",
    b"engineering/doc/FLY-1135-layer1-dag-templates/exploration.md",
    b"engineering/doc/FLY-1135-layer1-dag-templates/research.md",
    b"engineering/doc/FLY-1135-layer1-dag-templates/plan.md",
)
for index in range(0, len(tokens), 2):
    header = tokens[index]
    path = tokens[index + 1]
    if (
        not header.startswith(b":")
        or path in known_ci_consumed_doc_paths
        or not path.startswith(allowed_prefixes)
        or not path.endswith(allowed_suffixes)
    ):
        raise SystemExit(1)
    fields = header[1:].split()
    if len(fields) < 5:
        raise SystemExit(2)
    old_mode, new_mode = fields[0], fields[1]
    if old_mode in {b"120000", b"160000"} or new_mode in {b"120000", b"160000"}:
        raise SystemExit(1)
PY

printf 'no_code=true\n' >>"$GITHUB_OUTPUT"
