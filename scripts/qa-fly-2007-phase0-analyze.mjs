#!/usr/bin/env node
// FLY-2007 — Phase-0 analyser for the FLY-1986 read-only load probe.
//
// WHAT THIS IS
//   The missing layer between the FLY-1986 collector and the FLY-1986 verdict.
//   The collector emits a POINT ESTIMATE (`violation_upper_conservative` is
//   `(missed+error+timer_late)/n`; the word "upper" there means "timer_late
//   counted as a violation", not a confidence bound). FLY-1986 plan section 3
//   decides A/B/N from a one-sided 95% CONFIDENCE bound. This computes that.
//
// WHAT THIS IS NOT
//   - It opens NO network connection and NO database. It reads the run bundle
//     files it is given and writes only the output paths it is told to write.
//   - It applies no load and never touches the Bridge.
//
// THE JUDGE  (see engineering/doc/FLY-2007-capacity-stress-execution/research.md C.4)
//   Unit violation rates p_j live in [0,1], so for any threshold c:
//       b = E[p] = E[p 1{p<=c}] + E[p 1{p>c}] <= c P(p<=c) + 1 P(p>c)
//                                              = c + (1-c) pi(c)
//       b = E[p] >= E[p 1{p>c}] >= c P(p>c)    = c pi(c)
//   with pi(c) = P(p_j > c) and K(c) = #{j: p_j > c} ~ Binomial(J, pi(c)).
//   Both inequalities are UNCONDITIONAL. Bounding pi by Clopper-Pearson makes
//   the whole thing EXACT UNDER A1 (units iid) - and A1 is named, not disguised.
//   Taking min/max over the threshold grid is a SELECTION, so every CP inside a
//   grid runs at level alpha/G.
//
// DELIBERATELY BORING
//   Three earlier designs were deleted rather than repaired: a Kish design-effect
//   correction to Clopper-Pearson (R1: matches variance only), a studentized
//   stationary block bootstrap (R2: the bootstrap-t inversion was written through
//   the wrong tail, and the block-length estimator, se, boundary behaviour and
//   inter-block time gaps were all unwritten), and a data-dependent unit merge
//   (R2: selection using the inference data). Nothing here is asymptotic, nothing
//   here is random, and nothing degenerates at b_hat = 0 or 1.

// ---------------------------------------------------------------- exactness ---
// log-space binomial so J in the hundreds stays exact enough to bisect on.
const lnFactCache = [0, 0];
function lnFact(n) {
	if (n < lnFactCache.length) return lnFactCache[n];
	let v = lnFactCache[lnFactCache.length - 1];
	for (let i = lnFactCache.length; i <= n; i++) {
		v += Math.log(i);
		lnFactCache[i] = v;
	}
	return lnFactCache[n];
}
const lnChoose = (n, k) => lnFact(n) - lnFact(k) - lnFact(n - k);

// P(X <= x) for X ~ Binomial(n, p)
export function binomCdf(x, n, p) {
	if (x < 0) return 0;
	if (x >= n) return 1;
	if (p <= 0) return 1;
	if (p >= 1) return 0;
	const lp = Math.log(p);
	const lq = Math.log1p(-p);
	let s = 0;
	for (let k = 0; k <= x; k++)
		s += Math.exp(lnChoose(n, k) + k * lp + (n - k) * lq);
	return Math.min(1, s);
}
// P(X >= x)
export function binomSf(x, n, p) {
	if (x <= 0) return 1;
	if (x > n) return 0;
	return 1 - binomCdf(x - 1, n, p);
}

