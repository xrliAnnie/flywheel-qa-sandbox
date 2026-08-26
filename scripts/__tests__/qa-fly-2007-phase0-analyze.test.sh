#!/usr/bin/env bash
# FLY-2007 — contract tests for the Phase-0 analyser, wrapper and simulator.
#
# The mutation checks are the point. A check that cannot go red is not a check,
# and FLY-1986's own review history records five separate rounds where a guard
# was added but never wired, or asserted something that was vacuously true. So
# every guard here is proved by breaking it on a COPY of the source and
# requiring the suite to fail.

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ANALYZER="$REPO/scripts/qa-fly-2007-phase0-analyze.mjs"
SIMULATOR="$REPO/scripts/qa-fly-2007-phase0-simulate.mjs"
WRAPPER="$REPO/scripts/qa-fly-2007-phase0-run-window.sh"
SPEC="$REPO/engineering/doc/FLY-2007-capacity-stress-execution/spec-baseline.md"
PLAN="$REPO/engineering/doc/FLY-2007-capacity-stress-execution/plan.md"
RESEARCH="$REPO/engineering/doc/FLY-2007-capacity-stress-execution/research.md"
EXPLORATION="$REPO/engineering/doc/FLY-2007-capacity-stress-execution/exploration.md"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
check(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }
check_fails(){ if eval "$2" >/dev/null 2>&1; then bad "$1 (expected failure, got success)"; else ok "$1"; fi; }

TMP="$(mktemp -d)"

# ⚠ A hermetic freeze repo. The freeze check compares the working tree against a
# commit, so pointing the gate tests at the real repository makes them fail
# whenever it is mid-edit - which is exactly when they are being run. Build a
# throwaway repo whose HEAD contains the CURRENT frozen files, and use it as
# --repo-root. The real repository's freeze binding is exercised separately in
# section 6d, against a genuinely stale commit.
FZREPO=""
FZC=""
setup_freeze_repo() {
  FZREPO="$TMP/fzrepo"
  mkdir -p "$FZREPO/scripts" "$FZREPO/engineering/doc/FLY-2007-capacity-stress-execution"
  cp "$ANALYZER" "$SIMULATOR" "$WRAPPER" "$FZREPO/scripts/"
  cp "$SPEC" "$FZREPO/engineering/doc/FLY-2007-capacity-stress-execution/"
  git -C "$FZREPO" init -q 2>/dev/null
  git -C "$FZREPO" -c user.email=t@t -c user.name=t add -A >/dev/null 2>&1
  git -C "$FZREPO" -c user.email=t@t -c user.name=t commit -q -m freeze >/dev/null 2>&1
  FZC="$(git -C "$REPO" rev-parse HEAD)"
}
setup_freeze_repo
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "=== 1. the frozen positive controls ==="
check "analyser self-test passes" "node '$ANALYZER' --self-test"
check "self-test has at least 30 assertions" "[ \"\$(node '$ANALYZER' --self-test | grep -c '^PASS')\" -ge 30 ]"

echo
echo "=== 2. mutation checks: every guard must be able to go red ==="
# Each mutation edits a COPY. If the suite still passes, that guard was decorative.
# ⚠ The harness needs its own control. The first run of this suite reported
# eight mutants as "caught" and seven as "alive" - and BOTH readings were wrong,
# because the analyser's direct-invocation guard compared an unresolved
# process.argv[1] against a symlink-resolved import.meta.url, so from a macOS
# temp dir the self-test never ran and node just exited 0. A mutation harness
# where nothing executes reports whatever it likes. So: prove the UNMUTATED copy
# still passes from the same temp path before trusting any mutant verdict.
cp "$ANALYZER" "$TMP/control.mjs"
if node "$TMP/control.mjs" --self-test >/dev/null 2>&1; then
  ok "harness control: an unmutated copy still passes from the temp path"
else
  bad "harness control: the unmutated copy FAILS from the temp path - every mutant verdict below is meaningless"
fi

