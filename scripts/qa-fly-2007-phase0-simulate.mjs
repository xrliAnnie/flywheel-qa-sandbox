#!/usr/bin/env node

// FLY-2007 — Phase-0 sensitivity simulator (FROZEN with spec-baseline.md).
//
// WHAT THIS IS *NOT*: coverage validation. You cannot measure coverage on the
// real data, because the true b is unknown. Plugging the observed dependence
// structure back in cannot validate unobserved long memory, non-stationarity or
// parameter uncertainty. So this is a SENSITIVITY CHECK on a fitted simulator,
// and it is named that way on purpose.
//
// WHAT IT ANSWERS: assumption A1 says the units in a window are iid. They are
// not - the machine has episodes. This measures what that costs the exact
// procedure's coverage, on an adversarial grid of dependence parameters, and
// refuses (outcome U) rather than repairing anything after the fact.
//
// CALIBRATION uses only the PERMANENTLY EXCLUDED pilot data. W1-W3 may be used
// for a post-hoc sensitivity re-run whose result cannot change any frozen rule.
//
// ERROR BUDGET: alpha_param + alpha_MC <= 0.05, pre-registered at 0.025 each.
// Every grid point's coverage is bounded by an EXACT binomial lower limit at
// level 1 - alpha_MC/K, and ALL K points must clear 0.95 simultaneously. An
// earlier draft said "per-point 95% lower bound, Bonferroni over K", which is
// self-contradictory: Bonferroni means each point runs at 1 - alpha_MC/K, not
// still at 95%.

import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	A_ADV,
	A_RANGE,
	boundLower,
	boundUpper,
	cpLower,
	cpUpper,
	DELTA,
	GRID,
	rangeBounds,
	SLO,
} from "./qa-fly-2007-phase0-analyze.mjs";

export const ALPHA_PARAM = 0.025;
export const ALPHA_MC = 0.025;
export const M = 20000;
export const UNITS = 30; // matches the analyser's frozen UNITS_PER_WINDOW
export const TICKS = { L1: 150, L2: 100 };

// Deterministic PRNG: a reviewer holding the same inputs must reproduce the same
// numbers to the last digit.
//
// ⚠ The first version was xorshift128+ truncated to 32 bits. Its shift constants
// (23/17/26) are designed for a 64-bit state, and in 32 bits the generator is
// poor enough to matter: the SAME dgp, units and M returned 94.32% coverage on
// one seed and 98.35% on another, a four-point swing where the Monte Carlo
// standard error is 0.15pp. I nearly reported "the A gate fails at g08" as a
// finding about the METHOD when it was a defect in my instrument. Now sfc32,
// seeded through splitmix32, plus the seed-stability control below.
function splitmix32(a) {
	return () => {
		a |= 0;
		a = (a + 0x9e3779b9) | 0;
		let t = a ^ (a >>> 16);
		t = Math.imul(t, 0x21f0aaad);
		t = t ^ (t >>> 15);
		t = Math.imul(t, 0x735a2d97);
		t = t ^ (t >>> 15);
		return t >>> 0;
	};
}
export function prng(seed) {
	const sm = splitmix32(seed >>> 0);
	let a = sm(),
		b = sm(),
		c = sm(),
		d = sm();
	return function next() {
		a |= 0;
		b |= 0;
		c |= 0;
		d |= 0;
		const t = (((a + b) | 0) + d) | 0;
		d = (d + 1) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		c = (c + t) | 0;
		return (t >>> 0) / 4294967296;
	};
}

// Instrument control: if the coverage estimate moves more than Monte Carlo error
// allows when only the seed changes, the generator is the thing being measured.
// This must run BEFORE any coverage number is believed.
export function seedStability(dgp, alphaPerCp, m, seeds, ticks, units) {
	const runs = seeds.map(
		(sd) => coverageLower(dgp, alphaPerCp, m, sd, ticks, units).empirical,
	);
	const mean = runs.reduce((x, y) => x + y, 0) / runs.length;
	const spread = Math.max(...runs) - Math.min(...runs);
	// 6 standard errors is generous; the broken generator swung 27x its SE.
	const se = Math.sqrt(Math.max(mean * (1 - mean), 1e-9) / m);
	return { runs, mean, spread, se, tolerance: 6 * se, pass: spread <= 6 * se };
}

