/**
 * FLY-1987 — the ONE pure derivation used by both derive.mjs and aggregate.mjs.
 *
 * R5 finding 2: a validator that only checks labels against each other cannot tell a
 * mutated ledger from a real one. So aggregate.mjs re-runs THIS module over data/raw and
 * compares field-for-field. There is exactly one implementation; there is no second
 * "checking" copy that could drift from the producing copy.
 */
import fs from 'node:fs';

export const WIN_FROM = '2026-08-20T00:00:00Z';
export const WIN_TO   = '2026-08-22T00:00:00Z';        // half-open [FROM, TO)

// ---- the exact CI job graph (ci.yml). Exact strings, not prefixes: R5 finding 6 showed
// ---- a forged "Script Tests forged substitute" satisfied a startsWith()-based predicate.
export const UNIT_JOBS = [
  'Unit (teamlead 1 of 3)', 'Unit (teamlead 2 of 3)', 'Unit (teamlead 3 of 3)',
  'Unit (heavy)', 'Unit (light)',
];
export const SCRIPT_JOBS = [
  'Script Tests 1/2 — cmux/session (shell suites)',
  'Script Tests 2/2 — fleet/setup/packaging (shell suites)',
];
export const PAYLOAD_JOB  = 'NPM payload distribution (endpoint + release pipeline)';
export const CLASSIFY_JOB = 'Classify CI scope';
export const QUICK_GATE   = 'Quick Gate (build + typecheck + lint)';
export const CI_OK        = 'CI OK';
export const MATRIX_SENTINEL = 'Unit (${{ matrix.name }})';   // a skipped matrix collapses to this
export const HEAVY_JOBS = [...UNIT_JOBS, ...SCRIPT_JOBS, PAYLOAD_JOB];
/**
 * Every job name this snapshot is allowed to contain. An unrecognised name means either the CI
 * job graph changed (in which case the whole analysis is about a different graph and must not be
 * silently reprinted) or the snapshot was altered. R6 finding 6: renaming one job moved the
 * §1.3.1 / §8 figures without changing any ledger field, so nothing else caught it.
 */
export const KNOWN_JOB_NAMES = [
  ...HEAVY_JOBS, CLASSIFY_JOB, QUICK_GATE, CI_OK, MATRIX_SENTINEL,
  '🚀 CI + Merge',                 // Ship on :cool: Comment
  'Build + publish beta payload',  // Payload Beta Release
];
// the heavy "families" — any name that looks like one of these but is not an exact member
// is a topology we do not recognise, and must never certify a baseline
const looksHeavy = n => n.startsWith('Unit (') || n.startsWith('Script Tests') ||
                        n.startsWith('NPM payload');

export const DOC_PREFIXES  = ['doc/', 'product/doc/', 'engineering/doc/', 'content/doc/'];
export const SUFFIX_CURRENT = ['.md','.markdown','.mmd','.html','.htm','.svg','.png','.jpg',
                               '.jpeg','.gif','.webp','.avif','.pdf'];
export const SUFFIX_P0_ADDS = ['.txt','.csv','.log','.out','.jsonl','.wav','.mp3','.m4a','.ogg',
                               '.mp4','.webm','.vtt','.srt'];

export const LEDGER_HEADER = [
  'run_id','run_attempt','attempt_at','workflow','event','conclusion','branch','commit_label',
  'billed_min','carried_min','fast_path','is_full_green','build_steps','dup_build_sec',
  'p3_billed_min','bucket','bucket_reason','p1_baseline',
];

const secs = (s, c) => { if (!s || !c) return 0; const d = (new Date(c) - new Date(s)) / 1000; return d > 0 ? d : 0; };
// GitHub bills each job rounded up to the whole minute; a skipped job bills nothing.
export const billable = j => (j.conclusion === 'skipped' ? 0 : Math.ceil(secs(j.started_at, j.completed_at) / 60));

