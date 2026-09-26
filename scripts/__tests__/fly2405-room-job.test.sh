#!/usr/bin/env bash
# All databases and command stubs are fixture-local. Never launches a QA room.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
python3 - "$ROOT" "$@" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

WRAPPER = Path(sys.argv[1]) / 'scripts/lib/qa-room-job.sh'

class RoomJob(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='fly2405-room-job-')
        self.root = Path(self.tmp.name).resolve()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.seed = self.root / 'seed/scripts'
        (self.seed / 'lib').mkdir(parents=True)
        (self.seed / 'lib/qa-slot-claim.sh').write_text('# claim protocol\n')
        (self.seed / 'test-deploy.sh').write_text('''#!/bin/bash
# qa-slot-claim.sh
[[ -f "$TEST_OPERATION/owner.json" && "$FLYWHEEL_QA_ROOM_ID" == fixture-room && "$FLYWHEEL_QA_ROOM_CLAIM" == fixture-secret ]] || exit 89
printf 'deploy:%s\\n' "$*" >> "$TEST_EFFECTS"
printf '{"slot":1,"port":1981}\\n'
exit "${TEST_DEPLOY_EXIT:-0}"
''')
        (self.seed / 'test-teardown.sh').write_text('''#!/bin/bash
# qa-slot-claim.sh
[[ -f "$TEST_OPERATION/owner.json" && "$FLYWHEEL_QA_ROOM_CLAIM" == fixture-secret && "$1" == 1 ]] || exit 89
printf 'teardown:%s\\n' "$*" >> "$TEST_EFFECTS"
if [[ "${TEST_DELETE_SLOT:-0}" == 1 ]]; then rm -rf "$TEST_SLOT"; fi
if [[ "${TEST_KILL_WRAPPER:-0}" == 1 ]]; then kill -KILL "$PPID"; fi
exit "${TEST_TEARDOWN_EXIT:-0}"
''')
        stub = '''#!/usr/bin/env python3
import json, os, pathlib, shutil, subprocess, sys
op = pathlib.Path(os.environ['TEST_OPERATION'])
owner = json.loads((op / 'owner.json').read_text())
assert owner['operation_id'] == op.name
assert owner['lstart'] == subprocess.check_output(['ps', '-o', 'lstart=', '-p', str(owner['pid'])], text=True).strip()
args = sys.argv[1:]
name = pathlib.Path(sys.argv[0]).name
with open(os.environ['TEST_EFFECTS'], 'a') as f: f.write(name + ':' + ' '.join(args) + '\\n')
if name == 'git':
    args = args[2:] if args[:1] == ['-C'] else args
    if args[:1] == ['branch']:
        print('  other/topic' if os.getenv('TEST_FOREIGN_REF') else '  origin/topic')
    if args[:3] == ['worktree', 'add', '--detach']:
        shutil.copytree(os.environ['TEST_SEED'], args[3])
if name == 'pnpm' and args[0] == os.getenv('TEST_FAIL_PNPM'):
    sys.exit(31)
'''
        for name in ('git', 'pnpm'):
            p = self.bin / name
            p.write_text(stub)
            p.chmod(0o755)
        # The Codex test sandbox denies ps, so the process-start probe is a
        # fixture; the wrapper still supplies its own live PID to that probe.
        (self.bin / 'ps').write_text('#!/bin/sh\n[ "$1 $2 $3" = "-o lstart= -p" ] || exit 87\n[ "${TEST_PS_FAIL:-0}" = 0 ] || exit 1\nprintf "Sat Sep 26 12:00:00 2026\\n"\n')
        (self.bin / 'ps').chmod(0o755)
        # Any accidental launchctl execution is an immediate fixture failure.
        (self.bin / 'launchctl').write_text('#!/bin/sh\nexit 88\n')
        (self.bin / 'launchctl').chmod(0o755)
        self.src = self.root / 'src'
        self.slot = self.root / 'slot'
        self.evidence = self.root / 'evidence'
        self.effects = self.root / 'effects'
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        TEST_SEED=str(self.seed.parent), TEST_EFFECTS=str(self.effects),
                        TEST_SLOT=str(self.slot), FLYWHEEL_QA_ROOM_ID='fixture-room',
                        FLYWHEEL_QA_ROOM_CLAIM='fixture-secret')
        self.connections = []

    def tearDown(self):
        for conn in self.connections:
            conn.close()
        self.tmp.cleanup()

    def operation(self, name):
        op = self.root / 'ops' / name
        op.mkdir(parents=True)
        (op / 'room.json').write_text(json.dumps({'slot':1, 'slotDir':str(self.slot),
            'projectName':'test-slot-1', 'apiToken':'room-secret', 'tokenFile':str(self.slot / 'api-token')}))
        return op

    def run_job(self, op, kind, **env):
        args = [kind, str(op)]
        if kind == 'deploy':
            args += ['a' * 40, str(self.src), str(self.root / 'bridge'), '--', '1', '--lead-label', 'two words']
        elif kind == 'drill':
            args += [str(self.src), str(self.slot), '--', '1', '--issue', 'FLY-2405', '--real', '--timeout-ms', '10000']
        else:
            args += [str(self.src), '1', str(self.evidence)]
            if env.pop('skip', False):
                args += ['--skip-snapshot']
        with (op / 'stdout').open('w') as out, (op / 'stderr').open('w') as err:
            return subprocess.run(['bash', str(WRAPPER), *args],
                env=dict(self.env, TEST_OPERATION=str(op), **env), stdout=out, stderr=err).returncode

    def receipt(self, op, phase, code):
        value = json.loads((op / 'receipt.json').read_text())
        self.assertEqual(value['operation_id'], op.name)
        self.assertEqual(value['phase_reached'], phase)
        self.assertEqual(value['exit_code'], code)
        self.assertTrue(value['finished_at'])
        self.assertEqual((op / 'phase').read_text().strip(), phase)
        self.assertFalse(list(op.glob('*.tmp*')))

    def db(self, rel, tables=('sessions',), wal=False):
        path = self.slot / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path)
        if wal:
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA wal_autocheckpoint=0')
        for table in tables:
            conn.execute(f'CREATE TABLE {table} (value TEXT)')
            conn.execute(f'INSERT INTO {table} VALUES (?)', ('wal-row',))
        conn.commit()
        if wal:
            self.connections.append(conn)
            self.assertTrue(Path(str(path) + '-wal').exists())
        else:
            conn.close()
        return path

    def room(self):
        shutil.copytree(self.seed.parent, self.src)
        self.db('teamlead.db', wal=True)
        self.db('state/comm/test-slot-1/comm.db', ('sessions', 'mailbox'), wal=True)

    def published(self, op):
        path = Path((op / 'evidence-dir').read_text().strip())
        self.assertEqual(path, self.evidence / 'fixture-room' / op.name)
        self.assertTrue(path.is_dir())
        return path

    def test_owner_failure_is_97_before_any_commands(self):
        op = self.operation('owner-fail')
        (op / 'owner.json').mkdir()
        self.assertEqual(self.run_job(op, 'deploy'), 97)
        self.assertFalse(self.effects.exists())
        self.assertFalse((op / 'receipt.json').exists())
        self.assertFalse(self.src.exists())

    def test_existing_owner_or_failed_process_probe_has_no_job_effects(self):
        for name, env in [('duplicate', {}), ('no-start-time', {'TEST_PS_FAIL':'1'})]:
            op = self.operation(name)
            if name == 'duplicate':
                (op / 'owner.json').write_text('{"operation_id":"previous-owner"}')
            self.assertEqual(self.run_job(op, 'deploy', **env), 97)
            self.assertFalse(self.effects.exists())
            self.assertFalse((op / 'receipt.json').exists())
        self.assertEqual(json.loads((self.root / 'ops/duplicate/owner.json').read_text())['operation_id'], 'previous-owner')

    def test_build_failure_stays_in_prepare(self):
        op = self.operation('build-fail')
        self.assertEqual(self.run_job(op, 'deploy', TEST_FAIL_PNPM='-r'), 31)
        self.receipt(op, 'prepare', 31)
        self.assertNotIn('deploy:', self.effects.read_text())

    def test_required_database_parent_symlink_cannot_export_outside_room(self):
        self.room()
        for conn in self.connections:
            conn.close()
        self.connections = []
        source = self.slot / 'state/comm/test-slot-1'
        outside = self.root / 'foreign-comm'
        source.rename(outside)
        source.symlink_to(outside, target_is_directory=True)
        op = self.operation('symlink-parent')
        self.assertEqual(self.run_job(op, 'teardown'), 96)
        self.receipt(op, 'snapshot', 96)
        self.assertFalse(self.effects.exists())
        partial = self.evidence / 'fixture-room/symlink-parent.partial'
        self.assertFalse((partial / 'state/comm/test-slot-1/comm.db').exists())

    def test_slot_directory_symlink_cannot_export_outside_room(self):
        self.room()
        for conn in self.connections:
            conn.close()
        self.connections = []
        outside = self.root / 'foreign-room'
        self.slot.rename(outside)
        self.slot.symlink_to(outside, target_is_directory=True)
        op = self.operation('symlink-root')
        self.assertEqual(self.run_job(op, 'teardown'), 96)
        self.receipt(op, 'snapshot', 96)
        self.assertFalse(self.effects.exists())
        partial = self.evidence / 'fixture-room/symlink-root.partial'
        self.assertFalse((partial / 'teamlead.db').exists())
        self.assertFalse((partial / 'state/comm/test-slot-1/comm.db').exists())

    def test_deploy_owner_prepare_order_claim_and_atomic_receipt(self):
        op = self.operation('deploy-ok')
        self.assertEqual(self.run_job(op, 'deploy'), 0, (op / 'stderr').read_text())
        self.receipt(op, 'deploy', 0)
        effects = self.effects.read_text().splitlines()
        self.assertIn('fetch origin --prune', effects[0])
        self.assertIn('branch -r --contains ' + 'a' * 40, effects[1])
        self.assertIn('worktree add --detach', effects[2])
        self.assertEqual(effects[3:5], ['pnpm:install --frozen-lockfile --prefer-offline', 'pnpm:-r build'])
        self.assertEqual(effects[-1], 'deploy:1 --lead-label two words')
        self.assertIn('"slot":1', (op / 'stdout').read_text())

    def test_foreign_remote_and_missing_claim_protocol_fail_in_prepare(self):
        for name, env in [('foreign', {'TEST_FOREIGN_REF':'1'}), ('old-head', {})]:
            op = self.operation(name)
            if name == 'old-head':
                (self.seed / 'lib/qa-slot-claim.sh').unlink()
            self.assertNotEqual(self.run_job(op, 'deploy', **env), 0)
            self.assertEqual(json.loads((op / 'receipt.json').read_text())['phase_reached'], 'prepare')
            self.assertNotIn('deploy:', self.effects.read_text())
        self.assertIn('head_lacks_claim_protocol', (op / 'stderr').read_text())

    def test_install_failure_and_deploy_failure_have_distinct_phases(self):
        op = self.operation('install-fail')
        self.assertEqual(self.run_job(op, 'deploy', TEST_FAIL_PNPM='install'), 31)
        self.receipt(op, 'prepare', 31)
        self.assertNotIn('deploy:', self.effects.read_text())
        shutil.rmtree(self.src)
        op = self.operation('deploy-fail')
        self.assertEqual(self.run_job(op, 'deploy', TEST_DEPLOY_EXIT='42'), 42)
        self.receipt(op, 'deploy', 42)

    def test_snapshot_wal_nested_campaign_manifest_and_secret_exclusion(self):
        self.room()
        self.db('deep/a/b/c/audit.db', ('events',), wal=True)
        self.db('project-slot-1/ignored.db')
        self.db('nested/node_modules/ignored.db')
        extra = self.slot / 'extra-leads/slot-2'
        self.db('extra-leads/slot-2/teamlead.db', wal=True)
        (self.slot / 'campaign-manifest.json').write_text(json.dumps({'extraLeads':[{'stateDir':str(extra)}]}))
        (self.slot / 'bridge.log').write_text('bridge room-secret fixture-secret manifest-secret\n')
        (extra / 'lead.log').write_text('lead log\n')
        (self.slot / 'bridge-launch.json').write_text(json.dumps({'env':{'API_TOKEN':'manifest-secret', 'PORT':'1981'}}))
        (self.slot / 'api-token').write_text('room-secret')
        (self.slot / '.env').write_text('API_TOKEN=room-secret')
        (self.slot / 'unrelated.txt').write_text('room-secret')
        op = self.operation('snapshot-ok')
        self.assertEqual(self.run_job(op, 'teardown'), 0, (op / 'stderr').read_text())
        self.receipt(op, 'teardown', 0)
        dest = self.published(op)
        manifest = json.loads((dest / 'manifest.json').read_text())
        self.assertEqual(manifest['missing'], [])
        self.assertEqual(len([x for x in manifest['exported'] if x['path'].endswith('.db')]), 4)
        for item in manifest['exported']:
            file = dest / item['path']
            self.assertEqual(item['size'], file.stat().st_size)
            self.assertEqual(item['sha256'], hashlib.sha256(file.read_bytes()).hexdigest())
            self.assertTrue(item['source'])
            if file.suffix == '.db':
                with sqlite3.connect(file) as conn:
                    table = 'events' if file.name == 'audit.db' else 'sessions'
                    self.assertEqual(conn.execute(f'SELECT value FROM {table}').fetchall(), [('wal-row',)])
            else:
                for secret in ('room-secret', 'fixture-secret', 'manifest-secret'):
                    self.assertNotIn(secret, file.read_text())
        self.assertFalse(any(x.name in ('api-token', '.env', 'unrelated.txt', 'ignored.db') for x in dest.rglob('*')))
        self.assertEqual(self.effects.read_text(), 'teardown:1\n')

    def drill_fixture(self):
        shutil.copytree(self.seed.parent, self.src)
        self.slot.mkdir()
        home = self.root / 'home'
        home.mkdir()
        self.env['HOME'] = str(home)
        (self.src / 'scripts/qa-529-generalized-e2e.mjs').write_text("""
import fs from 'node:fs';
import path from 'node:path';
const op = process.env.TEST_OPERATION;
if (!fs.existsSync(path.join(op, 'owner.json'))) process.exit(89);
fs.writeFileSync(process.env.TEST_EFFECTS, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd()}));
const dest = path.join(process.env.TEST_SLOT, 'e2e-evidence', 'new-run');
fs.mkdirSync(dest, {recursive: true});
fs.writeFileSync(path.join(dest, 'step-1.json'), '{"ok":true}');
if (process.env.TEST_EVIDENCE_LINK) fs.symlinkSync('/etc/passwd', path.join(dest, 'escape'));
process.exit(Number(process.env.TEST_DRIVER_EXIT || 0));
""")
        old = self.slot / 'e2e-evidence/old-run'
        old.mkdir(parents=True)
        (old / 'keep.json').write_text('{}')

    def test_drill_preserves_driver_exit_and_copies_only_new_evidence(self):
        self.drill_fixture()
        for code in (0, 20, 21, 1):
            with self.subTest(code=code):
                shutil.rmtree(self.slot / 'e2e-evidence/new-run', ignore_errors=True)
                op = self.operation('drill-' + str(code))
                self.assertEqual(self.run_job(op, 'drill', TEST_DRIVER_EXIT=str(code)), code)
                self.receipt(op, 'drill', code)
                receipt = json.loads((op / 'receipt.json').read_text())
                self.assertEqual(receipt['evidence_copy'], 'ok')
                self.assertFalse((op / 'evidence/old-run').exists())
                manifest = json.loads((op / 'evidence/manifest.json').read_text())
                self.assertEqual(len(manifest['files']), 1)
                entry = manifest['files'][0]
                self.assertEqual(entry['path'], 'new-run/step-1.json')
                self.assertEqual(entry['sha256'], hashlib.sha256((op / 'evidence' / entry['path']).read_bytes()).hexdigest())
                effects = json.loads(self.effects.read_text())
                self.assertEqual(effects, {'argv':['1', '--issue', 'FLY-2405', '--real', '--timeout-ms', '10000'], 'cwd': str(self.src)})
                self.assertFalse(list(Path(self.env['HOME']).glob('.flywheel-qa-room-probe.*')))

    def test_drill_home_probe_refuses_before_driver(self):
        self.drill_fixture()
        op = self.operation('drill-readonly')
        home = Path(self.env['HOME'])
        home.chmod(0o500)
        try:
            self.assertEqual(self.run_job(op, 'drill'), 96)
            self.receipt(op, 'drill', 96)
            self.assertFalse(self.effects.exists())
        finally:
            home.chmod(0o700)

    def test_drill_copy_failure_does_not_hide_successful_driver(self):
        self.drill_fixture()
        op = self.operation('drill-copy-failed')
        self.assertEqual(self.run_job(op, 'drill', TEST_EVIDENCE_LINK='1'), 0)
        self.assertEqual(json.loads((op / 'receipt.json').read_text())['evidence_copy'], 'failed')
        self.assertFalse((op / 'evidence/new-run/escape').exists())

    def test_teardown_snapshot_includes_driver_evidence(self):
        self.room()
        evidence = self.slot / 'e2e-evidence/run-1'
        evidence.mkdir(parents=True)
        (evidence / 'step-1.json').write_text('{"ok":true}')
        op = self.operation('drill-snapshot')
        self.assertEqual(self.run_job(op, 'teardown'), 0)
        self.assertEqual((self.published(op) / 'e2e-evidence/run-1/step-1.json').read_text(), '{"ok":true}')

    def test_missing_required_snapshot_retains_partial_then_new_attempt_succeeds(self):
        shutil.copytree(self.seed.parent, self.src)
        self.db('teamlead.db')
        op = self.operation('missing')
        self.assertEqual(self.run_job(op, 'teardown'), 96)
        self.receipt(op, 'snapshot', 96)
        partial = self.evidence / 'fixture-room/missing.partial'
        manifest = json.loads((partial / 'manifest.json').read_text())
        self.assertTrue(any('comm.db' in x['source'] for x in manifest['missing']))
        self.assertFalse(self.effects.exists())
        self.db('state/comm/test-slot-1/comm.db', ('sessions', 'mailbox'))
        retry = self.operation('missing-retry')
        self.assertEqual(self.run_job(retry, 'teardown'), 0)
        self.published(retry)
        self.assertTrue(partial.exists())

    def test_required_tables_and_corrupt_supplement_prevent_teardown(self):
        self.room()
        for conn in self.connections:
            conn.close()
        self.connections = []
        with sqlite3.connect(self.slot / 'state/comm/test-slot-1/comm.db') as conn:
            conn.execute('DROP TABLE mailbox')
        op = self.operation('bad-tables')
        self.assertEqual(self.run_job(op, 'teardown'), 96)
        self.assertFalse(self.effects.exists())
        with sqlite3.connect(self.slot / 'state/comm/test-slot-1/comm.db') as conn:
            conn.execute('CREATE TABLE mailbox (id TEXT)')
        (self.slot / 'corrupt.db').write_text('not sqlite')
        op = self.operation('corrupt')
        self.assertEqual(self.run_job(op, 'teardown'), 96)
        self.assertFalse(self.effects.exists())

    def test_teardown_failure_retry_preserves_both_published_snapshots(self):
        self.room()
        op = self.operation('teardown-fail')
        self.assertEqual(self.run_job(op, 'teardown', TEST_TEARDOWN_EXIT='44'), 44)
        first = self.published(op)
        self.receipt(op, 'teardown', 44)
        retry = self.operation('teardown-retry')
        self.assertEqual(self.run_job(retry, 'teardown'), 0)
        self.assertNotEqual(first, self.published(retry))
        self.assertTrue(first.exists())

    def test_crash_after_slot_delete_requires_explicit_skip_retry(self):
        self.room()
        # Close fixture writers before emulating the teardown deleting the room.
        for conn in self.connections:
            conn.close()
        self.connections = []
        op = self.operation('receipt-lost')
        self.assertEqual(self.run_job(op, 'teardown', TEST_DELETE_SLOT='1', TEST_KILL_WRAPPER='1'), -9)
        first = self.published(op)
        self.assertFalse((op / 'receipt.json').exists())
        normal = self.operation('normal-retry')
        self.assertEqual(self.run_job(normal, 'teardown'), 96)
        self.receipt(normal, 'snapshot', 96)
        self.assertEqual(self.effects.read_text().count('teardown:'), 1)
        skip = self.operation('explicit-skip')
        self.assertEqual(self.run_job(skip, 'teardown', skip=True), 0)
        self.receipt(skip, 'teardown', 0)
        self.assertTrue(first.exists())
        self.assertEqual(self.effects.read_text().count('teardown:'), 2)

    def test_success_only_prunes_old_owned_evidence_without_following_links(self):
        self.room()
        op = self.operation('old')
        self.assertEqual(self.run_job(op, 'teardown'), 0)
        old = self.published(op)
        oldtime = time.time() - 15 * 86400
        os.utime(old, (oldtime, oldtime))
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('keep')
        (self.evidence / 'fixture-room/linked').symlink_to(outside, target_is_directory=True)
        retry = self.operation('failure-no-prune')
        self.assertEqual(self.run_job(retry, 'teardown', TEST_TEARDOWN_EXIT='44'), 44)
        self.assertTrue(old.exists())
        retry = self.operation('success-prune')
        self.assertEqual(self.run_job(retry, 'teardown'), 0)
        self.assertFalse(old.exists())
        self.assertTrue((outside / 'keep').exists())

unittest.main(argv=['fly2405-room-job', *sys.argv[2:]], verbosity=2)
PY
