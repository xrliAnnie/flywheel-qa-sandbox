#!/usr/bin/env bash
# Host-only C3 evidence runner. No production cleanup or message sends.
# Usage: bash c3-repro.sh --dry-run | bash c3-repro.sh 2 <git-ref>
set -euo pipefail
exec python3 - "$0" "$@" <<'PY'
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import socket
import stat
import subprocess as sp
import sys
import tempfile
import threading
import time

BASELINE = '5cbd540f1bfdee28dd474f89ecb1523a4507473b'
DEPLOY = ['bash', 'scripts/test-deploy.sh', '2', '--extra-lead', '3:Ops-Test']
SLOTS = (2, 3)
FILE_CAP = 256 * 1024
DIRECTORY_CAP = 64 * 1024 * 1024

def require(ok, reason):
    if not ok:
        raise RuntimeError(reason)

def valid_ref(ref):
    require(bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,160}', ref)), 'unsafe_ref')

def absent_guard(paths, sessions, labels, probe_ok=True):
    require(probe_ok, 'probe_error')
    require(not paths, 'occupied_path')
    require(not set(sessions).intersection({'runner-test-slot-2', 'runner-test-slot-3'}), 'production_session')
    require(not any(re.search(r'^com\.flywheel\..*slot-[23](?:\D|$)', x) for x in labels), 'launchd_label')

def identity_guard(body, expected):
    require(isinstance(body, dict) and body.get('buildSha') == expected, 'wrong_build')

def cleanup_guard(claimed, original_inode, current_inode):
    require(claimed, 'unowned_cleanup')
    require(original_inode is not None and original_inode == current_inode, 'changed_runtime')

def budget_guard(current, replaced, incoming, cap=DIRECTORY_CAP):
    require(current - replaced + incoming <= cap, 'evidence_budget')

def capped_stream(stream):
    data = bytearray()
    total = 0
    while True:
        chunk = stream.read(8192)
        if not chunk:
            break
        total += len(chunk)
        data.extend(chunk[:max(0, FILE_CAP - len(data))])
    return bytes(data), total > FILE_CAP

def evidence_paths(root):
    # Fixed depth only: never walk sandbox clones, Lead workspaces or node_modules.
    result = [root / name for name in ('bridge.pid', 'bridge.log', 'lead.log', 'launchd-leads.json')]
    for group in ('launchd', 'extra-leads'):
        parent = root / group
        if not parent.is_dir() or parent.is_symlink():
            continue
        children = list(parent.iterdir())
        require(len(children) <= 16, 'too_many_runtime_directories')
        for directory in children:
            if not directory.is_dir() or directory.is_symlink():
                continue
            if group == 'extra-leads':
                result.append(directory / 'lead.log')
            else:
                files = list(directory.iterdir())
                require(len(files) <= 64, 'too_many_runtime_files')
                result.extend(files)
    return result

def dry_run():
    passed = []
    cases = [
        ('occupied_path', lambda: absent_guard(['/tmp/occupied'], [], [])),
        ('production_session', lambda: absent_guard([], ['runner-test-slot-2'], [])),
        ('launchd_label', lambda: absent_guard([], [], ['com.flywheel.qa.lead.slot-3.test'])),
        ('probe_error', lambda: absent_guard([], [], [], False)),
        ('wrong_build', lambda: identity_guard({'buildSha': 'old'}, 'expected')),
        ('unsafe_ref', lambda: valid_ref('--upload-pack=unsafe')),
        ('unowned_cleanup', lambda: cleanup_guard(False, 1, 1)),
        ('changed_runtime', lambda: cleanup_guard(True, 1, 2)),
        ('evidence_budget', lambda: budget_guard(DIRECTORY_CAP, 0, 1)),
    ]
    for name, action in cases:
        try:
            action()
        except RuntimeError as exc:
            require(str(exc) == name, 'self_test_wrong_reason')
            passed.append(name)
        else:
            raise RuntimeError('self_test_guard_did_not_refuse:' + name)
    absent_guard([], ['unrelated'], ['com.flywheel.qa.lead.slot-23.test'])
    identity_guard({'buildSha': BASELINE}, BASELINE)
    valid_ref(BASELINE)
    with tempfile.TemporaryDirectory(prefix='fly2455-c3-dry-') as fixture:
        root = Path(fixture)
        (root / 'launchd/lead').mkdir(parents=True)
        (root / 'launchd/lead/manifest.json').write_text('{}')
        (root / 'sandbox/node_modules').mkdir(parents=True)
        (root / 'sandbox/node_modules/lead.log').write_text('must not visit')
        require(root / 'launchd/lead/manifest.json' in evidence_paths(root), 'bounded_discovery_missing_manifest')
        require(not any('node_modules' in path.parts for path in evidence_paths(root)), 'bounded_discovery_escaped')
    passed.append('bounded_discovery')
    budget_guard(DIRECTORY_CAP, 1024, 1024)
    stream = io.BytesIO(b'x' * (FILE_CAP + 10000))
    payload, truncated = capped_stream(stream)
    require(len(payload) == FILE_CAP and truncated and stream.tell() == FILE_CAP + 10000, 'bounded_log_failed')
    payload, truncated = capped_stream(io.BytesIO(b'complete'))
    require(payload == b'complete' and not truncated, 'bounded_log_control_failed')
    passed.append('bounded_log')
    print(json.dumps({'mode': 'dry-run', 'hostCalls': 0, 'deployArgv': DEPLOY, 'guardsPassed': passed}))