export const commitLabel = s => {
  if (!s) return 'unknown_non_pr';
  if (/^chore\(progress\)/.test(s)) return 'chore_progress';
  if (/^docs?[:(]/.test(s))         return 'docs';
  if (/^(test|chore|ci|style)[:(]/.test(s)) return 'test_chore_ci';
  if (/^(feat|fix|perf|refactor)[:(]/.test(s)) return 'code';
  return 'other';
};

const jsonl = (raw, f) => fs.readFileSync(`${raw}/${f}`, 'utf8').split('\n')
  .filter(l => l.trim()).map(l => JSON.parse(l));

/**
 * R6 finding 1 — "re-run failed jobs" carries the ALREADY-SUCCESSFUL jobs forward into the new
 * attempt as fresh records (new `job_id`!) that repeat the ORIGINAL start/end timestamps.
 * Those are not new physical executions and GitHub does not bill them again. `job_id` cannot
 * discriminate (all 5,019 records in this snapshot have distinct ids); identical
 * (name, started_at, completed_at) inside one run can — a genuinely re-executed job cannot have
 * byte-identical start AND end. So: bill a physical execution once, at its FIRST appearance.
 */
const physKey = j => `${j.name}|${j.started_at}|${j.completed_at}`;

/**
 * The classifier's fast path, per ATTEMPT.
 * R5 finding 1: "payload job skipped" is NOT the classifier's decision — payload also skips
 * when `classify` itself fails/cancels, because it carries `needs: [classify]`. Requiring a
 * SUCCESSFUL classify in the same attempt separates a real `no_code=true` from a cascade.
 */
const fastPath = jobs =>
  jobs.some(j => j.name === CLASSIFY_JOB && j.conclusion === 'success') &&
  jobs.some(j => j.name === PAYLOAD_JOB  && j.conclusion === 'skipped');

/** A qualifying P1 baseline: the exact heavy inventory green plus `CI OK`, in ONE attempt. */
const fullGreen = (jobs, run) => {
  if (run.name !== 'CI' || run.event !== 'pull_request') return false;
  if (jobs.some(j => j.name === MATRIX_SENTINEL)) return false;            // matrix collapsed => skipped
  // R6 finding 3: counting DISTINCT NAMES loses multiplicity — a second, FAILED copy of an
  // expected heavy job disappeared into the Set and the attempt still certified green.
  // Count records: each of the 8 heavy names must appear EXACTLY once and be success.
  const heavy = jobs.filter(j => looksHeavy(j.name));
  for (const j of heavy) if (!HEAVY_JOBS.includes(j.name)) return false;   // forged / unknown heavy name
  if (heavy.length !== HEAVY_JOBS.length) return false;                    // duplicate or missing record
  for (const n of HEAVY_JOBS) {
    const recs = heavy.filter(j => j.name === n);
    if (recs.length !== 1 || recs[0].conclusion !== 'success') return false;
  }
  const ciOk = jobs.filter(j => j.name === CI_OK);
  if (ciOk.length !== 1 || ciOk[0].conclusion !== 'success') return false;  // exactly one green CI OK
  // the topology that makes CI OK meaningful must be present exactly once each
  for (const n of [CLASSIFY_JOB, QUICK_GATE]) {
    if (jobs.filter(j => j.name === n).length !== 1) return false;
  }
  return true;
};

/**
 * Duplicate build work, from the REAL `Build` step (R5 finding 3). Keep the largest build as the
 * one producer; the rest is duplicate. MEASURED duration.
 */
const dupBuildSec = jobs => {
  const b = jobs.map(j => j.build_step_sec || 0).filter(v => v > 0).sort((x, y) => y - x);
  return b.length <= 1 ? 0 : b.slice(1).reduce((a, v) => a + v, 0);
};

/**
 * What removing those duplicate builds would change on the BILL.
 * R6 finding 4: GitHub rounds EACH JOB up to a whole minute, so `dup_seconds / 60` is not an
 * upper bound — shaving 2s off a 61s job saves a whole billed minute, which is far more than
 * 2/60. Model it at job granularity instead: for every consumer job (all but the retained
 * producer), the billed delta is ceil(dur/60) − ceil((dur − build)/60).
 * This is still INFERRED, not a bound: it does not include the new producer job's own
 * checkout/setup/install or artifact transfer, both of which push the real number DOWN, and it
 * is design-dependent (see research §4.3).
 */
const p3BilledMin = jobs => {
  const withBuild = jobs.filter(j => (j.build_step_sec || 0) > 0)
    .sort((a, b) => b.build_step_sec - a.build_step_sec);
  if (withBuild.length <= 1) return 0;
  let delta = 0;
  for (const j of withBuild.slice(1)) {          // slice(1) retains the largest build as producer
    const d = secs(j.started_at, j.completed_at);
    delta += Math.ceil(d / 60) - Math.ceil(Math.max(0, d - j.build_step_sec) / 60);
  }
  return delta;
};

/** Derive the full attempt-level ledger from a raw snapshot directory. Pure. */
export function deriveRows(rawDir) {
  const runs = jsonl(rawDir, 'runs.jsonl')
    .filter(r => r.created_at >= WIN_FROM && r.created_at < WIN_TO);

  const jobsByRun = new Map();
  for (const j of jsonl(rawDir, 'jobs.jsonl')) {
    const id = String(j.run_id);
    if (!jobsByRun.has(id)) jobsByRun.set(id, []);
    jobsByRun.get(id).push(j);
  }
  // ---- one validated authoritative declaration, used by BOTH the requirement pass and the
  // ---- row-building pass. R8 finding 1: they used to be computed separately (requirement from
  // ---- runs.jsonl, rows from max(runs, jobs)), so a cross-source disagreement reopened the
  // ---- silent fallback and reproduced the exact 57-minute failure->success drift.
  // GitHub's full conclusion vocabulary. R11: `startup_failure` was missing and would have been
  // rejected as unrecognised — a legitimate value this window simply happens not to contain.
  const TERMINAL = ['success', 'failure', 'cancelled', 'skipped', 'timed_out',
                    'action_required', 'neutral', 'stale', 'startup_failure'];
  const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v));
  const declaredAttempts = new Map();
  for (const r of runs) {
    const n = r.run_attempt;
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`runs.jsonl: run ${r.id} has an invalid run_attempt ${JSON.stringify(n)}`);
    }
    if (!TERMINAL.includes(r.conclusion)) {
      throw new Error(`runs.jsonl: run ${r.id} has an unrecognised conclusion ${JSON.stringify(r.conclusion)}`);
    }
    declaredAttempts.set(String(r.id), n);
  }
  // R9 finding 1: job objects were fail-open — a missing `run_attempt` silently became 1
  // (collapsing a real rerun into attempt 1), and nothing validated conclusions, timestamps or
  // build_step_sec before they were turned into money. Validate every in-window job first.
  for (const [id, js] of jobsByRun) {
    if (!declaredAttempts.has(id)) continue;         // out-of-window run
    const declared = declaredAttempts.get(id);
    for (const j of js) {
      if (typeof j.name !== 'string' || !j.name) throw new Error(`jobs.jsonl: run ${id} has a job with no name`);
      // R10 finding 2: the two supported shapes are (a) a SETTLED job — terminal conclusion plus
      // both timestamps — and (b) a job that never ran at all: no conclusion, no timestamps, no
      // build seconds. Anything in between is unsettled timing that cannot be billed yet.
      const unstarted = j.conclusion === null && j.started_at === null && j.completed_at === null
                        && (j.build_step_sec ?? 0) === 0;
      if (!unstarted) {
        if (!TERMINAL.includes(j.conclusion)) {
          throw new Error(`jobs.jsonl: run ${id} job "${j.name}" has an unrecognised conclusion ${JSON.stringify(j.conclusion)} ` +
                          `(the only conclusion-less shape accepted is a fully unstarted job: ` +
                          `conclusion/started_at/completed_at all null and build_step_sec 0)`);
        }
        for (const f of ['started_at', 'completed_at']) {
          if (!isTime(j[f])) {
            throw new Error(`jobs.jsonl: run ${id} job "${j.name}" has conclusion ${JSON.stringify(j.conclusion)} ` +
                            `but ${f}=${JSON.stringify(j[f])} is missing or unparseable`);
          }
        }
        // NB: GitHub's second-resolution timestamps legitimately yield completed < started on
        // very short jobs (546 such records in this snapshot). billable() clamps those to 0;
        // that is a documented clamp, not an error.
      }
      const b = j.build_step_sec;
      if (!Number.isInteger(b) || b < 0) {
        throw new Error(`jobs.jsonl: run ${id} job "${j.name}" has an invalid build_step_sec ${JSON.stringify(b)}`);
      }
      // an absent attempt number is only unambiguous when the run declares exactly one attempt
      if (j.run_attempt === undefined || j.run_attempt === null) {
        if (declared !== 1) {
          throw new Error(`jobs.jsonl: run ${id} job "${j.name}" has no run_attempt, but the run ` +
                          `declares ${declared} attempts — defaulting to 1 would collapse a rerun`);
        }
        continue;
      }
      const a = j.run_attempt;
      if (!Number.isInteger(a) || a < 1 || a > declared) {
        throw new Error(`jobs.jsonl: run ${id} job "${j.name}" claims attempt ${JSON.stringify(a)}, but the run ` +
                        `declares only ${declared} — raw sources disagree`);
      }
    }
  }

  // Authoritative per-attempt run objects (GET /runs/{id}/attempts/{n}).
  // REQUIRED for every multi-attempt run; there is no fallback. Silently defaulting to the
  // run-level (latest) conclusion is exactly the R6 bug, and R7/R8 both reproduced it through
  // collection or cross-source failures.
  const attemptMeta = new Map();
  const haveAttempts = fs.existsSync(`${rawDir}/attempts.jsonl`);
  if (haveAttempts) {
    for (const a of jsonl(rawDir, 'attempts.jsonl')) {
      const k = `${a.run_id}#${a.run_attempt}`;
      if (attemptMeta.has(k)) throw new Error(`attempts.jsonl: duplicate record for ${k}`);
      if (!Number.isInteger(a.run_attempt) || a.run_attempt < 1) {
        throw new Error(`attempts.jsonl: ${k} has an invalid run_attempt`);
      }
      if (!TERMINAL.includes(a.conclusion)) {
        throw new Error(`attempts.jsonl: ${k} has an unrecognised conclusion ${JSON.stringify(a.conclusion)}`);
      }
      if (!isTime(a.run_started_at)) {
        throw new Error(`attempts.jsonl: ${k} has an unparseable run_started_at ${JSON.stringify(a.run_started_at)}`);
      }
      attemptMeta.set(k, a);
    }
  }
  {
    const required = [];
    for (const [id, n] of declaredAttempts) {
      if (n > 1) for (let a = 1; a <= n; a++) required.push(`${id}#${a}`);
    }
    if (required.length && !haveAttempts) {
      throw new Error(`${rawDir}/attempts.jsonl is required: ${required.length} attempts belong to ` +
                      `multi-attempt runs and their per-attempt conclusions cannot be inferred`);
    }
    const reqSet = new Set(required);
    const missing = required.filter(k => !attemptMeta.has(k));
    if (missing.length) {
      throw new Error(`attempts.jsonl is incomplete — no authoritative record for: ${missing.join(', ')}. ` +
                      `Falling back to the run-level conclusion would silently reintroduce the ` +
                      `attempt-level bug (research section 0.1.4 item 2).`);
    }
    const extra = [...attemptMeta.keys()].filter(k => !reqSet.has(k));
    if (extra.length) throw new Error(`attempts.jsonl has records for non-multi-attempt runs: ${extra.join(', ')}`);
    // attempt start times must strictly increase within a run
    for (const [id, n] of declaredAttempts) {
      if (n <= 1) continue;
      for (let a = 2; a <= n; a++) {
        const prev = attemptMeta.get(`${id}#${a - 1}`).run_started_at;
        const cur = attemptMeta.get(`${id}#${a}`).run_started_at;
        if (!(Date.parse(cur) > Date.parse(prev))) {
          throw new Error(`attempts.jsonl: run ${id} attempt ${a} starts at ${cur}, not after attempt ${a - 1} (${prev})`);
        }
      }
    }
  }

  const prFiles = {};
  for (const line of fs.readFileSync(`${rawDir}/prfiles.tsv`, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const [branch, path] = line.split('\t');
    (prFiles[branch] ??= []).push(path);
  }

  // ---- build one entry per (run, attempt), enumerating 1..run_attempt so an attempt whose jobs
  // ---- the API did not return still exists as a zero-cost row (R6 finding 1).
  const entries = [];
  for (const r of runs) {
    const id = String(r.id);
    const all = jobsByRun.get(id) ?? [];
    const declared = declaredAttempts.get(id);   // validated above; jobs may not exceed it
    const firstSeen = new Map();     // physical execution -> the attempt that actually ran it
    for (const j of all.slice().sort((x, y) => (x.run_attempt ?? 1) - (y.run_attempt ?? 1))) {
      const k = physKey(j);
      if (!firstSeen.has(k)) firstSeen.set(k, j.run_attempt ?? 1);
    }
    for (let a = 1; a <= declared; a++) {
      const jobs = all.filter(j => (j.run_attempt ?? 1) === a);
      // a record is a NEW physical execution only in the attempt where it first appears
      const fresh = jobs.filter(j => firstSeen.get(physKey(j)) === a);
      const carried = jobs.filter(j => firstSeen.get(physKey(j)) !== a);
      entries.push({ run: r, attempt: a, jobs, fresh, carried,
                     meta: attemptMeta.get(`${id}#${a}`) ?? null });
    }
  }
  // Order by when the attempt physically STARTED. The authoritative `run_started_at` from the
  // attempt object is preferred; carried-forward job timestamps must not be used, they belong
  // to the earlier attempt (R6 finding 1).
  const attemptAt = e => {
    if (e.meta?.run_started_at) return e.meta.run_started_at;
    if (declaredAttempts.get(String(e.run.id)) > 1) {
      throw new Error(`unreachable: multi-attempt run ${e.run.id}#${e.attempt} has no authoritative metadata`);
    }
    const t = e.fresh.map(j => j.started_at).filter(Boolean).sort();
    return t.length ? t[0] : e.run.created_at;
  };
  entries.forEach(e => { e.at = attemptAt(e); });
  entries.sort((a, b) => a.at.localeCompare(b.at) ||
                         String(a.run.id).localeCompare(String(b.run.id)) || a.attempt - b.attempt);

  const lastGreen = {};
  const rows = [];
  for (const e of entries) {
    const { run: r, jobs, fresh, carried } = e;
    const id = String(r.id);
    const min = fresh.reduce((a, j) => a + billable(j), 0);          // physical executions only
    const carriedMin = carried.reduce((a, j) => a + billable(j), 0); // shown, never charged
    const fp = jobs.length ? fastPath(jobs) : false;
    const green = jobs.length ? fullGreen(jobs, r) : false;
    const label = commitLabel(r.subj);
    // build evidence is also physical-execution-only: a carried-forward record repeats an
    // earlier attempt's Build step, it is not new duplicate work
    const dup = dupBuildSec(fresh);
    const buildSteps = fresh.filter(j => (j.build_step_sec || 0) > 0).length;
    const p3 = Math.min(min, p3BilledMin(fresh));
    // R6 finding 2: runs.jsonl carries only the LATEST run conclusion. Use the attempt's own.
    if (!e.meta && declaredAttempts.get(id) > 1) {
      throw new Error(`unreachable: multi-attempt run ${id}#${e.attempt} has no authoritative conclusion`);
    }
    const concl = e.meta?.conclusion ?? r.conclusion;   // run-level only for single-attempt runs

    let bucket, reason, baseline = '';
    if (r.name !== 'CI') {
      bucket = 'non_ci'; reason = 'not the CI workflow; classifier levers do not apply';
    } else if (fp) {
      bucket = '1_already_fast';
      reason = 'classify succeeded AND payload skipped in this attempt => real no_code fast path';
    } else if (r.event !== 'pull_request') {
      bucket = '4_must_run_full';
      reason = `event=${r.event} is not a pull_request; P0/P1 are PR-scoped and research section 8 keeps main push CI full`;
    } else {
      const br = r.head_branch;
      const files = prFiles[br];
      const allAllowed = files && files.length &&
        files.every(f => DOC_PREFIXES.some(p => f.startsWith(p)) &&
                         [...SUFFIX_CURRENT, ...SUFFIX_P0_ADDS].some(s => f.endsWith(s)));
      const usesP0 = files && files.some(f => SUFFIX_P0_ADDS.some(s => f.endsWith(s)));
      if (allAllowed && usesP0) {
        bucket = '2_P0';
        reason = 'all files under a doc prefix and inside current+P0 suffixes AND at least one file uses a P0-only suffix';
      } else if (lastGreen[br] && (label === 'docs' || label === 'chore_progress')) {
        bucket = '3_P1_upper'; baseline = lastGreen[br];
        reason = 'UPPER BOUND: branch already had a qualifying full-green attempt AND head commit is doc/progress labelled; ' +
                 'incremental-diff inertness and unchanged base SHA / ci.yml are NOT verified here';
      } else {
        bucket = '4_must_run_full';
        reason = !files ? 'no PR file snapshot for this branch'
               : allAllowed ? 'files are already inside the CURRENT allowlist; P0 would change nothing for this PR'
               : lastGreen[br] ? 'not a P0 case; head commit is not doc/progress labelled'
               : 'not a P0 case; branch has no prior qualifying full-green baseline';
      }
    }
    rows.push({
      run_id: id, run_attempt: e.attempt, attempt_at: e.at,
      workflow: r.name, event: r.event, conclusion: concl, branch: r.head_branch ?? '',
      commit_label: label, billed_min: min, carried_min: carriedMin,
      fast_path: fp, is_full_green: green, build_steps: buildSteps,
      dup_build_sec: Math.round(dup), p3_billed_min: p3,
      bucket, bucket_reason: reason, p1_baseline: baseline,
    });
    if (green) lastGreen[r.head_branch] = `${id}#${e.attempt}`;
  }
  return rows;
}

const csvCell = v => String(v).replace(/[,\n\r]/g, ';');
export const rowToCsv = r => LEDGER_HEADER.map(h => csvCell(r[h])).join(',');
export const toCsv = rows => [LEDGER_HEADER.join(','), ...rows.map(rowToCsv)].join('\n') + '\n';
