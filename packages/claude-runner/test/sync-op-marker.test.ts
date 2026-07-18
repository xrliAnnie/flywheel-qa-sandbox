import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearSyncOp,
	markSyncOp,
	readSyncOpMarker,
	sweepStaleSyncOpMarkers,
	syncOpMarkerPath,
} from "../src/sync-op-marker.js";

describe("bridge sync-op marker", () => {
	let dir: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1365-syncop-"));
		env = { FLYWHEEL_BRIDGE_SYNCOP_DIR: dir };
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("atomically writes a per-pid marker and clears only the matching token", () => {
		const token = markSyncOp("codex-adapter:preflight", {
			pid: 123,
			now: () => 456,
			env,
		});
		const path = syncOpMarkerPath(123, env);
		expect(token).toBeTypeOf("string");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			label: "codex-adapter:preflight",
			startedAt: 456,
			pid: 123,
			token,
		});
		clearSyncOp("wrong-token", { pid: 123, env });
		expect(existsSync(path)).toBe(true);
		clearSyncOp(token!, { pid: 123, env });
		expect(existsSync(path)).toBe(false);
	});

	it("defensive read rejects symlink, fifo, oversized and malformed markers", () => {
		const path = syncOpMarkerPath(123, env);
		const target = join(dir, "target.json");
		writeFileSync(
			target,
			JSON.stringify({ label: "x", startedAt: 1, pid: 123, token: "t" }),
		);
		symlinkSync(target, path);
		expect(readSyncOpMarker(path)).toBeNull();
		rmSync(path);

		if (process.platform !== "win32") {
			execFileSync("mkfifo", [path]);
			expect(lstatSync(path).isFIFO()).toBe(true);
			expect(readSyncOpMarker(path)).toBeNull();
			rmSync(path);
		}

		writeFileSync(path, "x".repeat(5000));
		expect(readSyncOpMarker(path)).toBeNull();
		writeFileSync(path, "not-json");
		expect(readSyncOpMarker(path)).toBeNull();
	});

	it("sweeps only markers whose pid is proven dead", () => {
		writeFileSync(syncOpMarkerPath(111, env), "{}");
		writeFileSync(syncOpMarkerPath(222, env), "{}");
		sweepStaleSyncOpMarkers({ env, isPidAlive: (pid) => pid === 222 });
		expect(existsSync(syncOpMarkerPath(111, env))).toBe(false);
		expect(existsSync(syncOpMarkerPath(222, env))).toBe(true);
	});
});