if sys.argv[2:] == ['--dry-run']:
    dry_run()
    sys.exit(0)
require(len(sys.argv) == 4 and sys.argv[2] == '2', 'usage: c3-repro.sh 2 <git-ref> (Lead ruling fixes extra slot 3)')
ref = sys.argv[3]
valid_ref(ref)
os.umask(0o077)
repo = Path(sys.argv[1]).resolve().parents[3]
home = Path.home()
uid = os.getuid()
domain = 'gui/' + str(uid)
tmux = shutil.which('tmux')
require(tmux is not None, 'tmux_unavailable')
production_socket = Path('/private/tmp') / ('tmux-' + str(uid)) / 'default'

def command(argv, timeout=10, cwd=None, env=None):
    return sp.run(argv, cwd=cwd, env=env, stdin=sp.DEVNULL, capture_output=True, timeout=timeout)

def checked(argv, timeout=10, cwd=None):
    result = command(argv, timeout, cwd)
    require(result.returncode == 0, 'command_failed:' + str(argv[0]))
    return result.stdout.decode('utf-8', 'replace')

head = checked(['git', 'rev-parse', '--verify', ref + '^{commit}'], cwd=repo).strip()
require(command(['git', 'merge-base', '--is-ancestor', BASELINE, head], cwd=repo).returncode == 0, 'ref_predates_isolation_merge')
stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
evidence_root = home / '.flywheel/qa-evidence/FLY-2455'
evidence_root.mkdir(parents=True, exist_ok=True)
require(not evidence_root.is_symlink(), 'evidence_root_symlink')
evidence = evidence_root / (stamp + '-c3-' + head[:12])
evidence.mkdir(mode=0o700)
write_lock = threading.Lock()

def write(name, value):
    path = evidence / name
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(not path.is_symlink(), 'evidence_symlink')
    data = value if isinstance(value, bytes) else (json.dumps(value, indent=2) + '\n').encode()
    budget_guard(0, 0, len(data), FILE_CAP)
    with write_lock:
        current = sum(p.stat().st_size for p in evidence.rglob('*') if p.is_file() and not p.is_symlink())
        replaced = path.stat().st_size if path.exists() else 0
        # Reserve 1 MiB for the final receipt and digest even on quota failure.
        cap = DIRECTORY_CAP if name in {'receipt.json', 'sha256.json'} else DIRECTORY_CAP - 1048576
        budget_guard(current, replaced, len(data), cap)
        path.write_bytes(data)
        path.chmod(0o600)

def start_logged(argv, name, cwd, env=None):
    child = sp.Popen(argv, cwd=cwd, env=env, stdin=sp.DEVNULL, stdout=sp.PIPE, stderr=sp.STDOUT)
    errors = []
    def drain():
        try:
            payload, truncated = capped_stream(child.stdout)
            write(name, payload)
            write(name + '.status.json', {'truncated': truncated, 'capBytes': FILE_CAP})
        except Exception as exc:
            errors.append(exc)
    thread = threading.Thread(target=drain, daemon=True)
    thread.start()
    return child, thread, errors

def finish_log(thread, errors):
    thread.join(timeout=5)
    require(not thread.is_alive(), 'log_stream_still_open_preserve_runtime')
    if errors:
        raise RuntimeError('log_archive_failed_preserve_runtime') from errors[0]

