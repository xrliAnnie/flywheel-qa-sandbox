#!/usr/bin/env node
/**
 * FLY-1987 — raw GitHub snapshots -> ledger.csv (the checked-in derived table).
 *
 *   node derive.mjs <raw-dir> [out.csv]
 *
 * All rules live in derive-lib.mjs, which aggregate.mjs also runs. Disagree with a bucket?
 * Change the predicate there and re-derive — never hand-edit the CSV.
 *
 * <raw-dir> holds the snapshots fetched by research.md Appendix A.2:
 *   runs.jsonl   {id,name,event,head_branch,conclusion,run_attempt,created_at,subj}
 *   jobs.jsonl   {run_id,run_attempt,name,conclusion,started_at,completed_at,build_step_sec}
 *                from ?filter=all — every re-run attempt is billed, so every attempt is present
 *   prfiles.tsv  "<branch>\t<path>" per file in that branch's PR (final snapshot)
 */
import fs from 'node:fs';
import { deriveRows, toCsv, WIN_FROM, WIN_TO } from './derive-lib.mjs';

const RAW = process.argv[2];
const OUT = process.argv[3] || new URL('./ledger.csv', import.meta.url).pathname;
if (!RAW) { console.error('usage: node derive.mjs <raw-dir> [out.csv]'); process.exit(2); }

const rows = deriveRows(RAW);
fs.writeFileSync(OUT, toCsv(rows));
console.error(`derive: window [${WIN_FROM}, ${WIN_TO})  attempt-rows=${rows.length}  -> ${OUT}`);
