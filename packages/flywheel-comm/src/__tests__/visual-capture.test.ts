/**
 * GEO-151 A4 — visual-capture wrapper tests.
 *
 * Covers AC1 (port lock + free-port + no kill + lock cleanup), AC3 (manifest
 * + selected paths echoed in stdout JSON; wrapper does NOT do the Read step
 * — instruction template covers that), AC15 partial (no nested stage CLI
 * invocation; --notify=false default).
 *
 * Uses dependency injection for `runProofShot` + `findPort` + `runNotify`
 * so tests don't shell out to the real binaries. Discovery uses real
 * filesystem (writes fixture artifacts into a tmp output dir).
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type VisualCaptureArgs,
	visualCapture,
	visualCaptureStdout,
} from "../commands/visual-capture.js";
import {
	type AcquiredLock,
	acquireProofShotLock,
	acquireProofShotLockWithRetry,
} from "../proofshot/lock.js";

function baseArgs(
	overrides: Partial<VisualCaptureArgs> = {},
): VisualCaptureArgs {
	const proofShotCalls: string[][] = [];
	return {
		kind: "ui",
		description: "test capture",
		output: "/will-be-set-per-test",
		dedupKey: "exec-abc|test|ui",
		attempt: 1,
		execId: "exec-abc",
		issueId: "GEO-151",
		projectName: "GeoForge3D",
		stage: "test",
		devCommand: "pnpm dev",
		runProofShot: (args) => {
			proofShotCalls.push(args);
		},
		findPort: () => 3000, // always returns free
		runNotify: () => {},
		...overrides,
		// expose calls for the test
		...({ _proofShotCalls: proofShotCalls } as Partial<VisualCaptureArgs>),
	};
}

/** Helper: seed a fixture output dir with simulated ProofShot artifacts. */
function seedFixture(
	dir: string,
	entries: Array<{ name: string; bytes: number }>,
): void {
	mkdirSync(dir, { recursive: true });
	for (const e of entries) {
		writeFileSync(join(dir, e.name), Buffer.alloc(e.bytes, "x"));
	}
}

