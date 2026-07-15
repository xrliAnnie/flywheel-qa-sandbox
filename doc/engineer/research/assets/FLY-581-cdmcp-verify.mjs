// FLY-581 — chrome-devtools-mcp END-TO-END real-machine verification.
// Drives the official Chrome DevTools MCP over raw MCP stdio against real (headless) Chrome:
// initialize -> tools/list -> new_page (navigate) -> take_snapshot (DOM) ->
// evaluate_script (JS, emits a console.log) -> list_console_messages ->
// list_network_requests -> take_screenshot (saved to PNG). Asserts each step.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const SHOT = process.argv[2] || "/tmp/fly581-shot.png";
const URL = "https://example.com/";

const srv = spawn(
	"npx",
	["-y", "chrome-devtools-mcp@latest", "--isolated", "--headless"],
	{
		stdio: ["pipe", "pipe", "pipe"],
	},
);
let buf = "";
const pending = new Map();
let nextId = 1;
const stderrChunks = [];
srv.stderr.on("data", (d) => stderrChunks.push(d.toString()));

function rpc(method, params, { notify = false, timeout = 60000 } = {}) {
	const msg = {
		jsonrpc: "2.0",
		method,
		...(params !== undefined && { params }),
	};
	if (notify) {
		srv.stdin.write(`${JSON.stringify(msg)}\n`);
		return Promise.resolve();
	}
	const id = nextId++;
	msg.id = id;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		srv.stdin.write(`${JSON.stringify(msg)}\n`);
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				reject(new Error(`timeout ${method}`));
			}
		}, timeout);
	});
}
srv.stdout.on("data", (d) => {
	buf += d.toString();
	let nl = buf.indexOf("\n");
	while (nl >= 0) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (!line) continue;
		let m;
		try {
			m = JSON.parse(line);
		} catch {
			continue;
		}
		if (m.id !== undefined && pending.has(m.id)) {
			const { resolve, reject } = pending.get(m.id);
			pending.delete(m.id);
			if (m.error) reject(new Error(JSON.stringify(m.error)));
			else resolve(m.result);
		}
		nl = buf.indexOf("\n");
	}
});
// Extract concatenated text from an MCP tool result.
const txt = (r) =>
	(r?.content || [])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
const results = {};
function check(name, cond, detail) {
	results[name] = { pass: !!cond, detail };
	console.log(
		(cond ? "PASS " : "FAIL ") +
			name +
			" :: " +
			String(detail).replace(/\s+/g, " ").slice(0, 220),
	);
}

(async () => {
	try {
		const init = await rpc("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "fly581-verify", version: "1.0.0" },
		});
		check(
			"initialize",
			init?.serverInfo?.name === "chrome_devtools",
			`serverInfo=${JSON.stringify(init.serverInfo)} protocol=${init.protocolVersion}`,
		);
		await rpc("notifications/initialized", {}, { notify: true });

		const tl = await rpc("tools/list", {});
		check(
			"tools_list",
			(tl.tools || []).length >= 20,
			`tool_count=${(tl.tools || []).length}`,
		);

		// 1) NAVIGATE — launches real Chrome and loads the page (first call, allow long timeout)
		const nav = await rpc(
			"tools/call",
			{ name: "new_page", arguments: { url: URL } },
			{ timeout: 120000 },
		);
		const navTxt = txt(nav);
		check("navigate", /example\.com|Example Domain/i.test(navTxt), navTxt);

		// 2) READ DOM — a11y/DOM snapshot must contain the page's real content
		const snap = await rpc("tools/call", {
			name: "take_snapshot",
			arguments: {},
		});
		const snapTxt = txt(snap);
		check(
			"read_dom",
			/Example Domain/i.test(snapTxt),
			`snapshot_len=${snapTxt.length} head=${snapTxt.slice(0, 160)}`,
		);

		// 3) JS EVAL (also emits a console.log used by the next step)
		const stamp = `FLY-581-VERIFY-${Date.now()}`;
		const ev = await rpc("tools/call", {
			name: "evaluate_script",
			arguments: {
				function: `() => { console.log(${JSON.stringify(stamp)}); return document.title + " | h1=" + (document.querySelector('h1')?.textContent || ''); }`,
			},
		});
		const evTxt = txt(ev);
		check("evaluate_script", /Example Domain/i.test(evTxt), evTxt);

		// 4) CONSOLE — our injected log must be captured
		const cons = await rpc("tools/call", {
			name: "list_console_messages",
			arguments: {},
		});
		const consTxt = txt(cons);
		check(
			"read_console",
			consTxt.includes(stamp),
			"console_has_stamp=" +
				consTxt.includes(stamp) +
				" sample=" +
				consTxt.slice(0, 200),
		);

		// 5) NETWORK — the document request for example.com must be listed
		const net = await rpc("tools/call", {
			name: "list_network_requests",
			arguments: {},
		});
		const netTxt = txt(net);
		check(
			"read_network",
			/example\.com/i.test(netTxt),
			`net_len=${netTxt.length} sample=${netTxt.slice(0, 200)}`,
		);

		// 6) SCREENSHOT — saved server-side to a PNG file; verify magic bytes + size
		const shot = await rpc("tools/call", {
			name: "take_screenshot",
			arguments: { format: "png", filePath: SHOT },
		});
		let ok = false,
			detail = txt(shot);
		if (existsSync(SHOT)) {
			const b = readFileSync(SHOT);
			const isPng =
				b.length > 8 &&
				b[0] === 0x89 &&
				b[1] === 0x50 &&
				b[2] === 0x4e &&
				b[3] === 0x47;
			ok = isPng && b.length > 1000;
			detail = `file=${SHOT} bytes=${b.length} png_magic=${isPng}`;
		}
		check("screenshot", ok, detail);

		const passed = Object.values(results).filter((r) => r.pass).length;
		const total = Object.keys(results).length;
		console.log(`SUMMARY ${passed}/${total} passed`);
		process.exitCode = passed === total ? 0 : 2;
	} catch (e) {
		console.log(`ERROR ${e.message}`);
		console.log(`STDERR ${stderrChunks.join("").slice(0, 1500)}`);
		process.exitCode = 3;
	} finally {
		srv.kill();
		setTimeout(() => process.exit(process.exitCode ?? 0), 500);
	}
})();