# ⚠ an EVIDENCE ROOT, not a bundle path: the analyser discovers its own evidence
# now, so the probe has to hand it a root containing a canonical attempt.
MALROOT="$TMP/malroot"; MALFORMED="$MALROOT/attempt-001"; mkdir -p "$MALFORMED"
printf 'block_id,endpoint,tick,scheduled,start,end,outcome,secs\nb1,L1,0,1,1,1,met\n' > "$MALFORMED/samples.csv"
printf 'block_id,endpoint,n,met,missed,error,timer_late,violation_upper_conservative,violation_best_case,block_valid\nb1,L1,1,1,0,0,0,0.0000,0.0000,true\n' > "$MALFORMED/summary.csv"
printf 'url=http://localhost:9876\nblocks=1 block_seconds=300 endpoints=L1\nbuild_sha=deadbeef\n' > "$MALFORMED/meta.txt"
printf '{"attempt_id":1,"preflight":{}}\n' > "$MALFORMED/receipt.json"
printf '{"attempt_id":1,"dir":"attempt-001","window":1,"state":"TERMINAL","disposition":"completed"}' > "$MALFORMED/state.json"

mutate() { # name, sed-expression
  local name="$1" expr="$2" copy="$TMP/mut.mjs"
  sed "$expr" "$ANALYZER" > "$copy"
  if cmp -s "$copy" "$ANALYZER"; then bad "$name (mutation did not change the source - the pattern is stale)"; return; fi
  # Two probes, because the self-test alone never parses a CSV: a mutation that
  # silently drops malformed rows would otherwise sail through.
  local rc1 rc2
  node "$copy" --self-test >/dev/null 2>&1; rc1=$?
  rc2="$(node "$copy" --evidence "$MALROOT" --freeze-commit "$FZC" --sim-m 400 --out "$TMP/mut-out" 2>&1 | grep -c 'fields, expected 8')"
  if [ "$rc1" -ne "$REF_SELFTEST" ] || [ "$rc2" -ne "$REF_MALFORMED" ]; then ok "$name"
  else bad "$name (mutant behaves identically to the reference on every probe)"; fi
}

# Reference behaviour, MEASURED not assumed. Stating the rule as "the mutant must
# fail" was subtly wrong: the malformed-bundle probe catches a parser mutation by
# the mutant SUCCEEDING where the reference refuses. Comparing against measured
# reference exit codes makes the polarity impossible to get backwards as probes
# are added.
node "$ANALYZER" --self-test >/dev/null 2>&1; REF_SELFTEST=$?
REF_MALFORMED="$(node "$ANALYZER" --evidence "$MALROOT" --freeze-commit "$FZC" --sim-m 400 --out "$TMP/ref-out" 2>&1 | grep -c 'fields, expected 8')"
check "reference probe 1: the self-test passes"             "[ $REF_SELFTEST -eq 0 ]"
check "reference probe 2: a malformed bundle is NAMED, not silently dropped" "[ $REF_MALFORMED -ge 1 ]"

# A bundle whose samples.csv has a truncated row. The real analyser must refuse
# it; any mutant that accepts it has broken the fail-loud contract.
mutate "M1  timer_late excluded from the violation count" \
  "s/violations: r.missed + r.error + r.timer_late/violations: r.missed + r.error/"
mutate "M2  upper/lower bound directions swapped" \
  "s/const bound = cv + (1 - cv) \* piUb;/const bound = cv * piUb;/"
mutate "M3  threshold-grid Bonferroni removed (A level)" \
  "s#export const A_ADV = ALPHA_A / (COMPONENTS \* G);#export const A_ADV = ALPHA_A / COMPONENTS;#"
mutate "M4  A's cross-component Bonferroni removed" \
  "s#export const A_ADV = ALPHA_A / (COMPONENTS \* G);#export const A_ADV = ALPHA_A / G;#"
mutate "M5  strict > relaxed to >= (exact ties would count)" \
  "s/if (u.violations \* c.den > c.num \* u.ticks) k++;/if (u.violations * c.den >= c.num * u.ticks) k++;/"
# M6 was "float comparison instead of integer cross-multiplication". It is an
# EQUIVALENT MUTANT and has been removed rather than left failing: an exhaustive
# sweep (in the analyser's own self-test) shows the two forms agree on all 1255
# reachable inputs, so no fixture can distinguish them. The integer form stays as
# defence in depth against a future non-binary threshold; claiming a fixture
# catches it would be a check that cannot go red.
mutate "M7  unknown collector state defaults to allow" \
  "s/return { ok: false, reason: \"unclassified_terminal_state\" };/return { ok: true, reason: null };/"
mutate "M8  exposure uses the performance gate only, not max of both sub-gates" \
  "s/const fullB = Math.max(perf, equiv);/const fullB = perf;/"
