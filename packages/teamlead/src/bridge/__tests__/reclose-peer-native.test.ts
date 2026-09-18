import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadReclosePeerNative } from "../reclose-peer-native.js";

const execFileAsync = promisify(execFile);
const buildScript = fileURLToPath(
	new URL("../../../scripts/build-reclose-peer-native.mjs", import.meta.url),
);
const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(
		cleanup.splice(0).map((directory) => rm(directory, { recursive: true })),
	);
});

async function tempOutputDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "fly2662-native-build-"));
	cleanup.push(directory);
	return directory;
}

describe("optional reclose peer native adapter", () => {
	it("fails closed with a typed reason when the exact host module is absent", async () => {
		const directory = await tempOutputDirectory();

		await expect(
			loadReclosePeerNative({ moduleDirectory: directory }),
		).resolves.toEqual({
			available: false,
			reason: "peer_adapter_unavailable",
			detail: expect.stringContaining(
				`reclose-peer-${process.platform}-${process.arch}.node`,
			),
		});
	});

	it.skipIf(process.platform !== "darwin")(
		"keeps the package build successful when native compilation is forced to fail",
		async () => {
			const directory = await tempOutputDirectory();
			const result = await execFileAsync(process.execPath, [buildScript], {
				env: {
					...process.env,
					FLYWHEEL_RECLOSE_PEER_NATIVE_FORCE_FAIL: "1",
					FLYWHEEL_RECLOSE_PEER_NATIVE_OUT_DIR: directory,
				},
			});

			expect(result.stderr).toContain("peer_adapter_unavailable");
			const status = JSON.parse(
				await readFile(
					join(directory, "reclose-peer-build-status.json"),
					"utf8",
				),
			) as Record<string, unknown>;
			expect(status).toMatchObject({
				available: false,
				reason: "native_build_failed",
				platform: process.platform,
				arch: process.arch,
			});
			await expect(
				loadReclosePeerNative({ moduleDirectory: directory }),
			).resolves.toEqual({
				available: false,
				reason: "peer_adapter_unavailable",
				detail: expect.any(String),
			});
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"builds and loads the exact Darwin host adapter without downloading artifacts",
		async () => {
			const directory = await tempOutputDirectory();
			await execFileAsync(process.execPath, [buildScript], {
				env: {
					...process.env,
					FLYWHEEL_RECLOSE_PEER_NATIVE_OUT_DIR: directory,
				},
			});

			const loaded = await loadReclosePeerNative({
				moduleDirectory: directory,
			});
			expect(loaded).toMatchObject({ available: true });
			if (!loaded.available) throw new Error(loaded.detail);
			expect(loaded.adapter.abiVersion()).toBe(2);
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"binds the accepted socket to an exact kernel peer incarnation",
		async () => {
			const directory = await tempOutputDirectory();
			await execFileAsync(process.execPath, [buildScript], {
				env: {
					...process.env,
					FLYWHEEL_RECLOSE_PEER_NATIVE_OUT_DIR: directory,
				},
			});
			const loaded = await loadReclosePeerNative({
				moduleDirectory: directory,
			});
			if (!loaded.available) throw new Error(loaded.detail);
			const socketPath = join(directory, "peer.sock");
			const listener = loaded.adapter.createListener(socketPath);
			const client = createConnection(socketPath);
			let connection: number | null = null;
			try {
				client.write('{"probe":true}\n');
				for (let attempt = 0; attempt < 100 && connection === null; attempt++) {
					connection = loaded.adapter.accept(listener);
					if (connection === null) {
						await new Promise((resolve) => setTimeout(resolve, 5));
					}
				}
				expect(connection).not.toBeNull();
				if (connection === null) throw new Error("native accept timed out");
				let frame = loaded.adapter.readFrame(connection, 65_536);
				for (let attempt = 0; attempt < 100 && !frame.complete; attempt++) {
					await new Promise((resolve) => setTimeout(resolve, 5));
					frame = loaded.adapter.readFrame(connection, 65_536);
				}
				expect(frame).toEqual({ complete: true, frame: '{"probe":true}' });
				const peer = loaded.adapter.getPeerSnapshot(connection);
				expect(peer).toMatchObject({
					pid: process.pid,
					uid: process.getuid?.(),
					effectiveUid: process.geteuid?.(),
				});
				expect(peer.auditPidVersion).toBe(peer.pidVersion);
				expect(loaded.adapter.revalidatePeer(connection)).toEqual(peer);
			} finally {
				client.destroy();
				if (connection !== null) loaded.adapter.close(connection);
				loaded.adapter.close(listener);
			}
		},
		20_000,
	);
});
