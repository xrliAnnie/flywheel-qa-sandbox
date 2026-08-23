#!/usr/bin/env node
/**
 * FLY-1987 — verify + aggregate the checked-in derived ledger.
 *
 *   node aggregate.mjs [ledger.csv] [raw-dir]
 *
 * R5 finding 2: a validator that only checks labels AGAINST EACH OTHER cannot tell a mutated
 * ledger from a real one — four one-cell mutants (a flipped commit_label, a manufactured P0 row,
 * billed_min += 100, a flipped is_full_green) all moved headline numbers while the old checks
 * printed "all structural invariants passed".
 *
 * So this does not check relationships. It RE-DERIVES every row from data/raw using the same
 * derive-lib.mjs that produced the ledger, and requires field-for-field equality. Any cell that
 * does not follow from the raw snapshot is rejected by construction.
 *
 * Reproduces research.md §1.2–§1.5 and §4. It does NOT reproduce §1.1's 7/14/29-day rows or
 * §1.6's 30-day table — those need a longer snapshot (research.md Appendix A.1).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deriveRows, LEDGER_HEADER, KNOWN_JOB_NAMES, WIN_FROM, WIN_TO } from './derive-lib.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const CSV = process.argv[2] || path.join(here, 'ledger.csv');
const RAW = process.argv[3] || path.join(here, 'raw');
const WIN_HOURS = 48, SCALE = 720 / WIN_HOURS;          // = 15
const USD_PER_MIN = 0.006;

const lines = fs.readFileSync(CSV, 'utf8').trim().split('\n');
const head = lines.shift().split(',');
if (head.join(',') !== LEDGER_HEADER.join(',')) {
  console.error(`SCHEMA FAIL: header mismatch\n  got:      ${head.join(',')}\n  expected: ${LEDGER_HEADER.join(',')}`);
  process.exit(1);
}
const parsed = lines.map(l => {
  const v = l.split(',');
  return Object.fromEntries(LEDGER_HEADER.map((h, i) => [h, v[i] ?? '']));
});

// ---- the only check that matters: does every cell follow from the raw snapshot?
const expected = deriveRows(RAW).map(r =>
  Object.fromEntries(LEDGER_HEADER.map(h => [h, String(r[h])])));
const fail = [];
if (parsed.length !== expected.length) {
  fail.push(`row count ${parsed.length} != re-derived ${expected.length}`);
}
const key = r => `${r.run_id}#${r.run_attempt}`;
const expByKey = new Map(expected.map(r => [key(r), r]));
const seen = new Set();
for (const [i, r] of parsed.entries()) {
  const k = key(r);
  if (seen.has(k)) { fail.push(`row ${i + 2}: duplicate ${k}`); continue; }
  seen.add(k);
  const e = expByKey.get(k);
  if (!e) { fail.push(`row ${i + 2}: ${k} is not produced by re-derivation from ${RAW}`); continue; }
  for (const h of LEDGER_HEADER) {
    if (r[h] !== e[h]) fail.push(`row ${i + 2} (${k}): ${h}=${JSON.stringify(r[h])} but re-derivation gives ${JSON.stringify(e[h])}`);
  }
}
for (const k of expByKey.keys()) if (!seen.has(k)) fail.push(`re-derived row ${k} is missing from the ledger`);
if (fail.length) {
  console.error(`DERIVATION MISMATCH (${fail.length}) — the ledger does not follow from ${RAW}\n  ` +
                fail.slice(0, 25).join('\n  '));
  process.exit(1);
}

// ---- from here on the ledger is known to equal the derivation; aggregate it
const R = expected.map(r => ({
  ...r,
  billed_min: Number(r.billed_min),
  carried_min: Number(r.carried_min),
  p3_billed_min: Number(r.p3_billed_min),
  fast_path: r.fast_path === 'true',
  is_full_green: r.is_full_green === 'true',
}));
const sum = a => a.reduce((x, y) => x + y, 0);
const per30 = m => Math.round(m * SCALE);
const usd = m => '$' + Math.round(per30(m) * USD_PER_MIN);
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const TOTAL = sum(R.map(r => r.billed_min));
const CARRIED = sum(R.map(r => r.carried_min));
const ci = R.filter(r => r.workflow === 'CI');
const CI_TOTAL = sum(ci.map(r => r.billed_min));
const runIds = new Set(R.map(r => r.run_id));
console.log(`window [${WIN_FROM}, ${WIN_TO})  = ${WIN_HOURS}h, scale x${SCALE}, $${USD_PER_MIN}/min`);
console.log(`ledger is keyed by (run, attempt) — every attempt is billed, so every attempt is a row.`);
console.log(`runs=${runIds.size}  attempt-rows=${R.length}  billed=${TOTAL}  => ${per30(TOTAL)} min/30d  ${usd(TOTAL)}/mo`);
console.log(`carried-forward job records excluded from billing: ${CARRIED} min` +
            ` (re-running failed jobs repeats the already-green ones as fresh records with the ORIGINAL timestamps)`);
console.log(`CI only : attempt-rows=${ci.length}  billed=${CI_TOTAL}\n`);

const table = (title, rows, k, denom) => {
  const o = {};
  for (const r of rows) o[r[k]] = (o[r[k]] || 0) + r.billed_min;
  if (sum(Object.values(o)) !== denom) { console.error(`${title}: subgroup total != denominator ${denom}`); process.exit(1); }
  console.log(`-- ${title}  [denominator = ${denom} min] --`);
  let pct = 0;
  Object.entries(o).sort((a, b) => b[1] - a[1]).forEach(([n, v]) => {
    const p = v / denom * 100; pct += p;
    console.log(`  ${String(v).padStart(6)} ${p.toFixed(1).padStart(5)}%  ${n}`);
  });
  if (Math.abs(pct - 100) >= 0.5) { console.error(`${title}: percentages sum to ${pct.toFixed(2)}%`); process.exit(1); }
  console.log();
};
table('by workflow (all)',       R,  'workflow',     TOTAL);
table('by event (all)',          R,  'event',        TOTAL);
table('by conclusion (all)',     R,  'conclusion',   TOTAL);
table('CI by head-commit label', ci, 'commit_label', CI_TOTAL);

const fast = ci.filter(r => r.fast_path);
console.log(`classifier fast-path hit rate = ${fast.length}/${ci.length} CI attempts = ${(fast.length / ci.length * 100).toFixed(1)}%`);
console.log(`  (an attempt counts as fast-path only when Classify SUCCEEDED and payload was skipped;`);
console.log(`   payload also skips when classify itself fails, which is not a no_code decision)`);
console.log(`qualifying full-green attempts = ${ci.filter(r => r.is_full_green).length}`);
const FP_MODEL = med(fast.filter(r => r.conclusion === 'success').map(r => r.billed_min));
console.log(`fast-path cost model (median billed_min of completed fast-path attempts) = ${FP_MODEL} min\n`);

console.log('-- per-attempt counterfactual ledger (CI only; buckets mutually exclusive) --');
const row = name => {
  const arr = ci.filter(r => r.bucket === name);
  const gross = sum(arr.map(r => r.billed_min));
  const cf = sum(arr.map(r => Math.min(r.billed_min, FP_MODEL)));   // cancelled-early earns no phantom saving
  const net = gross - cf;
  console.log(`  ${name.padEnd(16)} n=${String(arr.length).padStart(4)}  gross=${String(gross).padStart(5)} (${usd(gross)}/mo)` +
              `  counterfactual=${String(cf).padStart(4)}  NET=${String(net).padStart(5)} (${usd(net)}/mo)`);
  return { arr, n: arr.length, gross, cf, net };
};
const b1 = row('1_already_fast'), b2 = row('2_P0'), b3 = row('3_P1_upper'), b4 = row('4_must_run_full');

const p3 = Math.round(sum(b4.arr.map(r => r.p3_billed_min)));
console.log(`  ${'5_P3_build_reuse'.padEnd(16)} bucket 4 only, per-job billed delta from the measured` +
            ` \`Build\` step: INFERRED=${p3} (${usd(p3)}/mo)`);
console.log(`    [MEASURED: the Build step seconds. INFERRED: the billed delta, because GitHub rounds`);
console.log(`     each job up to a whole minute. NOT an upper bound: it excludes the new producer job's`);
console.log(`     own checkout/setup/install and artifact transfer, and it is design-dependent.]`);

if (b1.gross + b2.gross + b3.gross + b4.gross !== CI_TOTAL) { console.error('bucket gross != CI total'); process.exit(1); }
const residual = TOTAL - b2.net - b3.net - p3;
console.log(`\n  residual after P0+P1+P3 = ${TOTAL} - ${b2.net} - ${b3.net} - ${p3} = ${residual} min` +
            ` => ${per30(residual)} min/30d  ${usd(residual)}/mo`);
console.log(`  conservation: buckets ${b1.gross + b2.gross + b3.gross + b4.gross} + non-CI ${TOTAL - CI_TOTAL} = ${TOTAL} OK`);
// ---- §1.3.1 / §8 come from the JOB dimension, not the ledger. Compute them here from the same
// ---- raw snapshot so those headline figures are covered by this run too (R6 finding 6).
const jobRows = fs.readFileSync(`${RAW}/jobs.jsonl`, 'utf8').split('\n')
  .filter(l => l.trim()).map(l => JSON.parse(l));
const seenPhys = new Map();
for (const j of jobRows.slice().sort((a, b) => (a.run_attempt ?? 1) - (b.run_attempt ?? 1))) {
  const k = `${j.run_id}|${j.name}|${j.started_at}|${j.completed_at}`;
  if (!seenPhys.has(k)) seenPhys.set(k, j);
}
// R7 finding 4: the known-name gate stops an OUT-OF-VOCABULARY rename, but swapping two known
// names (e.g. `Unit (heavy)` <-> `Unit (light)`) leaves the ledger byte-identical and only moves
// the JOB-dimension table. Re-derivation cannot catch that, because no ledger field depends on it.
// When aggregating the checked-in snapshot, verify it against the committed manifest; when a caller
// points at a freshly fetched raw dir, say plainly that the job table is unauthenticated.
const DEFAULT_RAW = path.join(here, 'raw');
const usingDefaultRaw = path.resolve(RAW) === path.resolve(DEFAULT_RAW);
let jobTableAuthenticated = false;
if (usingDefaultRaw) {
  // R8 finding 2: this used to be best-effort — deleting the jobs.jsonl line from SHA256SUMS made
  // the whole documented chain pass while a KNOWN-name swap moved the printed job table. On the
  // default path the manifest entry is now mandatory.
  // R9 finding 2: requiring only the jobs.jsonl entry left an INVENTORY hole — deleting the
  // aggregate.mjs line from SHA256SUMS let `shasum -c` still pass while USD_PER_MIN was changed
  // from 0.006 to 0.060, and the whole documented chain exited 0 with every dollar figure x10.
  // Require the exact promised inventory, then verify each digest.
  const sums = path.join(DEFAULT_RAW, 'SHA256SUMS');
  if (!fs.existsSync(sums)) {
    console.error(`MANIFEST MISSING: ${sums} is required when aggregating the checked-in snapshot`);
    process.exit(1);
  }
  const REQUIRED_MANIFEST = [
    'data/raw/runs.jsonl', 'data/raw/jobs.jsonl', 'data/raw/attempts.jsonl', 'data/raw/prfiles.tsv',
    'data/derive-lib.mjs', 'data/derive.mjs', 'data/aggregate.mjs', 'data/ledger.csv',
  ];
  const parsed2 = fs.readFileSync(sums, 'utf8').split('\n').filter(l => l.trim())
    .map(l => l.trim().split(/\s+/));
  const seenM = new Map();
  for (const fields of parsed2) {
    // R10 finding 5: `[digest, file] = split` silently ignored trailing fields
    if (fields.length !== 2) {
      console.error(`MANIFEST: malformed line (expected "<digest>  <path>"): ${fields.join(' ')}`);
      process.exit(1);
    }
    const [digest, file] = fields;
    if (seenM.has(file)) { console.error(`MANIFEST: duplicate entry for ${file}`); process.exit(1); }
    if (!/^[0-9a-f]{64}$/.test(digest ?? '')) { console.error(`MANIFEST: ${file} has a non-sha256 digest`); process.exit(1); }
    seenM.set(file, digest);
  }
  const missingM = REQUIRED_MANIFEST.filter(f => !seenM.has(f));
  const extraM = [...seenM.keys()].filter(f => !REQUIRED_MANIFEST.includes(f));
  if (missingM.length || extraM.length) {
    console.error(`MANIFEST INVENTORY mismatch` +
      (missingM.length ? `\n  missing: ${missingM.join(', ')}` : '') +
      (extraM.length ? `\n  unexpected: ${extraM.join(', ')}` : ''));
    process.exit(1);
  }
  const issueRoot = path.dirname(here);
  for (const f of REQUIRED_MANIFEST) {
    const abs = path.join(issueRoot, f);
    if (!fs.existsSync(abs)) { console.error(`MANIFEST: ${f} is listed but absent on disk`); process.exit(1); }
    const got = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    if (got !== seenM.get(f)) {
      console.error(`MANIFEST MISMATCH: ${f}\n  in SHA256SUMS ${seenM.get(f)}\n  on disk       ${got}`);
      process.exit(1);
    }
  }
  jobTableAuthenticated = true;
}
const unknownNames = [...new Set(jobRows.map(j => j.name))].filter(n => !KNOWN_JOB_NAMES.includes(n));
if (unknownNames.length) {
  console.error(`UNKNOWN JOB NAME(S) in ${RAW}/jobs.jsonl — the CI job graph is not the one this ` +
                `analysis describes, or the snapshot was altered:\n  ` + unknownNames.join('\n  '));
  process.exit(1);
}
const bill = j => j.conclusion === 'skipped' ? 0
  : Math.ceil(Math.max(0, (new Date(j.completed_at) - new Date(j.started_at)) / 1000) / 60);
const perJob = {};
let jobTotal = 0;
for (const j of seenPhys.values()) { const m = bill(j); jobTotal += m; perJob[j.name] = (perJob[j.name] || 0) + m; }
console.log(`\n-- by job (physical executions only; research §1.3.1 / §8)  [denominator = ${jobTotal} min] --`);
console.log(`   ${jobTableAuthenticated
  ? 'jobs.jsonl matches the CURRENT data/raw/SHA256SUMS entry (a worktree file, not the commit blob).'
  : 'NOT manifest-checked (non-default raw dir supplied by caller): these rows are aggregated from'
    + ' that snapshot, not re-derived — swapping two KNOWN job names would move them undetected.'}`);
Object.entries(perJob).sort((a, b) => b[1] - a[1]).forEach(([n, v]) =>
  console.log(`  ${String(v).padStart(6)} ${(v / jobTotal * 100).toFixed(1).padStart(5)}%  ${usd(v).padStart(6)}/mo  ${n}`));
if (jobTotal !== TOTAL) { console.error(`job-dimension total ${jobTotal} != ledger total ${TOTAL}`); process.exit(1); }

console.log(`\nledger verified against ${RAW}: every LEDGER field re-derived and equal.` +
            `\n(the job-dimension table above is aggregated, not re-derived — see the note under it)`);
