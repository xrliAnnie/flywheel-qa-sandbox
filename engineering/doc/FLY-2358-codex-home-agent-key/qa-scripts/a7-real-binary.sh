#!/usr/bin/env bash
# FLY-2358 QA A7 — real-machine proof: a KEYED home provisioned by production code
# is a WORKING CODEX_HOME for the real 0.153.2 binary, and two concurrent runners
# on the SAME keyed home both come up.
# Zero prod touch: isolated homes root + isolated source ~/.codex COPY (read-only seed).
set -uo pipefail
ROOT="$(mktemp -d /tmp/f2358a7.XXXX)"          # /tmp so unix socket paths stay < 104 bytes
REPO=/Users/xiaorongli/Dev/flywheel-FLY-2358
EV="${1:-$ROOT/evidence}"; mkdir -p "$EV"
export FLYWHEEL_CODEX_HOMES_ROOT="$ROOT/homes"
export FLYWHEEL_CODEX_SESSION_DIR="$ROOT/sessions"
# read-only seed: copy the host ~/.codex identity, never write to it
SRC="$ROOT/srccodex"; mkdir -p "$SRC/profiles/school" "$SRC/profiles/personal" "$SRC/profiles/business"
cp "$HOME/.codex/auth.json" "$SRC/auth.json"
cp "$HOME/.codex/config.toml" "$SRC/config.toml"
export FLYWHEEL_CODEX_SOURCE_HOME="$SRC"
BIN="$(command -v codex)"

node --input-type=module <<'NODE' > "$EV/a7-provision.txt" 2>&1
import fs from 'node:fs'; import path from 'node:path';
const M='/Users/xiaorongli/Dev/flywheel-FLY-2358/packages/claude-runner/dist/codex-home.js';
const { admitCodexAgentHome, provisionCodexAgentHome, codexAgentHomeDir } = await import(M);
const ID={project:'flywheel',role:'implement'};
const CONTRACT=path.join(process.env.FLYWHEEL_CODEX_HOMES_ROOT,'..','contract.md');
fs.mkdirSync(path.dirname(CONTRACT),{recursive:true}); fs.writeFileSync(CONTRACT,'# qa contract\n');
const WT=path.join(path.dirname(CONTRACT),'wt'); fs.mkdirSync(WT,{recursive:true});
const a=await admitCodexAgentHome({...ID,executionId:'qa-a7-one',requestedAssemblyArm:'superpowers'});
const home=await provisionCodexAgentHome(a.handle,{contractSourcePath:CONTRACT,skillFrameworkMode:'superpowers',trustedProjectPath:WT});
const b=await admitCodexAgentHome({...ID,executionId:'qa-a7-two',requestedAssemblyArm:'superpowers'});
const home2=await provisionCodexAgentHome(b.handle,{contractSourcePath:CONTRACT,skillFrameworkMode:'superpowers',trustedProjectPath:WT});
console.log('HOME='+home);
console.log('SAME_HOME='+(home===home2));
console.log('EXPECTED='+codexAgentHomeDir(ID));
console.log('LEASES='+fs.readdirSync(path.join(home,'.flywheel-leases')).sort().join(','));
console.log('HAS_AUTH='+fs.existsSync(path.join(home,'auth.json')));
console.log('HAS_AGENTS_MD='+fs.existsSync(path.join(home,'AGENTS.md')));
NODE
cat "$EV/a7-provision.txt"
HOME_DIR="$(grep '^HOME=' "$EV/a7-provision.txt" | cut -d= -f2-)"
[ -d "$HOME_DIR" ] || { echo "A7 FAIL: provision produced no home"; exit 1; }

start(){ CODEX_HOME="$HOME_DIR" "$BIN" app-server --remote-control --listen "unix://$ROOT/$1.sock" >"$EV/a7-$1.out" 2>"$EV/a7-$1.err" & echo $!; }
P1=$(start r1); P2=$(start r2)
for i in $(seq 1 60); do [ -S "$ROOT/r1.sock" ] && [ -S "$ROOT/r2.sock" ] && break; sleep 0.25; done
sleep 6
{
  echo "runner1 socket: $([ -S "$ROOT/r1.sock" ] && echo present || echo MISSING)"
  echo "runner2 socket: $([ -S "$ROOT/r2.sock" ] && echo present || echo MISSING)"
  echo "runner1 alive:  $(kill -0 "$P1" 2>/dev/null && echo yes || echo NO)"
  echo "runner2 alive:  $(kill -0 "$P2" 2>/dev/null && echo yes || echo NO)"
  echo "auth/config errors in stderr:"; grep -iE "auth|login|not.?authenticated|config|lock|already|panic" "$EV/a7-r1.err" "$EV/a7-r2.err" | head -8
  echo "keyed home after both started:"; ls -la "$HOME_DIR" | tail -n +2 | awk '{print $NF}' | tr '\n' ' '
  echo
  echo "leases still 2: $(ls "$HOME_DIR/.flywheel-leases" | sort | tr '\n' ',')"
  echo "memories db present: $([ -f "$HOME_DIR/memories_1.sqlite" ] && echo yes || echo no)"
} | tee "$EV/a7-result.txt"
kill "$P1" "$P2" 2>/dev/null; wait 2>/dev/null
echo "--- prod untouched check ---" | tee -a "$EV/a7-result.txt"
{ echo "prod ~/.flywheel/codex-homes/agents exists: $([ -d "$HOME/.flywheel/codex-homes/agents" ] && echo YES-UNEXPECTED || echo no)"
  echo "prod ~/.codex/auth.json mtime: $(stat -f '%Sm' "$HOME/.codex/auth.json")"; } | tee -a "$EV/a7-result.txt"
echo "SANDBOX=$ROOT"