def run_logged(argv, name, cwd, timeout, env=None):
    child, thread, errors = start_logged(argv, name, cwd, env)
    try:
        child.wait(timeout=timeout)
    except sp.TimeoutExpired:
        child.terminate()
        try:
            child.wait(timeout=30)
        finally:
            finish_log(thread, errors)
        raise RuntimeError('command_timeout:' + name)
    finish_log(thread, errors)
    return child.returncode

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

config = json.loads((home / '.flywheel/test-slots.json').read_text())
rows = [x for x in config['slots'] if x.get('id') in SLOTS]
require(len(rows) == 2, 'slot_config_missing')
ports = [int(x['bridgePort']) for x in rows]
require(all(1024 <= p <= 65535 for p in ports), 'invalid_port')
write('identity.json', {'ref': ref, 'head': head, 'baseline': BASELINE, 'startedAt': now(),
    'argv': DEPLOY, 'tmpdir': '/tmp/q7', 'slots': [{k: row.get(k) for k in
        ('id', 'botAppId', 'channelId', 'bridgePort', 'tokenEnvVar', 'identitySource')} for row in rows]})

def open_ports():
    result = []
    for port in ports:
        with socket.socket() as probe:
            probe.settimeout(1)
            if probe.connect_ex(('127.0.0.1', port)) == 0:
                result.append(port)
    return result

def prestate(name):
    paths = []
    for slot in SLOTS:
        for path in (Path('/tmp/flywheel-test-slot-' + str(slot)),
                     Path('/tmp/flywheel-test-slot-' + str(slot) + '.lock'),
                     home / ('.flywheel/comm/test-slot-' + str(slot))):
            if os.path.lexists(path):
                paths.append(str(path))
    labels_result = command(['launchctl', 'list'])
    labels = [line.split()[-1] for line in labels_result.stdout.decode('utf-8', 'replace').splitlines()[1:] if line.split()]
    sessions = []
    socket_ok = True
    if os.path.lexists(production_socket):
        result = command([tmux, '-S', str(production_socket), 'list-sessions', '-F', '#{session_name}'])
        socket_ok = result.returncode == 0
        sessions = result.stdout.decode('utf-8', 'replace').splitlines()
    state = {'observedAt': now(), 'paths': paths, 'sessions': sessions,
             'slotLabels': [x for x in labels if re.search(r'^com\.flywheel\..*slot-[23](?:\D|$)', x)],
             'probeOk': labels_result.returncode == 0 and socket_ok, 'openPorts': open_ports()}
    write(name + '.json', state)
    absent_guard(paths, sessions, labels, state['probeOk'])
    require(not state['openPorts'], 'port_occupied')

def census(name):
    # Never ps e/eww or persist argv/environment. PID + start time + comm only.
    data = checked(['/bin/ps', '-axo', 'pid=,ppid=,lstart=,comm='])
    write(name + '.txt', data.encode())
    return {line.strip().split()[0]: ' '.join(line.strip().split()[2:7])
            for line in data.splitlines() if len(line.split()) >= 8
            and re.search(r'(?:^|/)(?:node|codex|claude|tmux)(?:\s|$)', ' '.join(line.split()[7:]))}

slot_dir = Path('/tmp/flywheel-test-slot-2')
observed_pids = {}
observed_sockets = set()
observed_labels = set()
runtime_inode = None

def record_pid(pid, name):
    result = command(['/bin/ps', '-p', str(pid), '-o', 'pid=,ppid=,lstart=,comm='])
    write(name, result.stdout)
    if result.returncode == 0 and len(result.stdout.split()) >= 8:
        # Parent can change during teardown; start time is the generation fence.
        observed_pids[pid] = b' '.join(result.stdout.split()[2:7])

