// FLY-997 S1 skeleton smoke (plan §5 S1):
//   1. environment registration (SDK/Node/surface/AFC probe/model ids)
//   2. sandbox guard assertions (all four)
//   3. mock-bridge up + single-tool loop (create_issue) × 3 rounds
//   4. pass criterion: functionCall→functionResponse→final answer, zero
//      protocol errors. Primary surface = Interactions API; if it fails at
//      the protocol level the smoke retries on generateContent and records
//      the fallback reason.

import { readFileSync, writeFileSync } from "node:fs";
import { runAgent } from "./agent-loop.mjs";
import { CONFIG } from "./config.mjs";
import { initHarness, jsonlWriter, origins, withMock } from "./harness.mjs";
import { SYSTEM_INSTRUCTION } from "./judge.mjs";
import { registryFor } from "./tools.mjs";

const { ai, guards } = initHarness();

const sdkVersion = JSON.parse(
	readFileSync(
		new URL("./node_modules/@google/genai/package.json", import.meta.url),
		"utf8",
	),
).version;

const env = {
	ts: new Date().toISOString(),
	node: process.version,
	sdk: `@google/genai@${sdkVersion}`,
	surfacePrimary: "interactions",
	models: CONFIG.models,
	afcNote:
		"Interactions surface: function execution is manual by construction (calls arrive as content items; loop must send function_result to continue) — no AFC to disable on this surface. generateContent fallback sets automaticFunctionCalling:{disable:true} explicitly.",
	guards,
};

const SMOKE_PROMPT =
	"帮我建一个 issue:标题『测试冒烟 issue』,描述『S1 冒烟验证 create_issue 全链路』。建好后告诉我 issue 编号。";

await withMock(async () => {
	const raw = jsonlWriter(`${CONFIG.paths.outDir}s1-smoke.jsonl`);
	const audit = jsonlWriter(`${CONFIG.paths.outDir}s1-audit.jsonl`);

	let surface = "interactions";
	let fallbackReason = null;
	const rounds = [];

	for (let i = 0; i < 3; i++) {
		await fetch(`http://${CONFIG.mock.host}:${CONFIG.mock.port}/__mock/reset`, {
			method: "POST",
		});
		try {
			const res = await runAgent({
				ai,
				model: CONFIG.models.flash,
				surface,
				systemInstruction: SYSTEM_INSTRUCTION,
				userMessage: SMOKE_PROMPT,
				registry: registryFor(["create_issue"]),
				maxSteps: 4,
				audit: (l) => audit({ smoke: i, ...l }),
			});
			const mockState = await (
				await fetch(
					`http://${CONFIG.mock.host}:${CONFIG.mock.port}/__mock/state`,
				)
			).json();
			const created = mockState.issues.length === 1;
			const answered = res.finalText.trim().length > 0;
			const pass =
				created &&
				answered &&
				res.toolCalls.every(
					(c) => !c.hallucinated && c.validationErrors.length === 0,
				);
			rounds.push({
				round: i,
				surface,
				pass,
				created,
				answered,
				steps: res.steps,
				usage: res.usage,
			});
			raw({
				round: i,
				surface,
				pass,
				finalText: res.finalText,
				toolCalls: res.toolCalls,
				issues: mockState.issues,
			});
			console.log(
				`[S1] round ${i} surface=${surface} pass=${pass} steps=${res.steps} tokens=${JSON.stringify(res.usage)}`,
			);
		} catch (err) {
			raw({
				round: i,
				surface,
				error: String(err?.stack ?? err).slice(0, 800),
			});
			console.error(
				`[S1] round ${i} surface=${surface} ERROR: ${err?.message ?? err}`,
			);
			if (surface === "interactions" && i === 0) {
				fallbackReason = `interactions surface failed at protocol level: ${String(err?.message ?? err).slice(0, 300)}`;
				surface = "generateContent";
				i -= 1; // redo this round on the fallback surface
				continue;
			}
			rounds.push({
				round: i,
				surface,
				pass: false,
				error: String(err?.message ?? err),
			});
		}
	}

	const allPass = rounds.length === 3 && rounds.every((r) => r.pass);
	const report = {
		...env,
		surfaceUsed: surface,
		fallbackReason,
		rounds,
		outboundOrigins: origins(),
		verdict: allPass ? "PASS" : "FAIL",
	};
	writeFileSync(
		`${CONFIG.paths.evidenceDir}s1-environment.json`,
		JSON.stringify(report, null, 2),
	);
	console.log(
		`\n[S1] verdict: ${report.verdict}; surface=${surface}; origins=${report.outboundOrigins.join(",")}`,
	);
	if (!allPass) process.exit(1);
});
