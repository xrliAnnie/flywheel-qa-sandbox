import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncOpMarkerPath } from "../src/sync-op-marker.js";
import {
	DEFAULT_SYNC_EXEC_TIMEOUT_MS,
	defaultExecFile,
} from "../src/TmuxAdapter.js";

/**
 * FLY-154 hotfix — Bug 4 (visibility): `defaultExecFile` previously bubbled
 * `execFileSync`'s default error which is just `"Command failed: <cmd>"`,
 * dropping the actual stderr even though it was sitting on `error.stderr`.
 * qa-fly-372 spent a whole Bridge restart cycle guessing the cause of a
 * "tmux command too long" failure because the Bridge log only showed the
 * truncated cmd line. These tests guard the surfaced-stderr invariant.
 */
describe("defaultExecFile stderr capture (FLY-154 hotfix)", () => {
	it("includes stderr in the thrown error message when the command fails", () => {
		// /bin/sh -c "echo OUT; echo ERRBOOM 1>&2; exit 7"
		let caught: unknown;
		try {
			defaultExecFile("/bin/sh", [
				"-c",
				"echo HELLO_OUT; echo HELLO_ERR 1>&2; exit 7",
			]);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		const e = caught as Error & {
			stderr?: string | Buffer;
			stdout?: string | Buffer;
			status?: number;
		};
		// The original `error.stderr`/`error.stdout`/`error.status` MUST be
		// preserved so programmatic callers still work.
		expect(String(e.stderr)).toContain("HELLO_ERR");
		expect(String(e.stdout)).toContain("HELLO_OUT");
		expect(e.status).toBe(7);
		// AND the message MUST now include stderr so it surfaces in Bridge logs.
		expect(e.message).toContain("HELLO_ERR");
		expect(e.message).toContain("status: 7");
	});

	it("returns stdout normally on success (no regression in happy path)", () => {
		const result = defaultExecFile("/bin/sh", ["-c", "echo GREETING"]);
		expect(result.stdout.trim()).toBe("GREETING");
	});

	it("FLY-2331: keeps the legacy sync seam on its documented 20s ceiling", () => {
		expect(DEFAULT_SYNC_EXEC_TIMEOUT_MS).toBe(20_000);
	});

	it("FLY-2331: publishes a command-family marker and clears it afterward", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2331-default-exec-"));
		const oldDir = process.env.FLYWHEEL_BRIDGE_SYNCOP_DIR;
		process.env.FLYWHEEL_BRIDGE_SYNCOP_DIR = dir;
		try {
			const markerPath = syncOpMarkerPath();
			const result = defaultExecFile(
				process.execPath,
				[
					"-e",
					"const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync(process.env.MARKER_PATH,'utf8')); process.stdout.write(m.label)",
				],
				{ env: { MARKER_PATH: markerPath } },
			);
			expect(result.stdout).toBe("tmux-adapter:other");
			expect(() => rmSync(markerPath)).toThrow();
		} finally {
			if (oldDir === undefined) delete process.env.FLYWHEEL_BRIDGE_SYNCOP_DIR;
			else process.env.FLYWHEEL_BRIDGE_SYNCOP_DIR = oldDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces tmux-style 'command too long' stderr (the actual qa-fly-372 scenario)", () => {
		// Simulate a tmux failure that prints to stderr only (no stdout).
		let caught: unknown;
		try {
			defaultExecFile("/bin/sh", [
				"-c",
				"echo 'tmux: command too long' 1>&2; exit 1",
			]);
		} catch (err) {
			caught = err;
		}
		const e = caught as Error;
		expect(e.message).toContain("tmux: command too long");
	});
});
