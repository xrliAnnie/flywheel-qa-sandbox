#!/usr/bin/env node

/**
 * Reap real Codex app-server daemons owned by one QA slot.
 *
 * A Codex daemon is detached into its own process group, so killing Bridge is
 * not sufficient. Destructive authority remains the claude-runner contract:
 * the slot-local session ledger must name the process group and a live holder
 * of the execution's slot-local socket must belong to that group. Unknown live
 * sockets fail closed so test-teardown retains the room for inspection.
 */

import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join, sep } from "node:path";

const MAX_LEDGER_BYTES = 64 * 1024;
const SOCKET_PROBE_MS = 500;

async function statOrNull(path) {
	try {
		return await lstat(path);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function ownedDirectory(path, canonicalSlot, label) {
	const stat = await statOrNull(path);
	if (!stat) return null;
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`${label} is not a real directory`);
	}
	const canonical = await realpath(path);
	if (!canonical.startsWith(`${canonicalSlot}${sep}`)) {
		throw new Error(`${label} resolves outside the QA slot`);
	}
	// Keep the lexical path for Unix-socket operations. On macOS /tmp resolves
	// to /private/tmp, but lsof's pathname selector matches the string used at
	// bind time rather than the inode behind that symlink.
	return path;
}

async function authoritativeExecutionIds(sessionRoot) {
	if (!sessionRoot) return [];
	const ids = [];
	for (const entry of await readdir(sessionRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const ledger = join(sessionRoot, entry.name, "session.json");
		const stat = await statOrNull(ledger);
		if (
			!stat ||
			stat.isSymbolicLink() ||
			!stat.isFile() ||
			stat.size > MAX_LEDGER_BYTES
		) {
			continue;
		}
		try {
			const parsed = JSON.parse(await readFile(ledger, "utf8"));
			if (parsed?.executionId === entry.name) ids.push(entry.name);
		} catch {
			// A malformed ledger is not destructive authority. The live-socket
			// census below still fails closed if it conceals a running daemon.
		}
	}
	return ids;
}

async function socketIsLive(path) {
	return await new Promise((resolveProbe) => {
		let settled = false;
		const socket = createConnection({ path });
		const finish = (live) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolveProbe(live);
		};
		const timer = setTimeout(() => finish(true), SOCKET_PROBE_MS);
		socket.once("connect", () => finish(true));
		socket.once("error", (error) => {
			finish(!["ENOENT", "ECONNREFUSED"].includes(error?.code));
		});
	});
}

async function liveSockets(socketRoot) {
	if (!socketRoot) return [];
	const live = [];
	for (const entry of await readdir(socketRoot, { withFileTypes: true })) {
		if (!entry.name.endsWith(".sock")) continue;
		if (entry.isSymbolicLink()) {
			throw new Error("socket authority contains a symlink");
		}
		const socketPath = join(socketRoot, entry.name);
		if (await socketIsLive(socketPath)) live.push(socketPath);
	}
	return live;
}

async function main() {
	const requestedSlot = process.argv[2];
	if (!requestedSlot || !isAbsolute(requestedSlot)) {
		throw new Error("an absolute QA slot directory is required");
	}
	const lexicalSlot = requestedSlot.replace(/\/+$/, "") || sep;
	const slotStat = await lstat(lexicalSlot);
	if (slotStat.isSymbolicLink() || !slotStat.isDirectory()) {
		throw new Error("QA slot root is not a real directory");
	}
	const canonicalSlot = await realpath(lexicalSlot);
	if (canonicalSlot === sep) throw new Error("refusing the filesystem root");

	const sessionRoot = await ownedDirectory(
		join(lexicalSlot, "state", "codex-sessions"),
		canonicalSlot,
		"Codex session root",
	);
	const socketRoot = await ownedDirectory(
		join(lexicalSlot, "state", "cdx-sock"),
		canonicalSlot,
		"Codex socket root",
	);
	if (!sessionRoot && !socketRoot) return;
	const { reapCodexDaemonForExecution } = await import(
		"../../packages/claude-runner/dist/index.js"
	);

	const env = {
		...process.env,
		FLYWHEEL_CODEX_SESSION_DIR: join(lexicalSlot, "state", "codex-sessions"),
		FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT: join(lexicalSlot, "state", "cdx-sock"),
	};
	const executionIds = await authoritativeExecutionIds(sessionRoot);
	const results = await Promise.all(
		executionIds.map(async (executionId) => ({
			executionId,
			result: await reapCodexDaemonForExecution(executionId, {
				env,
				exitWaitMs: 3_000,
			}),
		})),
	);

	for (const { executionId, result } of results) {
		console.error(
			`[qa-codex-reap] execution=${executionId} outcome=${result.outcome}`,
		);
		if (result.outcome === "residual") {
			throw new Error(`Codex daemon process group survived for ${executionId}`);
		}
		if (
			result.outcome === "unverifiable" &&
			(await socketIsLive(result.socketPath))
		) {
			throw new Error(
				`live Codex socket has no destructive proof for ${executionId}`,
			);
		}
	}

	const residualSockets = await liveSockets(socketRoot);
	if (residualSockets.length > 0) {
		throw new Error(
			`${residualSockets.length} live Codex socket(s) remain under the QA slot`,
		);
	}
}

main().catch((error) => {
	console.error(
		`[qa-codex-reap] ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
});