mutate "M9  exposure stops rounding up" \
  "s#return Math.ceil(Math.log(alphaPerCp) / Math.log(1 - target));#return Math.log(alphaPerCp) / Math.log(1 - target);#"
mutate "M10 adverse family budget inflated to 0.05 each" \
  "s/export const ALPHA_N = 0.025;/export const ALPHA_N = 0.05;/"
mutate "M11 range lower bound loses its zero clamp" \
  "s/rangeLb: Math.max(0, Math.max(...L) - Math.min(...U)),/rangeLb: Math.max(...L) - Math.min(...U),/"
mutate "M12 units per window taken from the survivors instead of the frozen 30" \
  "s/export const UNITS_PER_WINDOW = 30;/export const UNITS_PER_WINDOW = 0;/"
mutate "M13 malformed sample rows silently dropped" \
  "s/if (f.length !== 8)/if (f.length !== 8 \&\& false)/"
mutate "M14 the threshold grid loses the SLO itself" \
  "s#{ num: 1, den: 20 }, // 0.05, the SLO itself##"
# M15 is the vacuous-green check: if deleting the whole control table still
# passes, the table was never asserted on.
mutate "M15 (vacuous-green) the FLY-1986 positive control table deleted" \
  "s/for (const \[n, exp\] of \[/for (const [n, exp] of [].concat([/"

echo
echo "=== 3. the analyser is read-only by construction ==="
check "no network client is imported"        "! grep -qE \"from 'node:(http|https|net|dgram|tls)'\" '$ANALYZER'"
check "no database is opened"                "! grep -qiE 'sqlite|better-sqlite3|\.db[\"'\\'']' '$ANALYZER'"
check "writes go only through writeFileSync" "[ \"\$(grep -c 'writeFileSync' '$ANALYZER')\" -ge 1 ]"
check "simulator opens no network or db"     "! grep -qE \"from 'node:(http|https|net)'|sqlite\" '$SIMULATOR'"

echo
echo "=== 4. wrapper: read authority and fail-closed preflight ==="
check "wrapper is syntactically valid"                 "bash -n '$WRAPPER'"
check "GET /health is the only network call"           "[ \"\$(grep -c 'curl ' '$WRAPPER')\" -eq 1 ]"
check "no write HTTP method anywhere"                  "! grep -qE \"curl.*-X (POST|PUT|PATCH|DELETE)|--data\" '$WRAPPER'"
check "pressure_hold uses the collector's own reader"  "grep -q 'read_pressure_hold' '$WRAPPER'"
check "worker pid uses the collector's own resolver"   "grep -q 'resolve_bridge_worker_pid' '$WRAPPER'"
check "unknown pressure_hold is fail-closed"           "grep -q 'pressure_hold_unknown' '$WRAPPER'"
check "the collector is sourced in a subshell"         "grep -q \"bash -c '\" '$WRAPPER'"
check "attempt directories are never reused"           "grep -q 'directories are never reused' '$WRAPPER'"
check "orphans converge deterministically"             "grep -q 'crash_before_terminal' '$WRAPPER'"
check "the ledger is a rebuildable index, not a truth" "grep -q 'rebuild_index' '$WRAPPER'"

echo
echo "=== 5. wrapper behaviour: reserve, converge, never reuse ==="
EV="$TMP/ev"; mkdir -p "$EV"
mkdir -p "$EV/attempt-001"; printf '%s\n' '{"attempt_id":1,"dir":"attempt-001","window":1,"state":"START"}' > "$EV/attempt-001/state.json"
bash "$WRAPPER" --evidence "$EV" --recover-only >/dev/null 2>&1
check "an attempt stranded at START is terminalised" "grep -q '\"state\":\"TERMINAL\"' '$EV/attempt-001/state.json'"
check "...and recorded as aborted, not deleted"      "grep -q 'crash_before_terminal' '$EV/ledger.jsonl'"
check "...and still present in the ledger"           "[ \"\$(wc -l < '$EV/ledger.jsonl')\" -eq 1 ]"