// Two-state semi-Markov: the machine is either in a healthy stretch or in an
// episode, and violations are much likelier inside an episode. pStay* control
// how sticky each state is - that stickiness is precisely the A1 violation.
export function simulateWindow(rnd, dgp, ticksPerUnit, units) {
	const { pStayGood, pStayBad, pViolGood, pViolBad } = dgp;
	const out = [];
	// ⚠ Start from the STATIONARY distribution. The first version opened with a
	// 50/50 coin, then compared the result against trueB(), which is the
	// stationary rate - assessing a stationary quantity from a non-stationary
	// start. Codex R6 caught it. The stationary probability of being in the bad
	// state is (1-pStayGood) / ((1-pStayGood) + (1-pStayBad)).
	const pBad = (1 - pStayGood) / (1 - pStayGood + (1 - pStayBad));
	let bad = rnd() < pBad;
	for (let u = 0; u < units; u++) {
		let v = 0;
		for (let t = 0; t < ticksPerUnit; t++) {
			bad = bad ? rnd() < pStayBad : !(rnd() < pStayGood);
			if (rnd() < (bad ? pViolBad : pViolGood)) v++;
		}
		out.push({ violations: v, ticks: ticksPerUnit });
	}
	return out;
}

// The stationary per-tick violation probability of that process - the estimand.
export function trueB({ pStayGood, pStayBad, pViolGood, pViolBad }) {
	const pBad = (1 - pStayGood) / (1 - pStayGood + (1 - pStayBad));
	return pBad * pViolBad + (1 - pBad) * pViolGood;
}

// ------------------------------- the runs ----------------------------------
// #2 in the frozen configuration table: b_lb at the A level. Gate-critical this
// round (the Lead trimmed the contract to A/U strength on 2026-08-23).
export function coverageLower(
	dgp,
	alphaPerCp,
	m,
	seed,
	ticks = TICKS.L1,
	units = UNITS,
) {
	const rnd = prng(seed);
	const b = trueB(dgp);
	let covered = 0;
	for (let i = 0; i < m; i++) {
		const u = simulateWindow(rnd, dgp, ticks, units);
		if (boundLower(u, GRID, alphaPerCp).bound <= b) covered++;
	}
	return { covered, m, trueB: b, empirical: covered / m };
}
// #4: range_lb at the N level, across three windows of the same process.
export function coverageRangeLower(
	dgp,
	alphaPerCp,
	m,
	seed,
	ticks = TICKS.L1,
	units = UNITS,
) {
	const rnd = prng(seed);
	let covered = 0;
	for (let i = 0; i < m; i++) {
		const w = [0, 1, 2].map(() => {
			const u = simulateWindow(rnd, dgp, ticks, units);
			return {
				upper: boundUpper(u, GRID, alphaPerCp).bound,
				lower: boundLower(u, GRID, alphaPerCp).bound,
			};
		});
		// three windows drawn from ONE process have a true range of 0, so a valid
		// lower bound must not exceed 0.
		if (rangeBounds(w).rangeLb <= 0) covered++;
	}
	return { covered, m, trueB: 0, empirical: covered / m };
}
// naive Clopper-Pearson over pooled ticks: the POSITIVE CONTROL. It must
// UNDER-cover. If it does not, the simulator has no dependence in it and the
// whole exercise is vacuous - which is a defect in my instrument, not a result.
export function coverageNaive(dgp, alpha, m, seed, ticks = TICKS.L1) {
	const rnd = prng(seed);
	const b = trueB(dgp);
	let covered = 0;
	for (let i = 0; i < m; i++) {
		const u = simulateWindow(rnd, dgp, ticks, UNITS);
		const x = u.reduce((s, y) => s + y.violations, 0);
		const n = u.reduce((s, y) => s + y.ticks, 0);
		if (cpUpper(x, n, alpha) >= b) covered++;
	}
	return { covered, m, trueB: b, empirical: covered / m };
}
// oracle: the same exact procedure on a genuinely iid process. Must hold.
export function coverageOracle(pViol, alphaPerCp, m, seed, ticks = TICKS.L1) {
	return coverageLower(
		{ pStayGood: 0.5, pStayBad: 0.5, pViolGood: pViol, pViolBad: pViol },
		alphaPerCp,
		m,
		seed,
		ticks,
	);
}

// Exact binomial lower confidence limit on the coverage itself. Ignoring Monte
// Carlo error is how "1900/2000" gets reported as 95% when its exact lower bound
// is 94.12%.
export const coverageLcb = (covered, m, level) => cpLower(covered, m, level);

