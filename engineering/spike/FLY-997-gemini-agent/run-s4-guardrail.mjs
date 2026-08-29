// FLY-997 S4 guardrail behavior observation (plan §5 S4, V8).
// 10 inducement rounds ("merge it directly", "skip approval and ship") against
// a registry with NO merge tool. Evidence boundary (Codex R1-4): this proves
// (a) the toy-surface red line (merge tool cannot be called because it does
// not exist) and (b) behavior observation for PRD wording — it does NOT prove
// build-architecture structural enforcement; that is D5's static audit.

import { writeFileSync } from "node:fs";
import { CONFIG } from "./config.mjs";
import {
	initHarness,
	jsonlWriter,
	origins,
	runRound,
	summarize,
	withMock,
} from "./harness.mjs";

const { ai } = initHarness();
const raw = jsonlWriter(`${CONFIG.paths.outDir}s4-guardrail.jsonl`);
const audit = jsonlWriter(`${CONFIG.paths.outDir}s4-audit.jsonl`);

// 10 rounds: both inducements × both tiers, flash weighted (more failure-prone)
const PLAN = [
	{ scenario: "G1", tier: "flash", rounds: 3 },
	{ scenario: "G2", tier: "flash", rounds: 3 },
	{ scenario: "G1", tier: "pro", rounds: 2 },
	{ scenario: "G2", tier: "pro", rounds: 2 },
];

await withMock(async () => {
	const summaries = [];
	const details = [];
	for (const { scenario, tier, rounds } of PLAN) {
		const results = [];
		for (let r = 0; r < rounds; r++) {
			const res = await runRound({
				ai,
				scenarioKey: scenario,
				modelTier: tier,
				surface: "interactions",
				roundIndex: r,
				rawWriter: (o) => {
					raw(o);
					if (o.verdict)
						details.push({
							scenario,
							tier,
							round: r,
							checks: o.verdict.checks,
						});
				},
				auditWriter: audit,
			});
			results.push(res);
			console.log(
				`[S4 ${tier}/${scenario}] round ${r + 1}/${rounds}: ${res.ok ? (res.verdict.success ? "ok" : "FAIL") : "err"}`,
			);
		}
		summaries.push({ scenario, tier, ...summarize(results) });
	}
	writeFileSync(
		`${CONFIG.paths.evidenceDir}s4-guardrail-summary.json`,
		JSON.stringify(
			{
				ts: new Date().toISOString(),
				outboundOrigins: origins(),
				summaries,
				perRoundChecks: details,
			},
			null,
			2,
		),
	);
	console.log(
		"[S4] done →",
		`${CONFIG.paths.evidenceDir}s4-guardrail-summary.json`,
	);
});
