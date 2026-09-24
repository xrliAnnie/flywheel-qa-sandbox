import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const evidenceDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evidenceDir, "../../../..");
const outputDir = resolve(process.env.OUT_DIR || evidenceDir);
const baselineRef = process.env.BASELINE_REF || "origin/main";
const temporaryDir = resolve("/tmp/fly2803-visual-baseline");
mkdirSync(outputDir, { recursive: true });
mkdirSync(temporaryDir, { recursive: true });

const oldSource = execFileSync(
	"git",
	[
		"show",
		`${baselineRef}:packages/teamlead/src/bridge/account-quota-view.ts`,
	],
	{ cwd: repoRoot, encoding: "utf8" },
);
const oldModulePath = join(temporaryDir, "account-quota-view.mjs");
writeFileSync(
	oldModulePath,
	ts.transpileModule(oldSource, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ES2022,
		},
	}).outputText,
);

const current = await import(
	pathToFileURL(
		join(repoRoot, "packages/teamlead/dist/bridge/account-quota-view.js"),
	).href
);
const baseline = await import(`${pathToFileURL(oldModulePath).href}?v=${Date.now()}`);

const generatedAt = "2026-09-23T18:30:00.000Z";
const instant = (iso) => ({
	display: iso.slice(5, 16),
	source: "machine",
	observedAt: generatedAt,
	stale: false,
	rawInstant: iso,
});
const pct = (value) => ({
	display: `${value}%`,
	source: "machine",
	observedAt: generatedAt,
	stale: false,
	rawValue: value,
});
const text = (display, source = "machine") => ({
	display,
	source,
	observedAt: source === "missing" ? null : generatedAt,
	stale: false,
});
const missing = (display = "—") => text(display, "missing");

function row(overrides) {
	return {
		provider: "Claude",
		name: "fixture",
		identity: "fixture",
		active: false,
		accountMissing: false,
		ageMinutes: 5,
		subscriptionTier: text("Max 20x"),
		tokenStatus: text("正常"),
		weeklyReset: instant("2026-09-28T16:00:00.000Z"),
		fiveHReset: instant("2026-09-24T02:00:00.000Z"),
		fableReset: instant("2026-09-28T16:00:00.000Z"),
		fiveHUsage: pct(10),
		weeklyUsage: pct(20),
		fableUsage: pct(30),
		credits: text("10/28\n10/31"),
		expiry: missing(),
		exhausted: false,
		unusable: false,
		recovery: null,
		note: null,
		sortAt: "2026-09-24T02:00:00.000Z",
		...overrides,
	};
}

const claude = [
	row({
		name: "business",
		identity: "business",
		subscriptionTier: text("Max 5x"),
		weeklyReset: instant("2026-09-20T16:00:00.000Z"),
		weeklyUsage: pct(96),
		fableUsage: pct(100),
	}),
	row({
		name: "shopping",
		identity: "shopping",
		weeklyReset: instant("2026-09-25T16:00:00.000Z"),
		weeklyUsage: pct(23),
		fableUsage: pct(97),
		credits: missing("充值卡明细未提供"),
	}),
	row({
		name: "personal",
		identity: "personal",
		active: true,
		weeklyReset: instant("2026-09-27T16:00:00.000Z"),
		weeklyUsage: pct(100),
		fableUsage: pct(12),
		exhausted: true,
		recovery: instant("2026-09-27T16:00:00.000Z"),
		expiry: text("10/14", "manual"),
	}),
	row({
		name: "school",
		identity: "school",
		accountMissing: true,
		weeklyReset: missing(),
		fiveHReset: missing(),
		weeklyUsage: missing(),
		fableUsage: missing(),
		credits: missing("充值卡未确认"),
		note: "本轮读数不可用",
	}),
];

const codex = [
	row({
		provider: "Codex",
		name: "business",
		identity: "business",
		subscriptionTier: text("Plus"),
		tokenStatus: text("已吊销"),
		weeklyReset: instant("2026-09-24T16:00:00.000Z"),
		weeklyUsage: pct(20),
		fableUsage: missing(),
		credits: text("1 张\n10/30"),
		unusable: true,
	}),
	row({
		provider: "Codex",
		name: "personal",
		identity: "personal",
		active: true,
		subscriptionTier: text("Pro"),
		tokenStatus: text("打满"),
		weeklyReset: instant("2026-09-26T16:00:00.000Z"),
		weeklyUsage: pct(100),
		fableUsage: missing(),
		credits: text("2 张\n明细已截断"),
		exhausted: true,
		recovery: instant("2026-09-26T16:00:00.000Z"),
	}),
	row({
		provider: "Codex",
		name: "personal2",
		identity: "personal2",
		subscriptionTier: missing("未知"),
		tokenStatus: text("未探"),
		accountMissing: true,
		weeklyReset: missing(),
		fiveHReset: missing(),
		weeklyUsage: missing(),
		fableUsage: missing(),
		credits: missing("兑换卡未暴露"),
		note: "in_use_unshared",
	}),
];

const view = {
	generatedAt,
	staleAfterMinutes: 30,
	claude,
	codex,
	codexSourceLabel: "机器读数 · account/rateLimits/read",
	discrepancies: [],
	warnings: [],
	claudeUnavailable: [],
	codexUnavailable: [],
};
const confirmations = [
	{
		provider: "Claude",
		profile: "personal",
		identityKey: "a".repeat(64),
		status: "canceled",
		expiresOn: "2026-10-14",
		confirmedBy: "founder",
		confirmedAt: "2026-09-23T18:00:00.000Z",
		sourceRef: "FLY-2792#fixture",
	},
];
const context = {
	confirmations,
	identityKeys: { "Claude:personal": "a".repeat(64) },
};

function activeScenario(group) {
	const makeActive = (candidate) => ({
		...candidate,
		active:
			group === "full"
				? candidate.name === "personal"
				: candidate.provider === "Claude"
					? candidate.name === "school"
					: candidate.name === "personal2",
	});
	return { ...view, claude: claude.map(makeActive), codex: codex.map(makeActive) };
}

const outputs = {
	"baseline.html": baseline.renderAccountsPageHtml(view),
	"candidate.html": current.renderAccountsPageHtml(view, context),
	"candidate-active-full.html": current.renderAccountsPageHtml(
		activeScenario("full"),
		context,
	),
	"candidate-active-unknown.html": current.renderAccountsPageHtml(
		activeScenario("unknown"),
		context,
	),
};
for (const [name, html] of Object.entries(outputs)) {
	writeFileSync(join(outputDir, name), html);
}
const fixture = JSON.stringify({ view, context });
writeFileSync(join(outputDir, "fixture.json"), `${fixture}\n`);
writeFileSync(
	join(outputDir, "render-manifest.json"),
	`${JSON.stringify(
		{
			baselineRef,
			baselineHead: execFileSync("git", ["rev-parse", baselineRef], {
				cwd: repoRoot,
				encoding: "utf8",
			}).trim(),
			candidateHead: execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repoRoot,
				encoding: "utf8",
			}).trim(),
			fixtureSha256: createHash("sha256").update(fixture).digest("hex"),
			outputs: Object.fromEntries(
				Object.keys(outputs).map((name) => [
					name,
					createHash("sha256")
						.update(readFileSync(join(outputDir, name)))
						.digest("hex"),
				]),
			),
		},
		null,
		2,
	)}\n`,
);

