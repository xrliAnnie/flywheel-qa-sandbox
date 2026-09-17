import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createNativePeerReader } from "../native-peer.js";

it("reads the actual Unix peer from inherited fd3 without request headers", async () => {
	const root = mkdtempSync("/tmp/xhs-peer-test-");
	const binary = join(root, "peer");
	const source = fileURLToPath(
		new URL(
			"../../../../../scripts/xhs/xhs-peer-credentials.c",
			import.meta.url,
		),
	);
	execFileSync("cc", [
		"-O2",
		"-Wall",
		"-Wextra",
		"-Werror",
		source,
		"-o",
		binary,
	]);
	const pin = {
		path: binary,
		sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
	};
	const read = createNativePeerReader(pin);
	const server = createServer();
	let client: ReturnType<typeof createConnection> | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(join(root, "peer.sock"), resolve);
		});
		const result = new Promise<number>((resolve, reject) =>
			server.once("connection", (socket) => {
				read(socket)
					.then(resolve, reject)
					.finally(() => socket.destroy());
			}),
		);
		client = createConnection(join(root, "peer.sock"));
		client.on("error", () => {});
		expect(await result).toBe(process.getuid!());
		const bad = createNativePeerReader({ ...pin, sha256: "a".repeat(64) });
		await expect(bad(client)).rejects.toThrow("private_peer_unavailable");
	} finally {
		client?.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});
