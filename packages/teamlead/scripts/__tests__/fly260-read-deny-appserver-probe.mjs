// FLY-260 — minimal app-server probe for the enforcement test. Spawns
// `codex app-server --strict-config`, initialize, thread/start with or without a
// legacy `sandbox` param, and prints the resulting activePermissionProfile.id (or
// "null"). NO model turn. argv: <cwd> <no-sandbox|legacy-sandbox>.
import { spawn } from "node:child_process";

const cwd = process.argv[2];
const mode = process.argv[3] || "no-sandbox";
const child = spawn("codex", ["app-server", "--strict-config"], {
	env: process.env,
	stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
let id = 0;
const pending = new Map();
const send = (method, params) => {
	const mid = ++id;
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: mid, method, params })}\n`,
	);
	return new Promise((r) => pending.set(mid, r));
};
const notify = (method, params) =>
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => {
	buf += c;
	let nl = buf.indexOf("\n");
	while (nl >= 0) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		nl = buf.indexOf("\n");
		if (!line) continue;
		let m;
		try {
			m = JSON.parse(line);
		} catch {
			continue;
		}
		if (m.id && pending.has(m.id)) {
			pending.get(m.id)(m);
			pending.delete(m.id);
		}
	}
});
const t = setTimeout(() => {
	child.kill("SIGKILL");
	process.exit(1);
}, 25000);
t.unref?.();
(async () => {
	try {
		await send("initialize", {
			clientInfo: { name: "fly260-probe", version: "0" },
			capabilities: {},
		});
		notify("initialized", {});
		const params = { cwd };
		if (mode === "legacy-sandbox") params.sandbox = "read-only";
		const res = await send("thread/start", params);
		const app = res.result?.activePermissionProfile;
		console.log(app?.id ? app.id : "null");
	} catch (e) {
		console.log(`err:${e?.message || e}`);
	} finally {
		clearTimeout(t);
		child.kill("SIGTERM");
		setTimeout(() => process.exit(0), 300).unref?.();
	}
})();
