#!/usr/bin/env node
// FLY-1062 broker PR · request a broker publish action over the unix socket.
//
// The request carries NO authority (plan §3 ①b) — the broker executes only
// when an unconsumed founder approval matches the exact tuple; otherwise it
// answers pending_approval and surfaces a request card to the founder.
//
// Usage:
//   node scripts/release/broker-request.mjs --action publish-release --release-id <id> --sha256 <hex>
//   node scripts/release/broker-request.mjs --action publish-shell   --release-id <id> --sha256 <hex> --staged-path <abs>
//   node scripts/release/broker-request.mjs --json '<request-json>'      # e.g. shell-prepare.mjs output
//   [--socket <path>]   default: $FLYWHEEL_PUBLISH_BROKER_SOCKET or ~/.flywheel/publish-broker.sock
//
// Exit codes: 0 executed · 2 pending_approval · 1 refused/transport error.
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function die(msg) {
	console.error(`[broker-request] ${msg}`);
	process.exit(1);
}

function argValue(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const socketPath = argValue(
	"socket",
	process.env.FLYWHEEL_PUBLISH_BROKER_SOCKET ||
		path.join(os.homedir(), ".flywheel", "publish-broker.sock"),
);

let request;
const rawJson = argValue("json", "");
if (rawJson) {
	try {
		request = JSON.parse(rawJson);
	} catch {
		die("--json is not valid JSON");
	}
} else {
	request = {
		action: argValue("action", ""),
		releaseId: argValue("release-id", ""),
		sha256: argValue("sha256", ""),
		...(argValue("staged-path", "")
			? { stagedPath: argValue("staged-path", "") }
			: {}),
	};
	if (!request.action || !request.releaseId || !request.sha256) {
		die("--action, --release-id and --sha256 are required (or use --json)");
	}
}

const conn = createConnection(socketPath);
conn.setEncoding("utf8");
let out = "";
const timer = setTimeout(() => {
	conn.destroy();
	die("broker did not answer within 60s");
}, 60_000);
conn.on("connect", () => conn.write(`${JSON.stringify(request)}\n`));
conn.on("data", (c) => {
	out += c;
});
conn.on("error", (err) =>
	die(`cannot reach the publish broker at ${socketPath}: ${err.message}`),
);
conn.on("end", () => {
	clearTimeout(timer);
	const line = out.trim();
	process.stdout.write(`${line}\n`);
	let response;
	try {
		response = JSON.parse(line);
	} catch {
		process.exit(1);
	}
	if (response.status === "executed") process.exit(0);
	if (response.status === "pending_approval") process.exit(2);
	process.exit(1);
});
