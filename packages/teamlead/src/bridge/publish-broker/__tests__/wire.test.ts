/**
 * FLY-1062 broker PR · wiring semantics:
 *  - reverse-compat sentinel: flag off (production default) → NOTHING starts;
 *  - the token envs are scrubbed at boot in BOTH branches;
 *  - enabled → unix socket serves the request/response protocol, 0600 mode,
 *    stale-socket replacement, clean close.
 */
import fs from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PublishBrokerHandle } from "../wire.js";
import { readAndScrubPublishTokens, wirePublishBroker } from "../wire.js";

function tmpStateDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "fw-broker-wire-"));
}

// unix socket paths cap out around 104 bytes on macOS — sockets in tests must
// live under a SHORT root, not the (deep) session tmpdir
function shortSocketDir() {
	return fs.mkdtempSync("/tmp/fwb-");
}

function socketRequest(socketPath: string, payload: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const conn = createConnection(socketPath);
		let out = "";
		conn.setEncoding("utf8");
		conn.on("connect", () => conn.write(payload));
		conn.on("data", (c: string) => {
			out += c;
		});
		conn.on("end", () => resolve(out.trim()));
		conn.on("error", reject);
	});
}

const handles: PublishBrokerHandle[] = [];
afterEach(async () => {
	for (const h of handles.splice(0)) await h.close();
});

describe("readAndScrubPublishTokens", () => {
	it("reads then deletes both token envs (absent = undefined, no throw)", () => {
		const env: NodeJS.ProcessEnv = {
			FW_CUSTOMER_RELEASE_TOKEN: "crt",
			FW_NPM_GAT_TOKEN: "gat",
			OTHER: "stays",
		};
		expect(readAndScrubPublishTokens(env)).toEqual({
			customerRelease: "crt",
			npmGat: "gat",
		});
		expect(env.FW_CUSTOMER_RELEASE_TOKEN).toBeUndefined();
		expect(env.FW_NPM_GAT_TOKEN).toBeUndefined();
		expect(env.OTHER).toBe("stays");
		expect(readAndScrubPublishTokens({})).toEqual({
			customerRelease: undefined,
			npmGat: undefined,
		});
	});
});

describe("wirePublishBroker — reverse-compat sentinel (default OFF)", () => {
	it("flag unset → returns null, starts nothing, still scrubs the token envs", async () => {
		const stateDir = tmpStateDir();
		const env: NodeJS.ProcessEnv = {
			FW_CUSTOMER_RELEASE_TOKEN: "crt",
			FW_NPM_GAT_TOKEN: "gat",
		};
		const handle = await wirePublishBroker({ env, stateDir });
		expect(handle).toBeNull();
		expect(env.FW_CUSTOMER_RELEASE_TOKEN).toBeUndefined();
		expect(env.FW_NPM_GAT_TOKEN).toBeUndefined();
		// no socket, no audit file — nothing was created in the state dir
		expect(fs.readdirSync(stateDir)).toEqual([]);
	});
});

describe("wirePublishBroker — enabled", () => {
	it("serves the socket protocol; pending without approval; malformed refused", async () => {
		const stateDir = tmpStateDir();
		const shortSock = path.join(shortSocketDir(), "pb.sock");
		const handle = await wirePublishBroker({
			env: {
				FLYWHEEL_PUBLISH_BROKER: "1",
				FLYWHEEL_PUBLISH_BROKER_SOCKET: shortSock,
			},
			stateDir,
			cardOverride: null,
		});
		expect(handle).not.toBeNull();
		handles.push(handle as PublishBrokerHandle);
		const { socketPath } = handle as PublishBrokerHandle;

		// 0600 socket
		expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);

		const pending = JSON.parse(
			await socketRequest(
				socketPath,
				`${JSON.stringify({
					action: "publish-release",
					releaseId: "rel-1",
					sha256: "a".repeat(64),
				})}\n`,
			),
		);
		expect(pending.status).toBe("pending_approval");
		expect(pending.reason).toBe("approval_surface_unconfigured");

		const bad = JSON.parse(await socketRequest(socketPath, "not-json\n"));
		expect(bad.status).toBe("refused");
		expect(bad.reason).toBe("malformed_request");

		const unknown = JSON.parse(
			await socketRequest(socketPath, `${JSON.stringify({ action: "x" })}\n`),
		);
		expect(unknown.reason).toBe("unknown_action");

		// pending requests are auditable
		const audit = fs.readFileSync(
			path.join(stateDir, "publish-audit.jsonl"),
			"utf8",
		);
		expect(audit).toContain("request_pending");

		await (handle as PublishBrokerHandle).close();
		handles.splice(0);
		expect(fs.existsSync(socketPath)).toBe(false);
	});

	it("replaces a stale socket file from a crashed previous run", async () => {
		const stateDir = tmpStateDir();
		const socketPath = path.join(shortSocketDir(), "publish-broker.sock");
		fs.writeFileSync(socketPath, ""); // stale plain file
		const handle = await wirePublishBroker({
			env: {
				FLYWHEEL_PUBLISH_BROKER: "1",
				FLYWHEEL_PUBLISH_BROKER_SOCKET: socketPath,
			},
			stateDir,
			cardOverride: null,
		});
		expect(handle).not.toBeNull();
		handles.push(handle as PublishBrokerHandle);
		const res = JSON.parse(await socketRequest(socketPath, "{}\n"));
		expect(res.status).toBe("refused");
	});
});
