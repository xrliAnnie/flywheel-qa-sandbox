import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(
	join(homedir(), ".npm-global/lib/node_modules/playwright/package.json"),
);
const { chromium } = require("playwright");
const evidenceDir = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(process.env.OUT_DIR || evidenceDir);
mkdirSync(outputDir, { recursive: true });
const executablePath =
	process.env.PLAYWRIGHT_CHROMIUM_PATH ||
	join(
		homedir(),
		"Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell",
	);

const consoleErrors = [];
const pageErrors = [];
const requests = [];

function recordFatal(error) {
	const message = error instanceof Error ? error.stack || error.message : String(error);
	writeFileSync(
		join(outputDir, "browser-failure.json"),
		`${JSON.stringify(
			{
				playwright: require("playwright/package.json").version,
				executablePath,
				error: message.slice(0, 8_000),
			},
			null,
			2,
		)}\n`,
	);
	console.error(message);
	process.exit(1);
}
process.on("uncaughtException", recordFatal);
process.on("unhandledRejection", recordFatal);

function observe(page) {
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	page.on("request", (request) => requests.push(request.url()));
}

async function open(name, viewport) {
	const browser = await chromium.launch({
		headless: true,
		executablePath,
		args: ["--single-process"],
	});
	const page = await browser.newPage({ viewport });
	observe(page);
	await page.goto(pathToFileURL(join(outputDir, name)).href, {
		waitUntil: "load",
	});
	return { browser, page };
}

async function activeEvidence(name) {
	const { browser, page } = await open(name, { width: 1440, height: 900 });
	const result = await page.evaluate(() => {
		const rows = [...document.querySelectorAll("tr.active-account")];
		return {
			rows: rows.length,
			providers: rows.map(
				(row) => row.closest("section")?.querySelector("h2")?.textContent ?? "",
			),
			allCellsGreen: rows.every((row) =>
				[...row.querySelectorAll("td")].every(
					(cell) => getComputedStyle(cell).backgroundColor === "rgb(227, 244, 236)",
				),
			),
			allHaveRail: rows.every(
				(row) =>
					getComputedStyle(row.querySelector("td")).boxShadow !== "none",
			),
			allHaveDotAndChip: rows.every(
				(row) =>
					row.querySelectorAll(".active-dot").length === 1 &&
					row.querySelectorAll(".active-chip").length === 1,
			),
		};
	});
	await page.screenshot({
		path: join(outputDir, name.replace(".html", ".png")),
		fullPage: true,
	});
	await page.close();
	await browser.close().catch(() => undefined);
	return result;
}

const { browser: baselineBrowser, page: baseline } = await open("baseline.html", {
	width: 1440,
	height: 1000,
});
await baseline.screenshot({
	path: join(outputDir, "baseline-1440.png"),
	fullPage: true,
});
await baseline.close();
await baselineBrowser.close().catch(() => undefined);

const { browser: candidateBrowser, page: candidate } = await open(
	"candidate.html",
	{ width: 1440, height: 1000 },
);
const candidateMetrics = await candidate.evaluate(() => {
	const groupGaps = [...document.querySelectorAll("section.provider-table")].flatMap(
		(section) => {
			const groups = [...section.querySelectorAll("tbody.quota-group")];
			return groups.slice(1).map((group, index) => {
				const previousRows = groups[index].querySelectorAll("tr");
				const previous = previousRows.item(previousRows.length - 1);
				const next = group.querySelector("tr");
				return {
					provider: section.querySelector("h2")?.textContent?.trim() ?? "",
					from: groups[index].dataset.group ?? "",
					to: group.dataset.group ?? "",
					pixels:
						previous && next
							? Number(
									(next.getBoundingClientRect().top -
										previous.getBoundingClientRect().bottom
									).toFixed(2),
								)
							: 0,
				};
			});
		},
	);
	const expectedGroupGapCount = [...document.querySelectorAll("section.provider-table")]
		.map((section) => section.querySelectorAll("tbody.quota-group").length)
		.reduce((total, groupCount) => total + Math.max(0, groupCount - 1), 0);
	const structuralGroupGaps = [
		...document.querySelectorAll("tbody.quota-group-spacer"),
	].map((spacer) => ({
		provider: spacer.closest("section")?.querySelector("h2")?.textContent?.trim() ?? "",
		pixels: Number(spacer.getBoundingClientRect().height.toFixed(2)),
		cells: spacer.querySelectorAll("tr > td").length,
	}));
	return {
		sections: document.querySelectorAll("section.provider-table").length,
		visibleGroupLabels: [...document.querySelectorAll(".group-title")].map(
			(element) => element.textContent.trim(),
		),
		expectedGroupGapCount,
		groupGaps,
		structuralGroupGaps,
		progressValues: [...document.querySelectorAll("progress")].map((element) =>
			Number(element.getAttribute("aria-valuenow")),
		),
		footerCount: document.querySelectorAll("footer").length,
		sourceMetaCount: document.querySelectorAll(".meta").length,
		recoveryCount: document.querySelectorAll(".recovery").length,
		text: document.body.innerText,
	};
});
await candidate.screenshot({
	path: join(outputDir, "candidate-1440.png"),
	fullPage: true,
});
await candidate.close();
await candidateBrowser.close().catch(() => undefined);