def capture(strict=False):
    global runtime_inode
    # Every file is private; raw output never reaches shared stderr or HTML.
    if not slot_dir.is_dir() or slot_dir.is_symlink():
        return
    if runtime_inode is None:
        runtime_inode = slot_dir.stat().st_ino
    for path in evidence_paths(slot_dir):
        if path.is_symlink() or not path.is_file():
            continue
        if path.name not in {'body-output.log', 'body-status.json', 'topology-failure.json', 'bridge.pid',
                             'manifest.json', 'launchd-leads.json', 'bridge.log', 'lead.log'} and path.suffix != '.plist':
            continue
        relative = str(path.relative_to(slot_dir))
        try:
            size = path.stat().st_size
            if path.suffix in {'.json', '.plist'}:
                require(size <= 1048576, 'oversized_evidence_metadata')
            if path.suffix == '.plist':
                value = plistlib.loads(path.read_bytes())
                write('slot/' + relative + '.json', {k: value.get(k) for k in ('Label', 'ProgramArguments')})
            elif path.name == 'manifest.json':
                value = json.loads(path.read_text())
                safe = {k: value.get(k) for k in ('leadId', 'projectName', 'pid', 'socketPath')}
                write('slot/' + relative, safe)
                pid, sock = safe.get('pid'), safe.get('socketPath')
                if isinstance(pid, int) and pid > 1:
                    record_pid(pid, 'slot/' + relative + '.process.txt')
                if isinstance(sock, str) and sock.startswith('/') and not any(ord(c) < 32 for c in sock):
                    observed_sockets.add(sock)
                    for kind, args in [('session', ['has-session', '-t', '=main']),
                                       ('windows', ['list-windows', '-a', '-F', '#{session_name}|#{window_id}|#{pane_pid}'])]:
                        result = command([tmux, '-S', sock] + args, 2)
                        write('slot/' + relative + '.' + kind + '.json', {'observedAt': now(),
                              'exitCode': result.returncode, 'stdout': result.stdout.decode('utf-8', 'replace')})
            elif path.name == 'bridge.pid':
                pid = int(path.read_text().strip())
                require(pid > 1, 'invalid_bridge_pid')
                record_pid(pid, 'slot/bridge-process.txt')
            else:
                with path.open('rb') as stream:
                    # Body recorder is already capped; other logs retain bounded tail.
                    if size > 262144:
                        stream.seek(size - 262144)
                    write('slot/' + relative, stream.read(262144))
        except (OSError, ValueError, sp.TimeoutExpired) as exc:
            write('capture-error.json', {'path': relative, 'errorType': type(exc).__name__, 'observedAt': now()})
            if strict:
                raise RuntimeError('evidence_archive_failed_preserve_runtime:' + relative) from exc
    labels = checked(['launchctl', 'list']).splitlines()[1:]
    for line in labels:
        fields = line.split()
        if not fields or not re.search(r'^com\.flywheel\..*slot-[23](?:\D|$)', fields[-1]):
            continue
        label = fields[-1]
        observed_labels.add(label)
        result = command(['launchctl', 'print', domain + '/' + label], 2)
        # launchctl print contains secrets in env; retain only these scalar fields.
        safe = [x.strip() for x in result.stdout.decode('utf-8', 'replace').splitlines()
                if re.fullmatch(r'\s*(?:pid|state|last exit code|runs) = [A-Za-z0-9 _-]+', x)]
        write('launchd/' + label + '.json', {'observedAt': now(), 'exitCode': result.returncode, 'fields': safe})

status = {'head': head, 'startedAt': now(), 'deployExit': None, 'teardownExit': None, 'complete': False}
deploy = None
checkout = None
try:
    # Host capability and strict absence proof precede build AND slot mutation.
    before = census('processes-before')
    prestate('pre-state')
    write('tools.json', {'observedAt': now(), 'os': checked(['uname', '-a']).strip(),
                        'tmuxBinary': tmux, 'tmuxRealpath': str(Path(tmux).resolve()),
                        'tmuxVersion': checked([tmux, '-V']).strip(),
                        'tmuxArchitecture': checked(['/usr/bin/file', str(Path(tmux).resolve())]).strip()})
    checkout = Path(tempfile.mkdtemp(prefix='fly2455-c3-', dir='/private/tmp')) / 'checkout'
    checked(['git', 'worktree', 'add', '--detach', str(checkout), head], 60, repo)
    require(not checked(['git', 'status', '--porcelain'], cwd=checkout).strip(), 'checkout_dirty')
    for name, argv in [('install', ['pnpm', 'install', '--frozen-lockfile']), ('build', ['pnpm', '-r', 'build'])]:
        started = time.monotonic()
        rc = run_logged(argv, name + '.log', checkout, 1800, dict(os.environ, CI='true'))
        status[name] = {'exitCode': rc, 'elapsedSeconds': time.monotonic() - started}
        require(rc == 0, name + '_failed')
    prestate('pre-start-state')
    before = census('processes-before-start')
    tmpdir = Path('/tmp/q7')
    if not os.path.lexists(tmpdir):
        tmpdir.mkdir(mode=0o700)
    require(not tmpdir.is_symlink() and tmpdir.is_dir() and tmpdir.stat().st_uid == uid, 'unsafe_tmpdir')
    env = dict(os.environ, TMPDIR='/tmp/q7')
    status['deployStartedAt'] = now()
    began = time.monotonic()
    deploy, deploy_thread, deploy_errors = start_logged(DEPLOY, 'deploy.log', checkout, env)
    while deploy.poll() is None and time.monotonic() - began < 900:
        capture()
        time.sleep(1)
    if deploy.poll() is None:
        # Signal only the direct child we created; never a group or host process.
        deploy.terminate()
        try:
            deploy.wait(timeout=30)
        except sp.TimeoutExpired:
            raise RuntimeError('deploy_timeout_still_running_preserve_for_owner')
    finish_log(deploy_thread, deploy_errors)
    status['deployExit'] = deploy.returncode
    status['deployEndedAt'] = now()
    status['deployElapsedSeconds'] = time.monotonic() - began
    capture(strict=True)
    if deploy.returncode == 0:
        port = next(row['bridgePort'] for row in rows if row['id'] == 2)
        result = command(['curl', '--silent', '--show-error', '--fail', '--max-time', '5',
                          '--write-out', '\n%{http_code}',
                          'http://127.0.0.1:' + str(port) + '/api/health'], 7)
        payload, _, http_status = result.stdout.rpartition(b'\n')
        write('health.json', payload)
        write('health-status.json', {'httpStatus': http_status.decode(), 'curlExit': result.returncode,
                                    'observedAt': now()})
        require(result.returncode == 0, 'health_unreachable')
        require(http_status == b'200', 'health_not_200')
        identity_guard(json.loads(payload), head)
        status['healthBuildShaVerified'] = True
