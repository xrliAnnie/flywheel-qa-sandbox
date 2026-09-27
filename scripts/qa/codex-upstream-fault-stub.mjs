#!/usr/bin/env node

import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";

const LOOPBACK_HOST = "127.0.0.1";
const ALLOWED_FAULTS = new Set([
	"rate_limit",
	"server_error",
	"capacity",
	"quota",
	"unauthorized",
]);
const DEFAULT_SEQUENCE = [
	"rate_limit",
	"server_error",
	"capacity",
	"quota",
	"unauthorized",
];

function fail(message) {
	process.stderr.write(`[codex-upstream-fault-stub] ERROR: ${message}\n`);
	process.exit(1);
}

function mode(path) {
	return lstatSync(path).mode & 0o777;
}

function parseArgs(argv) {
	const command = argv[0];
	if (command !== "serve" && command !== "prepare-source") {
		fail(
			"usage: codex-upstream-fault-stub.mjs serve|prepare-source --slot <N> --receipt <path>",
		);
	}
	let slot;
	let receipt;
	let sourceHome;
	let destination;
	let sequence = DEFAULT_SEQUENCE;
	for (let index = 1; index < argv.length; index += 1) {
		const name = argv[index];
		const value = argv[index + 1];
		if (name === "--slot" && value !== undefined) {
			slot = Number(value);
			index += 1;
		} else if (name === "--receipt" && value !== undefined) {
			receipt = value;
			index += 1;
		} else if (name === "--sequence" && value !== undefined) {
			sequence = value.split(",");
			index += 1;
		} else if (name === "--source-home" && value !== undefined) {
			sourceHome = value;
			index += 1;
		} else if (name === "--destination" && value !== undefined) {
			destination = value;
			index += 1;
		} else {
			fail(`unknown or incomplete argument: ${name ?? "<missing>"}`);
		}
	}
	if (!Number.isSafeInteger(slot) || slot <= 0)
		fail("--slot must be a positive integer");
	if (!receipt) fail("--receipt is required");
	if (
		command === "serve" &&
		(sequence.length === 0 ||
			sequence.length > 20 ||
			sequence.some((item) => !ALLOWED_FAULTS.has(item)))
	) {
		fail("--sequence contains an unsupported fault");
	}
	if (command === "prepare-source" && (!sourceHome || !destination)) {
		fail("prepare-source requires --source-home and --destination");
	}
	return { command, slot, receipt, sequence, sourceHome, destination };
}

function safeRegularFile(path, expectedMode) {
	const stat = lstatSync(path);
	return stat.isFile() && !stat.isSymbolicLink() && mode(path) === expectedMode;
}

