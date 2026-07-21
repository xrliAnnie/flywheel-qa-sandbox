import { renderReportHtml } from "/Users/xiaorongli/Dev/flywheel/packages/token-usage/dist/report/render-html.js";

const B = 1e9;
const day = "2026-07-16";
const proj = (name, tokens, cost, rm, leads, issues, inC = 0, inT = 0) => ({
	name,
	tokens,
	cost,
	runnerMainTokens: rm,
	leads,
	issues,
	inprogCount: inC,
	inprogTokens: inT,
});
const L = (name, tokens, cost) => ({ name, tokens, cost });
const I = (id, tokens, cost) => ({ id, tokens, cost });
const projects = [
	proj(
		"flywheel",
		2.1 * B,
		2100,
		0.9 * B,
		[
			L("Tadashi", 0.6 * B, 600),
			L("Honey Lemon", 0.4 * B, 400),
			L("Aunt Cass", 0.2 * B, 200),
		],
		[
			I("FLY-1252", 0.28 * B, 280),
			I("FLY-1307", 0.34 * B, 340),
			I("FLY-1272", 0.21 * B, 210),
			I("FLY-1309", 0.09 * B, 90),
		],
		3,
		0.4 * B,
	),
	proj(
		"geoforge3d",
		1.1 * B,
		1100,
		0.6 * B,
		[L("Peter", 0.3 * B, 300), L("Hiro-geo", 0.2 * B, 200)],
		[I("GEO-412", 0.22 * B, 220), I("GEO-419", 0.14 * B, 140)],
		2,
		0.2 * B,
	),
	proj(
		"tidal-echo",
		0.6 * B,
		600,
		0.35 * B,
		[L("Ariel", 0.15 * B, 150), L("Triton", 0.1 * B, 100)],
		[I("TIDE-88", 0.12 * B, 120)],
		1,
		0.08 * B,
	),
	proj(
		"growth",
		0.4 * B,
		400,
		0.25 * B,
		[L("Mufasa", 0.15 * B, 150)],
		[I("GROW-31", 0.09 * B, 90)],
		1,
		0.05 * B,
	),
	proj(
		"personal-assistant",
		0.3 * B,
		300,
		0.2 * B,
		[L("Belle", 0.1 * B, 100)],
		[],
		0,
		0,
	),
	proj(
		"joycon-typeless",
		0.2 * B,
		200,
		0.12 * B,
		[L("Hiro", 0.08 * B, 80)],
		[I("JOY-17", 0.06 * B, 60)],
		0,
		0,
	),
	proj(
		"polaris",
		0.1 * B,
		100,
		0.06 * B,
		[L("Rafiki", 0.04 * B, 40)],
		[],
		0,
		0,
	),
];
const total = {
	tokens: 4.8 * B,
	input: 0.72 * B,
	output: 0.18 * B,
	cacheRead: 3.6 * B,
	cacheWrite: 0.3 * B,
	cost: 4820,
};
const leadsAll = projects
	.flatMap((p) => p.leads)
	.concat([
		{
			name: "Codex(design/code review · 全 fleet)",
			tokens: 0.28 * B,
			cost: 280,
		},
	])
	.sort((a, b) => b.tokens - a.tokens);
const models = [
	{ name: "claude-opus-4-8", tokens: 2.1 * B, cost: 2100 },
	{ name: "claude-fable-5", tokens: 1.7 * B, cost: 1200 },
	{ name: "claude-sonnet-5", tokens: 0.7 * B, cost: 520 },
	{ name: "claude-haiku-4-5-20251001", tokens: 0.3 * B, cost: 110 },
	{ name: "gpt-5.6-sol (Codex)", tokens: 0.19 * B, cost: 190 },
	{ name: "gpt-5-codex (Codex)", tokens: 0.09 * B, cost: 90 },
];
const days = [];
for (let d = 4; d <= 16; d++)
	days.push(`2026-07-${String(d).padStart(2, "0")}`);
const trendTotal = days.map((day, i) => ({
	day,
	tokens: (3.2 + Math.sin(i) * 0.8 + i * 0.12) * B,
	cost: 3200 + i * 90,
}));
const trendByProject = projects.slice(0, 5).map((p) => ({
	project: p.name,
	points: days.map((day, i) => ({
		day,
		tokens: ((p.tokens / B) * (0.7 + 0.05 * i) * B) / 2,
		cost: 100,
	})),
}));
trendByProject.push({
	project: "Codex(design/code review)",
	points: days.map((day, i) => ({
		day,
		tokens: (0.18 + 0.02 * i + Math.sin(i) * 0.03) * B,
		cost: 120,
	})),
});
const comparison = {
	before: {
		label: "前一周",
		days: 7,
		avgTokens: 3.9 * B,
		avgCost: 3900,
		byModel: {},
	},
	after: {
		label: "本周",
		days: 7,
		avgTokens: 5.0 * B,
		avgCost: 5000,
		byModel: {},
	},
};
const model = {
	reportDay: day,
	timezone: "America/Los_Angeles",
	total,
	projects,
	leadsAll,
	models,
	trendTotal,
	trendByProject,
	comparison,
	integrity: {
		ok: true,
		codes: [],
		messages: [],
		latestDataDay: day,
		reportDayTotal: total.tokens,
		attributedTotal: total.tokens,
	},
	storeMode: "supabase",
};
const html = renderReportHtml(model);
process.stdout.write(html);
