import { execFileSync, spawn } from "node:child_process";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const chrome =
	process.env.FLY2054_CHROME_EXECUTABLE ||
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ffmpeg = process.env.FLY2054_FFMPEG_EXECUTABLE || "/opt/homebrew/bin/ffmpeg";
const evidenceDir = dirname(fileURLToPath(import.meta.url));
const profileDir = mkdtempSync(join(tmpdir(), "fly2054-chrome-"));
const debuggingPort = 19254;
const evidencePort = Number(process.env.FLY2054_EVIDENCE_PORT || 18854);
const baseUrl = `http://127.0.0.1:${evidencePort}`;

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
		const result = new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
		this.socket.send(JSON.stringify({ id, method, params }));
		return result;
	}

	close() {
		this.socket.close();
	}
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForChrome() {
	for (let attempt = 0; attempt < 80; attempt += 1) {
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
		throw new Error(result.exceptionDetails.text || "browser evaluation failed");
	}
	return result.result.value;
}

async function waitFor(client, expression, label) {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		if (await evaluate(client, expression)) return;
		await delay(100);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function navigate(client, url, readyExpression, label) {
	await client.send("Page.navigate", { url });
	await waitFor(client, readyExpression, label);
	await delay(150);
}

async function screenshot(client, filename) {
	const result = await client.send("Page.captureScreenshot", {
		format: "png",
		fromSurface: true,
		captureBeyondViewport: false,
	});
	writeFileSync(join(evidenceDir, filename), Buffer.from(result.data, "base64"));
}

async function assertModelControlsFit(client, screen) {
	const controlOverflows = await evaluate(
		client,
		`[...document.querySelectorAll("select[data-model-part]")]
			.filter((select) => select.getClientRects().length > 0)
			.map((select) => {
				const container = select.closest(".card,.lead-row");
				const selectRect = select.getBoundingClientRect();
				const containerRect = container?.getBoundingClientRect();
				return {
					target: select.closest("[data-model-target]")?.dataset.modelTarget,
					part: select.dataset.modelPart,
					overflowPx: containerRect
						? Number((selectRect.right - containerRect.right).toFixed(2))
						: null,
				};
			})
			.filter((item) => item.overflowPx == null || item.overflowPx > 1)`,
	);
	if (controlOverflows.length) {
		throw new Error(
			`model controls overflow their container on ${screen}: ${JSON.stringify(controlOverflows)}`,
		);
	}
	return controlOverflows;
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

try {
	await waitForChrome();
	const targetResponse = await fetch(
		`http://127.0.0.1:${debuggingPort}/json/new?about:blank`,
		{ method: "PUT" },
	);
	if (!targetResponse.ok) throw new Error("Could not create Chrome target");
	const target = await targetResponse.json();
	const client = new CdpClient(target.webSocketDebuggerUrl);
	await client.send("Page.enable");
	await client.send("Runtime.enable");
	const browserVersion = await client.send("Browser.getVersion");
	await client.send("Emulation.setDeviceMetricsOverride", {
		width: 1440,
		height: 1000,
		deviceScaleFactor: 1,
		mobile: false,
	});

	await navigate(
		client,
		`${baseUrl}/production`,
		'Boolean(document.querySelector("[data-model-target]"))',
		"production model controls",
	);
	await screenshot(client, "production-model.png");
	const productionMetrics = await evaluate(
		client,
		`(() => {
			const measure = (select) => {
				const style = getComputedStyle(select);
				const canvas = document.createElement("canvas");
				const context = canvas.getContext("2d");
				context.font = style.font;
				const label = select.selectedOptions[0]?.textContent || "";
				const textWidth = context.measureText(label).width;
				const paddingLeft = parseFloat(style.paddingLeft);
				const paddingRight = parseFloat(style.paddingRight);
				const availableTextWidth = select.clientWidth - paddingLeft - paddingRight;
				return {
					part: select.dataset.modelPart,
					label,
					clientWidth: select.clientWidth,
					textWidth: Number(textWidth.toFixed(2)),
					paddingLeft,
					paddingRight,
					availableTextWidth: Number(availableTextWidth.toFixed(2)),
					appearance: style.appearance,
					fits: textWidth <= availableTextWidth,
				};
			};
			return {
				viewport: [innerWidth, innerHeight],
				inactiveFlagsDisplay: getComputedStyle(document.getElementById("flagsPage")).display,
				flywheelButtons: document.querySelectorAll('[data-project="project-flywheel"]').length,
				infraButtons: document.querySelectorAll('[data-group="infra"]').length,
				header: document.querySelector(".topline")?.textContent.trim(),
				headerHasRevision: /file:|[a-f0-9]{32,}/i.test(document.querySelector(".topline")?.textContent || ""),
				selects: [...document.querySelectorAll('[data-model-target="lead-product-dispatch"] select')].map(measure),
			};
		})()`,
	);
	const modelControlOverflows = await assertModelControlsFit(client, "model");

	await evaluate(client, 'document.querySelector("[data-group=infra]").click()');
	await waitFor(
		client,
		'document.querySelector(".topline h1")?.textContent === "Infra"',
		"Infra detail",
	);
	await screenshot(client, "production-infra.png");
	const infraMetrics = await evaluate(
		client,
		`({
			flywheelButtons: document.querySelectorAll('[data-project="project-flywheel"]').length,
			infraButtons: document.querySelectorAll('[data-group="infra"]').length,
			detailLeads: [...document.querySelectorAll(".lead-meta h3")].map((item) => item.textContent),
			hasProjectTabs: Boolean(document.querySelector("[data-tab]")),
			note: document.querySelector(".group-note")?.textContent.trim(),
		})`,
	);
	const infraControlOverflows = await assertModelControlsFit(client, "infra");

	await evaluate(
		client,
		'document.querySelector("[data-project=project-flywheel]").click(); document.querySelector("[data-tab=dag]").click()',
	);
	await waitFor(
		client,
		'document.querySelector("[data-panel=dag]")?.classList.contains("active")',
		"production DAG panel",
	);
	await screenshot(client, "production-dag.png");
	const normalDagErrorCount = await evaluate(
		client,
		'document.querySelectorAll("[data-panel=dag] .role-error").length',
	);
	const dagControlOverflows = await assertModelControlsFit(client, "dag");

	await navigate(
		client,
		`${baseUrl}/production-missing`,
		'Boolean(document.querySelector("[data-model-target]"))',
		"missing-model fixture",
	);
	await evaluate(client, 'document.querySelector("[data-tab=dag]").click()');
	await waitFor(
		client,
		'document.querySelector("[data-panel=dag]")?.classList.contains("active")',
		"missing-model DAG panel",
	);
	await screenshot(client, "production-dag-missing.png");
	const missingDagErrorCount = await evaluate(
		client,
		'document.querySelectorAll("[data-panel=dag] .role-error").length',
	);
	const missingDagControlOverflows = await assertModelControlsFit(
		client,
		"dag-missing",
	);

	await navigate(
		client,
		`${baseUrl}/production`,
		'Boolean(document.querySelector("[data-model-target]"))',
		"production cron fixture",
	);
	await evaluate(client, 'document.querySelector("[data-tab=cron]").click()');
	await waitFor(
		client,
		'document.querySelector("[data-panel=cron]")?.classList.contains("active")',
		"production Cron panel",
	);
	await screenshot(client, "production-cron.png");
	const cronControlOverflows = await assertModelControlsFit(client, "cron");

	await evaluate(client, 'document.querySelector("[data-nav=flags]").click()');
	await waitFor(
		client,
		'document.getElementById("flagsPage").classList.contains("active")',
		"production flags page",
	);
	await screenshot(client, "production-flags.png");

	await navigate(
		client,
		`${baseUrl}/prototype`,
		'Boolean(document.querySelector("[data-proj=flywheel]"))',
		"prototype",
	);
	await evaluate(client, 'document.querySelector("[data-proj=flywheel]").click()');
	await screenshot(client, "prototype-model.png");
	await evaluate(client, 'document.querySelector("[data-proj=Infra]").click()');
	await screenshot(client, "prototype-infra.png");
	await evaluate(
		client,
		'document.querySelector("[data-proj=flywheel]").click(); document.querySelector("[data-tab=d]").click()',
	);
	await screenshot(client, "prototype-dag.png");
	await evaluate(client, 'document.querySelector("[data-tab=c]").click()');
	await screenshot(client, "prototype-cron.png");
	await evaluate(client, 'document.querySelector("[data-nav=flags]").click()');
	await screenshot(client, "prototype-flags.png");

	for (const [name, prototype, production] of [
		["model", "prototype-model.png", "production-model.png"],
		["infra", "prototype-infra.png", "production-infra.png"],
		["dag", "prototype-dag.png", "production-dag.png"],
		[
			"dag-missing",
			"prototype-dag.png",
			"production-dag-missing.png",
		],
		["cron", "prototype-cron.png", "production-cron.png"],
		["flags", "prototype-flags.png", "production-flags.png"],
	]) {
		execFileSync(
			ffmpeg,
			[
				"-y",
				"-i",
				join(evidenceDir, prototype),
				"-i",
				join(evidenceDir, production),
				"-filter_complex",
				"hstack=inputs=2",
				"-frames:v",
				"1",
				join(evidenceDir, `side-by-side-${name}.png`),
			],
			{ stdio: "ignore" },
		);
	}

	writeFileSync(
		join(evidenceDir, "metrics.json"),
		`${JSON.stringify(
			{
				capturedAt: new Date().toISOString(),
				browser: browserVersion.product,
				viewport: "1440x1000@1x",
				production: productionMetrics,
				infra: infraMetrics,
				normalDagErrorCount,
				missingDagErrorCount,
				controlOverflows: {
					model: modelControlOverflows,
					infra: infraControlOverflows,
					dag: dagControlOverflows,
					missingDag: missingDagControlOverflows,
					cron: cronControlOverflows,
				},
			},
			null,
			2,
		)}\n`,
	);
	client.close();
} finally {
	browser.kill("SIGTERM");
	await delay(200);
	rmSync(profileDir, { recursive: true, force: true });
}