function prepareSource({ slot, receipt, sourceHome, destination }) {
	const room = validateRoom(slot, receipt);
	const expectedDestination = `${room.slotRoot}/state/codex-fault/source-home`;
	if (resolve(destination) !== expectedDestination) {
		throw new Error("Codex source destination escaped the slot fault root");
	}
	const receiptStat = lstatSync(receipt);
	if (
		!receiptStat.isFile() ||
		receiptStat.isSymbolicLink() ||
		mode(receipt) !== 0o600
	) {
		throw new Error("fault receipt is missing or unsafe");
	}
	const ready = JSON.parse(readFileSync(receipt, "utf8"));
	if (
		ready.schemaVersion !== 1 ||
		ready.slot !== slot ||
		ready.host !== LOOPBACK_HOST ||
		!Number.isSafeInteger(ready.port) ||
		ready.port <= 0 ||
		ready.port > 65535 ||
		ready.baseUrl !== `http://${LOOPBACK_HOST}:${ready.port}/v1`
	) {
		throw new Error("fault receipt does not name a loopback-only listener");
	}
	const canonicalSource = realpathSync(sourceHome);
	const sourceStat = lstatSync(canonicalSource);
	if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
		throw new Error("Codex source home is unsafe");
	}
	const sourceAuth = `${canonicalSource}/auth.json`;
	if (!safeRegularFile(sourceAuth, 0o600)) {
		throw new Error("Codex source auth must be a mode-0600 regular file");
	}
	if (existsSync(destination)) {
		throw new Error("Codex fault source destination already exists");
	}
	mkdirSync(destination, { mode: 0o700 });
	chmodSync(destination, 0o700);
	const destinationAuth = `${destination}/auth.json`;
	linkSync(sourceAuth, destinationAuth);
	const sourceConfig = `${canonicalSource}/config.toml`;
	const baseConfig = existsSync(sourceConfig)
		? readFileSync(sourceConfig, "utf8")
		: "";
	let inRoot = true;
	const retained = [];
	for (const line of baseConfig.split(/\r?\n/)) {
		if (/^\s*\[/.test(line)) inRoot = false;
		if (inRoot && /^\s*(?:model_provider|openai_base_url)\s*=/.test(line)) {
			continue;
		}
		retained.push(line);
	}
	const rendered = [
		'model_provider = "openai"',
		`openai_base_url = ${JSON.stringify(ready.baseUrl)}`,
		...retained,
	].join("\n");
	const configPath = `${destination}/config.toml`;
	writeFileSync(configPath, rendered, { mode: 0o600, flag: "wx" });
	chmodSync(configPath, 0o600);
	const sourceAuthStat = lstatSync(sourceAuth);
	const destinationAuthStat = lstatSync(destinationAuth);
	if (
		sourceAuthStat.dev !== destinationAuthStat.dev ||
		sourceAuthStat.ino !== destinationAuthStat.ino
	) {
		throw new Error("Codex auth was copied instead of hard-linked");
	}
	const result = {
		schemaVersion: 1,
		slot,
		sourceHome: destination,
		baseUrl: ready.baseUrl,
		authDisposition: "same-inode-hardlink",
	};
	atomicWriteJson(`${destination}/qa-fault-source.json`, result);
	return result;
}

function validateRoom(slot, receipt) {
	const slotRoot = `/tmp/flywheel-test-slot-${slot}`;
	const canonicalSlotRoot = `${realpathSync("/tmp")}/flywheel-test-slot-${slot}`;
	const roomInfoPath = `${slotRoot}/room-info.json`;
	const expectedReceipt = `${slotRoot}/state/codex-fault/receipt.json`;
	try {
		const slotStat = lstatSync(slotRoot);
		if (
			!slotStat.isDirectory() ||
			slotStat.isSymbolicLink() ||
			mode(slotRoot) !== 0o700 ||
			realpathSync(slotRoot) !== canonicalSlotRoot
		) {
			throw new Error("unsafe slot root");
		}
		const roomStat = lstatSync(roomInfoPath);
		if (
			!roomStat.isFile() ||
			roomStat.isSymbolicLink() ||
			mode(roomInfoPath) !== 0o600
		) {
			throw new Error("unsafe room info");
		}
		const room = JSON.parse(readFileSync(roomInfoPath, "utf8"));
		if (
			room.schemaVersion !== 1 ||
			room.slot !== slot ||
			room.mode !== "slot"
		) {
			throw new Error("wrong room identity");
		}
		if (
			resolve(receipt) !== expectedReceipt ||
			dirname(receipt) !== dirname(expectedReceipt)
		) {
			throw new Error("receipt escaped slot fault root");
		}
		const faultRoot = dirname(expectedReceipt);
		const faultStat = lstatSync(faultRoot);
		if (
			!faultStat.isDirectory() ||
			faultStat.isSymbolicLink() ||
			mode(faultRoot) !== 0o700 ||
			realpathSync(faultRoot) !== `${canonicalSlotRoot}/state/codex-fault`
		) {
			throw new Error("unsafe fault root");
		}
		return { slotRoot, roomInfoPath, expectedReceipt };
	} catch {
		throw new Error("room-info.json must identify this mode=slot room");
	}
}