const { browser: mobileBrowser, page: mobile } = await open("candidate.html", {
	width: 390,
	height: 844,
});
const mobileMetrics = await mobile.evaluate(() => {
	const wraps = [...document.querySelectorAll(".table-wrap")];
	return {
		wraps: wraps.length,
		allScrollable: wraps.every(
			(element) =>
				getComputedStyle(element).overflowX === "auto" &&
				element.scrollWidth > element.clientWidth,
		),
	};
});
await mobile.screenshot({
	path: join(outputDir, "candidate-390.png"),
	fullPage: true,
});
await mobile.close();
await mobileBrowser.close().catch(() => undefined);

const activeFull = await activeEvidence("candidate-active-full.html");
const activeUnknown = await activeEvidence("candidate-active-unknown.html");

const comparisonHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>:root{color-scheme:light}body{margin:0;background:#e9e7e2;color:#1d1d1f;font-family:system-ui,sans-serif}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px}.panel{background:#fbfaf7;padding:12px}.panel h1{font-size:18px;margin:0 0 10px}.panel img{width:100%;height:auto;display:block}</style></head><body><div class="grid"><div class="panel"><h1>改前 · ${baselineRef()}</h1><img src="baseline-1440.png"></div><div class="panel"><h1>改后 · FLY-2803</h1><img src="candidate-1440.png"></div></div></body></html>`;
function baselineRef() {
	return JSON.parse(readFileSync(join(outputDir, "render-manifest.json"), "utf8"))
		.baselineHead.slice(0, 9);
}
writeFileSync(join(outputDir, "comparison.html"), comparisonHtml);
const { browser: comparisonBrowser, page: comparison } = await open(
	"comparison.html",
	{ width: 2880, height: 1200 },
);
await comparison.screenshot({
	path: join(outputDir, "baseline-vs-candidate.png"),
	fullPage: true,
});
await comparison.close();
await comparisonBrowser.close().catch(() => undefined);
const screenshots = [
	"baseline-1440.png",
	"candidate-1440.png",
	"candidate-390.png",
	"candidate-active-full.png",
	"candidate-active-unknown.png",
	"baseline-vs-candidate.png",
];
const metrics = {
	playwright: require("playwright/package.json").version,
	executablePath,
	candidate: candidateMetrics,
	mobile: mobileMetrics,
	activeFull,
	activeUnknown,
	consoleErrors,
	pageErrors,
	requestsOutsideEvidenceDir: requests.filter(
		(url) => !url.startsWith(pathToFileURL(outputDir).href),
	),
	screenshots: Object.fromEntries(
		screenshots.map((name) => [
			name,
			createHash("sha256")
				.update(readFileSync(join(outputDir, name)))
				.digest("hex"),
		]),
	),
};
writeFileSync(
	join(outputDir, "browser-metrics.json"),
	`${JSON.stringify(metrics, null, 2)}\n`,
);

const failures = [];
if (candidateMetrics.sections !== 2) failures.push("provider_sections");
if (candidateMetrics.footerCount !== 0) failures.push("footer_removed");
if (candidateMetrics.sourceMetaCount !== 0) failures.push("source_meta_removed");
if (candidateMetrics.recoveryCount !== 0) failures.push("recovery_removed");
if (!candidateMetrics.visibleGroupLabels.every((label) => label === "本轮读数不可用")) {
	failures.push("group_labels");
}
if (
	candidateMetrics.groupGaps.length === 0 ||
	candidateMetrics.groupGaps.some(({ pixels }) => pixels <= 0) ||
	candidateMetrics.structuralGroupGaps.length !==
		candidateMetrics.expectedGroupGapCount ||
	candidateMetrics.structuralGroupGaps.some(
		({ pixels, cells }) => pixels <= 0 || cells !== 1,
	)
) {
	failures.push("group_spacing");
}
if (![23, 96, 100, 100, 12, 20, 100].every((value) => candidateMetrics.progressValues.includes(value))) {
	failures.push("progress_values");
}
if (!mobileMetrics.allScrollable || mobileMetrics.wraps !== 2) {
	failures.push("mobile_scroll");
}
for (const [name, result] of Object.entries({ activeFull, activeUnknown })) {
	if (
		result.rows !== 2 ||
		result.providers.join(",") !== "Claude,Codex" ||
		!result.allCellsGreen ||
		!result.allHaveRail ||
		!result.allHaveDotAndChip
	) {
		failures.push(name);
	}
}
if (consoleErrors.length > 0) failures.push("console_errors");
if (pageErrors.length > 0) failures.push("page_errors");
if (metrics.requestsOutsideEvidenceDir.length > 0) failures.push("external_requests");

if (failures.length > 0) {
	console.error(`FAIL: ${failures.join(",")}`);
	process.exitCode = 1;
} else {
	console.log("PASS: browser visual contract");
}