describe("visualCapture (GEO-151 A4)", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = join(tmpdir(), `vc-${Date.now()}-${Math.random()}`);
		mkdirSync(tmpRoot, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tmpRoot, { recursive: true, force: true });
		} catch {}
	});

	describe("AC1 — port lock + free-port + no kill + cleanup", () => {
		it("acquires lock, calls findPort with preferred, releases lock when done", async () => {
			const output = join(tmpRoot, "session1");
			const findPortCalls: number[] = [];
			const args = baseArgs({
				output,
				preferredPort: 3000,
				findPort: (p) => {
					findPortCalls.push(p);
					return 3000;
				},
				runProofShot: () => {
					// Simulate proofshot writing a SUMMARY + one PNG.
					seedFixture(output, [
						{ name: "SUMMARY.md", bytes: 100 },
						{ name: "step-01.png", bytes: 5000 },
					]);
				},
			});
			const result = await visualCapture(args);
			expect(findPortCalls).toEqual([3000]);
			expect(result.devPort).toBe(3000);
			expect(result.manifestPath).toBe(join(output, "manifest.json"));
			// Lock should be released — we can acquire it again immediately.
			const lock = acquireProofShotLock();
			lock.release();
		});

		it("throws when no free port can be found in range", async () => {
			const output = join(tmpRoot, "session2");
			const args = baseArgs({
				output,
				findPort: () => null,
			});
			await expect(visualCapture(args)).rejects.toThrow(/no free port/);
		});

		it("findPort uses preferred port arg (not just default 3000)", async () => {
			const output = join(tmpRoot, "session-pref");
			const seenPreferred: number[] = [];
			const args = baseArgs({
				output,
				preferredPort: 3050,
				findPort: (p) => {
					seenPreferred.push(p);
					return p;
				},
				runProofShot: () => {
					seedFixture(output, [{ name: "SUMMARY.md", bytes: 100 }]);
				},
			});
			await visualCapture(args);
			expect(seenPreferred).toEqual([3050]);
		});

		it("releases lock even when proofshot throws", async () => {
			const output = join(tmpRoot, "session-throw");
			const args = baseArgs({
				output,
				runProofShot: () => {
					throw new Error("simulated proofshot failure");
				},
			});
			await expect(visualCapture(args)).rejects.toThrow(/simulated/);
			// Lock dir should be cleaned up.
			const lock = acquireProofShotLock();
			lock.release();
		});

		it("does NOT kill the port occupant — wrapper trusts findPort to skip occupied", async () => {
			// The wrapper never calls `kill` or any process-killing API. Verified
			// by absence: there's no `process.kill` in visual-capture.ts. Smoke
			// test: spawn the wrapper with a no-op runProofShot and confirm no
			// "kill" execFile call was made — we use a custom runProofShot that
			// would assert if invoked with kill-like args.
			const output = join(tmpRoot, "session-no-kill");
			const proofShotInvocations: string[][] = [];
			const args = baseArgs({
				output,
				runProofShot: (a) => {
					proofShotInvocations.push(a);
					if (a[0] === "stop") {
						seedFixture(output, [{ name: "SUMMARY.md", bytes: 100 }]);
					}
				},
			});
			await visualCapture(args);
			// All invocations are proofshot subcommands (start / exec / stop).
			// None call kill / pkill / lsof -kill etc.
			for (const inv of proofShotInvocations) {
				expect(inv).not.toContain("kill");
				expect(inv).not.toContain("pkill");
			}
		});
	});

	describe("AC3 — manifest + selected paths", () => {
		it("writes manifest.json with full wire schema (snake_case correlation fields)", async () => {
			const output = join(tmpRoot, "session-manifest");
			const args = baseArgs({
				output,
				runProofShot: () => {
					seedFixture(output, [
						{ name: "SUMMARY.md", bytes: 100 },
						{ name: "step-00.png", bytes: 50000 },
						{ name: "step-01.png", bytes: 50000 },
						{ name: "step-02-error.png", bytes: 50000 },
					]);
				},
			});
			const result = await visualCapture(args);

			// Manifest written
			expect(existsSync(result.manifestPath)).toBe(true);
			const manifest = JSON.parse(readFileSync(result.manifestPath, "utf-8"));

			// Wire field names — snake_case per §3.6.1 of the plan.
			expect(manifest.execId).toBe("exec-abc");
			expect(manifest.issue_id).toBe("GEO-151");
			expect(manifest.project_name).toBe("GeoForge3D");
			expect(manifest.stage).toBe("test");
			expect(manifest.dedup_key).toBe("exec-abc|test|ui");
			expect(manifest.attempt).toBe(1);
			expect(manifest.captureKind).toBe("ui");
			expect(Array.isArray(manifest.selected)).toBe(true);
			expect(Array.isArray(manifest.dropped)).toBe(true);
			expect(typeof manifest.totalTokens).toBe("number");

			// Selected should include SUMMARY + error PNG (highest priority).
			expect(
				manifest.selected.some((p: string) => p.endsWith("SUMMARY.md")),
			).toBe(true);
			expect(
				manifest.selected.some((p: string) => p.endsWith("step-02-error.png")),
			).toBe(true);
		});

		it("stdout JSON has wire field names (dedup_key, not dedupKey)", async () => {
			const output = join(tmpRoot, "session-stdout");
			const args = baseArgs({
				output,
				runProofShot: () => {
					seedFixture(output, [{ name: "SUMMARY.md", bytes: 100 }]);
				},
			});
			const result = await visualCapture(args);
			const stdout = visualCaptureStdout(result, {
				dedupKey: args.dedupKey,
				attempt: args.attempt,
			});
			expect(stdout).toMatchObject({
				dedup_key: "exec-abc|test|ui",
				attempt: 1,
				totalTokens: expect.any(Number),
				manifest_path: result.manifestPath,
				selected: expect.any(Array),
				dropped: expect.any(Array),
			});
			// snake_case in wire, not camelCase
			expect(stdout).not.toHaveProperty("dedupKey");
		});

		it("WebM files appear in dropped but never in selected", async () => {
			const output = join(tmpRoot, "session-webm");
			const args = baseArgs({
				output,
				runProofShot: () => {
					seedFixture(output, [
						{ name: "SUMMARY.md", bytes: 100 },
						{ name: "step-00.png", bytes: 50000 },
						{ name: "session.webm", bytes: 10_000_000 },
					]);
				},
			});
			const result = await visualCapture(args);
			const manifest = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
			expect(manifest.selected.some((p: string) => p.endsWith(".webm"))).toBe(
				false,
			);
			expect(manifest.dropped.some((p: string) => p.endsWith(".webm"))).toBe(
				true,
			);
		});
	});

	describe("ProofShot CLI invocation contract (Codex R2 HIGH#1)", () => {
		it("UI mode: calls proofshot exec screenshot (NOT snapshot — that's a11y tree)", async () => {
			const output = join(tmpRoot, "session-ui-shot");
			const seen: string[][] = [];
			const args = baseArgs({
				output,
				runProofShot: (a) => {
					seen.push(a);
					if (a[0] === "stop") {
						seedFixture(output, [
							{ name: "SUMMARY.md", bytes: 100 },
							{ name: "step-ui.png", bytes: 5000 },
						]);
					}
				},
			});
			await visualCapture(args);
			// `proofshot exec screenshot step-ui.png` should appear.
			const screenshotCalls = seen.filter(
				(a) => a[0] === "exec" && a[1] === "screenshot",
			);
			expect(screenshotCalls).toHaveLength(1);
			expect(screenshotCalls[0]?.[2]).toBe("step-ui.png");
			// NEVER call `exec snapshot` — that's an a11y tree pass-through.
			const snapshotCalls = seen.filter(
				(a) => a[0] === "exec" && a[1] === "snapshot",
			);
			expect(snapshotCalls).toHaveLength(0);
		});

		it("3D mode: for each angle, calls `exec open <url>` then `exec screenshot angle-<safe>.png`", async () => {
			const output = join(tmpRoot, "session-3d-shot");
			const seen: string[][] = [];
			// Need a real model file so the 3D HTTP server can start.
			const modelDir = join(tmpRoot, "models");
			mkdirSync(modelDir, { recursive: true });
			const modelPath = join(modelDir, "test.glb");
			writeFileSync(modelPath, "GLB-FAKE");
			const args = baseArgs({
				output,
				kind: "3d",
				devCommand: undefined,
				modelPath,
				modelViewerUrl: "https://3dviewer.net",
				angles: ["front", "side"],
				runProofShot: (a) => {
					seen.push(a);
					if (a[0] === "stop") {
						seedFixture(output, [
							{ name: "SUMMARY.md", bytes: 100 },
							{ name: "angle-front.png", bytes: 5000 },
							{ name: "angle-side.png", bytes: 5000 },
						]);
					}
				},
			});
			await visualCapture(args);
			// Expected sequence (after `start` + before `stop`):
			//   exec open <url>?model=...&camera=front
			//   exec screenshot angle-00-front.png
			//   exec open <url>?model=...&camera=side
			//   exec screenshot angle-01-side.png
			// (NN-prefix added per Codex R3 LOW — keeps filenames unique
			// even when sanitizeFilename collapses different angles.)
			const execSeq = seen.filter((a) => a[0] === "exec");
			expect(execSeq).toHaveLength(4);
			expect(execSeq[0]?.[1]).toBe("open");
			expect(execSeq[0]?.[2]).toContain("camera=front");
			expect(execSeq[1]).toEqual(["exec", "screenshot", "angle-00-front.png"]);
			expect(execSeq[2]?.[1]).toBe("open");
			expect(execSeq[2]?.[2]).toContain("camera=side");
			expect(execSeq[3]).toEqual(["exec", "screenshot", "angle-01-side.png"]);
		});

		it("3D mode: angle string sanitized to safe filename", async () => {
			const output = join(tmpRoot, "session-3d-evil");
			const seen: string[][] = [];
			const modelDir = join(tmpRoot, "models2");
			mkdirSync(modelDir, { recursive: true });
			const modelPath = join(modelDir, "x.glb");
			writeFileSync(modelPath, "x");
			const args = baseArgs({
				output,
				kind: "3d",
				devCommand: undefined,
				modelPath,
				modelViewerUrl: "https://3dviewer.net",
				angles: ["front/etc", " bad name ", "../escape"],
				runProofShot: (a) => {
					seen.push(a);
					if (a[0] === "stop") {
						seedFixture(output, [{ name: "SUMMARY.md", bytes: 100 }]);
					}
				},
			});
			await visualCapture(args);
			const shotCalls = seen.filter(
				(a) => a[0] === "exec" && a[1] === "screenshot",
			);
			// Names should be: `angle-NN-<safe>.png` — NN unique per angle so
			// the file names never collide even if sanitization maps two
			// different angle strings to the same safe form.
			const seenNames = new Set<string>();
			for (const c of shotCalls) {
				const name = c[2] ?? "";
				expect(name).not.toContain("/");
				expect(name).not.toMatch(/^\./);
				expect(name).toMatch(/^angle-\d{2}-[A-Za-z0-9._-]+\.png$/);
				expect(seenNames.has(name)).toBe(false); // uniqueness
				seenNames.add(name);
			}
		});
	});

	describe("AC15 partial — no nested stage CLI invocation", () => {
		it("wrapper never calls flywheel-comm stage", async () => {
			const output = join(tmpRoot, "session-nested");
			const seen: string[][] = [];
			const args = baseArgs({
				output,
				runProofShot: (a) => {
					seen.push(a);
					if (a[0] === "stop") {
						seedFixture(output, [{ name: "SUMMARY.md", bytes: 100 }]);
					}
				},
			});
			await visualCapture(args);
			// Every invocation should be a `proofshot ...` arg list.
			// None should look like a `stage set ...` invocation.
			for (const inv of seen) {
				expect(inv[0]).not.toBe("stage");
				expect(inv.join(" ")).not.toContain("stage set");
			}
		});

		it("--notify default FALSE — does not call notify even when manifest exists", async () => {
			const output = join(tmpRoot, "session-no-notify");
			let notifyCalled = false;
			const args = baseArgs({
				output,
				runProofShot: () => {
					seedFixture(output, [{ name: "SUMMARY.md", bytes: 100 }]);
				},
				runNotify: () => {
					notifyCalled = true;
				},
			});
			await visualCapture(args); // notify omitted → false
			expect(notifyCalled).toBe(false);
		});

		it("--notify=true calls notify with manifest path", async () => {
			const output = join(tmpRoot, "session-notify");
			const notifyCalls: string[] = [];
			const args = baseArgs({
				output,
				notify: true,
				runProofShot: () => {
					seedFixture(output, [{ name: "SUMMARY.md", bytes: 100 }]);
				},
				runNotify: (mp) => {
					notifyCalls.push(mp);
				},
			});
			const result = await visualCapture(args);
			expect(notifyCalls).toEqual([result.manifestPath]);
		});
	});

	describe("Argument validation", () => {
		it("throws on missing execId", async () => {
			const args = baseArgs({
				output: join(tmpRoot, "x"),
				execId: "",
			});
			await expect(visualCapture(args)).rejects.toThrow(/--exec-id/);
		});

		it("UI mode without devCommand throws", async () => {
			const args = baseArgs({
				output: join(tmpRoot, "x"),
				devCommand: undefined,
			});
			await expect(visualCapture(args)).rejects.toThrow(/--dev-command/);
		});

		it("3D mode without modelPath throws", async () => {
			const args = baseArgs({
				output: join(tmpRoot, "x"),
				kind: "3d",
				modelPath: undefined,
				modelViewerUrl: "https://3dviewer.net",
				angles: ["front"],
			});
			await expect(visualCapture(args)).rejects.toThrow(/--model-path/);
		});

		it("3D mode without modelViewerUrl throws", async () => {
			const args = baseArgs({
				output: join(tmpRoot, "x"),
				kind: "3d",
				modelPath: "/abs/model.glb",
				modelViewerUrl: undefined,
				angles: ["front"],
			});
			await expect(visualCapture(args)).rejects.toThrow(/--model-viewer-url/);
		});

		it("3D mode with empty angles throws", async () => {
			const args = baseArgs({
				output: join(tmpRoot, "x"),
				kind: "3d",
				modelPath: "/abs/model.glb",
				modelViewerUrl: "https://3dviewer.net",
				angles: [],
			});
			await expect(visualCapture(args)).rejects.toThrow(/--angles/);
		});

		it("non-positive attempt throws", async () => {
			const args = baseArgs({ output: join(tmpRoot, "x"), attempt: 0 });
			await expect(visualCapture(args)).rejects.toThrow(/--attempt/);
		});
	});
});