except Exception as exc:
    status['error'] = str(exc)
    raise
finally:
    # Do not clean a room until deployment has exited and evidence is archived.
    if deploy is not None and deploy.poll() is not None:
        try:
            capture(strict=True)
            # Only our child's successful claim plus unchanged runtime allows
            # teardown. A rejected claim must never clean another owner's slot.
            claimed = bool(re.search(rb'\[test-deploy\] [0-9:]+ Claimed slot 2(?:\r?\n|$)',
                                     (evidence / 'deploy.log').read_bytes()))
            if slot_dir.exists():
                cleanup_guard(claimed, runtime_inode, slot_dir.stat().st_ino)
            else:
                # Failed before creating a room: verify absence, do not teardown.
                prestate('post-state')
                status['zeroSlotResidue'] = True
                status['complete'] = True
                raise RuntimeError('no_runtime_created_teardown_not_needed')
            began = time.monotonic()
            status['teardownStartedAt'] = now()
            rc = run_logged(['bash', 'scripts/test-teardown.sh', '2'], 'teardown.log', checkout, 180)
            status['teardownExit'] = rc
            status['teardownElapsedSeconds'] = time.monotonic() - began
            status['teardownEndedAt'] = now()
            require(rc == 0, 'teardown_failed')
            prestate('post-state')
            residual_sockets = [x for x in observed_sockets if os.path.lexists(x)]
            require(not residual_sockets, 'socket_residue')
            still_alive = []
            for pid, identity in observed_pids.items():
                result = command(['/bin/ps', '-p', str(pid), '-o', 'pid=,ppid=,lstart=,comm='])
                if result.returncode == 0 and b' '.join(result.stdout.split()[2:7]) == identity:
                    still_alive.append(pid)
            require(not still_alive, 'slot_process_residue')
            after = census('processes-after')
            # Concurrent fleet exits need causal review; never report them as zero harm.
            changed = [pid for pid, start in before.items() if after.get(pid) != start]
            write('processes-changed.json', {'pids': changed, 'requiresCausalReview': bool(changed)})
            status['zeroSlotResidue'] = True
            status['nonSlotProcessChangesRequireReview'] = changed
            status['complete'] = True
        except Exception as exc:
            if str(exc) == 'no_runtime_created_teardown_not_needed':
                status['teardownSkipped'] = str(exc)
            else:
                status['cleanupError'] = str(exc)
    status['endedAt'] = now()
    status['checkout'] = str(checkout) if checkout else None
    write('receipt.json', status)
    hashes = {}
    for path in evidence.rglob('*'):
        if path.is_file() and not path.is_symlink():
            path.chmod(0o600)
            hashes[str(path.relative_to(evidence))] = hashlib.sha256(path.read_bytes()).hexdigest()
    write('sha256.json', hashes)
    print(json.dumps({'evidenceDir': str(evidence), 'receipt': status}))
require(status['complete'], 'reproduction_or_cleanup_incomplete')
PY
