import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { Socket } from "node:net";
import { isAbsolute, normalize } from "node:path";

/** Startup must independently establish immutable root ownership of the helper
 * and all ancestors. This adapter additionally checks its pin on every use. */
export function createNativePeerReader(input: {
	path: string;
	sha256: string;
}) {
	const pin = { ...input };
	return async (socket: Socket, signal?: AbortSignal): Promise<number> => {
		try {
			const stat = lstatSync(pin.path);
			if (
				!isAbsolute(pin.path) ||
				normalize(pin.path) !== pin.path ||
				!stat.isFile() ||
				stat.nlink !== 1 ||
				(stat.mode & 0o022) !== 0 ||
				(stat.mode & 0o111) === 0 ||
				stat.size > 1024 * 1024 ||
				!/^[a-f0-9]{64}$/.test(pin.sha256) ||
				createHash("sha256").update(readFileSync(pin.path)).digest("hex") !==
					pin.sha256
			)
				throw Error();
			// Node exposes no public Unix getpeereid API. Missing/changed internal handle
			// layout fails closed; the C helper also proves the inherited fd is AF_UNIX.
			const fd = (socket as Socket & { _handle?: { fd?: number } })._handle?.fd;
			if (
				socket.destroyed ||
				signal?.aborted ||
				!Number.isInteger(fd) ||
				fd === undefined ||
				fd < 0
			)
				throw Error();
			return await new Promise<number>((resolve, reject) => {
				const child = spawn(pin.path, [], {
					stdio: ["ignore", "pipe", "ignore", fd],
					env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
				});
				let output = "",
					failed = false;
				const stop = () => {
					failed = true;
					child.kill("SIGKILL");
				};
				const timer = setTimeout(stop, 1000);
				signal?.addEventListener("abort", stop, { once: true });
				child.stdout?.on("data", (chunk: Buffer) => {
					if (failed) return;
					if (output.length + chunk.length > 32) {
						stop();
						return;
					}
					output += chunk.toString("ascii");
				});
				child.once("error", () => {
					failed = true;
				});
				child.once("close", (code) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", stop);
					const uid = Number(output.trim());
					if (
						failed ||
						code !== 0 ||
						!/^\d{1,10}\n$/.test(output) ||
						!Number.isSafeInteger(uid) ||
						uid < 0 ||
						uid > 0xffffffff
					)
						reject(Error("private_peer_unavailable"));
					else resolve(uid);
				});
			});
		} catch {
			throw Error("private_peer_unavailable");
		}
	};
}