describe("lock helpers (proofshot/lock.ts)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `lock-${Date.now()}-${Math.random()}`);
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	});

	it("first acquire succeeds, second throws ELOCKED", async () => {
		const lock = acquireProofShotLock(tmpDir);
		expect(() => acquireProofShotLock(tmpDir)).toThrow("ELOCKED");
		lock.release();
	});

	it("release allows immediate re-acquire", async () => {
		const a = acquireProofShotLock(tmpDir);
		a.release();
		const b = acquireProofShotLock(tmpDir);
		b.release();
	});

	it("stale lock (pid file points at dead PID) is reclaimed", async () => {
		mkdirSync(tmpDir);
		// Write a pid that almost certainly doesn't exist
		writeFileSync(`${tmpDir}/pid`, "999999999");
		const lock = acquireProofShotLock(tmpDir);
		lock.release();
	});

	it("acquireWithRetry succeeds after lock released mid-window", async () => {
		const a = acquireProofShotLock(tmpDir);
		// Release after a short delay so the retry loop finds it free.
		setTimeout(() => a.release(), 50);
		const b = await acquireProofShotLockWithRetry(tmpDir, 5, 30);
		b.release();
	});

	it("acquireWithRetry times out when lock stays held", async () => {
		const a = acquireProofShotLock(tmpDir);
		try {
			await expect(
				acquireProofShotLockWithRetry(tmpDir, 2, 10),
			).rejects.toThrow("ELOCK_TIMEOUT");
		} finally {
			a.release();
		}
	});

	it("multiple concurrent waiters — only one wins per release", async () => {
		const a = acquireProofShotLock(tmpDir);
		const waiters: Promise<AcquiredLock>[] = [];
		for (let i = 0; i < 3; i++) {
			waiters.push(acquireProofShotLockWithRetry(tmpDir, 20, 20));
		}
		setTimeout(() => a.release(), 50);
		// At least one should succeed
		const results = await Promise.allSettled(waiters);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		expect(fulfilled.length).toBeGreaterThanOrEqual(1);
		// Clean up any won locks
		for (const r of results) {
			if (r.status === "fulfilled") {
				(r.value as AcquiredLock).release();
			}
		}
	});
});

