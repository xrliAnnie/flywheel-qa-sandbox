// FLY-2364 design-phase baseline ruler for the production console (:9876).
// Read-only: navigates, clicks tabs, measures. Never touches stage/apply.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire("/Users/xiaorongli/.npm-global/lib/node_modules/playwright/package.json");
const { chromium } = require("playwright");

const base = process.env.CONSOLE_URL || "http://127.0.0.1:9876/";
const outDir = process.env.OUT_DIR || "/tmp/fly2364/shots";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
const pageErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("request", (r) => { if (r.method() !== "GET") pageErrors.push("NON-GET REQUEST " + r.method() + " " + r.url()); });

await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector(".project-button", { timeout: 15000 });
const result = { base };

result.rail = await page.evaluate(() => {
  const rail = document.querySelector(".project-rail");
  const titles = [...document.querySelectorAll(".project-rail .group-title")].map((e) => e.textContent.trim());
  const projects = [...document.querySelectorAll(".project-rail .project-button .project-name")].map((e) => e.textContent.trim());
  return { groupTitleCount: titles.length, groupTitles: titles, projectCount: projects.length, railScrollHeight: rail.scrollHeight, railClientHeight: rail.clientHeight, visibleAllWithoutScroll: rail.scrollHeight <= rail.clientHeight };
});
await page.screenshot({ path: `${outDir}/01-rail-model.png` });

// Model tab (default) for project flywheel
await page.click('.project-button[data-project="project/flywheel"]');
await page.waitForSelector('[data-panel="model"].active');
result.model = await page.evaluate(() => {
  const panel = document.querySelector('[data-panel="model"]');
  const labels = [...panel.querySelectorAll(".lead-row .field label")].map((e) => e.textContent.trim());
  const visibleLabels = labels.filter((_, i) => { const el = panel.querySelectorAll(".lead-row .field label")[i]; return getComputedStyle(el).display !== "none"; });
  return { leadRows: panel.querySelectorAll(".lead-row").length, leadHead: panel.querySelectorAll(".lead-head").length, perRowLabelTextCount: labels.filter((t) => t.includes("公司 → 型号 → effort")).length, visiblePerRowLabelCount: visibleLabels.filter((t) => t.includes("公司 → 型号 → effort")).length, groupNote: (panel.querySelector(".group-note") || {}).textContent || null };
});

// DAG tab
await page.click('[data-tab="dag"]');
await page.waitForSelector('[data-panel="dag"].active');
await page.waitForTimeout(300);
async function dagMetrics(kind) {
  await page.click(`[data-kind="${kind}"]`);
  await page.waitForTimeout(250);
  const m = await page.evaluate((kind) => {
    const panel = document.querySelector('[data-panel="dag"]');
    const chips = [...panel.querySelectorAll(".dag-chip")];
    const agent = chips.filter((c) => !["gate", "land"].includes(c.dataset.nodeType));
    const colors = {};
    agent.forEach((c) => { const cs = getComputedStyle(c); colors[c.dataset.nodeType] = cs.borderColor + " / " + cs.backgroundColor; });
    const names = chips.map((c) => c.querySelector(".dc-n").textContent.trim());
    const loops = panel.querySelectorAll("[data-loop]").length;
    const loopTexts = [...panel.querySelectorAll("svg text")].map((t) => t.textContent.trim());
    const scrolls = [...panel.querySelectorAll(".dag-scroll")].map((s) => ({ w: s.clientWidth, sw: s.scrollWidth, overflow: s.scrollWidth > s.clientWidth }));
    const cards = panel.querySelectorAll(".squad").length;
    const text = panel.innerText;
    return { kind, cards, chipCount: chips.length, agentChipCount: agent.length, agentColorsByType: colors, distinctAgentBorderColors: new Set(Object.values(colors).map((v) => v.split(" / ")[0])).size, names, loops, loopTexts, bindTags: panel.querySelectorAll(".bind-tag").length, layNotes: panel.querySelectorAll(".lay-note").length, layNoteText: (panel.querySelector(".lay-note") || {}).textContent || null, perCardReason: panel.querySelectorAll(".squad .reason").length, unlimitedText: (text.match(/不限次/g) || []).length, founderGateEnglish: (text.match(/founder gate/gi) || []).length, scrolls, dagRowNames: [...panel.querySelectorAll(".dag-row strong")].map((s) => s.textContent.trim()) };
  }, kind);
  await page.screenshot({ path: `${outDir}/02-dag-${kind}.png` });
  return m;
}
result.dagEngineering = await dagMetrics("engineering");
result.dagProduct = await dagMetrics("product");

// Flags page
await page.click('[data-nav="flags"]');
await page.waitForSelector("#flags .flag-row", { timeout: 10000 });
await page.waitForTimeout(200);
result.flags = await page.evaluate(() => {
  const pageEl = document.querySelector(".flags-page");
  const text = pageEl.innerText;
  const rows = document.querySelectorAll("#flags .flag-row").length;
  const chips = [...document.querySelectorAll("#flags .lock-chip")].map((c) => c.textContent.trim());
  const tally = {};
  chips.forEach((c) => { tally[c] = (tally[c] || 0) + 1; });
  const headCols = document.querySelector("#flags .flag-head") ? document.querySelector("#flags .flag-head").children.length : 0;
  return { rows, pageScrollHeight: pageEl.scrollHeight, viewportH: innerHeight, screens: +(pageEl.scrollHeight / innerHeight).toFixed(2), visibleCliTextCount: (text.match(/flywheel-comm feature-flags set/g) || []).length, cliInAttributes: document.querySelectorAll('#flags [data-lock-why*="flywheel-comm feature-flags set"]').length, noReasonVisible: (text.match(/系统没有给原因/g) || []).length, unmappedVisible: (text.match(/没认出这条原因/g) || []).length, fourKindsHardcoded: (text.match(/四种/g) || []).length, kindsLine: (document.querySelector("#flags .fl-t") || {}).textContent || null, lockChipTally: tally, headCols, categoryColumn: (text.match(/类别/g) || []).length, categoryLabelRows: (text.match(/\bfeature\b/g) || []).length };
});
await page.screenshot({ path: `${outDir}/03-flags.png` });
await page.screenshot({ path: `${outDir}/03-flags-full.png`, fullPage: true });

result.consoleErrors = consoleErrors;
result.pageErrors = pageErrors;
console.log(JSON.stringify(result, null, 2));
await browser.close();