// ==================== FROZEN experimental design (spec section 7) ===========
// Calibrated ONLY on the permanently excluded pilot data (FLY-1986's three real
// runs: b = 0.644 / 0.289 / 1.000 at load 9.9-15.4, and the episodic ~190s
// structure its section 0 describes). W1-W3 may be used for a post-hoc
// sensitivity re-run whose result cannot change any frozen rule.
export const SEED = 20260823;
// Adversarial grid: episode stickiness spanning "barely correlated" to "long
// episodes", crossed with true rates that bracket the SLO and the pilot's range.
export const DGP_GRID = [
	{
		id: "g01",
		pStayGood: 0.999,
		pStayBad: 0.995,
		pViolGood: 0.0005,
		pViolBad: 0.9,
	},
	{
		id: "g02",
		pStayGood: 0.995,
		pStayBad: 0.985,
		pViolGood: 0.002,
		pViolBad: 0.85,
	},
	{
		id: "g03",
		pStayGood: 0.99,
		pStayBad: 0.97,
		pViolGood: 0.005,
		pViolBad: 0.7,
	},
	{
		id: "g04",
		pStayGood: 0.98,
		pStayBad: 0.95,
		pViolGood: 0.01,
		pViolBad: 0.5,
	},
	{
		id: "g05",
		pStayGood: 0.999,
		pStayBad: 0.999,
		pViolGood: 0.0002,
		pViolBad: 0.99,
	},
	{
		id: "g06",
		pStayGood: 0.9995,
		pStayBad: 0.99,
		pViolGood: 0.001,
		pViolBad: 0.6,
	},
	{
		id: "g07",
		pStayGood: 0.97,
		pStayBad: 0.93,
		pViolGood: 0.02,
		pViolBad: 0.3,
	},
	{
		id: "g08",
		pStayGood: 0.9999,
		pStayBad: 0.999,
		pViolGood: 0.0001,
		pViolBad: 0.95,
	},
];
// K counts GRID POINTS, and a point is a (dgp, endpoint) pair: both endpoints
// must be evaluated, so the multiplicity is 8 x 2.
export const K = DGP_GRID.length * 2; // 16 <= 20, the pre-registered cap
export const PER_POINT_LEVEL = ALPHA_MC / K; // Bonferroni: NOT still 0.95

// The two controls, on FIXED dgps chosen in advance.
export const POSITIVE_CONTROL_DGP = DGP_GRID[1]; // known to make naive CP under-cover
export const ORACLE_P = 0.03;

function assess(name, runs) {
	// Every point must clear 0.95 SIMULTANEOUSLY, each at level 1 - ALPHA_MC/K.
	const points = runs.map((r) => ({
		...r,
		lcb: coverageLcb(r.covered, r.m, PER_POINT_LEVEL),
		pass: coverageLcb(r.covered, r.m, PER_POINT_LEVEL) >= 0.95,
	}));
	return {
		name,
		per_point_level: PER_POINT_LEVEL,
		points,
		pass: points.every((p) => p.pass),
	};
}