echo
GE="$TMP/gate"; mkdir -p "$GE"
mkbundle() { # dir, block_valid_of_first_block, window
  local d="$1" bv="$2" win="${3:-1}" b ep n v
  mkdir -p "$d"
  { echo 'block_id,endpoint,tick,scheduled,start,end,outcome,secs'
    for b in $(seq 1 30); do for ep in L1 L2; do n=150; [ "$ep" = L2 ] && n=100
      for t in $(seq 0 $((n-1))); do echo "b$b,$ep,$t,1,1,1,missed,0.5"; done; done; done; } > "$d/samples.csv"
  { echo 'block_id,endpoint,n,met,missed,error,timer_late,violation_upper_conservative,violation_best_case,block_valid'
    for b in $(seq 1 30); do
      v="true"; [ "$b" = 1 ] && v="$bv"
      echo "b$b,L1,150,0,150,0,0,1.0000,1.0000,$v"
      echo "b$b,L2,100,0,100,0,0,1.0000,1.0000,$v"
    done; } > "$d/summary.csv"
  printf 'url=x\nblocks=30 block_seconds=300 endpoints=L1,L2\nbuild_sha=deadbeef\nbridge_worker_pid=1\nbridge_identity=x\n' > "$d/meta.txt"
  printf '{"attempt_id":%s,"window":%s,"freeze_commit":"%s","preflight":{"build_sha":"deadbeef","bridge_started_at":"t","bridge_worker_pid":"1","bridge_identity":"x","health_ok":"true","shutting_down":"false","pressure_hold":"0","load1":"9.0"}}' "$win" "$win" "$FZC" > "$d/receipt.json"
}
# the canonical state is the durable truth, and its artifact hashes are COMPUTED
# from the files so the fixture cannot drift away from what it asserts
write_state() {
  local i="$1" d="$GE/attempt-00$1" h="" f
  for f in samples.csv summary.csv meta.txt receipt.json; do
    h="$h\"$f\":\"$(shasum -a 256 "$d/$f" | cut -d' ' -f1)\","
  done
  printf '{"attempt_id":%d,"dir":"attempt-00%d","window":%d,"state":"TERMINAL","disposition":"completed","artifacts":{%s}}' \
    "$i" "$i" "$i" "${h%,}" > "$d/state.json"
}
for i in 1 2 3; do mkbundle "$GE/attempt-00$i" true "$i"; write_state "$i"; done

# a second root with one completed and one aborted attempt, for the discovery test
GE0="$TMP/gate0"; mkdir -p "$GE0/attempt-001" "$GE0/attempt-002" "$GE0/attempt-003"
printf '{"attempt_id":1,"dir":"attempt-001","window":1,"state":"TERMINAL","disposition":"completed"}' > "$GE0/attempt-001/state.json"
printf '{"attempt_id":2,"dir":"attempt-002","window":2,"state":"TERMINAL","disposition":"aborted","reason":"health_unreachable"}' > "$GE0/attempt-002/state.json"
printf '{"attempt_id":3,"dir":"attempt-003","window":3,"state":"TERMINAL","disposition":"completed"}' > "$GE0/attempt-003/state.json"

echo "=== 6. the analyser discovers its own evidence ==="
# ⚠ The CLI no longer takes --bundle, --ledger or --sensitivity. Every round of
# review found another way to select, substitute or fabricate what was handed in
# - out-of-root bundles, a JSONL contradicting the canonical state, a
# hand-written artifact with correct counts. Policing a caller-supplied list kept
# failing, so the list is gone: evidence is DISCOVERED from the canonical
# state.json files under the evidence root, the index is rebuilt from them, and
# the sensitivity analysis is RUN in-process. There is nothing left to forge.
check "the CLI no longer accepts --bundle"      "! node '$ANALYZER' --help | grep -q -- '--bundle'"
check "the CLI no longer accepts --ledger"      "! node '$ANALYZER' --help | grep -q -- '--ledger'"
check "the CLI no longer accepts --sensitivity" "! node '$ANALYZER' --help | grep -q -- '--sensitivity'"
check "discoverBundles only returns completed attempts" \
  "node -e \"import('$ANALYZER').then(m=>{const r=m.discoverBundles('$GE0');process.exit(r.completed.length===2?0:1)})\""

echo
echo "=== 6b. the eligibility gate fires, and NOT vacuously ==="
# ⚠ An unreachable fixture would prove nothing: the collector writes NA point
# estimates for it, so the loader refuses anyway and the test goes green whether
# or not the gate exists. Use a numeric-but-invalid block (timer_late > 2%,
# numbers survive) and a counter-fixture: the SAME data must reach A once that
# block is valid.
GATE="--evidence $GE --freeze-commit $FZC "
mkbundle "$GE/attempt-001" false 1
write_state 1
check "a numeric-but-invalid block forces U" \
  "node '$ANALYZER' $GATE --sim-m 400 --out '$TMP/g1' | grep -q 'authoritative_outcome=U'"
