#!/usr/bin/env bash
# FLY-2405: trusted Bridge-side operation wrapper. The service creates the
# operation directory and connects stdout/stderr to its per-operation files.
set -euo pipefail

kind="${1:-}"
operation_dir="${2:-}"
operation_id="${operation_dir##*/}"

# No worktree, build, phase, or receipt effects are allowed before this owner
# publication. link() publishes a complete file atomically without replacing
# another owner if this operation was accidentally launched twice.
if ! python3 - "$operation_dir" "$operation_id" "$$" <<'PY'
import json, os, pathlib, subprocess, sys, tempfile
op, operation_id, pid = sys.argv[1:]
tmp = None
try:
    directory = pathlib.Path(op)
    if not directory.is_dir() or directory.is_symlink() or not operation_id:
        raise ValueError('operation directory is unavailable')
    started = subprocess.check_output(['ps', '-o', 'lstart=', '-p', pid], text=True).strip()
    if not started:
        raise ValueError('process start time unavailable')
    fd, tmp = tempfile.mkstemp(prefix='.owner.', dir=directory)
    with os.fdopen(fd, 'w') as out:
        json.dump({'operation_id': operation_id, 'pid': int(pid), 'lstart': started}, out)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())
    os.link(tmp, directory / 'owner.json')
except Exception:
    sys.exit(97)
finally:
    if tmp is not None:
        os.unlink(tmp)
PY
then
  exit 97
fi