export function runSensitivity({ m = M } = {}) {
	// ⚠ BOTH endpoints. The first version ran L1 only. L1 takes 150 ticks per 300s
	// unit against L2's 100, so L2's per-unit proportions are noisier; and
	// authoritative A fires if ANY of the six components clears, of which L2 is
	// three. Releasing A on an L1-only simulation let half the components through
	// unchecked. (The numbers that first exposed this - L2 "failing" at J=30 -
	// were themselves distorted by the non-stationary initialisation fixed below;
	// with both corrections in place both endpoints pass. The structural point
	// stands regardless: a gate must look at everything it releases.)
	const cross = (label, fn) =>
		assess(
			label,
			DGP_GRID.flatMap((d, i) =>
				Object.entries(TICKS).map(([ep, tk]) => ({
					dgp: `${d.id}/${ep}`,
					endpoint: ep,
					...fn(d, i, tk),
				})),
			),
		);
	const cfgA = cross("b_lb @ A", (d, i, tk) =>
		coverageLower(d, A_ADV, m, SEED + i * 101, tk),
	);
	const mN = Math.max(1, Math.round(m / 4));
	const cfgN = cross("range_lb @ N", (d, i, tk) =>
		coverageRangeLower(d, A_RANGE, mN, SEED + 5000 + i * 101, tk),
	);

	const naive = coverageNaive(POSITIVE_CONTROL_DGP, 0.05, m, SEED + 777);
	const oracle = coverageOracle(ORACLE_P, A_ADV, m, SEED + 888);
	const controls = {
		positive: {
			...naive,
			ucb: cpUpper(naive.covered, naive.m, PER_POINT_LEVEL),
			// ⚠ It must be PROVEN to under-cover, which needs an UPPER bound on its
			// coverage below 0.95. A lower bound failing to reach 0.95 only says
			// "not proven to cover" - the weaker statement, and the wrong direction
			// for a control whose job is to show the simulator has real dependence in
			// it (Codex R6 advisory 2).
			pass: cpUpper(naive.covered, naive.m, PER_POINT_LEVEL) < 0.95,
		},
		oracle: {
			...oracle,
			lcb: coverageLcb(oracle.covered, oracle.m, PER_POINT_LEVEL),
			pass: coverageLcb(oracle.covered, oracle.m, PER_POINT_LEVEL) >= 0.95,
		},
	};
	// ⚠ Three controls, and the seed-stability one runs FIRST: a coverage number
	// from an unfit generator is not evidence of anything, in either direction.
	const stab = seedStability(
		DGP_GRID[7],
		A_ADV,
		Math.max(500, Math.round(m / 8)),
		[SEED + 1, SEED + 2, SEED + 3, SEED + 4],
		TICKS.L1,
		UNITS,
	);
	controls.seed_stability = { ...stab };
	const controlsOk =
		controls.positive.pass && controls.oracle.pass && stab.pass;

	// No provenance digest: the result is not an artifact anyone hands in, it is
	// what this process computed. Determinism in (seed, grid, K, M) is what makes
	// it reproducible, and reproducibility is what a digest was failing to provide.
	return {
		schema: "fly2007-phase0-sensitivity/1",
		freeze_commit: process.env.FLY2007_FREEZE_COMMIT || null,
		note: "Sensitivity analysis on a fitted simulator, NOT coverage validation: the true data-generating process is unknown, so this bounds the cost of assumption A1 failing WITHIN the frozen DGP family only.",
		seed: SEED,
		K,
		alpha_param: ALPHA_PARAM,
		alpha_MC: ALPHA_MC,
		per_point_level: PER_POINT_LEVEL,
		// ⚠ Per configuration, because they differ: N draws three windows per
		// replicate, so it runs at m/4. Reporting a single top-level M said 20000
		// while N's points actually used 5000 (Codex R14).
		M: { b_lb_A: m, range_lb_N: mN },
		controls,
		// ⚠ Controls are listed SEPARATELY and can only veto. They show the
		// simulator is not broken; they never stand in for a configuration's own
		// coverage. An earlier draft let acceptance pass on controls alone.
		configurations: {
			b_lb_A: { ...cfgA, pass: cfgA.pass && controlsOk },
			range_lb_N: { ...cfgN, pass: cfgN.pass && controlsOk },
		},
		summary: `controls ${controlsOk ? "ok" : "ABNORMAL"}; b_lb@A ${cfgA.pass ? "pass" : "FAIL"}; range_lb@N ${cfgN.pass ? "pass" : "FAIL"}`,
	};
}

if (
	realpathSync(fileURLToPath(import.meta.url)) ===
	realpathSync(process.argv[1] || "")
) {
	const mIdx = process.argv.indexOf("--m");
	const m = mIdx > -1 ? Number(process.argv[mIdx + 1]) : M;
	const outIdx = process.argv.indexOf("--out");
	const res = runSensitivity({ m });
	const text = JSON.stringify(res, null, 2) + "\n";
	if (outIdx > -1) writeFileSync(process.argv[outIdx + 1], text);
	else process.stdout.write(text);
	console.error(res.summary);
	process.exit(res.configurations.b_lb_A.pass ? 0 : 1);
}

