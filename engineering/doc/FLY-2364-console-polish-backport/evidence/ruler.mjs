// Read-only Playwright ruler for FLY-2364. Any non-GET request is a failure.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(
	"/Users/xiaorongli/.npm-global/lib/node_modules/playwright/package.json",
);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const targetIndexes = args.flatMap((arg, index) =>
	arg === "--target" ? [index] : [],
);
if (targetIndexes.length > 1) {
	throw new Error("pass --target at most once");
}
const targetIndex = targetIndexes[0] ?? -1;
const target = targetIndex >= 0 ? args[targetIndex + 1] : "fixture";
if (target !== "fixture" && target !== "prod") {
	throw new Error("--target must be fixture or prod");
}
const base =
	process.env.CONSOLE_URL ||
	(target === "prod" ? "http://127.0.0.1:9876/" : "http://127.0.0.1:18864/");
const outDir = process.env.OUT_DIR || "/tmp/fly2364/shots";
const explicitExpect = args.includes("--expect");
const selfCheck = args.includes("--self-check");
const expectMode = explicitExpect || (targetIndex >= 0 && !selfCheck);
const requireAll = args.includes("--require-all");
mkdirSync(outDir, { recursive: true });

if (expectMode === selfCheck) {
	throw new Error("pass --expect/--target or --self-check, but not both");
}
if (requireAll && target !== "prod") {
	throw new Error("--require-all is only valid with --target prod");
}

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evidenceDir, "../../../..");
const consoleSourceCandidates = [
	resolve(repoRoot, "packages/teamlead/dist/bridge/fleet-console-html.js"),
	resolve(repoRoot, "packages/teamlead/src/bridge/fleet-console-html.ts"),
];
const consoleSourcePath = consoleSourceCandidates.find((candidate) =>
	existsSync(candidate),
);
if (!consoleSourcePath) {
	throw new Error("fleet console source/build artifact is missing");
}
const consoleSource = readFileSync(consoleSourcePath, "utf8");
const lockKindsSource = consoleSource.match(
	/var LOCK_KINDS=\[([\s\S]*?)\];\s*function lockKind/,
)?.[1];
if (!lockKindsSource) {
	throw new Error(`LOCK_KINDS is missing from ${consoleSourcePath}`);
}
const knownLockLabels = [
	...lockKindsSource.matchAll(/label:("(?:\\.|[^"\\])*")/g),
].map((match) => JSON.parse(match[1]));
if (!knownLockLabels.length) {
	throw new Error(`LOCK_KINDS has no labels in ${consoleSourcePath}`);
}

const executablePath =
	process.env.PLAYWRIGHT_CHROMIUM_PATH ||
	"/Users/xiaorongli/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const browser = await chromium.launch({
	headless: true,
	executablePath,
	// The runner sandbox cannot register Chromium's macOS child-process Mach
	// rendezvous service. Single-process headless mode keeps the evidence run
	// inside the permitted process boundary while preserving real rendering.
	args: ["--single-process"],
});
const consoleErrors = [];
const pageErrors = [];
const nonGetRequests = [];

function observe(page) {
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	page.on("request", (request) => {
		if (request.method() !== "GET") {
			nonGetRequests.push(`${request.method()} ${request.url()}`);
		}
	});
}

async function ready(page) {
	await page.goto(base, { waitUntil: "networkidle" });
	await page.waitForSelector('.project-button[data-project="project/flywheel"]', {
		timeout: 15_000,
	});
}

const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
observe(page);
await ready(page);