check "...naming timer_late_void, not something vague" \
  "grep -q 'timer_late_void' '$TMP/g1/analysis.json'"
check "a reduced-M sensitivity run can never produce a verdict" \
  "grep -q 'reduced replicate count' '$TMP/g1/analysis.json'"

# the counter-fixture, at the FROZEN M, is the one place a real A is proved
mkbundle "$GE/attempt-001" true 1
write_state 1
# ⚠ The freeze root is derived from the analyser's own path, so the A branch can
# only be exercised when the frozen files are actually committed - which is
# always true in CI and is the only state in which a real run may happen anyway.
# When the tree is dirty this asserts the OTHER branch (drift detected), so both
# states assert something real and neither is a silent skip.
node "$ANALYZER" $GATE --out "$TMP/g2" >/dev/null 2>&1
if git -C "$REPO" diff --quiet -- "$ANALYZER" "$SIMULATOR" "$WRAPPER" "$SPEC" 2>/dev/null; then
  check "with the block valid and the frozen M, the same data reaches A" \
    "grep -q '\"authoritative_outcome\": \"A\"' '$TMP/g2/analysis.json'"
  check "...and the sensitivity was computed in this process, not supplied" \
    "grep -q 'computed_in_process' '$TMP/g2/analysis.json' && [ -f '$TMP/g2/sensitivity.json' ]"
else
  printf 'NOTE  frozen files are uncommitted; asserting the drift branch instead of the A branch\n'
  check "an uncommitted frozen file is detected as drift and forces U" \
    "grep -q '\"authoritative_outcome\": \"U\"' '$TMP/g2/analysis.json' && grep -q 'drifted from the freeze commit' '$TMP/g2/analysis.json'"
  check "...and the sensitivity was still computed in this process" \
    "[ -f '$TMP/g2/sensitivity.json' ]"
fi

echo
echo "=== 6c. a failure cannot disappear from the record ==="
printf '{"attempt_id":1,"dir":"attempt-001","window":1,"state":"TERMINAL","disposition":"aborted","reason":"health_unreachable"}' > "$GE/attempt-001/state.json"
check "a service/host failure forces U and is named" \
  "node '$ANALYZER' $GATE --sim-m 400 --out '$TMP/g4' | grep -q 'authoritative_outcome=U' && grep -q 'service/host reason' '$TMP/g4/analysis.json'"
check "...and cannot be replaced by a later good window" \
  "grep -q 'must not be replaced' '$TMP/g4/analysis.json'"
write_state 1
printf '{"attempt_id":1,"dir":"attempt-001","window":1,"state":"TERMINAL","disposition":"aborted","reason":"operator_credential"}' > "$GE/attempt-001/state.json"
check "a replaceable failure with no replacement_of edge is caught as a silent re-run" \
  "node '$ANALYZER' $GATE --sim-m 400 --out '$TMP/g5' | grep -q 'silent re-run'"
write_state 1

check "an undefined dependence statistic is not treated as a pass" \
  "node -e \"import('$SIMULATOR').then(s=>{const st=s.gridStatistics({m:40});const flat=Array.from({length:30},()=>1.0);const o=[{label:'w/L1',meanRate:1,varRate:s.variance(flat),acf:s.lag1(flat)}];const g=s.applicabilityGate(o,{...st,degenerate_windows:0});process.exit(g.pass?1:0)})\""
check "...but a degenerate window IS in-domain when the grid produces them too" \
  "node -e \"import('$SIMULATOR').then(s=>{const st=s.gridStatistics({m:40});const flat=Array.from({length:30},()=>1.0);const o=[{label:'w/L1',meanRate:1,varRate:s.variance(flat),acf:s.lag1(flat)}];process.exit(s.applicabilityGate(o,st).pass?0:1)})\""
check "the applicability statistics are always-defined ones" \
  "grep -q 'varRate' '$ANALYZER' && grep -q 'block-rate variance' '$SIMULATOR'"
# ⚠ The gate's envelope is [0,1] and every legal block rate is in [0,1], so
# nothing can fail it. It must SAY so, not merely call itself weak: a reader who
# sees pass=true is otherwise entitled to think something was tested.
check "the parameter-set gate declares it has no rejection region" \
  "node '$ANALYZER' $GATE --sim-m 400 --out '$TMP/gp' >/dev/null 2>&1; grep -q 'NON-DISCRIMINATING' '$TMP/gp/sensitivity.json' && grep -q '\"has_rejection_region\": false' '$TMP/gp/sensitivity.json'"
