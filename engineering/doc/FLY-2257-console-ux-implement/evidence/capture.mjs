import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const selfCheck = process.argv.includes("--self-check");
const playwrightHeadlessShell = join(
	homedir(),
	"Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell",
);
const chrome =
	process.env.FLY2257_CHROME_EXECUTABLE ||
	(existsSync(playwrightHeadlessShell)
		? playwrightHeadlessShell
		: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const evidenceDir = dirname(fileURLToPath(import.meta.url));
const profileDir = mkdtempSync(join(tmpdir(), "fly2257-chrome-"));
const debuggingPort = Number(process.env.FLY2257_DEBUG_PORT || 19257);
const evidencePort = Number(process.env.FLY2257_EVIDENCE_PORT || 18857);
const baseUrl = `http://127.0.0.1:${evidencePort}`;
const widths = [1024, 1280, 1440];
const height = 1100;
const expectedRoleLinks = [
	"https://github.com/xrliAnnie/flywheel/blob/main/.flywheel/agents/engineering/engineer-executor.md",
	"https://github.com/xrliAnnie/flywheel/blob/main/.flywheel/agents/engineering/qa-executor.md",
];

class CdpClient {
	constructor(url) {
		this.nextId = 1;
		this.pending = new Map();
		this.socket = new WebSocket(url);
		this.ready = new Promise((resolve, reject) => {
			this.socket.addEventListener("open", resolve, { once: true });
			this.socket.addEventListener("error", reject, { once: true });
		});
		this.socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data));
			if (!message.id) return;
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
		});
	}

	async send(method, params = {}) {
		await this.ready;
		const id = this.nextId++;
		const response = new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
		this.socket.send(JSON.stringify({ id, method, params }));
		return response;
	}

	close() {
		this.socket.close();
	}
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForChrome() {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const response = await fetch(
				`http://127.0.0.1:${debuggingPort}/json/version`,
			);
			if (response.ok) return;
		} catch {}
		await delay(100);
	}
	throw new Error("Chrome DevTools endpoint did not start");
}

async function evaluate(client, expression) {
	const result = await client.send("Runtime.evaluate", {
		expression,
		returnByValue: true,
		awaitPromise: true,
	});
	if (result.exceptionDetails) {
		throw new Error(
			result.exceptionDetails.exception?.description ||
				result.exceptionDetails.text ||
				"browser evaluation failed",
		);
	}
	return result.result.value;
}

async function waitFor(client, expression, label) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await evaluate(client, expression)) return;
		await delay(100);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function screenshot(client, filename) {
	const result = await client.send("Page.captureScreenshot", {
		format: "png",
		fromSurface: true,
		captureBeyondViewport: false,
	});
	writeFileSync(join(evidenceDir, filename), Buffer.from(result.data, "base64"));
}