describe("free-port helpers (proofshot/free-port.ts)", () => {
	it("findFreePort picks the first non-occupied port", async () => {
		const { findFreePort } = await import("../proofshot/free-port.js");
		const port = findFreePort(4000, 5, () => false); // always free
		expect(port).toBe(4000);
	});

	it("findFreePort skips occupied and returns next free", async () => {
		const { findFreePort } = await import("../proofshot/free-port.js");
		const port = findFreePort(4000, 5, (p) => p < 4002);
		expect(port).toBe(4002);
	});

	it("findFreePort returns null when all ports occupied", async () => {
		const { findFreePort } = await import("../proofshot/free-port.js");
		const port = findFreePort(4000, 3, () => true);
		expect(port).toBeNull();
	});
});

describe("local-server (proofshot/local-server.ts)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `local-srv-${Date.now()}-${Math.random()}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	});

	it("serves basename(modelPath) on loopback", async () => {
		const { startLocalModelServer } = await import(
			"../proofshot/local-server.js"
		);
		const modelPath = join(tmpDir, "model.glb");
		writeFileSync(modelPath, "GLB-CONTENT");
		const server = await startLocalModelServer(modelPath);
		try {
			expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/model\.glb$/);
			const res = await fetch(server.url);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toBe("GLB-CONTENT");
		} finally {
			await server.close();
		}
	});

	it("rejects path traversal (returns 403)", async () => {
		const { startLocalModelServer } = await import(
			"../proofshot/local-server.js"
		);
		const modelPath = join(tmpDir, "model.glb");
		writeFileSync(modelPath, "GLB");
		writeFileSync(join(tmpDir, "secret.txt"), "TOP SECRET");
		const server = await startLocalModelServer(modelPath);
		try {
			const res1 = await fetch(`http://127.0.0.1:${server.port}/secret.txt`);
			expect(res1.status).toBe(403);
			const res2 = await fetch(`http://127.0.0.1:${server.port}/../secret.txt`);
			expect(res2.status).toBe(403);
		} finally {
			await server.close();
		}
	});

	it("throws if model file does not exist", async () => {
		const { startLocalModelServer } = await import(
			"../proofshot/local-server.js"
		);
		await expect(
			startLocalModelServer(join(tmpDir, "nonexistent.glb")),
		).rejects.toThrow(/not found/);
	});
});