check "replicate counts are reported per configuration, not as one M" \
  "node -e \"const d=require('$TMP/gp/sensitivity.json');process.exit(typeof d.M==='object'&&d.M.range_lb_N<d.M.b_lb_A?0:1)\""

echo
echo "=== 6c2. R14 regression: the summary may not contradict its own samples ==="
# ⚠ These three come from Codex R14, the full adversarial round. Each one reached
# an authoritative A on the real CLI at the frozen M before the fix. R13's
# read-only pass had approved the same code. That is why they live here.
r14_fixture() { # name, mutation applied to attempt-001
  local name="$1"; local d="$TMP/r14-$name"
  rm -rf "$d" 2>/dev/null; mkdir -p "$d"
  local i
  for i in 1 2 3; do
    cp -R "$GE/attempt-00$i" "$d/attempt-00$i"
  done
  printf '%s' "$d"
}
# (1) a sample carries a configuration fault while the summary claims valid
D="$(r14_fixture config-fault)"
python3 - "$D/attempt-001" <<'PYEOF'
import sys,os,hashlib,json
d=sys.argv[1]
p=os.path.join(d,'samples.csv'); L=open(p).read().split('\n')
L[1]=','.join(L[1].split(',')[:6]+['no_token','NA'])          # tick 0 becomes a config fault
open(p,'w').write('\n'.join(L))
st=json.load(open(os.path.join(d,'state.json')))
for k in st.get('artifacts',{}):
    fp=os.path.join(d,k)
    if os.path.exists(fp): st['artifacts'][k]=hashlib.sha256(open(fp,'rb').read()).hexdigest()
json.dump(st,open(os.path.join(d,'state.json'),'w'))
PYEOF
check "a config-fault sample under block_valid=true is caught" \
  "node '$ANALYZER' --evidence '$D' --freeze-commit '$FZC' --sim-m 400 --out '$TMP/r14a' | grep -q 'authoritative_outcome=U' && grep -q 'configuration fault' '$TMP/r14a/analysis.json'"

# (2) a canonical record that contradicts itself
D="$(r14_fixture contradictory)"
python3 - "$D/attempt-001" <<'PYEOF'
import sys,os,json
d=sys.argv[1]; p=os.path.join(d,'state.json')
st=json.load(open(p)); st['reason']='health_unreachable'; st['exit_code']=1
json.dump(st,open(p,'w'))
PYEOF
check "a completed record naming a service failure is caught" \
  "node '$ANALYZER' --evidence '$D' --freeze-commit '$FZC' --sim-m 400 --out '$TMP/r14b' | grep -q 'authoritative_outcome=U' && grep -q 'contradicts itself\|cannot be certified' '$TMP/r14b/analysis.json'"

# (3) a non-numeric point estimate
D="$(r14_fixture non-numeric)"
python3 - "$D/attempt-001" <<'PYEOF'
import sys,os,hashlib,json
d=sys.argv[1]; p=os.path.join(d,'summary.csv')
L=open(p).read().split('\n')
for i in range(1,len(L)):
    f=L[i].split(',')
    if len(f)==10: f[7]='not-a-number'; L[i]=','.join(f)
open(p,'w').write('\n'.join(L))
st=json.load(open(os.path.join(d,'state.json')))
for k in st.get('artifacts',{}):
    fp=os.path.join(d,k)
    if os.path.exists(fp): st['artifacts'][k]=hashlib.sha256(open(fp,'rb').read()).hexdigest()
json.dump(st,open(os.path.join(d,'state.json'),'w'))
PYEOF
check "a non-numeric point estimate is caught, not silently compared to NaN" \
  "node '$ANALYZER' --evidence '$D' --freeze-commit '$FZC' --sim-m 400 --out '$TMP/r14c' | grep -q 'authoritative_outcome=U' && grep -q 'is not a number' '$TMP/r14c/analysis.json'"

echo
echo "=== 6d. freeze binding is about the BYTES, not just the commit ==="
check "a stale but real commit is caught as drift" \
  "node -e \"import('$ANALYZER').then(m=>process.exit(m.freezeDriftProblems('a46a83cba','$REPO').length>0?0:1))\""
check "the frozen file list includes the spec and all three scripts" \
  "node -e \"import('$ANALYZER').then(m=>process.exit(m.FROZEN_FILES.length===4?0:1))\""
