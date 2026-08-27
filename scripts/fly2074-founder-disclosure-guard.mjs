import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootFlag = process.argv.indexOf("--root");
const root =
	rootFlag === -1
		? join(repoRoot, "engineering/doc/FLY-2074-raya-voice-pipeline")
		: resolve(process.argv[rootFlag + 1] ?? "");
assert.notEqual(root, "", "--root requires a fixture directory");

const diagramNames = [
	"d1-core-flow",
	"d2-lifecycle",
	"d3-disconnect-sequence",
	"d4-data-model",
	"d5-silence",
];
const diagramSources = diagramNames
	.map((name) => readFileSync(join(root, `diagrams/${name}.mmd`), "utf8"))
	.join("\n");
const founderHtml = readFileSync(join(root, "founder-design.html"), "utf8");
const founderTemplate = readFileSync(
	join(root, "founder-design.template.html"),
	"utf8",
);
const facts = JSON.parse(
	readFileSync(join(root, "evidence/discord-rounds.json"), "utf8"),
);

const renderedTemplate = diagramNames.reduce(
	(html, name, index) =>
		html.replaceAll(
			`{{SVG${index + 1}}}`,
			readFileSync(join(root, `diagrams/${name}.svg`), "utf8").trim(),
		),
	founderTemplate,
);
assert.equal(
	renderedTemplate,
	founderHtml,
	"founder-design.html must be the exact render of founder-design.template.html and SVG1..5",
);

assert.equal(facts.schemaVersion, 1, "round facts schemaVersion drifted");
assert.equal(facts.rounds.length, facts.summary.attempts);
assert.equal(
	facts.rounds.filter((round) => round.harnessStatus === "passed").length,
	facts.summary.harnessPassed,
);
assert.equal(
	facts.rounds.filter(
		(round) => round.userVisibleOutcome === "question_answered",
	).length,
	facts.summary.userVisibleSuccesses,
);
assert.equal(
	facts.rounds.filter((round) => round.hardTimeout).length,
	facts.summary.hardTimeouts,
);
assert.deepEqual(
	{
		attempts: facts.summary.attempts,
		userVisibleSuccesses: facts.summary.userVisibleSuccesses,
		hardTimeouts: facts.summary.hardTimeouts,
	},
	{ attempts: 6, userVisibleSuccesses: 1, hardTimeouts: 3 },
	"founder disclosure truth changed; update evidence and all surfaces together",
);

for (const round of facts.rounds) {
	const evidencePath = join(root, "evidence", round.evidenceFile);
	assert.equal(
		existsSync(evidencePath),
		true,
		`missing evidence for ${round.id}`,
	);
	const digest = createHash("sha256")
		.update(readFileSync(evidencePath))
		.digest("hex");
	assert.equal(
		digest,
		round.evidenceSha256,
		`${round.id} evidence hash drifted`,
	);
	assert.equal(
		founderHtml.includes(`data-round="${round.id}"`),
		true,
		`founder HTML omits ${round.id}`,
	);
	assert.equal(
		founderHtml.includes(`data-outcome="${round.userVisibleOutcome}"`),
		true,
		`founder HTML outcome for ${round.id} drifted`,
	);
}

const disclosureSection = `<section id="discord-e2e-rounds" data-attempts="${facts.summary.attempts}" data-user-visible-successes="${facts.summary.userVisibleSuccesses}" data-hard-timeouts="${facts.summary.hardTimeouts}">`;
assert.equal(
	founderHtml.includes(disclosureSection),
	true,
	"founder HTML lacks machine-readable round totals",
);
for (const disclosure of [
	"用户可见成功率 <b>1/6</b>;3 轮硬超时",
	"同一 voice runtime",
	"07:29:37Z–07:42:06Z",
	"Discord 侧 30 分钟静默尚未执行,数据点为 0",
	facts.crashRelaunchAttestation,
	facts.launchAttribution.inferenceBoundary,
]) {
	assert.equal(
		founderHtml.includes(disclosure),
		true,
		`founder HTML is missing required disclosure: ${disclosure}`,
	);
}

for (const contradiction of [
	/六轮(?:全部|全都|均)(?:通过|成功|跑通)/u,
	/6\s*轮(?:全部|全都|均|全绿)(?:通过|成功|跑通)?/u,
	/成功\s*[2-6]\s*\/\s*6/u,
	/[2-6]\s*\/\s*6\s*(?:成功|通过|跑通)/u,
	/6\s*轮(?:中)?\s*[2-6]\s*轮(?:通过|成功|跑通)/u,
]) {
	assert.equal(
		contradiction.test(founderHtml),
		false,
		`founder HTML contradicts six-round evidence: ${contradiction}`,
	);
}