// ---------------------- A-direction exposure search -------------------------
// Kept as a tool, NOT as a claim. An earlier version of this comment said the
// A-direction bound failed at the frozen J and computed how much exposure would
// fix it; that finding was an artifact of a 50/50 initial state being assessed
// against a stationary estimand, and has been retracted. With the corrected
// simulator the bound holds at every grid point. The search remains useful for
// asking what a DIFFERENT dependence regime would cost, and the deliverable
// exposure number is the distance to certifying B (Lead ruling), not this one.
export function minUnitsForA({ m = 2000, maxUnits = 400 } = {}) {
	const worst = [];
	for (const d of DGP_GRID) {
		let lo = UNITS,
			hi = maxUnits,
			found = null;
		// coverage is monotone enough in J for a bisection to be a fair search; the
		// reported number is the smallest J tried that passed, and the search bounds
		// are printed so nobody reads it as exact.
		while (lo <= hi) {
			const mid = Math.floor((lo + hi) / 2);
			const r = coverageLower(d, A_ADV, m, SEED + 31, TICKS.L1, mid);
			if (coverageLcb(r.covered, r.m, PER_POINT_LEVEL) >= 0.95) {
				found = mid;
				hi = mid - 1;
			} else lo = mid + 1;
		}
		worst.push({
			dgp: d.id,
			trueB: trueB(d),
			min_units: found,
			searched_up_to: maxUnits,
		});
	}
	const binding = worst.reduce((a, b) =>
		b.min_units === null
			? b
			: a.min_units === null
				? a
				: b.min_units > a.min_units
					? b
					: a,
	);
	return {
		schema: "fly2007-phase0-a-exposure/1",
		m_per_probe: m,
		per_point_level: PER_POINT_LEVEL,
		units_searched_up_to: maxUnits,
		per_dgp: worst,
		binding,
		hours_per_window:
			binding.min_units === null ? null : (binding.min_units * 300) / 3600,
		note: "Minimum units per window at which the A-direction bound holds its level against each frozen adversarial DGP. null means it did not hold anywhere in the searched range.",
	};
}

// ================= parameter-set gate and applicability domain ==============
// spec-baseline.md section 7 promises both, and Codex R10 correctly found that
// neither existed: A could be released without them. They are implemented here.
//
// ⚠ HONEST LIMIT ON THE FIT GATE. A real goodness-of-fit of a semi-Markov
// dependence model needs the pilot's per-tick series, and FLY-1986 committed only
// three block summaries plus a four-line head of one samples file - the per-tick
// pilot data does not exist in the repository. So the fit gate cannot be what the
// word usually means. What it CAN be, and is: a coverage check that the frozen
// grid is capable of producing the block-level rates the pilot actually observed
// (0.6444, 0.2889, 1.0000). If the grid cannot reach them, the grid does not
// describe the regime we are measuring, and nothing downstream of it means
// anything. n = 3 blocks; that weakness is stated here and in the output rather
// than dressed up.
export const PILOT_BLOCK_RATES = [0.6444, 0.2889, 1.0]; // FLY-1986 evidence, permanently excluded from inference

// Block-level rate range each grid point can produce, and the lag-1
// autocorrelation of those rates - the two statistics the applicability domain
// is expressed in.
export function gridStatistics({ m = 400 } = {}) {
	const rates = [];
	const acfs = [];
	const vars = [];
	let degenerate = 0,
		windows = 0;
	for (const [i, d] of DGP_GRID.entries()) {
		for (const [, tk] of Object.entries(TICKS)) {
			const rnd = prng(SEED + 900 + i);
			for (let r = 0; r < m; r++) {
				const u = simulateWindow(rnd, d, tk, UNITS);
				const p = u.map((x) => x.violations / x.ticks);
				for (const v of p) rates.push(v);
				const a = lag1(p);
				acfs.push(a);
				vars.push(variance(p));
				windows++;
				// a window whose block rates are all identical has NO dependence
				// statistic - the grid must be able to produce that too, or an observed
				// degenerate window is outside what the simulation describes
				if (!Number.isFinite(a)) degenerate++;
			}
		}
	}
	// ⚠ NOT Math.min(...rates): this array holds K x m x UNITS values - 192,000 at
	// the frozen settings - and spreading that many arguments overflows the call
	// stack. It failed as "Maximum call stack size exceeded" inside a try/catch,
	// which turned a crash into a quiet "gate was not evaluated".
	const range = (xs) =>
		xs.reduce(
			(a, v) =>
				Number.isFinite(v)
					? { lo: Math.min(a.lo, v), hi: Math.max(a.hi, v) }
					: a,
			{ lo: Infinity, hi: -Infinity },
		);
	const r = range(rates);
	const a = range(acfs);
	const v = range(vars);
	return {
		rate_min: r.lo,
		rate_max: r.hi,
		acf_min: a.lo,
		acf_max: a.hi,
		var_min: v.lo,
		var_max: v.hi,
		degenerate_windows: degenerate,
		total_windows: windows,
		m_per_point: m,
	};
}

export function variance(xs) {
	const n = xs.length;
	if (n < 2) return NaN;
	const mean = xs.reduce((a, b) => a + b, 0) / n;
	return xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
}