async function openTarget(width) {
	const response = await fetch(
		`http://127.0.0.1:${debuggingPort}/json/new?about:blank`,
		{ method: "PUT" },
	);
	if (!response.ok) throw new Error(`Could not create ${width}px Chrome target`);
	const target = await response.json();
	const client = new CdpClient(target.webSocketDebuggerUrl);
	await client.send("Page.enable");
	await client.send("Runtime.enable");
	await client.send("Emulation.setDeviceMetricsOverride", {
		width,
		height,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await client.send("Page.addScriptToEvaluateOnNewDocument", {
		source:
			"window.__fly2257ResizeCount=0;window.addEventListener('resize',function(){window.__fly2257ResizeCount+=1;});",
	});
	await client.send("Page.navigate", { url: baseUrl });
	await waitFor(
		client,
		'document.querySelectorAll("[data-project]").length === 1',
		"management snapshot",
	);
	return client;
}

async function selectDagKind(client, kind, expectedCards) {
	await evaluate(
		client,
		`document.querySelector('[data-tab="dag"]').click();document.querySelector('[data-kind="${kind}"]').click()`,
	);
	await waitFor(
		client,
		`document.querySelector('[data-panel="dag"]')?.classList.contains('active') && document.querySelectorAll('article.squad').length === ${expectedCards}`,
		`${kind} DAG cards`,
	);
}

async function measureDag(client, kind) {
	return evaluate(
		client,
		`(() => {
			const round = (value) => Number(value.toFixed(2));
			const chips = [...document.querySelectorAll("article.squad .dag-chip")];
			const scrolls = [...document.querySelectorAll("article.squad .dag-scroll")].map((scroll) => ({
				template: scroll.closest("article.squad")?.dataset.template,
				scrollWidth: scroll.scrollWidth,
				clientWidth: scroll.clientWidth,
			}));
			const chipBoxes = chips.map((chip) => {
				const box = chip.getBoundingClientRect();
				const squad = chip.closest("article.squad").getBoundingClientRect();
				return {
					node: chip.dataset.node,
					width: round(box.width),
					height: round(box.height),
					right: round(box.right),
					squadRight: round(squad.right),
					top: round(box.top),
				};
			});
			const nine = document.querySelector('article.squad[data-template="engineering_nine"]');
			const nineTops = nine ? new Set([...nine.querySelectorAll(".dag-chip")].map((chip) => round(chip.getBoundingClientRect().top))) : new Set();
			return {
				kind: ${JSON.stringify(kind)},
				viewportWidth: window.innerWidth,
				resizeCount: window.__fly2257ResizeCount,
				chipBoxes,
				scrolls,
				nineNodeRows: nineTops.size,
				roleLinks: [...document.querySelectorAll("a.ic-link[href]")].map((link) => link.getAttribute("href")),
				unlinkedHasHref: document.querySelector('[data-role="role-unlinked"]')?.matches("a[href]") ?? null,
			};
		})()`,
	);
}

async function assertFlagGeometry(client) {
	const geometry = await evaluate(
		client,
		`(() => {
			const page = document.getElementById("flagsPage");
			const head = document.querySelector(".flag-head");
			const row = document.querySelector("article.flag-row");
			const boxes = (element) => element ? [...element.children].slice(0,4).map((child) => {
				const rect = child.getBoundingClientRect();
				return {left:Number(rect.left.toFixed(2)),width:Number(rect.width.toFixed(2))};
			}) : [];
			return {
				active: page?.classList.contains("active") ?? false,
				viewportWidth: window.innerWidth,
				headWidth: head?.getBoundingClientRect().width ?? 0,
				head: boxes(head),
				row: boxes(row),
				readings: [...document.querySelectorAll("article.flag-row")].map((item) => ({
					name:item.dataset.flag,
					text:item.querySelector(".flag-read")?.textContent,
				})),
			};
		})()`,
	);
	if (!geometry.active) throw new Error("Flags page is not visibly active");
	if (!(geometry.headWidth > 0)) throw new Error("Flags header has zero width");
	if (
		geometry.head.length !== 4 ||
		geometry.row.length !== 4 ||
		geometry.head.some((box) => !(box.width > 0)) ||
		geometry.row.some((box) => !(box.width > 0))
	) {
		throw new Error("Flags columns must all have non-zero geometry");
	}
	for (let index = 0; index < 4; index += 1) {
		if (Math.abs(geometry.head[index].left - geometry.row[index].left) > 1) {
			throw new Error(`Flags column ${index} is misaligned`);
		}
	}
	return geometry;
}

function assertDagMetrics(width, product, engineering) {
	if (product.resizeCount !== 0 || engineering.resizeCount !== 0) {
		throw new Error(`${width}px emitted an unexpected resize event`);
	}
	const chips = [...product.chipBoxes, ...engineering.chipBoxes];
	const sizes = new Set(chips.map((chip) => `${chip.width}x${chip.height}`));
	if (sizes.size !== 1) {
		throw new Error(`${width}px has inconsistent node sizes: ${[...sizes]}`);
	}
	const overflow = [...product.scrolls, ...engineering.scrolls].filter(
		(scroll) => scroll.scrollWidth > scroll.clientWidth,
	);
	if (overflow.length) {
		throw new Error(`${width}px has horizontal DAG overflow: ${JSON.stringify(overflow)}`);
	}
	const clipped = chips.filter((chip) => chip.right > chip.squadRight + 1);
	if (clipped.length) {
		throw new Error(`${width}px has clipped nodes: ${JSON.stringify(clipped)}`);
	}
	if (!(engineering.nineNodeRows > 1)) {
		throw new Error(`${width}px did not wrap the nine-node positive control`);
	}
	if (JSON.stringify(product.roleLinks) !== JSON.stringify(expectedRoleLinks)) {
		throw new Error(`${width}px changed a backend sourceLink`);
	}
	if (product.unlinkedHasHref !== false) {
		throw new Error(`${width}px gave the null-sourceLink role an href`);
	}
	return { nodeSizes: [...sizes], overflow, clipped };
}

const browser = spawn(
	chrome,
	[
		"--headless=new",
		`--remote-debugging-port=${debuggingPort}`,
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-default-apps",
		"--disable-gpu",
		"--hide-scrollbars",
		"about:blank",
	],
	{ stdio: "ignore" },
);

let selfCheckPassed = false;
try {
	await waitForChrome();
	if (selfCheck) {
		const client = await openTarget(1024);
		try {
			await assertFlagGeometry(client);
			throw new Error("hidden Flags geometry unexpectedly passed");
		} catch (error) {
			if (String(error.message).includes("unexpectedly passed")) throw error;
			process.stderr.write(
				`hidden-page assertions correctly failed: ${error.message}\n`,
			);
			selfCheckPassed = true;
		} finally {
			client.close();
		}
	} else {
		const metrics = [];
		const captures = [];
		let browserVersion = "unknown";
		for (const width of widths) {
			const client = await openTarget(width);
			try {
				if (browserVersion === "unknown") {
					browserVersion = (await client.send("Browser.getVersion")).product;
				}
				await selectDagKind(client, "product", 3);
				const product = await measureDag(client, "product");
				await screenshot(client, `${width}-product.png`);
				captures.push({
					file: `${width}-product.png`,
					tab: "product",
					requestedWidth: width,
					measuredViewportWidth: product.viewportWidth,
				});
				await selectDagKind(client, "engineering", 3);
				const engineering = await measureDag(client, "engineering");
				await screenshot(client, `${width}-engineering.png`);
				captures.push({
					file: `${width}-engineering.png`,
					tab: "engineering",
					requestedWidth: width,
					measuredViewportWidth: engineering.viewportWidth,
				});
				const dagAssertions = assertDagMetrics(width, product, engineering);

				await evaluate(client, 'document.querySelector("[data-nav=flags]").click()');
				await waitFor(
					client,
					'document.getElementById("flagsPage").classList.contains("active") && document.querySelector(".flag-head").getBoundingClientRect().width > 0',
					"visible Flags page",
				);
				const flags = await assertFlagGeometry(client);
				await screenshot(client, `${width}-flags.png`);
				captures.push({
					file: `${width}-flags.png`,
					tab: "flags",
					requestedWidth: width,
					measuredViewportWidth: flags.viewportWidth,
				});
				metrics.push({ width, height, product, engineering, flags, dagAssertions });
			} finally {
				client.close();
			}
		}
		if (
			captures.length !== widths.length * 3 ||
			captures.some(
				(capture) => capture.requestedWidth !== capture.measuredViewportWidth,
			)
		) {
			throw new Error(
				`Capture manifest is incomplete or has a viewport mismatch: ${JSON.stringify(captures)}`,
			);
		}
		writeFileSync(
			join(evidenceDir, "metrics.json"),
			`${JSON.stringify(
				{
					capturedAt: new Date().toISOString(),
					browser: browserVersion,
					coldPath: true,
					captures,
					metrics,
				},
				null,
				2,
			)}\n`,
		);
		process.stdout.write(
			`PASS: ${widths.length} cold viewports, 9 screenshots, all geometry assertions\n`,
		);
	}
} finally {
	browser.kill("SIGTERM");
	await delay(200);
	rmSync(profileDir, { recursive: true, force: true });
}

if (selfCheck) {
	process.exitCode = selfCheckPassed ? 1 : 2;
}