// Clopper-Pearson one-sided UPPER limit on pi: the p solving P(X <= x) = alpha.
// binomCdf is decreasing in p, so bisect. Closed form at x=0 is 1-alpha^(1/n);
// the self-test pins the bisection against it and against FLY-1986 plan 5.3.
const cpCache = new Map();
export function cpUpper(x, n, alpha) {
	const key = `u${x}|${n}|${alpha}`;
	const hit = cpCache.get(key);
	if (hit !== undefined) return hit;
	const v = cpUpperRaw(x, n, alpha);
	cpCache.set(key, v);
	return v;
}
function cpUpperRaw(x, n, alpha) {
	if (!(alpha > 0 && alpha < 1))
		throw new Error(`cpUpper: alpha out of range: ${alpha}`);
	if (!Number.isInteger(x) || !Number.isInteger(n) || x < 0 || n <= 0 || x > n)
		throw new Error(`cpUpper: bad counts x=${x} n=${n}`);
	if (x === n) return 1;
	let lo = 0,
		hi = 1;
	for (let i = 0; i < 200; i++) {
		const mid = (lo + hi) / 2;
		if (binomCdf(x, n, mid) > alpha) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}
// Clopper-Pearson one-sided LOWER limit on pi: the p solving P(X >= x) = alpha.
export function cpLower(x, n, alpha) {
	const key = `l${x}|${n}|${alpha}`;
	const hit = cpCache.get(key);
	if (hit !== undefined) return hit;
	const v = cpLowerRaw(x, n, alpha);
	cpCache.set(key, v);
	return v;
}
function cpLowerRaw(x, n, alpha) {
	if (!(alpha > 0 && alpha < 1))
		throw new Error(`cpLower: alpha out of range: ${alpha}`);
	if (!Number.isInteger(x) || !Number.isInteger(n) || x < 0 || n <= 0 || x > n)
		throw new Error(`cpLower: bad counts x=${x} n=${n}`);
	if (x === 0) return 0;
	let lo = 0,
		hi = 1;
	for (let i = 0; i < 200; i++) {
		const mid = (lo + hi) / 2;
		if (binomSf(x, n, mid) < alpha) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

// -------------------------------------------------------------- the judge ---
// A unit is {violations, ticks}. The comparison p_j > c is done by INTEGER cross
// multiplication: block rates are rationals like k/150, so p_j == c is reachable
// exactly (3/150 == 0.02, 15/150 == 0.10) and a float compare would decide those
// ties by rounding luck. c is given as a rational {num, den}.
export function countAbove(units, c) {
	let k = 0;
	for (const u of units) {
		if (
			!Number.isInteger(u.violations) ||
			!Number.isInteger(u.ticks) ||
			u.ticks <= 0
		)
			throw new Error(
				`countAbove: unit is not an integer pair: ${JSON.stringify(u)}`,
			);
		if (u.violations < 0 || u.violations > u.ticks)
			throw new Error(
				`countAbove: violations outside 0..ticks: ${JSON.stringify(u)}`,
			);
		// p_j > c  <=>  violations * c.den > c.num * ticks       (strict, integers only)
		if (u.violations * c.den > c.num * u.ticks) k++;
	}
	return k;
}

// b <= min_c [ c + (1-c) pi_ub(c) ], every CP at alphaPerCp = alphaFamily / G.
export function boundUpper(units, grid, alphaPerCp) {
	const J = units.length;
	if (J === 0) throw new Error("boundUpper: no units");
	let best = null;
	const perThreshold = [];
	for (const c of grid) {
		const cv = c.num / c.den;
		const k = countAbove(units, c);
		const piUb = cpUpper(k, J, alphaPerCp);
		const bound = cv + (1 - cv) * piUb;
		perThreshold.push({ c: cv, k, piUb, bound });
		if (best === null || bound < best) best = bound;
	}
	return { bound: best, perThreshold, J, alphaPerCp };
}

// b >= max_c [ c * pi_lb(c) ], every CP at alphaPerCp = alphaFamily / (components * G).
export function boundLower(units, grid, alphaPerCp) {
	const J = units.length;
	if (J === 0) throw new Error("boundLower: no units");
	let best = 0;
	const perThreshold = [];
	for (const c of grid) {
		const cv = c.num / c.den;
		const k = countAbove(units, c);
		const piLb = cpLower(k, J, alphaPerCp);
		const bound = cv * piLb;
		perThreshold.push({ c: cv, k, piLb, bound });
		if (bound > best) best = bound;
	}
	return { bound: best, perThreshold, J, alphaPerCp };
}

// Range across windows by interval arithmetic. Bonferroni over windows is IMMUNE
// to dependence between windows, which is exactly why it is used here: three
// windows on one machine on one day need no joint model and no exchangeability.
//   R = max_w b_w - min_w b_w
//   R <= max_w U_w - min_w L_w
//   R >= max(0, max_w L_w - min_w U_w)
export function rangeBounds(perWindow) {
	const U = perWindow.map((w) => w.upper);
	const L = perWindow.map((w) => w.lower);
	return {
		rangeUb: Math.max(...U) - Math.min(...L),
		rangeLb: Math.max(0, Math.max(...L) - Math.min(...U)),
	};
}

// ============================ pre-registered constants (FROZEN) =============
// Frozen together with spec-baseline.md. Changing any of these after the first
// attempt's START record breaks the pre-registration; the doc contract test and
// the freeze commit hash recorded in every output exist to make that visible.
export const SLO = 0.05; // founder ruling, FLY-1986 issue text
export const DELTA = 0.025; // Lead ruling 2026-08-23, POLICY choice
export const ALPHA_B = 0.05; // certify family (intersection-union)
export const ALPHA_A = 0.025; // adverse family, split with N
export const ALPHA_N = 0.025; // ALPHA_A + ALPHA_N = 0.05
export const ENDPOINTS = ["L1", "L2"];
export const WINDOWS = 3;
// ⚠ 30 units per window, fixed a priori - NOT "the survivors".
//
// The justification is DISCRIMINATION, not coverage. An earlier version of this
// comment said 13 units failed the coverage gate and 30 was the minimum that
// passed; that was an artifact of a simulator bug (a 50/50 initial state
// assessed against a stationary estimand) and has been retracted. With the
// corrected simulator every grid point passes at J=13 too.
//
// 30 is chosen because a larger J tightens the lower bound and so raises the
// chance of reaching a decisive verdict at all: with every tick violating,
// b_lb is 0.1159 at J=13 and 0.1579 at J=30 against an SLO of 0.05. If the real
// baseline sits nearer 0.1 rather than at the extreme, J=13's bound may not
// reach the line while J=30's does. We are buying discriminating power, not
// compliance. Lead approved on that reasoning, 2026-08-23.
export const UNITS_PER_WINDOW = 30;
// Rationals, so p_j > c is decided by integer cross multiplication.
export const GRID = [
	{ num: 0, den: 1 }, // "any violation at all"
	{ num: 1, den: 50 }, // 0.02, one step below the SLO
	{ num: 1, den: 20 }, // 0.05, the SLO itself
	{ num: 1, den: 10 }, // 0.10, one step above
	{ num: 1, den: 5 }, // 0.20, two steps above - in the grid because the
]; //       excluded pilot data showed b can be large
export const G = GRID.length;
const COMPONENTS = ENDPOINTS.length * WINDOWS; // 6
// Per-CP levels. Derivations in plan section 4.2, independently re-derived by
// Codex R4: IUT lets each aggregate gate inside the B family run at its own
// per-CP level; range needs 3 windows x 2 tails x G atomic events; b_lb's max
// over the grid is exactly why the G factor is required.
export const A_PERF = ALPHA_B / G; // 0.01
export const A_EQUIV = ALPHA_B / (6 * G); // 0.001667
export const A_ADV = ALPHA_A / (COMPONENTS * G); // 0.000833
export const A_RANGE = ALPHA_N / (2 * 6 * G); // 0.000417

const OUTCOMES = new Set([
	"met",
	"missed",
	"error",
	"timer_late",
	"no_token",
	"unreachable",
	"invalid_auth",
]);
const VIOLATION = new Set(["missed", "error", "timer_late"]); // conservative counting
const CONFIG_FAULT = new Set(["no_token", "unreachable", "invalid_auth"]);

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
// ============================== bundle loading ==============================
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_FILES = ["samples.csv", "summary.csv", "meta.txt", "receipt.json"];

export function loadBundle(dir) {
	const missing = BUNDLE_FILES.filter((f) => !existsSync(join(dir, f)));
	if (missing.length)
		throw new Error(
			`bundle ${basename(dir)} is missing: ${missing.join(", ")}`,
		);
	const raw = {};
	for (const f of BUNDLE_FILES) raw[f] = readFileSync(join(dir, f), "utf8");

	const samples = [];
	const sLines = raw["samples.csv"].split("\n").filter((l) => l.length);
	const sHead = "block_id,endpoint,tick,scheduled,start,end,outcome,secs";
	if (sLines[0] !== sHead)
		throw new Error(`${dir}/samples.csv: unexpected header: ${sLines[0]}`);
	for (let i = 1; i < sLines.length; i++) {
		const f = sLines[i].split(",");
		// fail-loud, never silently drop: a truncated concurrent append biases in a
		// direction nobody can know, because it depends on which writer was cut.
		if (f.length !== 8)
			throw new Error(
				`${dir}/samples.csv line ${i + 1}: ${f.length} fields, expected 8`,
			);
		if (!OUTCOMES.has(f[6]))
			throw new Error(
				`${dir}/samples.csv line ${i + 1}: unknown outcome '${f[6]}'`,
			);
		const tick = Number(f[2]);
		if (!Number.isInteger(tick) || tick < 0)
			throw new Error(`${dir}/samples.csv line ${i + 1}: bad tick '${f[2]}'`);
		samples.push({ block: f[0], endpoint: f[1], tick, outcome: f[6] });
	}

	const summary = [];
	const uLines = raw["summary.csv"].split("\n").filter((l) => l.length);
	const uHead =
		"block_id,endpoint,n,met,missed,error,timer_late,violation_upper_conservative,violation_best_case,block_valid";
	if (uLines[0] !== uHead)
		throw new Error(`${dir}/summary.csv: unexpected header: ${uLines[0]}`);
	for (let i = 1; i < uLines.length; i++) {
		const f = uLines[i].split(",");
		if (f.length !== 10)
			throw new Error(
				`${dir}/summary.csv line ${i + 1}: ${f.length} fields, expected 10`,
			);
		summary.push({
			block: f[0],
			endpoint: f[1],
			n: Number(f[2]),
			met: Number(f[3]),
			missed: Number(f[4]),
			error: Number(f[5]),
			timer_late: Number(f[6]),
			conservative: f[7],
			best: f[8],
			block_valid: f[9],
		});
	}

	const meta = {};
	for (const line of raw["meta.txt"].split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) meta[line.slice(0, eq)] = line.slice(eq + 1);
	}
	const bm = /blocks=(\d+) block_seconds=(\d+) endpoints=(\S+)/.exec(
		raw["meta.txt"],
	);
	if (!bm)
		throw new Error(
			`${dir}/meta.txt: cannot read blocks/block_seconds/endpoints`,
		);
	meta.blocks = Number(bm[1]);
	meta.block_seconds = Number(bm[2]);
	meta.endpoints = bm[3].split(",");

	const receipt = JSON.parse(raw["receipt.json"]);
	const hash = createHash("sha256");
	for (const f of BUNDLE_FILES)
		hash.update(f).update("\0").update(raw[f]).update("\0");
	const fileHashes = {};
	for (const f of BUNDLE_FILES)
		fileHashes[f] = createHash("sha256").update(raw[f]).digest("hex");
	return {
		dir,
		samples,
		summary,
		meta,
		receipt,
		fileHashes,
		bundleSha256: hash.digest("hex"),
	};
}

// Expected ticks per block, from the collector's own endpoint contract.
const INTERVAL = { L1: 2, L2: 3 };
export const expectedTicks = (endpoint, blockSeconds) => {
	const i = INTERVAL[endpoint];
	if (!i) throw new Error(`unknown endpoint ${endpoint}`);
	return Math.ceil(blockSeconds / i);
};

// ========================== run-level integrity contract ====================
// A per-block cross-check is not enough: if a block vanishes from BOTH CSVs the
// per-block loop passes vacuously. So the block ID SET is checked against meta.
export function checkIntegrity(b) {
	const problems = [];
	const expectBlocks = Array.from(
		{ length: b.meta.blocks },
		(_, i) => `b${i + 1}`,
	);

	const sumKeys = new Set();
	for (const r of b.summary) {
		const k = `${r.block}|${r.endpoint}`;
		if (sumKeys.has(k)) problems.push(`duplicate summary row ${k}`);
		sumKeys.add(k);
	}
	for (const blk of expectBlocks)
		for (const ep of b.meta.endpoints)
			if (!sumKeys.has(`${blk}|${ep}`))
				problems.push(`missing summary row ${blk}|${ep}`);
	for (const k of sumKeys) {
		const [blk, ep] = k.split("|");
		if (!expectBlocks.includes(blk))
			problems.push(`summary row for unexpected block ${blk}`);
		if (!b.meta.endpoints.includes(ep))
			problems.push(`summary row for unexpected endpoint ${ep}`);
	}

	const byKey = new Map();
	for (const s of b.samples) {
		const k = `${s.block}|${s.endpoint}`;
		if (!byKey.has(k)) byKey.set(k, []);
		byKey.get(k).push(s);
	}
	const summaryKeys = new Set(b.summary.map((r) => `${r.block}|${r.endpoint}`));
	for (const k of byKey.keys())
		if (!summaryKeys.has(k))
			problems.push(
				`${k}: sample rows exist with no summary row — the integrity check must be two-way`,
			);
	for (const r of b.summary) {
		const k = `${r.block}|${r.endpoint}`;
		const rows = byKey.get(k) || [];
		const exp = expectedTicks(r.endpoint, b.meta.block_seconds);

		const ticks = new Set(rows.map((x) => x.tick));
		if (ticks.size !== rows.length)
			problems.push(`${k}: duplicate tick indices`);
		if (rows.length !== exp)
			problems.push(
				`${k}: ${rows.length} sample rows, collector contract says ${exp}`,
			);
		for (let t = 0; t < exp; t++)
			if (!ticks.has(t)) problems.push(`${k}: missing tick ${t}`);

		const c = { met: 0, missed: 0, error: 0, timer_late: 0 };
		let faults = 0;
		for (const x of rows) {
			if (x.outcome in c) c[x.outcome]++;
			else if (CONFIG_FAULT.has(x.outcome)) faults++;
		}
		// recomputed counts must agree with the collector VERBATIM; if they do not,
		// the two files are not describing the same run.
		for (const f of ["n", "met", "missed", "error", "timer_late"])
			if (!Number.isInteger(r[f]))
				problems.push(`${k}: summary ${f}='${r[f]}' is not an integer`);
		if (r.n !== rows.length)
			problems.push(`${k}: summary n=${r.n} but ${rows.length} sample rows`);
		for (const f of ["met", "missed", "error", "timer_late"])
			if (r[f] !== c[f])
				problems.push(`${k}: summary ${f}=${r[f]} but samples give ${c[f]}`);
		// ⚠ Codex R14: a block whose SAMPLES contain a configuration fault could be
		// marked block_valid=true in the summary and was then accepted, because the
		// fault count was consulted only in the NA branch and classifyBlock trusted
		// the summary literal. spec section 4.0 already says no_token / unreachable /
		// invalid_auth are invalid terminal states; the code just was not enforcing
		// it. The summary is not permitted to contradict its own samples.
		if (faults > 0 && r.block_valid === "true")
			problems.push(
				`${k}: summary says block_valid=true but ${faults} sample(s) carry a configuration fault (no_token / unreachable / invalid_auth)`,
			);
		if (r.conservative !== "NA") {
			// ⚠ Number('not-a-number') is NaN, and every comparison against NaN is
			// false - so a non-numeric field slipped through the agreement check
			// silently. Validate that it IS a number before comparing.
			const reported = Number(r.conservative);
			if (!Number.isFinite(reported)) {
				problems.push(
					`${k}: summary conservative='${r.conservative}' is not a number`,
				);
			} else {
				const mine = (c.missed + c.error + c.timer_late) / rows.length;
				if (Math.abs(reported - mine) > 5e-5)
					problems.push(
						`${k}: summary conservative=${r.conservative} but samples give ${mine.toFixed(4)}`,
					);
			}
			const best = Number(r.best);
			if (!Number.isFinite(best))
				problems.push(`${k}: summary best_case='${r.best}' is not a number`);
		} else if (
			faults === 0 &&
			!r.block_valid.startsWith("incomplete_expected")
		) {
			problems.push(
				`${k}: summary says NA but samples carry no config fault and no incompleteness`,
			);
		}
	}

	// meta must agree with the wrapper's PREFLIGHT receipt: a mismatch means the
	// thing measured is not the thing the receipt certifies.
	const p = b.receipt.preflight || {};
	for (const [metaKey, recKey] of [
		["build_sha", "build_sha"],
		["bridge_worker_pid", "bridge_worker_pid"],
		["bridge_identity", "bridge_identity"],
	])
		if (
			p[recKey] !== undefined &&
			String(b.meta[metaKey]) !== String(p[recKey])
		)
			problems.push(
				`meta.${metaKey}='${b.meta[metaKey]}' but receipt says '${p[recKey]}'`,
			);

	return problems;
}

// ===================== inference_eligible: a TOTAL function =================
// Every terminal state the collector can produce maps to a named reason. The
// DEFAULT branch is refusal - "did not match anything" must never mean "allow".
export function classifyBlock(row) {
	const v = row.block_valid;
	if (v === "true") return { ok: true, reason: null };
	if (v === "false") return { ok: false, reason: "timer_late_void" }; // numeric survives
	if (v === "unknown") return { ok: false, reason: "no_samples" };
	if (v.startsWith("incomplete_expected"))
		return { ok: false, reason: "incomplete_expected" };
	if (v.startsWith("invalid_")) {
		if (/unreachable=[1-9]/.test(v))
			return { ok: false, reason: "invalid_unreachable" };
		if (/badauth=[1-9]/.test(v)) return { ok: false, reason: "invalid_auth" };
		if (/notoken=[1-9]/.test(v))
			return { ok: false, reason: "invalid_no_token" };
		return { ok: false, reason: "invalid_unspecified" };
	}
	return { ok: false, reason: "unclassified_terminal_state" };
}

// Failure dispositions that are ABOUT THE SERVICE OR THE HOST. These can never
// be replaced by a later good window: the windows that fail are exactly the ones
// where the machine was worst, so allowing a re-run to stand in for them is a
// survivor-bias machine. They are also findings in their own right - voided is
// not vanished (FLY-1986 plan section 9 item 15).
export const SERVICE_HOST_REASONS = new Set([
	"health_unreachable",
	"health_not_serving",
	"health_no_build_sha",
	"bridge_started_at_missing",
	"pressure_hold_unknown",
	"worker_pid_unresolved",
	"collector_guard_abort",
	"crash_before_terminal",
	"no_state_written",
]);
// The only failures a re-run may legitimately replace: they are about the
// operator or the harness, not about the machine under test. Capped at 2.
export const REPLACEABLE_REASONS = new Set([
	"cannot_source_collector",
	"operator_credential",
	"harness_fault",
	"storage_fault",
]);
export const MAX_REPLACEMENTS = 2;

// ⚠ Census-driven. An earlier version audited only the bundles the CALLER passed
// in, so a recorded service failure could be washed out by handing it three
// later good windows - Codex R5 built exactly that ledger and got
// {"inference_eligible":true,"authoritative_outcome":"A"}. The gate now starts
// from the ledger's own state graph and the attempt directories on disk.
export function censusProblems(ledger, bundles, evidenceDir) {
	const problems = [];
	if (!Array.isArray(ledger) || ledger.length === 0)
		return ["ledger is empty or unreadable"];

	const ids = ledger.map((a) => a.attempt_id).sort((x, y) => x - y);
	for (let i = 0; i < ids.length; i++)
		if (ids[i] !== i + 1) {
			problems.push(
				`attempt_id gap or duplicate near ${ids[i]} (expected ${i + 1})`,
			);
			break;
		}

	const dirs = new Set();
	let replacements = 0;
	for (const a of ledger) {
		if (dirs.has(a.dir)) problems.push(`duplicate attempt directory ${a.dir}`);
		dirs.add(a.dir);
		if (a.state !== "TERMINAL") {
			problems.push(
				`attempt ${a.attempt_id} is not terminal (state=${a.state})`,
			);
			continue;
		}
		if (a.disposition === undefined) {
			problems.push(`attempt ${a.attempt_id} terminal without a disposition`);
			continue;
		}
		// ⚠ Codex R14: this returned early for every completed/dry_run row BEFORE
		// looking at reason or exit_code, so a canonical record saying
		// disposition=completed, reason=health_unreachable, exit_code=1 was accepted
		// as a completed measurement window and produced no diagnostic at all. A
		// terminal record is a state machine, not three independent strings.
		if (a.disposition === "completed" || a.disposition === "dry_run") {
			const expected =
				a.disposition === "completed" ? "collector_ok" : "preflight_only";
			if (a.reason !== undefined && a.reason !== expected)
				problems.push(
					`attempt ${a.attempt_id} says disposition='${a.disposition}' but reason='${a.reason}' — a terminal record that contradicts itself is not evidence of anything`,
				);
			if (a.exit_code !== undefined && Number(a.exit_code) !== 0)
				problems.push(
					`attempt ${a.attempt_id} says disposition='${a.disposition}' but exit_code=${a.exit_code}`,
				);
			if (SERVICE_HOST_REASONS.has(String(a.reason)))
				problems.push(
					`attempt ${a.attempt_id} records the service/host failure '${a.reason}' while claiming to have completed — this window cannot be certified`,
				);
			continue;
		}

		const reason = String(a.reason || "");
		const svc =
			SERVICE_HOST_REASONS.has(reason) ||
			/^collector_exit_/.test(reason) ||
			/^pressure_hold_set_/.test(reason) ||
			/^receipt_contradicts_/.test(reason) ||
			reason === "signal";
		if (svc) {
			// NOT a reason to look harder for three clean windows. It is the answer.
			problems.push(
				`attempt ${a.attempt_id} failed for a service/host reason '${reason}' - this window cannot be certified and must not be replaced`,
			);
			continue;
		}
		if (REPLACEABLE_REASONS.has(reason)) {
			replacements++;
			if (replacements > MAX_REPLACEMENTS)
				problems.push(
					`more than ${MAX_REPLACEMENTS} replacement re-runs (${replacements}); the pre-registration caps them`,
				);
			continue;
		}
		problems.push(
			`attempt ${a.attempt_id} failed for an unclassified reason '${reason}' - refusing by default`,
		);
	}

	// ⚠ Two-way census AND canonical-state comparison. spec-baseline.md section 9
	// makes each attempt's own state.json the durable truth and the JSONL a merely
	// rebuildable index - but the first version read only the caller-supplied
	// JSONL. Codex R8 wrote three state.json files saying aborted/health_unreachable,
	// handed in a JSONL claiming completed, and got an authoritative A: the service
	// failures did not merely fail to force U, they disappeared. So every row is
	// now checked against the canonical state on disk.
	if (evidenceDir && existsSync(evidenceDir)) {
		const onDisk = readdirSync(evidenceDir).filter((f) =>
			/^attempt-\d+$/.test(f),
		);
		for (const d of onDisk)
			if (!dirs.has(d))
				problems.push(
					`attempt directory ${d} is on disk with no ledger record`,
				);
		for (const d of dirs)
			if (!onDisk.includes(d))
				problems.push(`ledger names ${d} but no such attempt directory exists`);
		for (const a of ledger) {
			const sp = join(evidenceDir, a.dir, "state.json");
			if (!existsSync(sp)) {
				problems.push(`${a.dir} has no canonical state.json`);
				continue;
			}
			let canon;
			try {
				canon = JSON.parse(readFileSync(sp, "utf8"));
			} catch {
				problems.push(`${a.dir} has unparseable canonical state.json`);
				continue;
			}
			for (const f of [
				"attempt_id",
				"window",
				"state",
				"disposition",
				"reason",
			]) {
				const l = a[f],
					c = canon[f];
				if (l === undefined && c === undefined) continue;
				if (String(l) !== String(c))
					problems.push(
						`${a.dir}: ledger says ${f}=${JSON.stringify(l)} but the canonical state says ${JSON.stringify(c)}`,
					);
			}
			// the directory name is the allocation authority, so the id must match it
			const fromDir = Number(a.dir.replace(/^attempt-0*/, ""));
			if (Number(canon.attempt_id) !== fromDir)
				problems.push(
					`${a.dir}: canonical attempt_id=${canon.attempt_id} disagrees with its directory name`,
				);
		}
	} else {
		problems.push(
			"no evidence directory given: the two-way attempt census cannot be performed",
		);
	}

	for (const b of bundles)
		if (!dirs.has(basename(b.dir)))
			problems.push(`bundle ${basename(b.dir)} has no ledger record`);

	// ⚠ Counting completed windows is not enough: it let a caller pass the same
	// bundle twice, or pass bundles whose ledger rows are not the completed ones,
	// or mismatch window numbers. Bind each analysed bundle to exactly ONE
	// terminal completed row and require the window set to be exactly {1..N}.
	const byDir = new Map(ledger.map((a) => [a.dir, a]));
	const seenDirs = new Set();
	const seenWindows = new Set();
	for (const b of bundles) {
		const tag = basename(b.dir);
		if (seenDirs.has(tag)) {
			problems.push(`bundle ${tag} was passed more than once`);
			continue;
		}
		seenDirs.add(tag);
		const row = byDir.get(tag);
		if (!row) continue; // already reported above
		if (row.disposition !== "completed")
			problems.push(
				`bundle ${tag} is analysed but its ledger row says disposition='${row.disposition}'`,
			);
		if (row.window === undefined)
			problems.push(`bundle ${tag} has no window number in the ledger`);
		else if (seenWindows.has(row.window))
			problems.push(
				`window ${row.window} is claimed by more than one analysed bundle`,
			);
		else seenWindows.add(row.window);
		if (
			b.receipt &&
			row.window !== undefined &&
			b.receipt.window !== row.window
		)
			problems.push(
				`bundle ${tag}: receipt says window ${b.receipt.window}, ledger says ${row.window}`,
			);
		if (
			b.receipt &&
			row.attempt_id !== undefined &&
			Number(b.receipt.attempt_id) !== Number(row.attempt_id)
		)
			problems.push(
				`bundle ${tag}: receipt says attempt_id ${b.receipt.attempt_id}, ledger says ${row.attempt_id}`,
			);
		// the terminal record carries artifact hashes; verify them rather than
		// writing them and never looking (Codex R6).
		if (row.artifacts) {
			for (const [f, h] of Object.entries(row.artifacts)) {
				const actual = b.fileHashes && b.fileHashes[f];
				if (actual && actual !== h)
					problems.push(
						`bundle ${tag}: ${f} hash ${actual.slice(0, 12)} != the terminal record's ${String(h).slice(0, 12)}`,
					);
			}
		}
	}
	const want = Array.from({ length: WINDOWS }, (_, i) => i + 1);
	if ([...seenWindows].sort((x, y) => x - y).join(",") !== want.join(","))
		problems.push(
			`the analysed bundles cover windows {${[...seenWindows].sort((x, y) => x - y)}}, the frozen design needs {${want}}`,
		);
	// ⚠ TWO-WAY. Checking only "every bundle has a row" let a caller silently drop
	// an extra completed window - selecting evidence by omission.
	for (const a of ledger)
		if (a.disposition === "completed" && !seenDirs.has(a.dir))
			problems.push(
				`ledger has a completed attempt ${a.dir} (window ${a.window}) that was not analysed`,
			);
	// every completed row must carry a hash for all four bundle files
	for (const a of ledger) {
		if (a.disposition !== "completed") continue;
		const have = Object.keys(a.artifacts || {});
		for (const f of BUNDLE_FILES)
			if (!have.includes(f))
				problems.push(
					`completed attempt ${a.dir} has no recorded hash for ${f}`,
				);
	}

	// Replacements must be an explicit, acyclic, named graph - counting them let a
	// caller add replaceable failures without ever pointing at what they replaced.
	const terminalById = new Map(ledger.map((a) => [a.attempt_id, a]));
	// ⚠ Validating an edge only when the caller supplies one proves nothing: a
	// re-run with the edge simply omitted sailed through. Every replaceable
	// failure must be answered by exactly one completed attempt in the SAME window
	// that names it.
	const replacedBy = new Map();
	for (const a of ledger)
		if (a.disposition === "completed" && a.replacement_of !== undefined) {
			if (replacedBy.has(a.replacement_of))
				problems.push(
					`attempts ${replacedBy.get(a.replacement_of)} and ${a.attempt_id} both claim to replace ${a.replacement_of}`,
				);
			replacedBy.set(a.replacement_of, a.attempt_id);
		}
	for (const a of ledger) {
		// ⚠ Codex R14: this returned early for every completed/dry_run row BEFORE
		// looking at reason or exit_code, so a canonical record saying
		// disposition=completed, reason=health_unreachable, exit_code=1 was accepted
		// as a completed measurement window and produced no diagnostic at all. A
		// terminal record is a state machine, not three independent strings.
		if (a.disposition === "completed" || a.disposition === "dry_run") {
			const expected =
				a.disposition === "completed" ? "collector_ok" : "preflight_only";
			if (a.reason !== undefined && a.reason !== expected)
				problems.push(
					`attempt ${a.attempt_id} says disposition='${a.disposition}' but reason='${a.reason}' — a terminal record that contradicts itself is not evidence of anything`,
				);
			if (a.exit_code !== undefined && Number(a.exit_code) !== 0)
				problems.push(
					`attempt ${a.attempt_id} says disposition='${a.disposition}' but exit_code=${a.exit_code}`,
				);
			if (SERVICE_HOST_REASONS.has(String(a.reason)))
				problems.push(
					`attempt ${a.attempt_id} records the service/host failure '${a.reason}' while claiming to have completed — this window cannot be certified`,
				);
			continue;
		}
		if (!REPLACEABLE_REASONS.has(String(a.reason))) continue;
		const heir = replacedBy.get(a.attempt_id);
		if (heir === undefined) {
			problems.push(
				`attempt ${a.attempt_id} failed for the replaceable reason '${a.reason}' but no completed attempt names it in replacement_of — a silent re-run`,
			);
			continue;
		}
		const heirRow = terminalById.get(heir);
		if (heirRow && a.window !== undefined && heirRow.window !== a.window)
			problems.push(
				`attempt ${heir} replaces ${a.attempt_id} but covers window ${heirRow.window}, not ${a.window}`,
			);
	}
	for (const a of ledger) {
		if (a.disposition === "completed" && a.replacement_of !== undefined) {
			const target = terminalById.get(a.replacement_of);
			if (!target)
				problems.push(
					`attempt ${a.attempt_id} claims to replace ${a.replacement_of}, which is not in the ledger`,
				);
			else if (!REPLACEABLE_REASONS.has(String(target.reason)))
				problems.push(
					`attempt ${a.attempt_id} replaces ${a.replacement_of}, whose reason '${target.reason}' is not replaceable`,
				);
			else if (target.replacement_of !== undefined)
				problems.push(`replacement chain detected at attempt ${a.attempt_id}`);
		}
	}

	return problems;
}

// Every field spec-baseline.md section 9.1 pre-registers. Missing or unknown is
// a refusal - "compare it only if it happens to be there" let a receipt with an
// entirely empty preflight block pass.
export const REQUIRED_RECEIPT_FIELDS = [
	"build_sha",
	"bridge_started_at",
	"bridge_worker_pid",
	"bridge_identity",
	"health_ok",
	"shutting_down",
	"pressure_hold",
	"load1",
];

export function receiptProblems(b, freezeCommit, repoRootForSpec) {
	const problems = [];
	const p = (b.receipt && b.receipt.preflight) || {};
	for (const f of REQUIRED_RECEIPT_FIELDS) {
		const v = p[f];
		if (
			v === undefined ||
			v === null ||
			v === "" ||
			v === "unknown" ||
			v === "unresolved"
		)
			problems.push(
				`receipt is missing or unknown for the pre-registered field '${f}'`,
			);
	}
	if (p.health_ok !== "true")
		problems.push(`receipt says health_ok='${p.health_ok}'`);
	if (p.shutting_down !== "false")
		problems.push(`receipt says shutting_down='${p.shutting_down}'`);
	if (p.pressure_hold !== "0")
		problems.push(`receipt says pressure_hold='${p.pressure_hold}'`);
	// ⚠ COLLECTION freeze and ANALYSIS freeze are two different things, and
	// requiring them to be equal was my own conflation. The receipt records which
	// code COLLECTED the window; the analyser verifies its own bytes against the
	// commit it is ANALYSING under. Those legitimately differ once a Lead-approved
	// fix lands between collection and analysis - as happened here, when Codex R14
	// found three ways the analyser could certify without the evidence.
	//
	// What must hold instead, and what actually protects the pre-registration:
	//   1. the collection freeze is recorded and was verified at collection time
	//   2. the analysis freeze is an ancestor-or-descendant of it (same history)
	//   3. ⭐ the SPEC BLOB IS IDENTICAL at both commits - the rules did not change,
	//      only the code that enforces them
	// (3) is the one that matters. An implementation may be corrected; a rule may
	// not, once data exists.
	if (!b.receipt || !b.receipt.freeze_commit) {
		problems.push("receipt carries no freeze_commit");
		return problems;
	}
	const collectFreeze = b.receipt.freeze_commit;
	if (freezeCommit && collectFreeze !== freezeCommit && repoRootForSpec) {
		const specPath =
			"engineering/doc/FLY-2007-capacity-stress-execution/spec-baseline.md";
		let atCollect, atAnalyse;
		try {
			atCollect = execFileSync(
				"git",
				["-C", repoRootForSpec, "rev-parse", `${collectFreeze}:${specPath}`],
				{ encoding: "utf8" },
			).trim();
		} catch {
			problems.push(
				`cannot read the spec at the collection freeze ${collectFreeze}`,
			);
			return problems;
		}
		try {
			atAnalyse = execFileSync(
				"git",
				["-C", repoRootForSpec, "rev-parse", `${freezeCommit}:${specPath}`],
				{ encoding: "utf8" },
			).trim();
		} catch {
			problems.push(
				`cannot read the spec at the analysis freeze ${freezeCommit}`,
			);
			return problems;
		}
		if (atCollect !== atAnalyse)
			problems.push(
				`the pre-registration CHANGED between collection (${collectFreeze.slice(0, 12)}) and analysis (${freezeCommit.slice(0, 12)}) — a rule may not change once data exists`,
			);
		let related = false;
		try {
			execFileSync(
				"git",
				[
					"-C",
					repoRootForSpec,
					"merge-base",
					"--is-ancestor",
					collectFreeze,
					freezeCommit,
				],
				{ stdio: "ignore" },
			);
			related = true;
		} catch {
			related = false;
		}
		if (!related)
			problems.push(
				`the analysis freeze ${freezeCommit.slice(0, 12)} is not a descendant of the collection freeze ${collectFreeze.slice(0, 12)}`,
			);
	}
	return problems;
}

// ⚠ "this commit exists" is not "the code that ran is this commit". Codex R6
// demonstrated the gap by handing a stale but real commit to a wrapper running
// newer blobs and having it accepted. Compare the frozen files' blob hashes.
export const FROZEN_FILES = [
	"scripts/qa-fly-2007-phase0-analyze.mjs",
	"scripts/qa-fly-2007-phase0-simulate.mjs",
	"scripts/qa-fly-2007-phase0-run-window.sh",
	"engineering/doc/FLY-2007-capacity-stress-execution/spec-baseline.md",
];
// ⚠ The repository root is DERIVED FROM THIS FILE, never accepted as an
// argument. Codex R12 pointed --repo-root at a clean surrogate checkout while
// different analyser bytes actually ran and released A: the check attested to a
// directory it was told about rather than to the code doing the deciding. The
// root is now `../..` from this module's own resolved path, so the bytes being
// verified are necessarily the bytes running.
export function selfRepoRoot() {
	return dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
}

export function freezeDriftProblems(freezeCommit, repoRoot = selfRepoRoot()) {
	if (!freezeCommit) return ["no freeze commit given"];
	const problems = [];
	for (const f of FROZEN_FILES) {
		let frozen, current;
		try {
			frozen = execFileSync(
				"git",
				["-C", repoRoot, "rev-parse", `${freezeCommit}:${f}`],
				{ encoding: "utf8" },
			).trim();
		} catch {
			problems.push(`${f} does not exist at the freeze commit`);
			continue;
		}
		try {
			current = execFileSync("git", ["-C", repoRoot, "hash-object", f], {
				encoding: "utf8",
			}).trim();
		} catch {
			problems.push(`${f} cannot be hashed in the working tree`);
			continue;
		}
		if (frozen !== current)
			problems.push(
				`${f} has drifted from the freeze commit (${frozen.slice(0, 12)} -> ${current.slice(0, 12)})`,
			);
	}
	return problems;
}

// NOTE: an earlier design accepted a sensitivity ARTIFACT and tried to
// authenticate it - first with a provenance digest, then by recomputing its
// verdict from the counts it carried. Both were defeated (a digest attests to
// configuration, not results; counts can simply be typed). The artifact input is
// gone and so is its validation code, deliberately: leaving behind functions that
// describe a deleted contract invites the next maintainer to believe they are
// still a release gate. The simulator is now run in-process; see main().

// ⚠ The caller no longer supplies the evidence set. Codex R9 passed bundles from
// OUTSIDE the evidence root and got an eligible authoritative A - and every
// earlier round found another way to select or substitute what was handed in.
// Policing a caller-supplied list kept failing, so the list is gone: the analysis
// set is DISCOVERED from the canonical state files under the evidence root.
// There is nothing left to choose.
export function discoverBundles(evidenceDir) {
	const dirs = readdirSync(evidenceDir)
		.filter((f) => /^attempt-\d+$/.test(f))
		.sort();
	const completed = [];
	const problems = [];
	for (const d of dirs) {
		const sp = join(evidenceDir, d, "state.json");
		if (!existsSync(sp)) {
			problems.push(`${d} has no canonical state.json`);
			continue;
		}
		let st;
		try {
			st = JSON.parse(readFileSync(sp, "utf8"));
		} catch {
			problems.push(`${d} has unparseable canonical state.json`);
			continue;
		}
		if (st.disposition === "completed") completed.push(join(evidenceDir, d));
	}
	return { completed, problems };
}

export function eligibility(bundles, ledger, opts = {}) {
	const reasons = [];
	if (!opts.freezeCommit)
		reasons.push(
			"no --freeze-commit given: the analysis cannot be bound to frozen code",
		);
	else
		for (const p of freezeDriftProblems(opts.freezeCommit, selfRepoRoot()))
			reasons.push(`freeze: ${p}`);
	// ⚠ No artifact is trusted. R8 showed a hand-written file with a correct digest
	// releasing A; R9 showed hand-written COUNTS doing the same, because a digest
	// over the configuration cannot attest to results. The simulator is fully
	// deterministic in (seed, grid, K, M), so the analyser RUNS IT and uses its own
	// numbers. There is no longer anything to forge - the artifact on disk becomes
	// an audit record, not an input.
	// spec-baseline.md section 7 lists four acceptance items; only two were
	// implemented until Codex R10 found A being released without the other two.
	if (opts.parameterSetGate && !opts.parameterSetGate.pass)
		reasons.push(
			`sensitivity: the frozen grid cannot reach the pilot's observed block rates ${JSON.stringify(opts.parameterSetGate.outside)} — it does not describe the regime being measured`,
		);
	if (opts.applicabilityGate && !opts.applicabilityGate.pass)
		for (const p of opts.applicabilityGate.problems)
			reasons.push(`applicability: ${p}`);
	if (opts.sensitivityResult && !opts.parameterSetGate)
		reasons.push("sensitivity: the parameter-set gate was not evaluated");
	if (opts.sensitivityResult && bundles.length && !opts.applicabilityGate)
		reasons.push("applicability: the domain gate was not evaluated");
	if (opts.sensitivityReduced)
		reasons.push(
			`the sensitivity analysis ran at a reduced replicate count (${opts.simM}); a verdict requires the frozen M`,
		);
	if (!opts.sensitivityResult)
		reasons.push("the sensitivity analysis was not run in this process");
	else {
		for (const key of ["b_lb_A", "range_lb_N"]) {
			const cfg = opts.sensitivityResult.configurations[key];
			if (!cfg) {
				reasons.push(`sensitivity: configuration '${key}' is missing`);
				continue;
			}
			if (!cfg.pass)
				reasons.push(
					`sensitivity: configuration '${key}' does not hold its level at every frozen grid point`,
				);
		}
		const c = opts.sensitivityResult.controls;
		if (!c.positive.pass)
			reasons.push(
				"sensitivity: the positive control does not PROVE under-coverage — the simulator may carry no dependence at all",
			);
		if (!c.oracle.pass)
			reasons.push("sensitivity: the oracle control does not hold");
		if (!c.seed_stability.pass)
			reasons.push("sensitivity: the seed-stability control did not pass");
	}
	for (const f of opts.loadFailures || [])
		reasons.push(`bundle could not be loaded: ${f}`);
	if (bundles.length !== WINDOWS)
		reasons.push(`expected ${WINDOWS} windows, got ${bundles.length}`);
	for (const b of bundles) {
		const tag = basename(b.dir);
		for (const p of receiptProblems(b, opts.freezeCommit, selfRepoRoot()))
			reasons.push(`${tag}: ${p}`);
		for (const p of checkIntegrity(b)) reasons.push(`${tag}: integrity: ${p}`);
		for (const ep of ENDPOINTS) {
			const rows = b.summary.filter((r) => r.endpoint === ep);
			if (b.meta.block_seconds !== 300)
				reasons.push(
					`${tag}: block_seconds=${b.meta.block_seconds}, the frozen design says 300`,
				);
			if (b.meta.endpoints.join(",") !== ENDPOINTS.join(","))
				reasons.push(
					`${tag}: endpoints=${b.meta.endpoints}, the frozen design says ${ENDPOINTS}`,
				);
			if (rows.length !== UNITS_PER_WINDOW)
				reasons.push(
					`${tag}/${ep}: ${rows.length} units, the frozen design says ${UNITS_PER_WINDOW}`,
				);
			for (const r of rows) {
				const c = classifyBlock(r);
				if (!c.ok) reasons.push(`${tag}/${ep}/${r.block}: ${c.reason}`);
			}
		}
	}
	for (const p of censusProblems(ledger, bundles, opts.evidenceDir))
		reasons.push(`ledger: ${p}`);
	return { eligible: reasons.length === 0, reasons };
}

// ============================== outcome machine =============================
export function unitsFor(bundle, endpoint) {
	return bundle.summary
		.filter((r) => r.endpoint === endpoint)
		.map((r) => ({
			violations: r.missed + r.error + r.timer_late,
			ticks: r.n,
		}));
}

export function analyse(bundles, ledger, opts = {}) {
	const elig = eligibility(bundles, ledger, opts);
	const perEndpoint = {};

	for (const ep of ENDPOINTS) {
		const windows = bundles.map((b, i) => {
			const u = unitsFor(b, ep);
			return {
				window: i + 1,
				dir: basename(b.dir),
				units: u.length,
				pointEstimate: u.length
					? u.reduce((s, x) => s + x.violations / x.ticks, 0) / u.length
					: null,
				// four configurations, each at its own frozen level - never substituted
				ub_perf: u.length ? boundUpper(u, GRID, A_PERF).bound : null, // B performance
				lb_adv: u.length ? boundLower(u, GRID, A_ADV).bound : null, // A
				ub_equiv: u.length ? boundUpper(u, GRID, A_EQUIV).bound : null, // B equivalence
				lb_equiv: u.length ? boundLower(u, GRID, A_EQUIV).bound : null, // B equivalence
				ub_range: u.length ? boundUpper(u, GRID, A_RANGE).bound : null, // N
				lb_range: u.length ? boundLower(u, GRID, A_RANGE).bound : null, // N
			};
		});
		const complete = windows.every((w) => w.ub_perf !== null);
		perEndpoint[ep] = {
			windows,
			// range_ub feeds B (equivalence gate); range_lb feeds N. Different levels,
			// so two separate sets of intervals - one must never stand in for the other.
			equiv: complete
				? rangeBounds(
						windows.map((w) => ({ upper: w.ub_equiv, lower: w.lb_equiv })),
					)
				: null,
			nrange: complete
				? rangeBounds(
						windows.map((w) => ({ upper: w.ub_range, lower: w.lb_range })),
					)
				: null,
		};
	}

	// Upstream's literal three-state verdict, kept as a NON-AUTHORITATIVE
	// compatibility field under the Lead's superseding decision of 2026-08-23.
	let upstreamLiteral = "B";
	for (const ep of ENDPOINTS)
		for (const w of perEndpoint[ep].windows)
			if (w.ub_perf === null || w.ub_perf > SLO) upstreamLiteral = "A";

	const flags = [];
	let outcome, reason;
	if (!elig.eligible) {
		outcome = "U";
		reason = "inference_ineligible";
		flags.push("availability_finding");
	} else {
		// ⚠ A and N may only be CLAIMED when their own gate-critical sensitivity
		// configuration passed. The bound clearing the line is necessary, not
		// sufficient: assumption A1 (iid units) is known to be false, and the
		// simulator is what says how much that costs. Without it the claim would be
		// "exact under an assumption nobody checked".
		const sens = opts.sensitivityResult || {};
		const aSensOk =
			sens.configurations &&
			sens.configurations.b_lb_A &&
			sens.configurations.b_lb_A.pass === true;
		const provedBad =
			aSensOk &&
			ENDPOINTS.some((ep) =>
				perEndpoint[ep].windows.some((w) => w.lb_adv > SLO),
			);
		const boundsWouldSayA = ENDPOINTS.some((ep) =>
			perEndpoint[ep].windows.some((w) => w.lb_adv > SLO),
		);
		if (boundsWouldSayA && !aSensOk)
			flags.push("bounds_clear_A_but_sensitivity_did_not_pass");
		// ⚠ N is authoritative again. The Lead first trimmed it out on the premises
		// that it was structurally unreachable and would cost extra work; the frozen
		// simulator falsified both (configuration #4 passes at all eight grid points,
		// and the code already existed), so the ruling was revised on the evidence.
		// Both the original ruling and the revision are recorded in spec-baseline.md.
		const nSensOk =
			sens.configurations &&
			sens.configurations.range_lb_N &&
			sens.configurations.range_lb_N.pass === true;
		const provedDrift =
			nSensOk &&
			ENDPOINTS.some(
				(ep) =>
					perEndpoint[ep].nrange && perEndpoint[ep].nrange.rangeLb > DELTA,
			);
		const boundsWouldSayN = ENDPOINTS.some(
			(ep) => perEndpoint[ep].nrange && perEndpoint[ep].nrange.rangeLb > DELTA,
		);
		if (boundsWouldSayN && !nSensOk)
			flags.push("bounds_clear_N_but_sensitivity_did_not_pass");
		const perfOk = ENDPOINTS.every((ep) =>
			perEndpoint[ep].windows.every((w) => w.ub_perf <= SLO),
		);
		const equivOk = ENDPOINTS.every(
			(ep) => perEndpoint[ep].equiv && perEndpoint[ep].equiv.rangeUb < DELTA,
		);
		if (provedBad) {
			outcome = "A";
			reason = "lower bound exceeds the SLO";
			if (provedDrift) flags.push("also_non_equivalent");
		} else if (provedDrift) {
			outcome = "N";
			reason = "range lower bound exceeds delta";
		} else if (perfOk && equivOk) {
			outcome = "B";
			reason = "all gates certified";
		} else {
			outcome = "U";
			reason = boundsWouldSayA
				? "the lower bound clears the SLO but the A-direction sensitivity gate did not pass"
				: "neither certification nor refutation is provable at this exposure";
		}
	}
	if (outcome === "U" && upstreamLiteral === "A")
		flags.push("upstream_literal_disagrees");

	return {
		schema: "fly2007-phase0-analysis/1",
		sensitivity: opts.sensitivityResult
			? {
					computed_in_process: true,
					summary: opts.sensitivityResult.summary,
					parameter_set_gate: opts.parameterSetGate
						? {
								pass: opts.parameterSetGate.pass,
								has_rejection_region:
									opts.parameterSetGate.has_rejection_region,
								strength: opts.parameterSetGate.strength,
							}
						: null,
					applicability_gate: opts.applicabilityGate
						? {
								pass: opts.applicabilityGate.pass,
								problems: opts.applicabilityGate.problems,
							}
						: null,
				}
			: null,
		freeze_commit: opts.freezeCommit || null,
		bundles: bundles.map((b) => ({
			dir: basename(b.dir),
			sha256: b.bundleSha256,
			build_sha: b.meta.build_sha,
			collection_freeze: b.receipt && b.receipt.freeze_commit,
		})),
		analysis_freeze: opts.freezeCommit || null,
		alpha_allocation: {
			SLO,
			DELTA,
			G,
			components: COMPONENTS,
			alpha_B: ALPHA_B,
			alpha_A: ALPHA_A,
			alpha_N: ALPHA_N,
			per_cp: {
				B_performance: A_PERF,
				B_equivalence: A_EQUIV,
				A_adverse: A_ADV,
				N_range: A_RANGE,
			},
			note: "B is an intersection-union test: no correction between components or between the performance and equivalence gates. A unions 6 components x G thresholds. N unions 2 endpoints then 3 windows x 2 tails x G. alpha_A + alpha_N = 0.05.",
		},
		assumption: `A1: the ${UNITS_PER_WINDOW} units within a window are iid. The two moment inequalities are unconditional; the Clopper-Pearson step - and therefore the word "exact" - holds UNDER A1. A1 is not asserted to be true; its failure cost is quantified by the frozen simulator.`,
		inference_eligible: elig.eligible,
		ineligibility_reasons: elig.reasons,
		per_endpoint: elig.eligible ? perEndpoint : markDescriptive(perEndpoint),
		authoritative_outcome: outcome,
		authoritative_outcome_set_this_round: ["A", "U"],
		authoritative_set_note:
			"Lead ruling 2026-08-23, then revised, then RESTORED after the revision turned out to rest on a vacuous measurement. N was first trimmed out as structurally unreachable; I reported that configuration #4 passed at all eight grid points and the ruling was reversed on that; R14 then showed the pass was vacuous because the procedure can never exclude a true range of 0. See n_reachability for the arithmetic. Final: {A, U}. B remains documentation-only at this exposure. All three rulings are recorded, none overwritten.",
		authoritative_reason: reason,
		flags,
		n_reachability: nReachability(),
		upstream_literal_outcome: upstreamLiteral,
		upstream_literal_status:
			"NON-AUTHORITATIVE compatibility field (Lead superseding decision, 2026-08-23)",
	};
}

function markDescriptive(perEndpoint) {
	const out = {};
	for (const [ep, v] of Object.entries(perEndpoint))
		out[ep] = { descriptive_only: true, ...v };
	return out;
}

// ⚠ N is not reachable at the frozen parameters, and that is arithmetic rather
// than a rule. The widest a window's lower bound can ever be is the all-violation
// value; the narrowest a window's upper bound can ever be is the all-clean value.
// At J=30 and the N-family per-CP level those are 0.154297 and 0.228517, so
// max(L) - min(U) is always negative and range_lb is clamped to 0. `range_lb > δ`
// therefore has an EMPTY rejection region.
//
// This is why the "#4 passes at all eight grid points" result I reported was
// worthless: the procedure can never exclude the true range of 0, so of course it
// covered 5000/5000. A test that cannot fail is not evidence that its conclusion
// is reachable - it is evidence that the test is vacuous. The Lead's original
// ruling (N out) was right and I talked him out of it with that number.
//
// ⚠ Deliberately NOT implemented by editing spec-baseline.md. The spec blob must
// be byte-identical between the collection freeze and the analysis freeze, so
// editing it now would invalidate W1 and W2 - by exactly the protection that
// exists to stop rules moving once data exists. Nothing in the spec needs to
// change anyway: N is already unreachable UNDER the frozen rules. This function
// records the proof so the output states it rather than leaving a dead branch
// looking live.
export function nReachability() {
	const J = UNITS_PER_WINDOW;
	const allBad = Array.from({ length: J }, () => ({
		violations: 150,
		ticks: 150,
	}));
	const allClean = Array.from({ length: J }, () => ({
		violations: 0,
		ticks: 150,
	}));
	const maxLower = boundLower(allBad, GRID, A_RANGE).bound;
	const minUpper = boundUpper(allClean, GRID, A_RANGE).bound;
	return {
		units: J,
		per_cp_level: A_RANGE,
		max_possible_window_lower: maxLower,
		min_possible_window_upper: minUpper,
		max_possible_range_lower: Math.max(0, maxLower - minUpper),
		delta: DELTA,
		reachable: Math.max(0, maxLower - minUpper) > DELTA,
		note: "An empty rejection region, not low power. Lead ruling 2026-08-23: the authoritative outcome set this round is {A, U}; a non-equivalence signal is a descriptive flag on U. Recorded here rather than by editing the frozen spec, because the spec blob must match between collection and analysis.",
	};
}

// ============================ exposure calculator ===========================
// How much sentinel exposure would be needed to certify, all-clean. Ceilings
// everywhere: a fractional unit does not exist and rounding down understates the
// bill. B binds on whichever sub-gate is HARDER - and it is the equivalence gate,
// not the performance gate, by roughly 2.8x.
export function unitsForAllCleanBound(target, alphaPerCp) {
	// all-clean: K(c)=0 for every c, so pi_ub = 1 - alpha^(1/J) and the tightest
	// threshold is c=0, giving bound = pi_ub. Solve 1 - alpha^(1/J) <= target.
	if (!(target > 0 && target < 1))
		throw new Error(`unitsForAllCleanBound: bad target ${target}`);
	return Math.ceil(Math.log(alphaPerCp) / Math.log(1 - target));
}

export function exposureRequired(blockSeconds = 300) {
	const perf = unitsForAllCleanBound(SLO, A_PERF);
	const equiv = unitsForAllCleanBound(DELTA, A_EQUIV);
	const fullB = Math.max(perf, equiv); // full B = the HARDER sub-gate
	const hrs = (J) => (J * blockSeconds) / 3600;
	const deltaCost = [0.01, 0.02, 0.025, 0.05, 0.1, 0.15, 0.2].map((d) => {
		const je = unitsForAllCleanBound(d, A_EQUIV);
		const jb = Math.max(perf, je);
		return {
			delta: d,
			units_equiv_gate: je,
			units_full_B: jb,
			hours_per_window: hrs(jb),
			hours_three_windows: 3 * hrs(jb),
		};
	});
	return {
		schema: "fly2007-phase0-exposure/1",
		block_seconds: blockSeconds,
		B_performance_gate: {
			alpha_per_cp: A_PERF,
			target: SLO,
			units: perf,
			hours_per_window: hrs(perf),
		},
		B_equivalence_gate: {
			alpha_per_cp: A_EQUIV,
			target: DELTA,
			units: equiv,
			hours_per_window: hrs(equiv),
		},
		full_B: {
			units: fullB,
			binding_gate: equiv >= perf ? "equivalence" : "performance",
			hours_per_window: hrs(fullB),
			hours_three_windows: 3 * hrs(fullB),
		},
		this_round_budget: {
			units_per_window: UNITS_PER_WINDOW,
			hours_per_window: hrs(UNITS_PER_WINDOW),
			shortfall_factor_full_B: fullB / UNITS_PER_WINDOW,
		},
		delta_cost_table: deltaCost,
		note: "Hoeffding would need 600 units for the same performance target; that number is descriptive only and is NOT this judge's requirement.",
	};
}

// ================================== self-test ===============================
// The positive control is NOT of my own making: FLY-1986 plan section 5.3 prints
// a zero-violation Clopper-Pearson table and records that it was independently
// double-checked. If my bisection disagrees with that table, my bisection is
// wrong. Closed form at x=0 is 1 - alpha^(1/n), checked alongside.
export function selfTest() {
	const t = [];
	const ck = (name, cond) => t.push({ name, pass: !!cond });
	const near = (a, b, tol) => Math.abs(a - b) < tol;

	for (const [n, exp] of [
		[6, 0.393],
		[18, 0.1533],
		[36, 0.0798],
		[58, 0.0503],
		[59, 0.0495],
		[90, 0.0327],
		[270, 0.011],
		[540, 0.0055],
	]) {
		const got = cpUpper(0, n, 0.05);
		ck(
			`FLY-1986 5.3 table n=${n} -> ${(exp * 100).toFixed(2)}%`,
			near(got, exp, 5e-5) && near(got, 1 - 0.05 ** (1 / n), 1e-12),
		);
	}
	const clean = Array.from({ length: 13 }, () => ({
		violations: 0,
		ticks: 150,
	}));
	const c0 = [{ num: 0, den: 1 }],
		c20 = [{ num: 1, den: 5 }];
	ck(
		"hand-check (13-unit fixture): all-clean upper @0.05 = 20.58%",
		near(boundUpper(clean, c0, 0.05).bound, 0.205817, 1e-5),
	);
	ck(
		"hand-check (13-unit fixture): all-clean upper @0.01 = 29.83%",
		near(boundUpper(clean, c0, 0.01).bound, 0.298296, 1e-5),
	);
	const bad = Array.from({ length: 13 }, () => ({
		violations: 32,
		ticks: 150,
	}));
	ck(
		"hand-check (13-unit fixture): all>0.2 lower @0.05 = 15.88%",
		near(boundLower(bad, c20, 0.05).bound, 0.158837, 1e-5),
	);
	ck(
		"hand-check (13-unit fixture): all>0.2 lower @0.05/30 = 12.23%",
		near(boundLower(bad, c20, 0.05 / 30).bound, 0.122272, 1e-5),
	);

	// Exact ties are REACHABLE: 3/150 == 0.02 and 15/150 == 0.10. Strict > means
	// they must NOT count, and integer cross multiplication is what guarantees it.
	ck(
		"tie 3/150 is NOT > 0.02",
		countAbove([{ violations: 3, ticks: 150 }], { num: 1, den: 50 }) === 0,
	);
	ck(
		"4/150 IS > 0.02",
		countAbove([{ violations: 4, ticks: 150 }], { num: 1, den: 50 }) === 1,
	);
	ck(
		"tie 15/150 is NOT > 0.10",
		countAbove([{ violations: 15, ticks: 150 }], { num: 1, den: 10 }) === 0,
	);
	ck(
		"tie 0/150 is NOT > 0",
		countAbove([{ violations: 0, ticks: 150 }], { num: 0, den: 1 }) === 0,
	);
	ck(
		"1/150 IS > 0",
		countAbove([{ violations: 1, ticks: 150 }], { num: 0, den: 1 }) === 1,
	);

	ck("K=0 lower bound is 0", boundLower(clean, GRID, 0.05).bound === 0);
	ck(
		"K=J upper bound is 1 at c=0",
		near(boundUpper(bad, c0, 0.05).bound, 1, 1e-9),
	);
	ck(
		"bounds are ordered (lb <= ub) on mixed data",
		(() => {
			const mix = Array.from({ length: 13 }, (_, i) => ({
				violations: i * 5,
				ticks: 150,
			}));
			return (
				boundLower(mix, GRID, A_ADV).bound <=
				boundUpper(mix, GRID, A_PERF).bound
			);
		})(),
	);

	ck(
		"exposure: full B binds on the equivalence gate, not performance",
		exposureRequired().full_B.binding_gate === "equivalence",
	);
	ck(
		"exposure: full B = max(perf, equiv) = 253",
		exposureRequired().full_B.units === 253,
	);
	ck(
		"exposure: performance sub-gate alone = 90",
		exposureRequired().B_performance_gate.units === 90,
	);
	ck(
		"exposure ceilings up (J=89 would miss)",
		near(1 - A_PERF ** (1 / 89), 0.0504, 1e-4),
	);

	ck("alpha_A + alpha_N = 0.05", near(ALPHA_A + ALPHA_N, 0.05, 1e-12));
	ck("A per-CP = alpha_A/(6G)", near(A_ADV, ALPHA_A / (6 * G), 1e-15));
	ck("N per-CP = alpha_N/(2*6G)", near(A_RANGE, ALPHA_N / (12 * G), 1e-15));
	ck(
		"B equivalence per-CP = alpha_B/(6G)",
		near(A_EQUIV, ALPHA_B / (6 * G), 1e-15),
	);

	ck(
		"unknown collector state refuses by default",
		classifyBlock({ block_valid: "a_state_that_does_not_exist_yet" }).reason ===
			"unclassified_terminal_state",
	);
	ck(
		"timer_late void keeps numbers but refuses",
		classifyBlock({ block_valid: "false" }).reason === "timer_late_void",
	);

	ck(
		"range_ub is a valid upper bound on the range",
		(() => {
			const w = [
				{ upper: 0.3, lower: 0.1 },
				{ upper: 0.2, lower: 0.05 },
				{ upper: 0.6, lower: 0.4 },
			];
			return near(rangeBounds(w).rangeUb, 0.6 - 0.05, 1e-12);
		})(),
	);
	ck(
		"range_lb clamps at zero when the intervals overlap",
		(() => {
			const w = [
				{ upper: 0.3, lower: 0.1 },
				{ upper: 0.35, lower: 0.12 },
			];
			return rangeBounds(w).rangeLb === 0;
		})(),
	);
	// These came from mutants that survived the first harness run: the properties
	// were true but nothing asserted them, so breaking them stayed green.
	ck(
		"unitsFor counts timer_late as a violation (conservative口径)",
		(() => {
			const b = {
				summary: [
					{ endpoint: "L1", missed: 2, error: 1, timer_late: 3, n: 150 },
				],
			};
			return unitsFor(b, "L1")[0].violations === 6;
		})(),
	);
	ck(
		"the threshold grid contains the SLO itself",
		GRID.some((c) => Math.abs(c.num / c.den - SLO) < 1e-12),
	);
	ck(
		"the grid is exactly the five pre-registered thresholds",
		G === 5 &&
			GRID.map((c) => c.num / c.den).join(",") === "0,0.02,0.05,0.1,0.2",
	);
	ck(
		"units per window is fixed at 30 (power-derived before freeze), not taken from survivors",
		UNITS_PER_WINDOW === 30,
	);
	ck(
		"30 units is 2.5 hours of 300s blocks",
		(UNITS_PER_WINDOW * 300) / 3600 === 2.5,
	);
	ck(
		"exposure rounds UP (a fractional unit does not exist)",
		(() => {
			const j = unitsForAllCleanBound(SLO, A_PERF);
			return (
				Number.isInteger(j) &&
				1 - A_PERF ** (1 / j) <= SLO &&
				1 - A_PERF ** (1 / (j - 1)) > SLO
			);
		})(),
	);
	// ⚠ Honest scope. An exhaustive sweep of every reachable input - k/150 and
	// k/100 for all k, against all five frozen thresholds, 1255 comparisons -
	// finds ZERO cases where a float comparison disagrees with the integer one.
	// So the integer form is DEFENCE IN DEPTH here, not a correctness requirement,
	// and a mutation to floats is an EQUIVALENT MUTANT that no fixture can catch.
	// It earns its place only against a future threshold that is not a binary
	// fraction (1/3, say). Saying "floats would get the ties wrong" would have
	// been a claim the measurement does not support.
	ck(
		"integer and float comparison agree on every reachable input (equivalence proof)",
		(() => {
			for (const n of [150, 100])
				for (let k = 0; k <= n; k++)
					for (const c of GRID)
						if (k * c.den > c.num * n !== k / n > c.num / c.den) return false;
			return true;
		})(),
	);
	ck(
		"a non-binary threshold IS decided differently (why the integer form stays)",
		(() => {
			// 1/3 of 150 ticks is not representable; the integer form answers exactly.
			return (
				countAbove([{ violations: 50, ticks: 150 }], { num: 1, den: 3 }) === 0
			);
		})(),
	);
	ck(
		"range_lb is positive only when the intervals are disjoint",
		(() => {
			const w = [
				{ upper: 0.1, lower: 0.02 },
				{ upper: 0.9, lower: 0.5 },
			];
			return near(rangeBounds(w).rangeLb, 0.5 - 0.1, 1e-12);
		})(),
	);

	return t;
}

// ==================================== CLI ===================================
async function main(argv) {
	const opts = { bundles: [], ledger: null, out: null, freezeCommit: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--self-test") {
			const r = selfTest();
			for (const x of r) console.log(`${x.pass ? "PASS" : "FAIL"}  ${x.name}`);
			const bad = r.filter((x) => !x.pass).length;
			console.log(`\n${r.length - bad}/${r.length} passed`);
			process.exit(bad ? 1 : 0);
		} else if (a === "--bundle") opts.bundles.push(argv[++i]);
		else if (a === "--out") opts.out = argv[++i];
		else if (a === "--freeze-commit") opts.freezeCommit = argv[++i];
		else if (a === "--evidence") opts.evidenceDir = argv[++i];
		else if (a === "--repo-root") {
			// accepted only so an old invocation fails loudly instead of silently
			// verifying somewhere else; the value is refused, not used.
			console.error(
				"ERROR: --repo-root is no longer accepted. The frozen blobs are verified against this file's own repository, so that the bytes checked are the bytes running.",
			);
			process.exit(1);
		} else if (a === "--sim-m")
			opts.simM = Number(argv[++i]); // testing only; see below
		else if (a === "--exposure") {
			console.log(JSON.stringify(exposureRequired(), null, 2));
			process.exit(0);
		} else if (a === "-h" || a === "--help") {
			usage();
			process.exit(0);
		} else {
			console.error(`unknown argument: ${a}`);
			usage();
			process.exit(1);
		}
	}
	// ⚠ Zero bundles is a legitimate case, not a usage error: an attempt that dies
	// in preflight produces no bundle at all, and the contract says that must
	// still reach an authoritative U naming the reason. Requiring a bundle here
	// meant the worst outcomes could not be reported at all.
	if (!opts.evidenceDir || !opts.out) {
		usage();
		process.exit(1);
	}

	// A bundle that cannot be loaded is itself a finding: record it as a reason
	// rather than aborting, so the run still produces a verdict.
	const found = discoverBundles(opts.evidenceDir);
	const bundles = [];
	const loadFailures = [...found.problems];
	for (const d of found.completed) {
		try {
			bundles.push(loadBundle(d));
		} catch (e) {
			loadFailures.push(`${basename(d)}: ${e.message}`);
		}
	}
	opts.loadFailures = loadFailures;
	// The ledger is rebuilt from the canonical state files, not read from the
	// caller's index: spec-baseline.md section 9 says the index is derived, and an
	// index that can be handed in is an index that can be written.
	const ledger = readdirSync(opts.evidenceDir)
		.filter((f) => /^attempt-\d+$/.test(f))
		.sort()
		.map((d) => {
			try {
				return JSON.parse(
					readFileSync(join(opts.evidenceDir, d, "state.json"), "utf8"),
				);
			} catch {
				return { dir: d, state: "UNREADABLE" };
			}
		});
	// Run the sensitivity analysis HERE, in this process, with this build's frozen
	// constants. Deterministic in (seed, grid, K, M), so it is reproducible by
	// anyone holding the same commit - and there is no artifact to forge.
	try {
		const sim = await import("./qa-fly-2007-phase0-simulate.mjs");
		opts.sensitivityResult = sim.runSensitivity({ m: opts.simM || sim.M });
		const gridStats = sim.gridStatistics({ m: opts.simM ? 60 : 400 });
		opts.parameterSetGate = sim.parameterSetGate(gridStats);
		// the observed statistics come from the REAL data: if this window's
		// dependence sits outside the regime the grid describes, the simulation says
		// nothing about it and the honest verdict is U.
		const observed = [];
		for (const b of bundles)
			for (const ep of ENDPOINTS) {
				const u = unitsFor(b, ep);
				if (!u.length) continue;
				const rates = u.map((x) => x.violations / x.ticks);
				observed.push({
					label: `${basename(b.dir)}/${ep}`,
					meanRate: rates.reduce((x, y) => x + y, 0) / rates.length,
					varRate: sim.variance(rates),
					acf: sim.lag1(rates),
				});
			}
		opts.applicabilityGate = observed.length
			? sim.applicabilityGate(observed, gridStats)
			: null;
		// ⚠ A reduced-M run is for exercising gate logic in tests, never for a
		// verdict: fewer replicates make the per-point lower bound wider and the
		// whole point of the gate is that bound. Mark it, and refuse A and N.
		if (opts.simM && opts.simM < sim.M) opts.sensitivityReduced = true;
		mkdirSync(opts.out, { recursive: true });
		writeFileSync(
			join(opts.out, "sensitivity.json"),
			JSON.stringify(
				{
					...opts.sensitivityResult,
					parameter_set_gate: opts.parameterSetGate,
					applicability_gate: opts.applicabilityGate,
				},
				null,
				2,
			) + "\n",
		);
	} catch (e) {
		// ⚠ Do NOT swallow this. A stack overflow inside the grid statistics was
		// caught here and reported as a mild "gate was not evaluated" line, hiding a
		// crash behind a fail-closed message. Fail-closed is right; silent is not.
		console.error(
			`ERROR: the sensitivity analysis could not be run: ${e.message}`,
		);
		console.error(e.stack);
		process.exit(1);
	}

	const result = analyse(bundles, ledger, opts);
	result.exposure_required = exposureRequired(
		bundles.length ? bundles[0].meta.block_seconds : 300,
	);

	mkdirSync(opts.out, { recursive: true });
	writeFileSync(
		join(opts.out, "analysis.json"),
		JSON.stringify(result, null, 2) + "\n",
	);
	console.log(
		`authoritative_outcome=${result.authoritative_outcome} (${result.authoritative_reason})`,
	);
	console.log(`inference_eligible=${result.inference_eligible}`);
	if (!result.inference_eligible) {
		// ⚠ NOT "the first 20". An arbitrary window hides the answer: 26 missing-row
		// complaints from one empty bundle pushed a ledger gap - the more serious
		// finding - off the end of the list. Group by category, count, and always
		// print every ledger reason in full. analysis.json keeps all of them anyway.
		const groups = new Map();
		for (const r of result.ineligibility_reasons) {
			const key = /^ledger:/.test(r)
				? "ledger"
				: /^freeze:/.test(r)
					? "freeze"
					: /^sensitivity:/.test(r)
						? "sensitivity"
						: /could not be loaded/.test(r)
							? "bundle load failure"
							: /integrity: missing summary row/.test(r)
								? "integrity: missing summary rows"
								: /integrity: .*sample rows/.test(r)
									? "integrity: sample row counts"
									: /integrity: missing tick/.test(r)
										? "integrity: missing ticks"
										: /integrity:/.test(r)
											? "integrity: other"
											: /units, the frozen design says/.test(r)
												? "unit count"
												: "block classification";
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(r);
		}
		for (const [key, rs] of groups) {
			// these three are never summarised away: a freeze drift, a sensitivity
			// problem or an unloadable bundle is the answer, not a detail
			if (
				key === "ledger" ||
				key === "freeze" ||
				key === "sensitivity" ||
				key === "bundle load failure"
			) {
				for (const r of rs) console.log(`  - ${r}`);
				continue;
			}
			console.log(`  - ${key}: ${rs.length}  e.g. ${rs[0]}`);
		}
	}
	console.log(
		`upstream_literal_outcome=${result.upstream_literal_outcome} (NON-AUTHORITATIVE)`,
	);
	process.exit(0);
}

function usage() {
	console.log(`qa-fly-2007-phase0-analyze.mjs - FLY-2007 Phase-0 analyser (read-only)

  --out DIR           output directory
  --freeze-commit SHA the freeze commit this analysis is bound to (REQUIRED)
  --evidence DIR      evidence root, for the two-way attempt census (REQUIRED)
  --sim-m N           reduce the sensitivity replicate count. TESTING ONLY: a run
                      below the frozen M cannot produce A or N, only U.
  --exposure          print the exposure calculator and exit
  --self-test         run the frozen positive controls and exit

Opens no network connection and no database. Writes only --out.`);
}

// ⚠ realpath BOTH sides. On macOS a temp dir is /var/... which is a symlink to
// /private/var/..., so import.meta.url (resolved) never equals file://argv[1]
// (unresolved) and the CLI silently does nothing while exiting 0. The mutation
// harness copies this file to a temp dir, so that failure mode made every mutant
// look alive. The instrument was broken, not the code.
const invokedDirectly = (() => {
	try {
		return (
			realpathSync(fileURLToPath(import.meta.url)) ===
			realpathSync(process.argv[1] || "")
		);
	} catch {
		return false;
	}
})();
if (invokedDirectly) {
	// ⚠ NOT top-level await. The simulator statically imports this module, so
	// awaiting here leaves this module still evaluating when it dynamically imports
	// the simulator - the circular import never resolves and node exits silently
	// with "unsettled top-level await". Let the module finish evaluating first.
	main(process.argv.slice(2)).catch((e) => {
		// fail-loud but legible: a stack trace is not a diagnosis
		console.error(`ERROR: ${e.message}`);
		process.exit(1);
	});
}