function responseFor(fault) {
	switch (fault) {
		case "rate_limit":
			return {
				status: 429,
				type: "rate_limit_error",
				code: "rate_limit_exceeded",
				message: "QA injected rate limit",
			};
		case "server_error":
			return {
				status: 500,
				type: "server_error",
				code: "server_error",
				message: "QA injected upstream server error",
			};
		case "capacity":
			return {
				status: 503,
				type: "server_error",
				code: "server_overloaded",
				message: "QA injected provider capacity",
			};
		case "quota":
			return {
				status: 429,
				type: "insufficient_quota",
				code: "insufficient_quota",
				message: "QA injected usage limit",
			};
		case "unauthorized":
			return {
				status: 401,
				type: "invalid_request_error",
				code: "invalid_api_key",
				message: "QA injected unauthorized response",
			};
		default:
			throw new Error(`unhandled fault: ${fault}`);
	}
}

function writeJson(response, status, body) {
	const encoded = `${JSON.stringify(body)}\n`;
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(encoded),
		"content-type": "application/json; charset=utf-8",
	});
	response.end(encoded);
}

function atomicWriteJson(path, value) {
	const temp = `${path}.tmp.${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(value)}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}

process.umask(0o077);
const options = parseArgs(process.argv.slice(2));
const { slot, receipt, sequence } = options;
if (options.command === "prepare-source") {
	try {
		process.stdout.write(`${JSON.stringify(prepareSource(options))}\n`);
		process.exit(0);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}
let room;
try {
	room = validateRoom(slot, receipt);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

let requestIndex = 0;
const server = createServer((request, response) => {
	try {
		validateRoom(slot, receipt);
	} catch {
		writeJson(response, 503, {
			error: {
				type: "server_error",
				code: "qa_room_invalid",
				message: "QA slot identity is no longer valid",
			},
		});
		return;
	}
	if (request.method !== "POST" || request.url !== "/v1/responses") {
		writeJson(response, 404, {
			error: {
				type: "invalid_request_error",
				code: "not_found",
				message: "QA fault stub only implements POST /v1/responses",
			},
		});
		return;
	}
	let bytes = 0;
	request.on("data", (chunk) => {
		bytes += chunk.length;
	});
	request.on("end", () => {
		if (bytes > 1024 * 1024) {
			writeJson(response, 413, {
				error: {
					type: "invalid_request_error",
					code: "request_too_large",
					message: "QA request exceeded the one-megabyte limit",
				},
			});
			return;
		}
		const fault = sequence[Math.min(requestIndex, sequence.length - 1)];
		requestIndex += 1;
		const injected = responseFor(fault);
		process.stderr.write(
			`[codex-upstream-fault-stub] request=${requestIndex} fault=${fault} status=${injected.status}\n`,
		);
		writeJson(response, injected.status, {
			error: {
				type: injected.type,
				code: injected.code,
				message: injected.message,
				param: null,
			},
		});
	});
});

server.on("error", (error) =>
	fail(`loopback listener failed: ${error.message}`),
);
server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
	const address = server.address();
	if (
		!address ||
		typeof address === "string" ||
		address.address !== LOOPBACK_HOST
	) {
		fail("listener did not bind the required IPv4 loopback address");
	}
	const baseUrl = `http://${LOOPBACK_HOST}:${address.port}/v1`;
	atomicWriteJson(room.expectedReceipt, {
		schemaVersion: 1,
		slot,
		host: LOOPBACK_HOST,
		port: address.port,
		baseUrl,
		pid: process.pid,
		sequence,
		roomInfoPath: room.roomInfoPath,
		startedAt: new Date().toISOString(),
	});
	process.stderr.write(
		`[codex-upstream-fault-stub] ready slot=${slot} baseUrl=${baseUrl} faults=${sequence.length}\n`,
	);
});

function shutdown() {
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(1), 2_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