if (selfCheck) {
	const hiddenDagWidth = await page.evaluate(() => {
		const scroll = document.querySelector('[data-panel="dag"] .dag-scroll');
		if (!scroll) throw new Error("self-check prerequisite missing: inactive DAG");
		return scroll.clientWidth;
	});
	await browser.close();
	if (hiddenDagWidth <= 0) {
		console.log("SELF_CHECK_FAILED_AS_EXPECTED: HIDDEN_DAG_WIDTH");
		process.exitCode = 1;
	} else {
		console.error(`SELF_CHECK_UNEXPECTED_PASS: HIDDEN_DAG_WIDTH=${hiddenDagWidth}`);
		process.exitCode = 2;
	}
} else {
	const result = { base, target };

	result.rail = await page.evaluate(() => {
		const rail = document.querySelector(".project-rail");
		const titles = [
			...document.querySelectorAll(".project-rail .group-title"),
		].map((element) => element.textContent.trim());
		const realProjects = [
			...document.querySelectorAll(
				'.project-rail .project-button[data-project^="project/"]',
			),
		];
		const railBox = rail.getBoundingClientRect();
		const allRealProjectsVisible = realProjects.every((element) => {
			const box = element.getBoundingClientRect();
			return box.top >= railBox.top && box.bottom <= railBox.bottom;
		});
		return {
			groupTitleCount: titles.length,
			groupTitles: titles,
			projectCount: realProjects.length,
			allRealProjectsVisible,
			railScrollHeight: rail.scrollHeight,
			railClientHeight: rail.clientHeight,
		};
	});

	await page.click('.project-button[data-project="project/flywheel"]');
	await page.waitForSelector('[data-panel="model"].active');
	result.model = await page.evaluate(() => {
		const panel = document.querySelector('[data-panel="model"]');
		const head = panel.querySelector(".lead-list > .lead-head");
		const rowLabels = [...panel.querySelectorAll(".lead-row .field>label")];
		const runnerLabel = panel.querySelector(".grid .card .field>label");
		return {
			leadRows: panel.querySelectorAll(".lead-row").length,
			leadHead: panel.querySelectorAll(".lead-list > .lead-head").length,
			leadHeadText: head
				? [...head.querySelectorAll("span")].map((element) =>
						element.textContent.trim(),
					)
				: [],
			visiblePerRowLabelCount: rowLabels.filter(
				(element) => getComputedStyle(element).display !== "none",
			).length,
			runnerCardLabelVisible:
				Boolean(runnerLabel) && getComputedStyle(runnerLabel).display !== "none",
			groupNote: panel.querySelector(".group-note")?.textContent ?? null,
		};
	});
	await page.screenshot({ path: `${outDir}/01-rail-model.png` });

	await page.click('.project-button[data-group="infra"]');
	await page.waitForFunction(
		() => document.querySelector("#detail h1")?.textContent === "Infra",
	);
	result.groupModel = await page.evaluate(() => ({
		leadHead: document.querySelectorAll("#detail .lead-list > .lead-head").length,
		leadRows: document.querySelectorAll("#detail .lead-row").length,
	}));
	await page.click('.project-button[data-project="project/flywheel"]');
	await page.waitForSelector('[data-panel="model"].active');

	await page.click('[data-tab="dag"]');
	await page.waitForSelector('[data-panel="dag"].active');
	await page.click('[data-kind="engineering"]');
	await page.waitForTimeout(100);
	result.dagEngineering = await page.evaluate(() => {
		const panel = document.querySelector('[data-panel="dag"]');
		const primaryCards = ["tpl_code", "tpl_simple_code"].map((templateId) =>
			panel.querySelector(`.squad[data-template="${templateId}"]`),
		);
		const primaryChips = primaryCards.flatMap((card) =>
			card ? [...card.querySelectorAll(".dag-chip")] : [],
		);
		const agentChips = [...panel.querySelectorAll(".dag-chip")].filter(
			(chip) => ["design", "implement", "qa"].includes(chip.dataset.nodeType),
		);
		const stylesByType = {};
		for (const chip of agentChips) {
			const style = getComputedStyle(chip);
			stylesByType[chip.dataset.nodeType] =
				`${style.borderColor} / ${style.backgroundColor}`;
		}
		const codeCard = panel.querySelector('.squad[data-template="tpl_code"]');
		const legacyCard = panel.querySelector(
			'.squad[data-template="tpl_legacy_loop"]',
		);
		const dagRows = [...panel.querySelectorAll(".dag-row")];
		const bindTags = [...panel.querySelectorAll(".dag-row strong > .bind-tag")];
		const lastLoop = codeCard?.querySelector("[data-loop]:last-of-type");
		const firstBox = codeCard?.querySelector("[data-loop-label-box]");
		return {
			primaryChipCount: primaryChips.length,
			primaryNames: primaryChips.map(
				(chip) => chip.querySelector(".dc-n")?.textContent.trim() ?? "",
			),
			stylesByType,
			dagRows: dagRows.length,
			bindTags: bindTags.length,
			bindSources: bindTags.map((tag) => tag.dataset.bindSource ?? ""),
			bindTitles: bindTags.map((tag) => tag.getAttribute("title") ?? ""),
			codeLoopTexts: [
				...codeCard.querySelectorAll("text[data-loop-label]"),
			].map((element) => element.textContent.trim()),
			legacyCardPresent: Boolean(legacyCard),
			legacyLoopTexts: legacyCard
				? [...legacyCard.querySelectorAll("text[data-loop-label]")].map(
						(element) => element.textContent.trim(),
					)
				: [],
			loopPaintOrder:
				Boolean(lastLoop && firstBox) &&
				Boolean(
					lastLoop.compareDocumentPosition(firstBox) &
						Node.DOCUMENT_POSITION_FOLLOWING,
				),
			unlimitedText: (panel.innerText.match(/不限次/g) || []).length,
			founderGateEnglish: (panel.innerText.match(/founder gate/gi) || []).length,
			landEnglish: (panel.innerText.match(/\bland\b/gi) || []).length,
			layNotes: panel.querySelectorAll(".lay-note").length,
			perCardReasons: panel.querySelectorAll(".squad .reason").length,
			loopCount: panel.querySelectorAll("[data-loop]").length,
		};
	});
	await page.screenshot({ path: `${outDir}/02-dag-engineering.png` });
	await page
		.locator('.squad[data-template="tpl_code"]')
		.screenshot({ path: `${outDir}/02b-tpl-code-loops.png` });

	await page.click('[data-kind="product"]');
	await page.waitForTimeout(100);
	result.dagProduct = await page.evaluate(() => {
		const panel = document.querySelector('[data-panel="dag"]');
		const generic = panel.querySelector('.dag-chip[data-node-type="generic"]');
		const style = generic ? getComputedStyle(generic) : null;
		return {
			chipCount: panel.querySelectorAll(".dag-chip").length,
			genericStyle: style
				? `${style.borderColor} / ${style.backgroundColor}`
				: null,
			layNotes: panel.querySelectorAll(".lay-note").length,
			perCardReasons: panel.querySelectorAll(".squad .reason").length,
			founderGateEnglish: (panel.innerText.match(/founder gate/gi) || []).length,
			landEnglish: (panel.innerText.match(/\bland\b/gi) || []).length,
		};
	});
	await page.screenshot({ path: `${outDir}/03-dag-product.png` });

	await page.click('[data-nav="flags"]');
	await page.waitForSelector("#flags .flag-row");
	result.flags = await page.evaluate(() => {
		const pageElement = document.querySelector(".flags-page");
		const text = pageElement.innerText;
		const lockChips = [...document.querySelectorAll("#flags .lock-chip")].map(
			(element) => element.textContent.trim(),
		);
		return {
			rows: document.querySelectorAll("#flags .flag-row").length,
			pageScrollHeight: pageElement.scrollHeight,
			viewportHeight: innerHeight,
			screens: Number((pageElement.scrollHeight / innerHeight).toFixed(2)),
			visibleCliTextCount: (text.match(/flywheel-comm feature-flags set/g) || [])
				.length,
			cliInAttributes: document.querySelectorAll(
				'#flags [data-lock-why*="flywheel-comm feature-flags set"]',
			).length,
			noReasonVisible: (text.match(/系统没有给原因/g) || []).length,
			unmappedVisible: (text.match(/没认出这条原因/g) || []).length,
			fourKindsHardcoded: (text.match(/四种/g) || []).length,
			categoryColumn: (text.match(/类别/g) || []).length,
			categoryLabelRows: (text.match(/\bfeature\b/g) || []).length,
			headColumns:
				document.querySelector("#flags .flag-head")?.children.length ?? 0,
			lockChips,
			kindsLine: document.querySelector("#flags .fl-t")?.textContent ?? null,
		};
	});
	await page.screenshot({ path: `${outDir}/04-flags.png`, fullPage: true });

	await page.setViewportSize({ width: 1000, height: 900 });
	await ready(page);
	await page.click('.project-button[data-project="project/flywheel"]');
	result.narrowModel = await page.evaluate(() => {
		const head = document.querySelector('[data-panel="model"] .lead-head');
		const leadLabels = [
			...document.querySelectorAll('[data-panel="model"] .lead-row .field>label'),
		];
		const leadSelects = [
			...document.querySelectorAll('[data-panel="model"] .lead-row select'),
		];
		const runnerLabel = document.querySelector(
			'[data-panel="model"] .grid .card .field>label',
		);
		return {
			headPresent: Boolean(head),
			headDisplay: head ? getComputedStyle(head).display : null,
			visibleLeadLabelCount: leadLabels.filter(
				(label) => getComputedStyle(label).display !== "none",
			).length,
			leadSelectAriaLabels: leadSelects.map((select) =>
				select.getAttribute("aria-label"),
			),
			runnerCardLabelVisible:
				Boolean(runnerLabel) && getComputedStyle(runnerLabel).display !== "none",
		};
	});
	await page.screenshot({ path: `${outDir}/05-model-narrow.png` });

	result.consoleErrors = consoleErrors;
	result.pageErrors = pageErrors;
	result.nonGetRequests = nonGetRequests;

	const expectedNames = [
		"设计(工程)",
		"实现",
		"QA 验证",
		"创始人门",
		"合入",
		"实现",
		"QA 验证",
		"创始人门",
		"合入",
	];
	const typeStyles = new Set([
		...Object.values(result.dagEngineering.stylesByType),
		result.dagProduct.genericStyle,
	]);
	result.lockKinds = {
		source: relative(repoRoot, consoleSourcePath),
		labels: knownLockLabels,
	};
	const fixtureTarget = target === "fixture";
	const knownLockLabelSet = new Set(knownLockLabels);
	const checks = [
		{
			id: "B6",
			expected: {
				groupTitleCount: 2,
				projectCount: fixtureTarget ? 6 : "dynamic",
				allRealProjectsVisible: true,
			},
			actual: result.rail,
			ok:
				result.rail.groupTitleCount === 2 &&
				(!fixtureTarget || result.rail.projectCount === 6) &&
				result.rail.allRealProjectsVisible,
		},
		{
			id: "D",
			expected: {
				leadHead: 1,
				leadHeadText: ["Lead", "公司 → 型号 → effort"],
				groupNotePrefix: "另有 2 个 Lead 归在「Infra」分组下",
				narrowHeadDisplay: "none",
				narrowVisibleLeadLabelCount: 1,
			},
			actual: {
				model: result.model,
				groupModel: result.groupModel,
				narrowModel: result.narrowModel,
			},
			ok:
				result.model.leadHead === 1 &&
				JSON.stringify(result.model.leadHeadText) ===
					JSON.stringify(["Lead", "公司 → 型号 → effort"]) &&
				result.model.visiblePerRowLabelCount === 0 &&
				result.model.runnerCardLabelVisible &&
				result.model.groupNote?.startsWith("另有 2 个 Lead 归在「Infra」分组下") &&
				result.groupModel.leadHead === 1 &&
				result.narrowModel.headPresent &&
				result.narrowModel.headDisplay === "none" &&
				result.narrowModel.visibleLeadLabelCount === 1 &&
				JSON.stringify(result.narrowModel.leadSelectAriaLabels) ===
					JSON.stringify([
						"公司 → 型号 → effort：公司",
						"公司 → 型号 → effort：型号",
						"公司 → 型号 → effort：effort",
					]) &&
				result.narrowModel.runnerCardLabelVisible,
		},
		{
			id: "A4",
			expected: "every editable DAG model row has a sourced 模板绑定 tag",
			actual: {
				dagRows: result.dagEngineering.dagRows,
				bindTags: result.dagEngineering.bindTags,
				bindSources: result.dagEngineering.bindSources,
				bindTitles: result.dagEngineering.bindTitles,
			},
			ok:
				result.dagEngineering.dagRows > 0 &&
				result.dagEngineering.bindTags === result.dagEngineering.dagRows &&
				result.dagEngineering.bindSources.every((source) => source.includes("@")) &&
				result.dagEngineering.bindTitles.every(
					(title) => title.startsWith("模板绑定 ") && title.includes("@"),
				),
		},
		{
			id: "A3",
			expected: fixtureTarget
				? {
						codeLoopTexts: ["QA 失败重来 ×3", "创始人打回重做"],
						legacyLoopTexts: ["legacy_retry"],
						loopPaintOrder: true,
						unlimitedText: 0,
					}
				: {
						codeLoopTexts: "non-empty runtime labels",
						loopPaintOrder: true,
						unlimitedText: 0,
					},
			actual: {
				codeLoopTexts: result.dagEngineering.codeLoopTexts,
				legacyCardPresent: result.dagEngineering.legacyCardPresent,
				legacyLoopTexts: result.dagEngineering.legacyLoopTexts,
				loopPaintOrder: result.dagEngineering.loopPaintOrder,
				unlimitedText: result.dagEngineering.unlimitedText,
			},
			ok:
				(!fixtureTarget ||
					(JSON.stringify(result.dagEngineering.codeLoopTexts) ===
						JSON.stringify(["QA 失败重来 ×3", "创始人打回重做"]) &&
						result.dagEngineering.legacyCardPresent &&
						JSON.stringify(result.dagEngineering.legacyLoopTexts) ===
							JSON.stringify(["legacy_retry"]))) &&
				(fixtureTarget || result.dagEngineering.codeLoopTexts.length > 0) &&
				result.dagEngineering.codeLoopTexts.every(Boolean) &&
				result.dagEngineering.loopPaintOrder &&
				result.dagEngineering.unlimitedText === 0,
		},
		{
			id: "DAG",
			expected: { primaryChipCount: 9, loopCount: ">=3" },
			actual: {
				primaryChipCount: result.dagEngineering.primaryChipCount,
				loopCount: result.dagEngineering.loopCount,
			},
			ok:
				result.dagEngineering.primaryChipCount === 9 &&
				result.dagEngineering.loopCount >= 3,
		},
		{
			id: "A1",
			expected: {
				primaryNames: expectedNames,
				founderGateEnglish: 0,
				landEnglish: 0,
			},
			actual: {
				primaryNames: result.dagEngineering.primaryNames,
				engineeringFounderGateEnglish:
					result.dagEngineering.founderGateEnglish,
				engineeringLandEnglish: result.dagEngineering.landEnglish,
				productFounderGateEnglish: result.dagProduct.founderGateEnglish,
				productLandEnglish: result.dagProduct.landEnglish,
			},
			ok:
				JSON.stringify(result.dagEngineering.primaryNames) ===
					JSON.stringify(expectedNames) &&
				result.dagEngineering.founderGateEnglish === 0 &&
				result.dagEngineering.landEnglish === 0 &&
				result.dagProduct.founderGateEnglish === 0 &&
				result.dagProduct.landEnglish === 0,
		},
		{
			id: "A2",
			expected: "4 distinct non-null node.type styles",
			actual: [...typeStyles],
			ok: typeStyles.size === 4 && !typeStyles.has(null),
		},
		{
			id: "A5",
			expected: {
				engineering: { layNotes: 1, perCardReasons: 0 },
				product: { layNotes: 1, perCardReasons: 0 },
			},
			actual: {
				engineering: {
					layNotes: result.dagEngineering.layNotes,
					perCardReasons: result.dagEngineering.perCardReasons,
				},
				product: {
					layNotes: result.dagProduct.layNotes,
					perCardReasons: result.dagProduct.perCardReasons,
				},
			},
			ok:
				result.dagEngineering.layNotes === 1 &&
				result.dagEngineering.perCardReasons === 0 &&
				result.dagProduct.layNotes === 1 &&
				result.dagProduct.perCardReasons === 0,
		},
		{
			id: "C7",
			expected: {
				noReasonVisible: 0,
				unmappedVisible: 0,
				lockLabelsFromArtifact: knownLockLabels,
			},
			actual: {
				noReasonVisible: result.flags.noReasonVisible,
				unmappedVisible: result.flags.unmappedVisible,
				lockChips: result.flags.lockChips,
			},
			ok:
				result.flags.noReasonVisible === 0 &&
				result.flags.unmappedVisible === 0 &&
				knownLockLabelSet.size > 0 &&
				result.flags.lockChips.every((label) =>
					knownLockLabelSet.has(label),
				),
		},
		{
			id: "C8",
			expected: {
				visibleCliTextCount: 0,
				categoryColumn: 0,
				categoryLabelRows: 0,
				fourKindsHardcoded: 0,
				headColumns: 4,
			},
			actual: result.flags,
			ok:
				result.flags.visibleCliTextCount === 0 &&
				result.flags.categoryColumn === 0 &&
				result.flags.categoryLabelRows === 0 &&
				result.flags.fourKindsHardcoded === 0 &&
				result.flags.headColumns === 4,
		},
		{
			id: "ERRORS",
			expected: {
				consoleErrors: [],
				pageErrors: [],
				nonGetRequests: [],
			},
			actual: { consoleErrors, pageErrors, nonGetRequests },
			ok:
				consoleErrors.length === 0 &&
				pageErrors.length === 0 &&
				nonGetRequests.length === 0,
		},
	];
	const pendingDeployIds = new Set(["B6", "D", "A4", "A3", "C7"]);
	result.checks = checks.map((check) => ({
		...check,
		status:
			target === "prod" && !requireAll && pendingDeployIds.has(check.id)
				? "PENDING_DEPLOY"
				: check.ok
					? "PASS"
					: "FAIL",
	}));
	const failed = result.checks
		.filter((check) => check.status === "FAIL")
		.map((check) => check.id);
	const pendingDeploy = result.checks
		.filter((check) => check.status === "PENDING_DEPLOY")
		.map((check) => check.id);
	result.failed = failed;
	result.pendingDeploy = pendingDeploy;
	writeFileSync(`${outDir}/metrics.json`, `${JSON.stringify(result, null, 2)}\n`);
	console.log(JSON.stringify(result, null, 2));
	for (const check of result.checks) {
		console.log(
			`${check.id}: ${check.status} | expected=${JSON.stringify(check.expected)} | actual=${JSON.stringify(check.actual)}`,
		);
	}
	console.log(`FAIL: ${failed.length ? failed.join(",") : "none"}`);
	console.log(
		`${checks.length} 项 / ${failed.length} 红 / ${pendingDeploy.length} 待部署`,
	);
	await browser.close();
	if (failed.length) process.exitCode = 1;
}