umask 077
phase=prepare
evidence_copy=empty
failure_reason=
finish() {
  local code=$?
  trap - EXIT
  python3 - "$operation_dir" "$operation_id" "$phase" "$code" "$evidence_copy" "$failure_reason" <<'PY'
import datetime, json, os, pathlib, sys, tempfile
op, operation_id, phase, code, evidence_copy, failure_reason = sys.argv[1:]
fd, tmp = tempfile.mkstemp(prefix='.receipt.', dir=op)
try:
    with os.fdopen(fd, 'w') as out:
        json.dump({'operation_id': operation_id, 'phase_reached': phase,
                   'exit_code': int(code), **({'evidence_copy': evidence_copy, 'failure_reason': failure_reason or None} if phase == 'drill' else {}), 'finished_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}, out)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, pathlib.Path(op) / 'receipt.json')
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
PY
  exit "$code"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
log() { printf '[qa-room-job] %s\n' "$*" >&2; }
set_phase() { phase="$1"; printf '%s\n' "$phase" > "$operation_dir/phase"; }

snapshot() {
  python3 - "$operation_dir" "$operation_id" "$evidence_root" <<'PY'
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import sqlite3
import shutil
import sys
import tempfile

op, operation_id, evidence_root = map(Path, sys.argv[1:])
operation_id = operation_id.name
room_id = os.environ.get('FLYWHEEL_QA_ROOM_ID', '')
secret_key = re.compile(r'token|password|credential|secret|claim', re.I)
assignment = re.compile(r'(?i)((?:[A-Z0-9_]*(?:TOKEN|PASSWORD|CREDENTIAL|SECRET|CLAIM)[A-Z0-9_]*)\s*[=:]\s*)([^\s,;\"\']+)')
secrets = {value for key, value in os.environ.items() if secret_key.search(key) and value}
forbidden = set()
manifest = {'format': 'qa-room-evidence-v1', 'room_id': room_id,
            'operation_id': operation_id, 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'expected': [], 'exported': [], 'missing': []}
staging = None


def collect(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if secret_key.search(key) and isinstance(child, str) and child:
                if re.search(r'(file|path)$', key, re.I):
                    forbidden.add(Path(child).resolve())
                elif not re.search(r'env$', key, re.I):
                    secrets.add(child)
            collect(child)
    elif isinstance(value, list):
        for child in value:
            collect(child)
    elif isinstance(value, str):
        for match in assignment.finditer(value):
            secrets.add(match.group(2))


def redact_text(text):
    for secret in sorted(secrets, key=len, reverse=True):
        text = text.replace(secret, '[redacted]')
    text = assignment.sub(lambda m: m.group(1) + '[redacted]', text)
    return re.sub(r'(?i)(bearer\s+)[A-Za-z0-9._~+/-]+', r'\1[redacted]', text)


def sanitize(value):
    if isinstance(value, dict):
        return {key: ('[redacted]' if secret_key.search(key) else sanitize(child)) for key, child in value.items()}
    if isinstance(value, list):
        return [sanitize(child) for child in value]
    return redact_text(value) if isinstance(value, str) else value


def atomic_json(path, value):
    fd, tmp = tempfile.mkstemp(prefix='.manifest.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, indent=2)
            out.write('\n')
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def eligible(path, slot):
    relative = path.relative_to(slot)
    return (not path.is_symlink() and path.resolve() not in forbidden
            and not any(p == 'node_modules' or p.startswith('project-slot-') or secret_key.search(p)
                        for p in relative.parts))


def entry(source, relative, kind, required=False, tables=()):
    return {'source': str(source), 'path': str(relative), 'kind': kind,
            'required': required, 'tables': list(tables)}

try:
    if not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9._-]*', room_id) or not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9._-]*', operation_id):
        raise ValueError('invalid evidence identity')
    room_root = evidence_root.resolve() / room_id
    if room_root.is_symlink():
        raise ValueError('symlink evidence room')
    room_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    staging = room_root / (operation_id + '.partial')
    published = room_root / operation_id
    if published.exists() or published.is_symlink() or staging.exists() or staging.is_symlink():
        raise ValueError('operation evidence already exists')
    staging.mkdir(mode=0o700)
    room = json.loads((op / 'room.json').read_text())
    collect(room)
    slot_input = Path(room['slotDir'])
    project = room['projectName']
    if not slot_input.is_absolute() or not isinstance(project, str) or not re.fullmatch(r'[A-Za-z0-9._-]+', project) or project in ('.', '..'):
        raise ValueError('invalid room coordinates')
    if slot_input.is_symlink() or not slot_input.is_dir():
        raise ValueError('missing_or_unsafe_slot_directory')
    slot = slot_input.resolve()
    candidates = []
    if slot.is_dir():
        for directory, dirs, names in os.walk(slot, followlinks=False):
            dirs[:] = sorted(d for d in dirs if eligible(Path(directory) / d, slot))
            for name in sorted(names):
                source = Path(directory) / name
                if eligible(source, slot) and source.is_file():
                    candidates.append(source)
    metadata = {}
    for source in candidates:
        relative = source.relative_to(slot)
        # Deliberate allowlist: no env files, homes, token files, arbitrary room
        # trees, or runner checkouts are copied into the evidence archive.
        is_log = source.name in ('bridge.log', 'lead.log') and (len(relative.parts) == 1 or relative.parts[0] in ('extra-leads', 'launchd'))
        is_json = (len(relative.parts) == 1 and source.name in ('launch-manifest.json', 'bridge-launch.json', 'campaign-manifest.json', 'launchd-leads.json')) or (relative.parts[0] == 'launchd' and source.name == 'manifest.json')
        is_plist = relative.parts[0] == 'launchd' and source.suffix == '.plist'
        if is_json or is_plist:
            data = plistlib.loads(source.read_bytes()) if is_plist else json.loads(source.read_text())
            collect(data)
            metadata[source] = ('plist' if is_plist else 'json', data)
        elif is_log:
            metadata[source] = ('log', None)
        elif relative.parts[0] == 'e2e-evidence':
            metadata[source] = ('driver-evidence', None)
    databases = {
        slot / 'teamlead.db': ('sessions',),
        slot / 'state/comm' / project / 'comm.db': ('sessions', 'mailbox'),
    }
    campaign = slot / 'campaign-manifest.json'
    if campaign in metadata:
        # Current campaigns share the main Bridge databases. A stateDir can
        # also contain independent libraries; validate those as required.
        for lead in metadata[campaign][1].get('extraLeads', []):
            state = Path(lead['stateDir']).resolve()
            if not state.is_relative_to(slot):
                raise ValueError('campaign state outside room')
            for source in candidates:
                if source.is_relative_to(state):
                    if source == state / 'teamlead.db':
                        databases[source] = ('sessions',)
                    elif source.name == 'comm.db' and 'comm' in source.relative_to(state).parts:
                        databases[source] = ('sessions', 'mailbox')
    for source in candidates:
        if source.suffix == '.db':
            databases.setdefault(source, ())
    for source, tables in sorted(databases.items()):
        manifest['expected'].append(entry(source, source.relative_to(slot), 'sqlite', bool(tables), tables))
    for source, (kind, _) in sorted(metadata.items()):
        manifest['expected'].append(entry(source, source.relative_to(slot), kind))
    manifest['expected'].append(entry(op / 'room.json', 'room.json', 'room'))
    for item in manifest['expected']:
        source, dest = Path(item['source']), staging / item['path']
        try:
            if not source.is_file() or source.is_symlink():
                raise ValueError('missing_or_unsafe_source')
            if item['kind'] != 'room' and (source.resolve() != source or not source.is_relative_to(slot) or not eligible(source, slot)):
                raise ValueError('source_outside_room_or_secret')
            dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if item['kind'] == 'sqlite':
                # SQLite reads committed WAL contents; copying the main file
                # would silently discard those rows. Read-only avoids creating
                # a new empty source when a required database is absent.
                with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=30) as db:
                    db.execute('VACUUM INTO ?', (str(dest),))
                with sqlite3.connect(dest.as_uri() + '?mode=ro', uri=True) as db:
                    if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                        raise ValueError('quick_check_failed')
                    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                    if not tables or not set(item['tables']).issubset(tables):
                        raise ValueError('required_tables_missing')
            elif item['kind'] in ('json', 'plist', 'room'):
                data = room if item['kind'] == 'room' else metadata[source][1]
                if item['kind'] == 'plist':
                    dest.write_bytes(plistlib.dumps(sanitize(data)))
                else:
                    dest.write_text(json.dumps(sanitize(data), indent=2) + '\n')
            elif item['kind'] == 'driver-evidence':
                shutil.copyfile(source, dest)
            else:
                dest.write_text(redact_text(source.read_text(errors='replace')))
            manifest['exported'].append(dict(item, size=dest.stat().st_size,
                sha256=hashlib.sha256(dest.read_bytes()).hexdigest()))
        except Exception as error:
            manifest['missing'].append(dict(item, reason=type(error).__name__ + ': ' + str(error)))
    atomic_json(staging / 'manifest.json', manifest)
    if manifest['missing']:
        raise ValueError('one or more evidence exports failed')
    os.rename(staging, published)
    fd, tmp = tempfile.mkstemp(prefix='.evidence-dir.', dir=op)
    with os.fdopen(fd, 'w') as out:
        out.write(str(published) + '\n')
    os.replace(tmp, op / 'evidence-dir')
except Exception as error:
    # A failed attempt keeps its own partial evidence; it never reuses or
    # removes any older attempt's successfully published snapshot.
    if staging is not None and staging.is_dir() and not (staging / 'manifest.json').exists():
        manifest['missing'].append({'source': str(op / 'room.json'), 'reason': type(error).__name__ + ': ' + str(error)})
        atomic_json(staging / 'manifest.json', manifest)
    print('[qa-room-job] snapshot_failed: ' + str(error), file=sys.stderr)
    sys.exit(96)
PY
}

prune_evidence() {
  python3 - "$evidence_root" <<'PY'
import json, pathlib, shutil, sys, time
root = pathlib.Path(sys.argv[1])
cutoff = time.time() - 14 * 86400
if root.is_dir() and not root.is_symlink():
    for room in root.iterdir():
        if room.is_symlink() or not room.is_dir():
            continue
        for attempt in room.iterdir():
            if attempt.is_symlink() or not attempt.is_dir() or attempt.name.endswith('.partial') or attempt.stat().st_mtime >= cutoff:
                continue
            try:
                file = attempt / 'manifest.json'
                if file.is_symlink():
                    continue
                manifest = json.loads(file.read_text())
                if (manifest.get('format') == 'qa-room-evidence-v1' and manifest.get('room_id') == room.name
                        and manifest.get('operation_id') == attempt.name):
                    shutil.rmtree(attempt)
            except (OSError, ValueError):
                continue
PY
}

case "$kind" in
  deploy)
    set_phase prepare
    [[ $# -ge 6 && "$6" == -- ]] || { log 'invalid deploy arguments'; exit 2; }
    sha="$3"; src_dir="$4"; bridge_repo_root="$5"
    shift 6
    [[ "$sha" =~ ^[a-f0-9]{40}$ && -n "${FLYWHEEL_QA_ROOM_CLAIM:-}" && -n "${FLYWHEEL_QA_ROOM_ID:-}" ]] || { log 'invalid deploy identity'; exit 2; }
    git -C "$bridge_repo_root" fetch origin --prune
    refs=$(git -C "$bridge_repo_root" branch -r --contains "$sha")
    if ! printf '%s\n' "$refs" | grep -Eq '^[[:space:]]*origin/'; then
      log 'head_not_on_origin'; exit 95
    fi
    git -C "$bridge_repo_root" worktree add --detach "$src_dir" "$sha"
    if [[ ! -f "$src_dir/scripts/lib/qa-slot-claim.sh" ]] \
      || ! grep -q 'qa-slot-claim.sh' "$src_dir/scripts/test-deploy.sh" \
      || ! grep -q 'qa-slot-claim.sh' "$src_dir/scripts/test-teardown.sh"; then
      log 'head_lacks_claim_protocol'; exit 95
    fi
    (cd "$src_dir" && pnpm install --frozen-lockfile --prefer-offline && pnpm -r build)
    set_phase deploy
    bash "$src_dir/scripts/test-deploy.sh" "$@"
    ;;
  drill)
    set_phase drill
    [[ $# -ge 6 && "$5" == -- ]] || { log 'invalid drill arguments'; exit 2; }
    src_dir="$3"; slot_dir="$4"
    shift 5
    probe="$HOME/.flywheel-qa-room-probe.$operation_id"
    if ! mkdir "$probe"; then failure_reason=sandboxed_executor; log 'sandboxed_executor'; exit 96; fi
    rmdir "$probe"
    # The driver runs from the exact source checkout, using only server-built
    # arguments. Preserve its exit status even if evidence publication fails.
    python3 - "$slot_dir" "$operation_dir" <<'PYDRILL'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1]) / 'e2e-evidence'
before = [p.name for p in root.iterdir()] if root.is_dir() else []
(pathlib.Path(sys.argv[2]) / 'evidence-before.json').write_text(json.dumps(before))
PYDRILL
    driver_exit=0
    (cd "$src_dir" && node "$src_dir/scripts/qa-529-generalized-e2e.mjs" "$@") || driver_exit=$?
    evidence_copy=$(python3 - "$slot_dir" "$operation_dir" <<'PYDRILL'
import hashlib, json, os, pathlib, shutil, sys
root = pathlib.Path(sys.argv[1]) / 'e2e-evidence'
op = pathlib.Path(sys.argv[2])
try:
    before = set(json.loads((op / 'evidence-before.json').read_text()))
    new = sorted((p for p in root.iterdir() if p.name not in before), key=lambda p: p.name) if root.is_dir() else []
    if not new:
        print('empty')
    else:
        dest = op / 'evidence'
        dest.mkdir(mode=0o700)
        files = []
        for run in new:
            if run.is_symlink() or not run.is_dir():
                raise ValueError('unsafe driver evidence directory')
            for directory, dirs, names in os.walk(run, followlinks=False):
                for name in sorted(dirs + names):
                    source = pathlib.Path(directory) / name
                    if source.is_symlink():
                        raise ValueError('unsafe driver evidence link')
                    if source.is_dir():
                        continue
                    if not source.is_file():
                        raise ValueError('unsafe driver evidence file')
                    relative = source.relative_to(root)
                    target = dest / relative
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    shutil.copyfile(source, target)
                    files.append({'path': str(relative), 'size': target.stat().st_size,
                                  'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
        (dest / 'manifest.json').write_text(json.dumps({'files': files}, indent=2) + '\n')
        print('ok' if files else 'empty')
except Exception:
    print('failed')
PYDRILL
    ) || evidence_copy=failed
    exit "$driver_exit"
    ;;
  teardown)
    set_phase snapshot
    [[ $# -eq 5 || ( $# -eq 6 && "$6" == --skip-snapshot ) ]] || { log 'invalid teardown arguments'; exit 2; }
    src_dir="$3"; slot="$4"; evidence_root="$5"
    [[ "$slot" =~ ^[1-9][0-9]*$ && -n "${FLYWHEEL_QA_ROOM_CLAIM:-}" && -n "${FLYWHEEL_QA_ROOM_ID:-}" ]] || { log 'invalid teardown identity'; exit 2; }
    if [[ "${6:-}" != --skip-snapshot ]]; then snapshot; fi
    set_phase teardown
    bash "$src_dir/scripts/test-teardown.sh" "$slot"
    prune_evidence || log 'evidence retention cleanup failed'
    ;;
  *)
    set_phase prepare
    log 'unknown operation'; exit 2
    ;;
esac