for (const receipt of [
	"1542408908239536138",
	"1542438894472138852",
	"1542438902722334770",
	"sent=1,423 / voice=258",
	"2,425",
	"last exit code=0",
]) {
	assert.equal(
		founderHtml.includes(receipt),
		true,
		`founder HTML is missing measured receipt: ${receipt}`,
	);
}

const supersededOnDemandClaims = [
	"raya-voice 常驻进程",
	"常驻语音房",
	"24 小时常开",
	"不因空房收掉",
	"首版进程不按空房收",
	"常驻、双向常开流",
];
const withdrawnClaims = [
	"thread/resume(上次 threadId)",
	"记得上一段:是/否",
	"空房超过 N 分钟",
	"到点自动解除",
	"hold - reason 与 until",
	"kind context_usage_estimate",
	"RAYA_DISCORD_TOKEN_ENV",
	"RAYA_VOICE_CONFIG",
	"EVIDENCE_DIR / STATE_FILE",
];
for (const claim of [...supersededOnDemandClaims, ...withdrawnClaims]) {
	assert.equal(
		diagramSources.includes(claim),
		false,
		`diagram source still claims withdrawn behavior: ${claim}`,
	);
	assert.equal(
		founderHtml.includes(claim),
		false,
		`founder HTML still claims withdrawn behavior: ${claim}`,
	);
}

const inlineSvgs = [
	...founderHtml.matchAll(/<svg id="FLY-2074-d[1-5]"[\s\S]*?<\/svg>/gu),
]
	.map((match) => match[0])
	.join("\n");
const withdrawnSemantics = [
	/thread\/resume/i,
	/(?:到点|定时|超时|自动).{0,16}(?:解除|清除)/u,
	/(?:空房|冷却).{0,40}(?:(?:收掉|关闭|停止).{0,20}(?:codex|realtime)|(?:codex|realtime).{0,20}(?:收掉|关闭|停止))/iu,
	/context_usage_estimate|context.{0,16}usage.{0,16}估算/iu,
];
for (const pattern of withdrawnSemantics) {
	assert.equal(
		pattern.test(diagramSources),
		false,
		`diagram source matches withdrawn semantics: ${pattern}`,
	);
	assert.equal(
		pattern.test(inlineSvgs),
		false,
		`delivered inline SVG matches withdrawn semantics: ${pattern}`,
	);
}

const currentContractClaims = [
	"voice-mode.requested",
	"RunAtLoad=false",
	"进入语音模式",
	"现有 Voice Channel",
	"fresh thread/start",
	"记得:否",
	"人工 clear-hold",
	"totalTokens + modelContextWindow",
	"RAYA_BOT_TOKEN",
	"RAYA_OPENAI_API_KEY",
	"RAYA_DISCORD_TEXT_CHANNEL_ID",
	"RAYA_FOUNDER_DISCORD_USER_ID",
	"RAYA_VOICE_OPTIONS_JSON",
	"RAYA_METRICS_DIR / RAYA_STATE_DIR",
	"resource-usage.jsonl",
];
for (const claim of currentContractClaims) {
	assert.equal(
		diagramSources.includes(claim),
		true,
		`diagram source is missing current contract claim: ${claim}`,
	);
	assert.equal(
		founderHtml.includes(claim),
		true,
		`founder HTML is missing rendered current contract claim: ${claim}`,
	);
}

assert.equal(
	founderHtml.includes("DIAGRAM PENDING LOCAL RENDER"),
	false,
	"founder HTML must not ship an unrendered diagram placeholder",
);
for (const name of diagramNames) {
	const source = `diagrams/${name}.mmd`;
	assert.equal(
		founderHtml.includes(source),
		false,
		`founder HTML exposes an internal Mermaid source path: ${source}`,
	);
	assert.equal(
		existsSync(join(root, `diagrams/${name}.svg`)),
		true,
		`rendered diagram is missing: diagrams/${name}.svg`,
	);
}
for (let index = 1; index <= diagramNames.length; index += 1) {
	assert.equal(
		founderHtml.includes(`id="FLY-2074-d${index}"`),
		true,
		`founder HTML is missing inline diagram FLY-2074-d${index}`,
	);
}

console.log(
	"FLY-2074 founder disclosure matches six-round evidence and final diagrams",
);
