import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const playwrightRoot = process.env.FLY2365_PLAYWRIGHT_ROOT;
if (!playwrightRoot) {
	throw new Error("FLY2365_PLAYWRIGHT_ROOT is required");
}
const require = createRequire(join(playwrightRoot, "package.json"));
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const selfCheck = args.includes("--self-check");
const expectGreen = args.includes("--expect");
if (selfCheck === expectGreen) {
	throw new Error("choose exactly one of --self-check or --expect");
}
const baseUrl = process.env.CONSOLE_URL || "http://127.0.0.1:18865/";
const outDir = process.env.OUT_DIR;
const baselinePath = process.env.FLY2365_BASELINE_PATH;
if (!outDir || !baselinePath) {
	throw new Error("OUT_DIR and FLY2365_BASELINE_PATH are required");
}
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
	headless: true,
	args: ["--single-process", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
const pageErrors = [];
const nonGetRequests = [];
page.on("console", (message) => {
	if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("request", (request) => {
	if (request.method() !== "GET") {
		nonGetRequests.push(`${request.method()} ${request.url()}`);
	}
});

const failures = [];
function check(condition, id, detail) {
	if (condition) {
		console.log(`PASS ${id}: ${detail}`);
	} else {
		console.error(`FAIL ${id}: ${detail}`);
		failures.push(id);
	}
}

async function openConsole(path = "/") {
	await page.goto(new URL(path, baseUrl).href, { waitUntil: "networkidle" });
	await page.locator('[data-tab="dag"]').first().waitFor();
}

async function selectProject(name) {
	const button = page.locator(`[data-project="project/${name}"]`);
	await button.click();
	await page.locator('[data-tab="dag"]').click();
	await page.locator('[data-kind="product"]').click();
}

async function visibleAgentLinks() {
	return page.locator(
		'.panel.active .dag-chip[data-node-type]:not([data-node-type="gate"]):not([data-node-type="land"])',
	);
}

async function checkFlywheelLinks() {
	await selectProject("flywheel");
	const observations = [];
	for (const kind of ["product", "engineering"]) {
		await page.locator(`[data-kind="${kind}"]`).click();
		const chips = await visibleAgentLinks();
		for (let index = 0; index < (await chips.count()); index++) {
			const chip = chips.nth(index);
			const observation = await chip.evaluate((element) => {
				const roleId = element.dataset.handbookRole || "";
				const matches = [...document.querySelectorAll(".ic[data-role]")].filter(
					(card) => card.dataset.role === roleId,
				).length;
				return {
					node: element.dataset.node,
					ref: element.dataset.handbookRef,
					roleId,
					matches,
				};
			});
			observations.push(observation);
		}
	}
	return observations;
}

await openConsole(selfCheck ? "/self-check" : "/");
const flywheelLinks = await checkFlywheelLinks();
const missingUnique = flywheelLinks.filter(
	(observation) => !observation.roleId || observation.matches !== 1,
);

if (selfCheck) {
	await browser.close();
	if (missingUnique.length === 0) {
		console.error("self-check invalid: missing-role mutation did not fail");
		process.exitCode = 3;
	} else {
		console.error("SELF_CHECK_FAILED_AS_EXPECTED: FLY2365_MISSING_UNIQUE_ROLE");
		process.exitCode = 2;
	}
} else {
	check(missingUnique.length === 0, "U1", "every flywheel agent chip has one role card");
	check(
		new Set(flywheelLinks.map((observation) => observation.ref)).size === 7,
		"U2",
		"flywheel exposes seven workflow handbook refs",
	);

	const projectNames = [
		"flywheel",
		"geoforge3d",
		"growth",
		"joycon-typeless",
		"personal-assistant",
		"tidal-echo",
	];
	const perProject = [];
	for (const name of projectNames) {
		await selectProject(name);
		const chip = page.locator('[data-node="tpl_generic_menu/general"]');
		const observation = await chip.evaluate((element) => ({
			linked: Boolean(element.dataset.handbookRole),
			subtitle: element.querySelector(".dc-f")?.textContent,
			title: element.getAttribute("title"),
			aria: element.getAttribute("aria-label"),
		}));
		const shouldLink = name === "flywheel" || name === "personal-assistant";
		check(
			observation.linked === shouldLink,
			`P-${name}`,
			`${name} generic node link state is truthful`,
		);
		if (name === "personal-assistant") {
			check(
				observation.title?.includes("按项目 ic-roster 解析到同一手册"),
				"P-personal-roster",
				"personal-assistant explains the canonical roster match",
			);
		} else if (!shouldLink) {
			check(
				observation.subtitle === "generic · 未关联" &&
					observation.title?.includes("该项目无 ic-roster / 无 overlay") &&
					observation.aria?.includes("未关联"),
				`P-${name}-reason`,
				`${name} exposes the full unlinked reason outside the narrow chip`,
			);
		}
		if (shouldLink) await chip.click();
		else await chip.hover();
		await page.screenshot({ path: join(outDir, `${name}.png`) });
		perProject.push({ name, ...observation });
	}

	await openConsole("/schema2");
	await selectProject("flywheel");
	const schema2Chip = page.locator('[data-node="tpl_generic_menu/general"]');
	const schema2 = await schema2Chip.evaluate((element) => ({
		subtitle: element.querySelector(".dc-f")?.textContent,
		title: element.getAttribute("title"),
		linked: Boolean(element.dataset.handbookRole),
	}));
	check(
		schema2.subtitle === "generic · 未关联" &&
			schema2.title?.includes("模板未提供执行手册引用") &&
			!schema2.linked,
		"V2",
		"schema 2/null handbook ref remains renderable and explicit",
	);
	await page.screenshot({ path: join(outDir, "schema2-unlinked.png") });

	const noteCounts = await page.evaluate(() => ({
		classification: document.querySelectorAll('[data-rule="eng-node-types"]')
			.length,
		handbook: document.querySelectorAll('[data-rule="handbook-links"]').length,
	}));
	check(
		noteCounts.classification === 1 && noteCounts.handbook === 1,
		"N1",
		"classification and handbook notes are independently present once",
	);
	const chipMetrics = await page
		.locator(".panel.active .dag-chip")
		.evaluateAll((chips) =>
			chips.map((chip) => ({
				width: chip.getBoundingClientRect().width,
				subtitleFits:
					chip.querySelector(".dc-f").scrollWidth <=
					chip.querySelector(".dc-f").clientWidth,
			})),
		);
	check(
		chipMetrics.every(
			(metric) =>
				metric.width >= 76 && metric.width <= 118 && metric.subtitleFits,
		),
		"L1",
		"visible chip widths stay 76-118px and short subtitles fit",
	);
	check(consoleErrors.length === 0, "E1", "no browser console errors");
	check(pageErrors.length === 0, "E2", "no page errors");
	check(nonGetRequests.length === 0, "E3", "evidence browsing stayed GET-only");

	const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
	const metrics = {
		issue: "FLY-2365",
		baseline: {
			projects: baseline.projects.map((project) => project.name),
			dagCounts: Object.fromEntries(
				baseline.projects.map((project) => [project.name, project.dags.length]),
			),
			handbookRefCount: baseline.projects
				.flatMap((project) => project.dags)
				.flatMap((dag) => dag.graph?.nodes ?? [])
				.filter((node) => node.handbookRef).length,
			roleCounts: Object.fromEntries(
				baseline.projects.map((project) => [project.name, project.roles.length]),
			),
		},
		fixture: {
			flywheelLinks,
			uniqueWorkflowRefs: new Set(
				flywheelLinks.map((observation) => observation.ref),
			).size,
			perProject,
			schema2,
			noteCounts,
			chipMetrics,
		},
		browser: { consoleErrors, pageErrors, nonGetRequests },
		failures,
	};
	writeFileSync(join(outDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
	await browser.close();
	if (failures.length > 0) {
		console.error(`FAILURES: ${failures.join(",")}`);
		process.exitCode = 1;
	}
}
