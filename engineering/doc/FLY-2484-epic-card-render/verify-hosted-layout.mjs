// Run against an isolated Chromium: node verify-hosted-layout.mjs --cdp <browser-ws> <html> <png-prefix> [--without-footer-wrap]
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args[0] === "--cdp") args.shift();
const [endpoint, html, prefix, mutation] = args;
assert(endpoint && html && prefix, "browser WebSocket, hosted HTML and PNG prefix required");
const ws = new WebSocket(endpoint);
let sequence = 0;
const pending = new Map();
const timer = setTimeout(() => {
	console.error("Chromium layout verification timed out");
	process.exit(1);
}, 30000);
function send(method, params = {}, sessionId) {
	return new Promise((resolve, reject) => {
		const id = ++sequence;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
	});
}
ws.addEventListener("message", ({ data }) => {
	const message = JSON.parse(data);
	const request = pending.get(message.id);
	if (!request) return;
	pending.delete(message.id);
	if (message.error) request.reject(new Error(JSON.stringify(message.error)));
	else request.resolve(message.result);
});
await new Promise((resolve, reject) => {
	ws.addEventListener("open", resolve, { once: true });
	ws.addEventListener("error", reject, { once: true });
});
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
try {
	const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
	const call = (method, params) => send(method, params, sessionId);
	await call("Page.enable");
	await call("Page.navigate", { url: pathToFileURL(html).href });
	await call("Runtime.evaluate", {
		expression: "new Promise(resolve => document.readyState === 'complete' ? resolve() : addEventListener('load', resolve, {once:true}))",
		awaitPromise: true,
	});
	if (mutation === "--without-footer-wrap") await call("Runtime.evaluate", {
		expression: "document.querySelector('footer').style.overflowWrap='normal'",
	});
	for (const width of [390, 1440]) {
		await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
		const result = await call("Runtime.evaluate", {
			expression: `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
				width: innerWidth, client: document.documentElement.clientWidth,
				scroll: document.documentElement.scrollWidth,
				open: document.querySelectorAll('details[open]').length,
				footer: document.querySelector('footer')?.textContent,
				wrap: getComputedStyle(document.querySelector('footer')).overflowWrap
			}))))`, awaitPromise: true, returnByValue: true,
		});
		assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
		const measured = result.result.value;
		console.log(JSON.stringify(measured));
		const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
		writeFileSync(`${prefix}-${width}.png`, Buffer.from(shot.data, "base64"));
		assert.match(measured.footer, /SHA-256 [a-f0-9]{64}/, "must verify hosted bundle with audit footer");
		assert.equal(measured.client, width);
		assert(measured.scroll <= measured.client, `horizontal overflow: ${measured.scroll} > ${measured.client}`);
		assert.equal(measured.open, 0, "initial page must be collapsed");
	}
} finally {
	await send("Target.closeTarget", { targetId });
	ws.close();
	clearTimeout(timer);
}