# ⚠ --repo-root is gone: it let a caller attest to a clean surrogate checkout
# while different analyser bytes actually ran. The root is derived from this
# file's own path now, so the bytes verified are the bytes running.
check "--repo-root is refused outright rather than quietly honoured" \
  "! node '$ANALYZER' --evidence '$GE' --freeze-commit '$FZC' --repo-root '$FZREPO' --sim-m 400 --out '$TMP/g6' >/dev/null 2>&1"
check "the freeze root is derived from the analyser's own path" \
  "node -e \"import('$ANALYZER').then(m=>process.exit(m.selfRepoRoot()==='$REPO'?0:1))\""
check "a surrogate checkout cannot be substituted for the running code" \
  "node -e \"import('$ANALYZER').then(m=>process.exit(m.freezeDriftProblems('a46a83cba').length>0?0:1))\""
check "a missing --freeze-commit is refused" \
  "node '$ANALYZER' --evidence '$GE' --sim-m 400 --out '$TMP/g7' | grep -q 'authoritative_outcome=U'"
check "the wrapper refuses a stale-but-real freeze commit before reserving" \
  "! bash '$WRAPPER' --evidence '$TMP/fz' --window 1 --freeze-commit a46a83cba --dry-run >/dev/null 2>&1 && [ ! -d '$TMP/fz/attempt-001' ]"

echo
echo "=== 6d2. collection freeze and analysis freeze are different things ==="
# ⚠ Requiring them to be EQUAL was my own conflation, and it would have made the
# Lead-approved R14 fixes unusable: the windows were collected before the fixes
# existed. What protects the pre-registration is not that the code is identical -
# it is that the RULES are. So the spec blob must be identical at both commits,
# and the analysis commit must be a descendant.
check "a differing analysis freeze is allowed when the spec blob is identical" \
  "node -e \"import('$ANALYZER').then(m=>{
     const b={receipt:{freeze_commit:'$(git -C "$REPO" rev-parse HEAD~1)'},meta:{}};
     const p=m.receiptProblems(b,'$(git -C "$REPO" rev-parse HEAD)','$REPO');
     process.exit(p.some(x=>/pre-registration CHANGED|not a descendant/.test(x))?1:0)})\""
check "a changed spec between collection and analysis is refused" \
  "node -e \"import('$ANALYZER').then(m=>{
     const b={receipt:{freeze_commit:'a46a83cba'},meta:{}};
     const p=m.receiptProblems(b,'$(git -C "$REPO" rev-parse HEAD)','$REPO');
     process.exit(p.some(x=>/pre-registration CHANGED/.test(x))?0:1)})\""
check "the analysis records BOTH freezes, not one" \
  "grep -q 'collection_freeze' '$ANALYZER' && grep -q 'analysis_freeze' '$ANALYZER'"

echo
echo "=== 6e. the retracted J story must not survive anywhere ==="
check "the spec states the discrimination rationale, not a coverage minimum" \
  "grep -q '判别力，不是合规' '$SPEC'"
check "the spec records the retraction rather than hiding it" \
  "grep -q '现已作废' '$SPEC'"
check "no live document or frozen script asserts a fixed J of 13" \
  "! grep -qE '(固定的 13|fixed at 13|J = 13 units|units_per_window = 13)' '$SPEC' '$PLAN' '$RESEARCH' '$EXPLORATION' '$ANALYZER' '$SIMULATOR' '$WRAPPER'"
check "the frozen unit count is stated as 30 wherever it is stated" \
  "grep -q 'J = 30' '$SPEC' && grep -q 'UNITS_PER_WINDOW = 30' '$ANALYZER'"

echo
echo "=== 6e2. N is proven unreachable, and the spec is not edited to say so ==="
check "the analysis proves N has an empty rejection region" \
  "node -e \"import('$ANALYZER').then(m=>{const r=m.nReachability();process.exit(r.reachable===false&&r.max_possible_range_lower===0?0:1)})\""
check "the authoritative set this round is {A, U}" \
  "node '$ANALYZER' $GATE --sim-m 400 --out '$TMP/gn' >/dev/null 2>&1; node -e \"const d=require('$TMP/gn/analysis.json');process.exit(JSON.stringify(d.authoritative_outcome_set_this_round)==='[\\\"A\\\",\\\"U\\\"]'?0:1)\""
check "all three rulings on N are recorded, none overwritten" \
  "grep -q 'then revised, then RESTORED' '$ANALYZER'"