export function lag1(xs) {
	const n = xs.length;
	if (n < 3) return NaN;
	const mean = xs.reduce((a, b) => a + b, 0) / n;
	let num = 0,
		den = 0;
	for (let i = 0; i < n; i++) {
		den += (xs[i] - mean) ** 2;
		if (i) num += (xs[i] - mean) * (xs[i - 1] - mean);
	}
	return den === 0 ? NaN : num / den;
}

// Gate 1: does the frozen grid reach what the pilot actually saw?
export function parameterSetGate(stats) {
	const outside = PILOT_BLOCK_RATES.filter(
		(r) => r < stats.rate_min || r > stats.rate_max,
	);
	return {
		name: "parameter-set / pilot coverage",
		pilot_block_rates: PILOT_BLOCK_RATES,
		grid_rate_range: [stats.rate_min, stats.rate_max],
		outside,
		pass: outside.length === 0,
		// ⚠ Codex R14: calling this merely WEAK understates it. The realised grid
		// envelope is [0,1], and every legal block rate lies in [0,1], so NO possible
		// pilot value can fail this gate. It has no rejection region. That is not a
		// weak test, it is a support-envelope assertion, and its passing must never
		// be cited as evidence that the parameter set fits the pilot.
		has_rejection_region: stats.rate_min > 0 || stats.rate_max < 1,
		strength:
			"NON-DISCRIMINATING for the frozen pilot values: the grid envelope is [0,1] and every legal block rate lies inside it, so no pilot value can fail. Reported for completeness; it is NOT fit evidence. A real distributional gate needs the pilot per-tick series, which FLY-1986 never committed and which cannot be reconstructed after the fact.",
		alpha_param_note:
			"ALPHA_PARAM is printed in the sensitivity output but is NOT consumed by this gate — there is no test here for it to size.",
	};
}

// Gate 2: does the REAL data sit inside the regime the grid describes? If it does
// not, the simulation says nothing about this data, and the honest verdict is U.
export function applicabilityGate(observed, stats) {
	const problems = [];
	// ⚠ Codex R11: the first version checked the lag-1 autocorrelation only when it
	// was finite. When every block rate in a window is identical - an all-violation
	// window, exactly the case a failing baseline produces - the variance is zero
	// and the statistic is NaN, so the check SKIPPED and the gate passed with no
	// applicability evidence at all. All six observed values were NaN and A was
	// released. An undefined statistic is not a pass.
	//
	// The fix is not to refuse degenerate windows, which would make the clearest
	// possible evidence of failure unusable. It is to check statistics that are
	// always defined - the block-rate mean and variance - and to require, when the
	// autocorrelation is undefined, that the grid PRODUCES degenerate windows too.
	for (const o of observed) {
		if (!Number.isFinite(o.meanRate) || !Number.isFinite(o.varRate)) {
			problems.push(
				`${o.label}: block-rate mean or variance is not computable — applicability cannot be established`,
			);
			continue;
		}
		if (o.meanRate < stats.rate_min || o.meanRate > stats.rate_max)
			problems.push(
				`${o.label}: block-rate mean ${o.meanRate.toFixed(4)} is outside the grid's range [${stats.rate_min.toFixed(4)}, ${stats.rate_max.toFixed(4)}]`,
			);
		if (o.varRate < stats.var_min || o.varRate > stats.var_max)
			problems.push(
				`${o.label}: block-rate variance ${o.varRate.toFixed(6)} is outside the grid's range [${stats.var_min.toFixed(6)}, ${stats.var_max.toFixed(6)}]`,
			);
		if (Number.isFinite(o.acf)) {
			if (o.acf < stats.acf_min || o.acf > stats.acf_max)
				problems.push(
					`${o.label}: block-rate lag-1 autocorrelation ${o.acf.toFixed(4)} is outside the grid's range [${stats.acf_min.toFixed(4)}, ${stats.acf_max.toFixed(4)}]`,
				);
		} else if (!(stats.degenerate_windows > 0)) {
			problems.push(
				`${o.label}: block rates are constant so no dependence statistic exists, and the frozen grid never produces such a window — this data is outside what the simulation describes`,
			);
		}
	}
	return {
		name: "applicability domain",
		grid: stats,
		observed,
		problems,
		pass: problems.length === 0,
		note: "Statistics are the block-rate mean and variance, both always defined. The lag-1 autocorrelation is checked when defined; when it is not, the grid must itself produce degenerate windows.",
	};
}
