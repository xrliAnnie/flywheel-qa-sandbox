import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { validateEvaluation } from "../../packages/teamlead/dist/ship-judgment/evaluate.js";

const evaluatorUrl = new URL(
	"../../packages/teamlead/dist/ship-judgment/evaluate.js",
	import.meta.url,
);
const require = createRequire(evaluatorUrl);
const source = readFileSync(evaluatorUrl, "utf8")
	.replace('"zod"', JSON.stringify(pathToFileURL(require.resolve("zod")).href))
	.replace(
		'"./contract.js"',
		JSON.stringify(new URL("./contract.js", evaluatorUrl).href),
	);
const sources = [
	{ source_id: "plan", kind: "plan", revision: "1", text: "R1: require login" },
	{ source_id: "diff", kind: "diff", revision: "1", text: "+requireLogin();" },
	{ source_id: "qa", kind: "qa", revision: "1", text: "login test: PASS" },
];
const cite = (id) => {
	const s = sources.find((s) => s.source_id === id);
	return {
		source_id: id,
		quote_start: 0,
		quote_end: s.text.length,
		quote: s.text,
	};
};
const packet = {
	sources,
	files: [],
	requirements: [
		{ requirement_id: "R1", source_id: "plan", quote_start: 0, quote_end: 17 },
	],
};
const positive = () => ({
	schema_version: 1,
	alignment: {
		verdict: "pass",
		evidence: [cite("plan")],
		reason_code: "implemented",
	},
	coverage: { verdict: "pass", evidence: [cite("qa")], reason_code: "covered" },
	requirements: [
		{
			requirement_id: "R1",
			implementation_evidence: [cite("diff")],
			use_cases: [
				{
					use_case_id: "login",
					test_ref: "login test",
					result: "pass",
					report_evidence: [cite("qa")],
				},
			],
		},
	],
});
const run = (fn, value) => fn(JSON.stringify(value), packet);

for (const mutation of ["mapping", "coverage"]) {
	test(`${mutation}: paired negative kills a removed guard while complete positive passes both`, async () => {
		let mutantSource = source;
		const negative = positive();
		let reason;
		if (mutation === "mapping") {
			negative.requirements[0].requirement_id = "invented-R2";
			const begin = mutantSource.indexOf("    if (!ids.length");
			const end = mutantSource.indexOf(
				"    if (value.requirements.reduce",
				begin,
			);
			assert.ok(begin > 0 && end > begin);
			mutantSource = mutantSource.slice(0, begin) + mutantSource.slice(end);
			reason = "requirement_map_invalid";
		} else {
			negative.coverage.evidence = [];
			negative.requirements[0].use_cases[0].report_evidence = [];
			for (const code of [
				"coverage_evidence_missing",
				"test_evidence_missing",
				"test_reference_unverified",
			]) {
				const marker = `return invalid("${code}");`;
				assert.ok(mutantSource.includes(marker));
				mutantSource = mutantSource.replace(marker, "void 0;");
			}
			reason = "coverage_evidence_missing";
		}
		const mutant = await import(
			`data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}`
		);
		for (const fn of [validateEvaluation, mutant.validateEvaluation])
			assert.equal(run(fn, positive()).resultCode, "evaluated");
		assert.equal(run(validateEvaluation, negative).resultCode, reason);
		assert.equal(
			run(mutant.validateEvaluation, negative).resultCode,
			"evaluated",
		);
		assert.equal(run(mutant.validateEvaluation, negative).coverage, "pass");
	});
}