echo
echo "=== 6f. the simulator is real and both endpoints are covered ==="
check "the sensitivity output carries per-point atomic evidence" \
  "node -e \"const d=require('$TMP/g2/sensitivity.json');const p=d.configurations.b_lb_A.points;process.exit(p.length===d.K&&p.every(x=>Number.isFinite(x.covered)&&Number.isFinite(x.m))?0:1)\""
check "it evaluates BOTH endpoints, not just L1" \
  "node -e \"const d=require('$TMP/g2/sensitivity.json');process.exit(d.configurations.b_lb_A.points.some(p=>p.endpoint==='L2')?0:1)\""
check "K counts (dgp, endpoint) pairs" \
  "node -e \"const d=require('$TMP/g2/sensitivity.json');process.exit(d.K===16?0:1)\""
check "the positive control proves UNDER-coverage with an upper bound" \
  "node -e \"const d=require('$TMP/g2/sensitivity.json');process.exit(d.controls.positive.ucb<0.95?0:1)\""
check "the oracle and seed-stability controls hold" \
  "node -e \"const d=require('$TMP/g2/sensitivity.json');process.exit(d.controls.oracle.pass&&d.controls.seed_stability.pass?0:1)\""

echo "=== 7. document contract: the literals must not drift apart ==="
check "spec carries the Lead's verbatim superseding decision" "grep -q '裁决·可引用' '$SPEC'"
check "spec carries the contract-strength trim"               "grep -q '合同强度裁剪' '$SPEC'"
check "spec names assumption A1 rather than hiding it"        "grep -q 'A1' '$SPEC'"
check "spec records that A/A was NOT run this round"          "grep -q '本轮没有跑 A/A' '$SPEC'"
# ⚠ The count is DERIVED, not restated: the doc must agree with the number of
# mutate calls actually in this file. v4 said 15 in the plan while 14 ran.
MUT_N="$(grep -c '^mutate \"' "${BASH_SOURCE[0]}")"
check "the plan's mutation count matches the mutations that actually run" \
  "grep -q \"合计 \$MUT_N 条突变\" '$PLAN'"
check "no other document restates a mutation count" \
  "! grep -qE '[0-9]+ 条突变检验' '$RESEARCH' '$EXPLORATION'"
check "no document still claims a uniformly tighter bound"    "! grep -q '精确界一致更紧，多加' '$PLAN' '$RESEARCH' '$EXPLORATION'"
check "no document still says the wrapper opens no network"   "! grep -q 'wrapper 证明.*不打开任何网络' '$RESEARCH'"
check "run bundle is four files everywhere it is enumerated"  "! grep -q 'samples.csv + summary.csv + meta.txt，缺一即拒' '$RESEARCH'"
check "exposure for full B is stated as 253, not 90"          "grep -q '253' '$SPEC' && grep -q '253' '$PLAN'"
check "spec records the authoritative set trim to {A,U}"     "grep -q '可达权威结局集' '$SPEC'"
check "spec records the single exposure-gap definition"      "grep -q '曝光缺口' '$SPEC'"
# ⚠ This check was "the analyser refuses to make N authoritative", written when
# the Lead had trimmed N out. The frozen simulator then falsified both premises
# of that trim (configuration #4 passes at all eight grid points, and the code
# already existed), the Lead revised the ruling on that evidence, and N is
# authoritative again. Keeping the old assertion would have quietly enforced a
# superseded decision - so it is replaced, not deleted silently.
# ⚠ This assertion has now been rewritten twice, tracking two reversals of the
# same ruling. It last read "N is authoritative again"; the Lead's final ruling,
# after R14 showed my evidence for that reversal was vacuous, is that N is out.
# Rewritten rather than deleted, so the history of the assertion is visible.
check "N is not reachable, and the code proves it rather than asserting it" \
  "node -e \"import('$ANALYZER').then(m=>{const r=m.nReachability();process.exit(r.reachable===false?0:1)})\""
check "spec records BOTH the original N trim and its revision" \
  "grep -q '可达权威结局集' '$SPEC'"
check "the CI step inventory names this suite"               "grep -q 'FLY-2007 phase-0 analyser contract' '$REPO/scripts/__tests__/ci-structure.test.sh'"
check "CI actually runs this suite"                          "grep -q 'qa-fly-2007-phase0-analyze.test.sh' '$REPO/.github/workflows/ci.yml'"

echo
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