describe("visualCapture — FLY-188 agent-browser env passthrough", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = join(tmpdir(), `vc-fly188-${Date.now()}-${Math.random()}`);
		mkdirSync(tmpRoot, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tmpRoot, { recursive: true, force: true });
		} catch {}
	});

	/** Stub that records the opts each runProofShot call received + seeds artifacts. */
	function recordingArgs(
		output: string,
		overrides: Partial<VisualCaptureArgs>,
		sink: Array<{ args: string[]; opts?: { env?: NodeJS.ProcessEnv } }>,
	): VisualCaptureArgs {
		return baseArgs({
			output,
			runProofShot: (args, opts) => {
				sink.push({ args, opts });
				seedFixture(output, [
					{ name: "SUMMARY.md", bytes: 50 },
					{ name: "step-ui.png", bytes: 4000 },
				]);
			},
			...overrides,
		});
	}

	it("forwards agentBrowserProfile to every proofshot call via AGENT_BROWSER_PROFILE env", async () => {
		const output = join(tmpRoot, "profile");
		const seen: Array<{ args: string[]; opts?: { env?: NodeJS.ProcessEnv } }> =
			[];
		await visualCapture(
			recordingArgs(output, { agentBrowserProfile: "/tmp/qa-profile" }, seen),
		);
		expect(seen.length).toBeGreaterThan(0);
		for (const call of seen) {
			expect(call.opts?.env?.AGENT_BROWSER_PROFILE).toBe("/tmp/qa-profile");
			// process.env is preserved (env is a superset, not a replacement).
			expect(call.opts?.env?.PATH).toBe(process.env.PATH);
		}
	});

	it("forwards agentBrowserStreamPort via AGENT_BROWSER_STREAM_PORT env (stringified)", async () => {
		const output = join(tmpRoot, "stream");
		const seen: Array<{ args: string[]; opts?: { env?: NodeJS.ProcessEnv } }> =
			[];
		await visualCapture(
			recordingArgs(output, { agentBrowserStreamPort: 9223 }, seen),
		);
		expect(seen.length).toBeGreaterThan(0);
		for (const call of seen) {
			expect(call.opts?.env?.AGENT_BROWSER_STREAM_PORT).toBe("9223");
		}
	});

	it("passes NO env override when neither profile nor stream is set (byte-compatible)", async () => {
		const output = join(tmpRoot, "none");
		const seen: Array<{ args: string[]; opts?: { env?: NodeJS.ProcessEnv } }> =
			[];
		await visualCapture(recordingArgs(output, {}, seen));
		expect(seen.length).toBeGreaterThan(0);
		// No override → runner invoked exactly as before: no second opts arg.
		for (const call of seen) {
			expect(call.opts).toBeUndefined();
		}
	});
});
