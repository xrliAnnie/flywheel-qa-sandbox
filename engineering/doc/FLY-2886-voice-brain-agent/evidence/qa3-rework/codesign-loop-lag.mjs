// FLY-2886 QA@3 H1: does the real browser host identity check block the event loop?
// Runs the real codesign --verify --deep on this host; launches no browser.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
const WT = "/Users/xiaorongli/Dev/flywheel-FLY-2886";
const { verifyBrowserHostIdentity, BROWSER_HOST_BASELINE } = await import(
	`${WT}/packages/teamlead/dist/lead-capabilities/browser-host-identity.js`
);
function monitor() {
	let last = performance.now(), max = 0, ticks = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		max = Math.max(max, now - last - 50);
		last = now;
		ticks++;
	}, 50);
	return () => (clearInterval(timer), { maxBlockMs: Math.round(max), ticks });
}
const pin = BROWSER_HOST_BASELINE;
const input = {
	nodeExecutable: realpathSync(process.execPath),
	chromeExecutable: `${pin.chrome.root}/Contents/MacOS/Google Chrome`,
};
// Control: the former synchronous call shape.
let stop = monitor();
let t = performance.now();
let control = "verified";
try {
	execFileSync("/usr/bin/codesign", ["--verify", "--deep", pin.chrome.root], {
		timeout: 60000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"],
		env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" },
	});
} catch (e) { control = `failed:${e.code ?? e.status}`; }
await new Promise((r) => setTimeout(r, 60));
console.log(JSON.stringify({ case: "sync_execFileSync_control", codesign: control, ms: Math.round(performance.now() - t), ...stop() }));
stop = monitor();
t = performance.now();
let result;
try {
	const r = await verifyBrowserHostIdentity(input);
	result = { codesign: r.codesign, warnings: r.warnings };
} catch (e) { result = { error: e.message }; }
console.log(JSON.stringify({ case: "async_verifyBrowserHostIdentity", ...result, ms: Math.round(performance.now() - t), ...stop() }));
