#!/usr/bin/env bash
# FLY-2549: exercise the real source verifier and its child against stale workspace dist.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
RESTART="${1:-$REPO/scripts/restart-services.sh}"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly2549-summary-source.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
export REPO ROOT

python3 <<'PY'
import json, os, shutil
from pathlib import Path
repo, root = Path(os.environ['REPO']), Path(os.environ['ROOT'])
fixture = root / 'repo'
(fixture / 'scripts').mkdir(parents=True)
(fixture / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
(fixture / 'package.json').write_text('{"private":true,"type":"module"}')
config = repo / 'scripts/tsconfig.restart-preflight.json'
if config.exists():
    shutil.copy2(config, fixture / 'scripts' / config.name)
# Redirect every installed workspace dependency to the fixture. Other dependencies
# retain their installed targets; no test writes through any node_modules link.
for package in (repo / 'packages').iterdir():
    if not (package / 'package.json').exists():
        continue
    dest = fixture / 'packages' / package.name
    dest.mkdir(parents=True)
    shutil.copy2(package / 'package.json', dest / 'package.json')
    if package.name in ('config', 'core', 'flywheel-comm', 'teamlead'):
        shutil.copytree(package / 'src', dest / 'src', ignore=shutil.ignore_patterns('__tests__', '*.test.ts'))
    if package.name in ('core', 'flywheel-comm'):
        shutil.copytree(package / 'dist', dest / 'dist',
                        ignore=shutil.ignore_patterns('__tests__', '*.test.*', '*.map', '*.d.ts'))
    else:
        # Unused workspace packages need no runnable artifact. A future import
        # outside the source mapping must fail instead of using fresh host dist.
        (dest / 'dist').mkdir()
        (dest / 'dist/index.js').write_text('export const staleDist = true;\n')
    modules = package / 'node_modules'
    if not modules.exists():
        continue
    for entry in modules.iterdir():
        entries = list(entry.iterdir()) if entry.name.startswith('@') else [entry]
        for dep in entries:
            target = dep.resolve()
            try:
                target = fixture / 'packages' / target.relative_to(repo / 'packages')
            except ValueError:
                pass
            link = dest / 'node_modules' / dep.relative_to(modules)
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(target, target_is_directory=True)
state = root / 'home/.flywheel'
state.mkdir(parents=True)
(state / 'summary-config.json').write_text(json.dumps({'granularity':'per-lead','setBy':'founder','setAt':'2026-09-14T07:00:00.000Z'}))
(root / 'projects.json').write_text(json.dumps([{'projectName':'fixture','projectRoot':str(root / 'project'),'leads':[{'agentId':'fixture-lead','summaryRole':'producer','chatChannel':'10000000000000000','match':{'labels':['fixture-lead']},'botTokenEnv':'FIXTURE_BOT_TOKEN','botUserId':'20000000000000000','canSpawnRunners':False,'backend':'claude-code','carrier':'v2'}]}]))
(root / 'assignments.json').write_text(json.dumps({'assignments':[{'projectName':'fixture','leadId':'fixture-lead','summaryRole':'producer'}],'projectAggregators':[]}))
PY

export HOME="$ROOT/home" npm_config_manage_package_manager_versions=false
unset FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR FLYWHEEL_PROJECTS TSX_TSCONFIG_PATH
# Generate a valid receipt with the real migration wrapper/validator in the built
# checkout, then test those exact registry bytes against the stale-dist fixture.
FLYWHEEL_COMM_CLI="$REPO/packages/flywheel-comm/dist/index.js" \
  bash "$REPO/scripts/migrate-summary-registry.sh" \
  "$ROOT/projects.json" "$ROOT/assignments.json" "$ROOT/receipt.json" \
  "$(shasum -a 256 "$ROOT/projects.json" | awk '{print $1}')" > "$ROOT/migrate.log"

awk '/^log\(\)/,/^}/ { print; next } /^summary_registry_activation_preflight\(\)/,/^}/ { print; next }' \
  "$RESTART" > "$ROOT/functions.sh"
source "$ROOT/functions.sh"
export FLYWHEEL_DIR="$ROOT/repo" FLYWHEEL_PROJECTS_FILE="$ROOT/projects.json" \
  FLYWHEEL_SUMMARY_MIGRATION_RECEIPT="$ROOT/receipt.json"

snapshot() {
  python3 <<'PY'
import hashlib, os
from pathlib import Path
root = Path(os.environ['ROOT']) / 'repo'
for path in sorted(root.rglob('*')):
    if path.is_symlink():
        print(path.relative_to(root), 'link', os.readlink(path))
    elif path.is_file() and 'dist' in path.parts:
        print(path.relative_to(root), hashlib.sha256(path.read_bytes()).hexdigest())
PY
}
# Negative control: the actual unmapped command must reproduce the named export failure.
if pnpm --dir "$FLYWHEEL_DIR" exec tsx \
  "$FLYWHEEL_DIR/packages/flywheel-comm/src/bin/summary-registry.ts" verify-activation \
  --projects-file "$ROOT/projects.json" --receipt-file "$ROOT/receipt.json" > "$ROOT/unmapped.log" 2>&1; then
  echo 'FAIL: unmapped stale workspace dist unexpectedly passed'; exit 1
fi
cat "$ROOT/unmapped.log"
grep -q 'resolveCodexLeadCapabilities' "$ROOT/unmapped.log"
echo 'PASS: unmapped real verifier fails on missing resolveCodexLeadCapabilities'
# Now poison every fixture workspace dist entry to catch accidental fallback to
# another freshly built workspace package, including future dependency additions.
python3 <<'PY2'
import os
from pathlib import Path
for path in (Path(os.environ['ROOT']) / 'repo/packages').glob('*/dist/**/*'):
    if path.is_file():
        path.write_text('export const staleDist = true;\n')
PY2
snapshot > "$ROOT/before"

if ! summary_registry_activation_preflight > "$ROOT/mapped.log" 2>&1; then
  cat "$ROOT/mapped.log"
  echo 'FAIL: source preflight cannot validate with stale workspace dist'; exit 1
fi
cat "$ROOT/mapped.log"
grep -q '"ok":true' "$ROOT/mapped.log"
echo 'PASS: source preflight and child validator pass with stale workspace dist'
snapshot > "$ROOT/after"
cmp "$ROOT/before" "$ROOT/after"

# The same read-only preflight is used by --dry-run, without install or build.
DRY_RUN=true summary_registry_activation_preflight > "$ROOT/dry-run.log"
grep -q '"ok":true' "$ROOT/dry-run.log"
# Valid JSON with a stale digest must still fail closed.
python3 <<'PY2'
import json, os
from pathlib import Path
path = Path(os.environ['ROOT']) / 'projects.json'
projects = json.loads(path.read_text())
projects[0]['leads'][0]['agentId'] = 'changed-lead'
projects[0]['leads'][0]['match']['labels'] = ['changed-lead']
path.write_text(json.dumps(projects))
PY2
if summary_registry_activation_preflight > "$ROOT/stale.log" 2>&1; then
  echo 'FAIL: stale registry receipt accepted'; exit 1
fi
cat "$ROOT/stale.log"
grep -q 'summary_registry_projection_mismatch' "$ROOT/stale.log"
snapshot > "$ROOT/after-failure"
cmp "$ROOT/before" "$ROOT/after-failure"
echo 'PASS: dry-run and stale-receipt rejection leave dist and dependency links unchanged'
