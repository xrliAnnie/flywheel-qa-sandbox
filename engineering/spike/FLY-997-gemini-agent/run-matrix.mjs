// FLY-997 S2 reliability matrix (plan §5 S2) + S4 guardrail rounds share this
// driver. Scenario × rounds × model tier; per-round mock reset; raw JSONL to
// gitignored out/; sanitized aggregates to committed evidence/.
//
// Usage:
//   ./run.sh run-matrix.mjs                          # full S2 plan
//   ./run.sh run-matrix.mjs --smoke                  # 1 round/scenario, flash only
//   ./run.sh run-matrix.mjs --scenario N1 --model pro --rounds 20
//   ./run.sh run-matrix.mjs --surface generateContent

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG } from "./config.mjs";
import {
	initHarness,
	jsonlWriter,
	origins,
	runRound,
	sessionsUsed,
	summarize,
	withMock,
} from "./harness.mjs";

const args = process.argv.slice(2);
function flag(name, dflt) {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? dflt : args[i + 1];
}
const smoke = args.includes("--smoke");
const surface = flag("surface", "interactions");

// plan §5 S2 round table (N4 split into a/b halves)
const FULL_PLAN = [
	{ scenario: "N1", rounds: 20 },
	{ scenario: "N2", rounds: 10 },
	{ scenario: "N3", rounds: 10 },
	{ scenario: "N4a", rounds: 5 },
	{ scenario: "N4b", rounds: 5 },
];
const TIERS = ["flash", "pro"];

let plan;
let tiers;
if (flag("scenario")) {
	plan = [{ scenario: flag("scenario"), rounds: Number(flag("rounds", "10")) }];
	tiers = [flag("model", "flash")];
} else if (smoke) {
	plan = FULL_PLAN.map((p) => ({ ...p, rounds: 1 }));
	tiers = ["flash"];
} else {
	plan = FULL_PLAN;
	tiers = TIERS;
}

const { ai } = initHarness();
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const rawFile = `${CONFIG.paths.outDir}matrix-${stamp}.jsonl`;
const auditFile = `${CONFIG.paths.outDir}matrix-${stamp}-audit.jsonl`;
const raw = jsonlWriter(rawFile);
const audit = jsonlWriter(auditFile);

await withMock(async () => {
	const summaries = [];
	for (const tier of tiers) {
		for (const { scenario, rounds } of plan) {
			const results = [];
			for (let r = 0; r < rounds; r++) {
				const res = await runRound({
					ai,
					scenarioKey: scenario,
					modelTier: tier,
					surface,
					roundIndex: r,
					rawWriter: raw,
					auditWriter: audit,
				});
				results.push(res);
				const v = res.ok
					? res.verdict.success
						? "ok"
						: "FAIL"
					: res.quota
						? "quota"
						: "err";
				process.stdout.write(
					`[${tier}/${scenario}] round ${r + 1}/${rounds}: ${v}\n`,
				);
			}
			const agg = {
				tier,
				model: CONFIG.models[tier],
				scenario,
				surface,
				...summarize(results),
			};
			summaries.push(agg);
			console.log(
				`[matrix] ${tier}/${scenario}: success ${agg.successes}/${agg.completedRounds} (${agg.successRate})`,
			);
		}
	}

	// merge into committed evidence (accumulate across partial runs)
	const evPath = `${CONFIG.paths.evidenceDir}s2-matrix-summary.json`;
	const prev = existsSync(evPath)
		? JSON.parse(readFileSync(evPath, "utf8"))
		: { runs: [] };
	prev.runs.push({
		ts: new Date().toISOString(),
		surface,
		smoke,
		sessionsUsed: sessionsUsed(),
		outboundOrigins: origins(),
		rawFileRef: rawFile.split("/").slice(-1)[0],
		summaries,
	});
	writeFileSync(evPath, JSON.stringify(prev, null, 2));
	console.log(
		`\n[matrix] done. sessions=${sessionsUsed()} origins=${origins().join(",")}`,
	);
	console.log(`[matrix] raw: ${rawFile}`);
	console.log(`[matrix] evidence: ${evPath}`);
});
