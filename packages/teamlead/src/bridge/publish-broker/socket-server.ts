/**
 * FLY-1062 broker PR · unix-socket request surface (plan §3 ①).
 *
 * The broker exposes EXACTLY two actions over a local unix socket. A caller's
 * identity carries no authority (①b) — the socket only lets a co-resident
 * process REQUEST a tuple; execution happens iff a matching unconsumed
 * founder approval exists in the broker's memory. Protocol: one JSON request
 * line per connection → one JSON response line, then the server ends the
 * connection. Malformed input gets a refusal, never a crash.
 */

import { existsSync, unlinkSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import type { PublishResponse } from "./types.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const CONNECTION_TIMEOUT_MS = 30_000;

export interface PublishSocketServer {
	socketPath: string;
	close(): Promise<void>;
}

/** macOS caps sun_path at ~104 bytes — fail with a NAMED error instead of the
 * kernel's opaque EINVAL (the FLY-245 secret broker hit the same edge). */
const MAX_SOCKET_PATH_BYTES = 100;

export async function startPublishBrokerSocket(opts: {
	socketPath: string;
	handle: (raw: unknown) => Promise<PublishResponse>;
	log?: (line: string) => void;
}): Promise<PublishSocketServer> {
	if (Buffer.byteLength(opts.socketPath) > MAX_SOCKET_PATH_BYTES) {
		throw new Error(
			`publish-broker socket path too long (${Buffer.byteLength(opts.socketPath)} bytes > ${MAX_SOCKET_PATH_BYTES}; unix sockets cap out around 104): ${opts.socketPath}`,
		);
	}
	if (existsSync(opts.socketPath)) {
		unlinkSync(opts.socketPath); // stale socket from a crashed previous run
	}
	const server: Server = createServer((conn) => {
		let buf = "";
		let done = false;
		const finish = (response: PublishResponse) => {
			if (done) return;
			done = true;
			conn.end(`${JSON.stringify(response)}\n`);
		};
		conn.setEncoding("utf8");
		conn.setTimeout(CONNECTION_TIMEOUT_MS, () => {
			finish({ status: "refused", reason: "timeout" });
			conn.destroy();
		});
		conn.on("data", (chunk: string) => {
			buf += chunk;
			if (buf.length > MAX_REQUEST_BYTES) {
				finish({ status: "refused", reason: "request_too_large" });
				conn.destroy();
				return;
			}
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			const line = buf.slice(0, nl);
			void (async () => {
				let raw: unknown;
				try {
					raw = JSON.parse(line);
				} catch {
					finish({ status: "refused", reason: "malformed_request" });
					return;
				}
				try {
					finish(await opts.handle(raw));
				} catch {
					// handle() is designed not to throw; this is a last-resort guard
					finish({ status: "refused", reason: "internal_error" });
				}
			})();
		});
		conn.on("error", () => {
			// client went away — nothing to do
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	await chmod(opts.socketPath, 0o600);
	opts.log?.(`[publish-broker] socket listening at ${opts.socketPath}`);
	return {
		socketPath: opts.socketPath,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => {
					try {
						if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
					} catch {
						// best-effort cleanup
					}
					resolve();
				});
			}),
	};
}
