#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/qa-launchd-lead.sh
source "$ROOT/scripts/lib/qa-launchd-lead.sh"
export FLYWHEEL_DIR="${FLYWHEEL_DIR:-$ROOT}"

slot="${1:-}"
mode="${2:-}"
evidence_root="${3:-}"
if [[ ! "$slot" =~ ^[1-9][0-9]*$ ]] \
    || [[ "$mode" != crash && "$mode" != kickstart ]] \
    || [[ "$evidence_root" != /* ]]; then
  echo "Usage: $0 <slot> <crash|kickstart> <evidence-dir>" >&2
  exit 1
fi

slot_dir="/tmp/flywheel-test-slot-${slot}"
manifest="${slot_dir}/launch-manifest.json"
python3 - "$evidence_root" "$slot_dir" <<'PY'
import os
from pathlib import Path
import stat
import sys

evidence, slot = map(Path, sys.argv[1:])
try:
    info = evidence.lstat()
except OSError:
    raise SystemExit(1)
if not stat.S_ISDIR(info.st_mode) or evidence.is_symlink():
    raise SystemExit(1)
try:
    if os.path.commonpath((os.path.realpath(slot), os.path.realpath(evidence))) == os.path.realpath(slot):
        raise SystemExit(1)
except ValueError:
    raise SystemExit(1)
PY

stage=$(mktemp -d "${evidence_root}/.fly-2301-drill-stage.XXXXXX")
manifest_snapshot=$(mktemp "${evidence_root}/.fly-2301-manifest.XXXXXX")
default_windows_before=$(mktemp "${evidence_root}/.fly-2301-default-windows.XXXXXX")
slot_windows_before=$(mktemp "${evidence_root}/.fly-2301-slot-windows.XXXXXX")
rm -f "$manifest_snapshot"
cleanup() {
  [[ -z "${stage:-}" || ! -d "$stage" ]] || rm -rf "$stage"
  rm -f "${manifest_snapshot:-}" "${default_windows_before:-}" "${slot_windows_before:-}"
}
trap cleanup EXIT INT TERM

coordinates=$(python3 - "$manifest" "$manifest_snapshot" "$slot" "$slot_dir" <<'PY'
import json
import os
from pathlib import Path
import re
import stat
import sys

manifest, snapshot, slot_text, slot_dir_text = sys.argv[1:]
manifest_path, snapshot_path, slot_dir = Path(manifest), Path(snapshot), Path(slot_dir_text)
try:
    info = manifest_path.lstat()
except OSError:
    raise SystemExit(1)
if not stat.S_ISREG(info.st_mode) or manifest_path.is_symlink() or info.st_size > 65536:
    raise SystemExit(1)
with manifest_path.open("rb") as stream:
    raw = stream.read(65537)
if len(raw) > 65536:
    raise SystemExit(1)
try:
    value = json.loads(raw)
except (UnicodeDecodeError, ValueError):
    raise SystemExit(1)
if value.get("leadCarrier") != "launchd-codex-tui" or not isinstance(value.get("codexLead"), dict):
    raise SystemExit(1)
row = value["codexLead"]
required = ("label", "projectName", "agentId", "stateDir", "codexHome", "tmuxSocket", "tuiWindow")
if any(not isinstance(row.get(key), str) or not row[key] for key in required):
    raise SystemExit(1)
agent = row["agentId"]
if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", agent):
    raise SystemExit(1)
project = f"test-slot-{slot_text}"
label = f"com.flywheel.qa.lead.slot-{slot_text}.{agent}"
home = slot_dir / "cdxh" / agent
tmux_socket = slot_dir / f"tmux-{os.getuid()}" / "default"
identity_hex = (project + "\x1f" + agent).encode().hex()
safe_project = re.sub(r"[^A-Za-z0-9_-]", "_", project)
safe_agent = re.sub(r"[^A-Za-z0-9_-]", "_", agent)
state = slot_dir / "q" / slot_text / "state/codex-lead" / f"{safe_project}__{safe_agent}-{identity_hex}"
expected = {
    "label": label,
    "projectName": project,
    "agentId": agent,
    "stateDir": str(state),
    "codexHome": str(home),
    "tmuxSocket": str(tmux_socket),
    "tuiWindow": "present",
}
if row != expected or value.get("mainLeadLabel") != label:
    raise SystemExit(1)
slot_real = os.path.realpath(slot_dir)
try:
    for path in (home, state, tmux_socket):
        if os.path.commonpath((slot_real, os.path.realpath(path))) != slot_real:
            raise SystemExit(1)
except ValueError:
    raise SystemExit(1)
descriptor = os.open(snapshot_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, "wb") as stream:
    stream.write(raw)
    stream.flush()
    os.fsync(stream.fileno())
print("\t".join((label, project, agent, str(state), str(home), str(tmux_socket))))
PY
)
IFS=$'\t' read -r label project agent state_dir codex_home tmux_socket <<<"$coordinates"

capture_windows() {
  local socket="$1" out="$2"
  if [[ -S "$socket" ]]; then
    "${FLYWHEEL_QA_TMUX:-tmux}" -S "$socket" list-windows -a \
      -F '#{session_name}\t#{window_name}' > "$out" 2>/dev/null || : > "$out"
  else
    : > "$out"
  fi
  chmod 600 "$out"
}

default_tmux_socket="/tmp/tmux-$(id -u)/default"
capture_windows "$default_tmux_socket" "$default_windows_before"
capture_windows "$tmux_socket" "$slot_windows_before"

qa_launchd_lead_restart_drill "$label" codex-tui "$mode" "$codex_home" \
  "$state_dir" "$tmux_socket" "$project" "$agent" "$stage"

mv "$manifest_snapshot" "$stage/launch-manifest.json"
manifest_snapshot=""
mv "$default_windows_before" "$stage/default-tmux-windows.before.tsv"
default_windows_before=""
mv "$slot_windows_before" "$stage/slot-tmux-windows.before.tsv"
slot_windows_before=""
capture_windows "$default_tmux_socket" "$stage/default-tmux-windows.after.tsv"
capture_windows "$tmux_socket" "$stage/slot-tmux-windows.after.tsv"

timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
final="${evidence_root}/fly-2301-drill-${mode}-${timestamp}"
[[ ! -e "$final" && ! -L "$final" ]] || { echo "evidence target already exists" >&2; exit 1; }
mv "$stage" "$final"
stage=""
jq -cn --arg evidenceDir "$final" '{evidenceDir:$evidenceDir}'
