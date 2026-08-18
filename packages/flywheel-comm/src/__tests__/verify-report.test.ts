/**
 * FLY-1828: hosted-report verification must be browser-free by default, and
 * its opt-in Chrome screenshot must leave no process group behind.
 */

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_CHROME_BIN,
	DEFAULT_SHOT_TIMEOUT_MS,
	verifyReport,
} from "../commands/verify-report.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "fly1828-verify-test-"));
	tempDirs.push(dir);
	return dir;
}

function png(width = 12, height = 34): Buffer {
	const out = Buffer.alloc(36);
	Buffer.from("89504e470d0a1a0a", "hex").copy(out);
	out.writeUInt32BE(13, 8);
	out.write("IHDR", 12, "ascii");
	out.writeUInt32BE(width, 16);
	out.writeUInt32BE(height, 20);
	out.writeUInt32BE(0, 24);
	out.write("IEND", 28, "ascii");
	out.writeUInt32BE(0xae426082, 32);
	return out;
}

function response(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "text/html" },
	});
}

describe("verifyReport — lightweight hosted-page checks", () => {
	it("passes a clean hosted page without spawning a browser", async () => {
		let spawned = false;
		const result = await verifyReport({
			url: "https://reports.example/r/abc/",
			expect: "Founder report",
			fetchImpl: async () =>
				response(
					'<h1>Founder report</h1><svg></svg><img src="x"><script nonce="abc">ok()</script>',
				),
			screenshotDeps: {
				spawnImpl: (() => {
					spawned = true;
					throw new Error("must not spawn");
				}) as never,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.envelope).toMatchObject({
			ok: true,
			status: 200,
			checks: {
				http: "pass",
				noncePlaceholder: "pass",
				scriptNonce: "pass",
				expect: "pass",
			},
			info: { hasInlineSvg: true, imgCount: 1 },
			screenshot: null,
		});
		expect(spawned).toBe(false);
	});

	it("skips scriptNonce when the page has no script", async () => {
		const result = await verifyReport({
			url: "https://reports.example/r/static/",
			fetchImpl: async () => response("<h1>Static</h1>"),
		});
		expect(result.envelope.checks.scriptNonce).toBe("skipped");
		expect(result.envelope.checks.expect).toBe("skipped");
	});

	it.each([
		["HTTP failure", response("missing", 404), "HTTP 404"],
		[
			"nonce placeholder",
			response('<script nonce="__CSP_NONCE__"></script>'),
			"__CSP_NONCE__",
		],
		["script without nonce", response("<script>broken()</script>"), "nonce"],
	])("fails %s", async (_name, fetchResponse, error) => {
		const result = await verifyReport({
			url: "https://reports.example/r/bad/",
			fetchImpl: async () => fetchResponse,
		});
		expect(result.exitCode).toBe(1);
		expect(result.envelope.ok).toBe(false);
		expect(result.envelope.error).toContain(error);
	});

	it("fails when any script tag is missing a nonce", async () => {
		const result = await verifyReport({
			url: "https://reports.example/r/mixed-nonces/",
			fetchImpl: async () =>
				response('<script nonce="abc">ok()</script><script>blocked()</script>'),
		});
		expect(result.exitCode).toBe(1);
		expect(result.envelope.error).toContain("nonce");
	});

	it("fails when --expect is absent from the body", async () => {
		const result = await verifyReport({
			url: "https://reports.example/r/expect/",
			expect: "required marker",
			fetchImpl: async () => response("<h1>Other</h1>"),
		});
		expect(result.envelope.error).toContain("expected substring");
	});

	it("warns on template braces without rejecting a valid report", async () => {
		const result = await verifyReport({
			url: "https://reports.example/r/braces/",
			fetchImpl: async () => response("<pre>{{possible placeholder}}</pre>"),
		});
		expect(result.exitCode).toBe(0);
		expect(result.envelope.warnings).toEqual(["braces: found '{{' 1x"]);
	});

	it("returns a stable failure envelope when fetch aborts", async () => {
		const result = await verifyReport({
			url: "https://reports.example/r/slow/",
			fetchImpl: async () => {
				throw new DOMException("timed out", "TimeoutError");
			},
		});
		expect(result.exitCode).toBe(1);
		expect(result.envelope).toMatchObject({ ok: false, status: null });
		expect(result.envelope.error).toContain("request failed");
	});
});

interface FakeGroup {
	alive: boolean;
	signals: Array<NodeJS.Signals | 0>;
}

function screenshotHarness(options: {
	write?: Buffer;
	group?: FakeGroup;
	exit?: { code: number | null; signal: NodeJS.Signals | null };
	renameFile?: (from: string, to: string) => void;
}) {
	const group = options.group ?? { alive: false, signals: [] };
	const spawnImpl = ((_bin: string, args: readonly string[]) => {
		const child = Object.assign(new EventEmitter(), {
			pid: 43210,
			unref() {},
		});
		const shotArg = args.find((arg) => arg.startsWith("--screenshot="));
		if (options.write && shotArg) {
			writeFileSync(shotArg.slice("--screenshot=".length), options.write);
		}
		queueMicrotask(() => {
			if (!options.group) group.alive = false;
			child.emit("exit", options.exit?.code ?? 0, options.exit?.signal ?? null);
		});
		return child;
	}) as never;
	const killProcess = ((_pid: number, signal: NodeJS.Signals | 0) => {
		group.signals.push(signal);
		if (signal === 0) {
			if (group.alive) return true;
			const error = new Error("gone") as NodeJS.ErrnoException;
			error.code = "ESRCH";
			throw error;
		}
		group.alive = false;
		return true;
	}) as typeof process.kill;
	return {
		spawnImpl,
		killProcess,
		sleep: async () => {},
		renameFile: options.renameFile,
		group,
	};
}

describe("verifyReport — opt-in screenshot", () => {
	it("uses a 20 second default screenshot deadline", () => {
		expect(DEFAULT_SHOT_TIMEOUT_MS).toBe(20_000);
	});

	it("accepts only a fresh valid PNG and atomically installs it", async () => {
		const dir = makeTempDir();
		const target = join(dir, "report.png");
		const result = await verifyReport({
			url: "https://reports.example/r/shot/",
			screenshotPath: target,
			chromeBin: process.execPath,
			fetchImpl: async () => response("<h1>OK</h1>"),
			screenshotDeps: screenshotHarness({ write: png(640, 480) }),
		});

		expect(result.exitCode).toBe(0);
		expect(result.envelope.screenshot).toEqual({
			path: target,
			width: 640,
			height: 480,
		});
		expect(readFileSync(target)).toEqual(png(640, 480));
	});

	it.each([
		["missing", undefined, "did not produce"],
		["short", Buffer.from("short"), "too short"],
		["wrong signature", Buffer.alloc(24), "PNG signature"],
		[
			"missing IHDR",
			Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(16)]),
			"IHDR",
		],
		["missing IEND", png().subarray(0, 24), "IEND"],
	])(
		"rejects a %s output even when the target already has an old PNG",
		async (_name, fresh, error) => {
			const dir = makeTempDir();
			const target = join(dir, "report.png");
			writeFileSync(target, png(1, 1));
			const result = await verifyReport({
				url: "https://reports.example/r/stale/",
				screenshotPath: target,
				chromeBin: process.execPath,
				fetchImpl: async () => response("<h1>OK</h1>"),
				screenshotDeps: screenshotHarness({ write: fresh }),
			});
			expect(result.exitCode).toBe(1);
			expect(result.envelope.error).toContain(error);
			expect(readFileSync(target)).toEqual(png(1, 1));
		},
	);

	it("escalates a helper that outlives Chrome main, then keeps a valid screenshot with a warning", async () => {
		const dir = makeTempDir();
		const target = join(dir, "report.png");
		const group = { alive: true, signals: [] as Array<NodeJS.Signals | 0> };
		const harness = screenshotHarness({ write: png(), group });
		const result = await verifyReport({
			url: "https://reports.example/r/helper/",
			screenshotPath: target,
			chromeBin: process.execPath,
			fetchImpl: async () => response("<h1>OK</h1>"),
			screenshotDeps: harness,
		});
		expect(result.exitCode).toBe(0);
		expect(group.signals).toContain("SIGTERM");
		expect(result.envelope.warnings.join(" ")).toContain(
			"helper processes outlived main",
		);
	});

	it("fails on spawn error without ever signalling -undefined", async () => {
		const dir = makeTempDir();
		const signals: number[] = [];
		const spawnImpl = (() => {
			const child = Object.assign(new EventEmitter(), {
				pid: undefined,
				unref() {},
			});
			queueMicrotask(() => child.emit("error", new Error("ENOENT")));
			return child;
		}) as never;
		const result = await verifyReport({
			url: "https://reports.example/r/spawn/",
			screenshotPath: join(dir, "report.png"),
			chromeBin: process.execPath,
			fetchImpl: async () => response("<h1>OK</h1>"),
			screenshotDeps: {
				spawnImpl,
				killProcess: ((pid: number) => signals.push(pid)) as never,
			},
		});
		expect(result.envelope.error).toContain("failed to start Chrome");
		expect(signals).toEqual([]);
	});

	it("preserves the old target when atomic rename fails", async () => {
		const dir = makeTempDir();
		const target = join(dir, "report.png");
		writeFileSync(target, Buffer.from("old target"));
		const harness = screenshotHarness({
			write: png(),
			renameFile: () => {
				const error = new Error("cross-device") as NodeJS.ErrnoException;
				error.code = "EXDEV";
				throw error;
			},
		});
		const result = await verifyReport({
			url: "https://reports.example/r/rename/",
			screenshotPath: target,
			chromeBin: process.execPath,
			fetchImpl: async () => response("<h1>OK</h1>"),
			screenshotDeps: harness,
		});
		expect(result.exitCode).toBe(1);
		expect(result.envelope.error).toContain("rename");
		expect(readFileSync(target, "utf8")).toBe("old target");
	});

	it("times out, escalates TERM to KILL for the whole group, then cleans", async () => {
		const dir = makeTempDir();
		const events: string[] = [];
		let alive = true;
		const child = Object.assign(new EventEmitter(), { pid: 45678, unref() {} });
		const result = await verifyReport({
			url: "https://reports.example/r/timeout/",
			screenshotPath: join(dir, "timeout.png"),
			chromeBin: process.execPath,
			shotTimeoutMs: 1_000,
			fetchImpl: async () => response("<h1>OK</h1>"),
			screenshotDeps: {
				spawnImpl: (() => child) as never,
				killProcess: ((pid: number, signal: NodeJS.Signals | 0) => {
					events.push(`${pid}:${signal}`);
					if (signal === 0 && !alive) {
						const error = new Error("gone") as NodeJS.ErrnoException;
						error.code = "ESRCH";
						throw error;
					}
					if (signal === "SIGKILL") alive = false;
					return true;
				}) as typeof process.kill,
				sleep: async () => {},
				removePath: ((path: string) => {
					events.push(`cleanup:${path}`);
				}) as typeof rmSync,
			},
		});
		expect(result.envelope.error).toContain("screenshot timeout");
		expect(events).toContain("-45678:SIGTERM");
		expect(events).toContain("-45678:SIGKILL");
		const killIndex = events.indexOf("-45678:SIGKILL");
		expect(
			events.findIndex((event) => event.startsWith("cleanup:")),
		).toBeGreaterThan(killIndex);
	});

	it("keeps a valid PNG written before timeout without treating normal cleanup as a warning", async () => {
		const dir = makeTempDir();
		const target = join(dir, "timeout-valid.png");
		let alive = true;
		const result = await verifyReport({
			url: "https://reports.example/r/timeout-valid/",
			screenshotPath: target,
			chromeBin: process.execPath,
			shotTimeoutMs: 1_000,
			fetchImpl: async () => response("<h1>OK</h1>"),
			screenshotDeps: {
				spawnImpl: ((_bin: string, args: readonly string[]) => {
					const shotArg = args.find((arg) => arg.startsWith("--screenshot="));
					if (shotArg) {
						writeFileSync(shotArg.slice("--screenshot=".length), png(640, 480));
					}
					return Object.assign(new EventEmitter(), { pid: 45679, unref() {} });
				}) as never,
				killProcess: ((_: number, signal: NodeJS.Signals | 0) => {
					if (signal === 0 && !alive) {
						const error = new Error("gone") as NodeJS.ErrnoException;
						error.code = "ESRCH";
						throw error;
					}
					if (signal === "SIGTERM") alive = false;
					return true;
				}) as typeof process.kill,
				sleep: async () => {},
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.envelope.screenshot).toEqual({
			path: target,
			width: 640,
			height: 480,
		});
		expect(result.envelope.warnings.join(" ")).not.toContain("exceeded");
		expect(readFileSync(target)).toEqual(png(640, 480));
	});

	it("retries transient post-SIGKILL EPERM probes before installing the PNG and cleaning temporary resources", async () => {
		const dir = makeTempDir();
		const target = join(dir, "eperm.png");
		const removed: string[] = [];
		let killed = false;
		let postKillProbes = 0;
		const result = await verifyReport({
			url: "https://reports.example/r/eperm/",
			screenshotPath: target,
			chromeBin: process.execPath,
			shotTimeoutMs: 1_000,
			fetchImpl: async () => response("<h1>OK</h1>"),
			screenshotDeps: {
				spawnImpl: ((_bin: string, args: readonly string[]) => {
					const shotArg = args.find((arg) => arg.startsWith("--screenshot="));
					if (shotArg) writeFileSync(shotArg.slice(13), png(640, 480));
					const child = Object.assign(new EventEmitter(), {
						pid: 45680,
						unref() {},
					});
					return child;
				}) as never,
				killProcess: ((_: number, signal: NodeJS.Signals | 0) => {
					if (signal === 0 && killed) {
						const error = new Error(
							postKillProbes++ < 2 ? "not permitted" : "gone",
						) as NodeJS.ErrnoException;
						error.code = postKillProbes <= 2 ? "EPERM" : "ESRCH";
						throw error;
					}
					if (signal === "SIGKILL") killed = true;
					return true;
				}) as typeof process.kill,
				sleep: async () => {},
				removePath: ((path: string, options) => {
					removed.push(path);
					rmSync(path, options);
				}) as typeof rmSync,
			},
		});

		expect(result.exitCode, result.envelope.error).toBe(0);
		expect(readFileSync(target)).toEqual(png(640, 480));
		expect(result.envelope.warnings.join(" ")).not.toContain("exceeded");
		expect(removed.some((path) => path.includes("fly1828-shot-"))).toBe(true);
	});

	it("uses survived semantics when every final post-SIGKILL probe remains EPERM", async () => {
		const dir = makeTempDir();
		const target = join(dir, "eperm-persistent.png");
		const removed: string[] = [];
		let killed = false;
		const result = await verifyReport({
			url: "https://reports.example/r/eperm-persistent/",
			screenshotPath: target,
			chromeBin: process.execPath,
			shotTimeoutMs: 1_000,
			fetchImpl: async () => response("<h1>OK</h1>"),
			screenshotDeps: {
				spawnImpl: (() =>
					Object.assign(new EventEmitter(), {
						pid: 45681,
						unref() {},
					})) as never,
				killProcess: ((_: number, signal: NodeJS.Signals | 0) => {
					if (signal === 0 && killed) {
						const error = new Error("not permitted") as NodeJS.ErrnoException;
						error.code = "EPERM";
						throw error;
					}
					if (signal === "SIGKILL") killed = true;
					return true;
				}) as typeof process.kill,
				sleep: async () => {},
				removePath: ((path: string, options) => {
					removed.push(path);
					rmSync(path, options);
				}) as typeof rmSync,
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.envelope.error).toContain("survived SIGKILL");
		expect(existsSync(target)).toBe(false);
		expect(removed.some((path) => path.includes("fly1828-shot-"))).toBe(true);
	});

	it("cleans temporary resources when signalling the process group returns EPERM", async () => {
		const dir = makeTempDir();
		const removed: string[] = [];
		const result = await verifyReport({
			url: "https://reports.example/r/eperm-signal/",
			screenshotPath: join(dir, "eperm-signal.png"),
			chromeBin: process.execPath,
			shotTimeoutMs: 1_000,
			fetchImpl: async () => response("<h1>OK</h1>"),
			screenshotDeps: {
				spawnImpl: (() =>
					Object.assign(new EventEmitter(), {
						pid: 45682,
						unref() {},
					})) as never,
				killProcess: ((_: number, signal: NodeJS.Signals | 0) => {
					if (signal === "SIGTERM") {
						const error = new Error("not permitted") as NodeJS.ErrnoException;
						error.code = "EPERM";
						throw error;
					}
					return true;
				}) as typeof process.kill,
				sleep: async () => {},
				removePath: ((path: string, options) => {
					removed.push(path);
					rmSync(path, options);
				}) as typeof rmSync,
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.envelope.error).toContain("process-group cleanup failed");
		expect(removed.some((path) => path.includes("fly1828-shot-"))).toBe(true);
	});

	it("cleans the group after a nonzero Chrome exit before returning failure", async () => {
		const dir = makeTempDir();
		const group = { alive: true, signals: [] as Array<NodeJS.Signals | 0> };
		const result = await verifyReport({
			url: "https://reports.example/r/nonzero/",
			screenshotPath: join(dir, "nonzero.png"),
			chromeBin: process.execPath,
			fetchImpl: async () => response("<h1>OK</h1>"),
			screenshotDeps: screenshotHarness({
				group,
				exit: { code: 23, signal: null },
			}),
		});
		expect(result.envelope.error).toContain("Chrome exited with 23");
		expect(group.signals).toContain("SIGTERM");
	});

	it("fails loud and cleans temporary artifacts if the PGID survives SIGKILL", async () => {
		const dir = makeTempDir();
		const removed: string[] = [];
		const result = await verifyReport({
			url: "https://reports.example/r/survivor/",
			screenshotPath: join(dir, "survivor.png"),
			chromeBin: process.execPath,
			fetchImpl: async () => response("<h1>OK</h1>"),
			screenshotDeps: {
				spawnImpl: (() => {
					const child = Object.assign(new EventEmitter(), {
						pid: 56789,
						unref() {},
					});
					queueMicrotask(() => child.emit("exit", 0, null));
					return child;
				}) as never,
				killProcess: (() => true) as typeof process.kill,
				sleep: async () => {},
				removePath: ((path: string) => {
					removed.push(path);
				}) as typeof rmSync,
			},
		});
		expect(result.envelope.error).toContain("survived SIGKILL");
		expect(removed.some((path) => path.includes("fly1828-shot-"))).toBe(true);
	});
});

function writeChromeFixture(source: string): { bin: string; pidFile: string } {
	const dir = makeTempDir();
	const bin = join(dir, "fake-chrome");
	const pidFile = join(dir, "pgid");
	writeFileSync(
		bin,
		`#!/usr/bin/env node\nconst pidFile = ${JSON.stringify(pidFile)};\n${source}\n`,
	);
	chmodSync(bin, 0o755);
	return { bin, pidFile };
}

function expectProcessGroupGone(pidFile: string): void {
	const pgid = Number(readFileSync(pidFile, "utf8"));
	expect(Number.isInteger(pgid)).toBe(true);
	expect(() => process.kill(-pgid, 0)).toThrow(
		expect.objectContaining({ code: "ESRCH" }),
	);
}

describe("verifyReport — real process-group teardown", () => {
	it("kills a TERM-immune parent on hard timeout", async () => {
		const fixture = writeChromeFixture(`
const fs = require("node:fs");
fs.writeFileSync(pidFile, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
		const result = await verifyReport({
			url: "https://reports.example/r/hang/",
			screenshotPath: join(dirname(fixture.bin), "hang.png"),
			chromeBin: fixture.bin,
			shotTimeoutMs: 1_000,
			fetchImpl: async () => response("<h1>OK</h1>"),
			screenshotDeps: {
				sleep: (ms) =>
					new Promise((resolveSleep) =>
						setTimeout(resolveSleep, Math.min(ms, 20)),
					),
			},
		});
		expect(result.exitCode).toBe(1);
		expect(result.envelope.error).toContain("screenshot timeout");
		expectProcessGroupGone(fixture.pidFile);
	});

	it("kills a TERM-immune grandchild after the direct child exits", async () => {
		const fixture = writeChromeFixture(`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
fs.writeFileSync(pidFile, String(process.pid));
spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" }).unref();
`);
		const result = await verifyReport({
			url: "https://reports.example/r/grandchild/",
			screenshotPath: join(dirname(fixture.bin), "missing.png"),
			chromeBin: fixture.bin,
			fetchImpl: async () => response("<h1>OK</h1>"),
			screenshotDeps: {
				sleep: (ms) =>
					new Promise((resolveSleep) =>
						setTimeout(resolveSleep, Math.min(ms, 20)),
					),
			},
		});
		expect(result.exitCode).toBe(1);
		expectProcessGroupGone(fixture.pidFile);
	});

	it("keeps a valid PNG but warns when a grandchild required escalation", async () => {
		const dir = makeTempDir();
		const target = join(dir, "valid.png");
		const fixture = writeChromeFixture(`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
fs.writeFileSync(pidFile, String(process.pid));
const shot = process.argv.find((arg) => arg.startsWith("--screenshot=")).slice(13);
fs.writeFileSync(shot, Buffer.from("89504e470d0a1a0a0000000d494844520000000c000000220000000049454e44ae426082", "hex"));
spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" }).unref();
`);
		const result = await verifyReport({
			url: "https://reports.example/r/grandchild-valid/",
			screenshotPath: target,
			chromeBin: fixture.bin,
			fetchImpl: async () => response("<h1>OK</h1>"),
			screenshotDeps: {
				sleep: (ms) =>
					new Promise((resolveSleep) =>
						setTimeout(resolveSleep, Math.min(ms, 20)),
					),
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.envelope.warnings.join(" ")).toContain("outlived main");
		expectProcessGroupGone(fixture.pidFile);
	});
});

// The sandbox aborts the system Chrome binary before product code can exercise
// it. The real detached-process fixtures above still run everywhere.
describe.skipIf(
	Boolean(process.env.CODEX_SANDBOX) || !existsSync(DEFAULT_CHROME_BIN),
)("verifyReport — real Chrome integration", () => {
	it("fetches and screenshots a loopback hosted report", async () => {
		const server = createServer((_request, reply) => {
			reply.writeHead(200, { "content-type": "text/html" });
			reply.end("<!doctype html><h1>Loopback report</h1>");
		});
		await new Promise<void>((resolveListen) =>
			server.listen(0, "127.0.0.1", resolveListen),
		);
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("no port");
			const dir = makeTempDir();
			const result = await verifyReport({
				url: `http://127.0.0.1:${address.port}/report.html`,
				expect: "Loopback report",
				screenshotPath: join(dir, "chrome.png"),
				shotTimeoutMs: 30_000,
			});
			expect(result.exitCode, result.envelope.error).toBe(0);
			expect(result.envelope.screenshot?.width).toBeGreaterThan(0);
		} finally {
			await new Promise<void>((resolveClose, rejectClose) =>
				server.close((error) => (error ? rejectClose(error) : resolveClose())),
			);
		}
	}, 60_000);
});

const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(testDir, "../../dist/index.js");

function runCli(args: string[]): {
	stdout: string;
	stderr: string;
	code: number;
} {
	try {
		const stdout = execFileSync("node", [cliPath, ...args], {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { stdout: stdout.trim(), stderr: "", code: 0 };
	} catch (error) {
		const failed = error as {
			stdout?: string;
			stderr?: string;
			status?: number;
		};
		return {
			stdout: (failed.stdout ?? "").toString().trim(),
			stderr: (failed.stderr ?? "").toString().trim(),
			code: failed.status ?? 1,
		};
	}
}

describe("verify-report CLI wrapper (built dist)", () => {
	it.each([
		[["verify-report"], "--url"],
		[["verify-report", "--bogus", "x"], "invalid arguments"],
		[["verify-report", "--url", "file:///tmp/report.html"], "http(s)"],
		[
			["verify-report", "--url", "https://x", "--timeout-ms", "-1"],
			"timeout-ms",
		],
		[
			["verify-report", "--url", "https://x", "--timeout-ms", "NaN"],
			"timeout-ms",
		],
		[
			["verify-report", "--url", "https://x", "--timeout-ms", "300001"],
			"timeout-ms",
		],
		[
			["verify-report", "--url", "https://x", "--shot-timeout-ms", "-1"],
			"shot-timeout-ms",
		],
		[
			["verify-report", "--url", "https://x", "--shot-timeout-ms", "NaN"],
			"shot-timeout-ms",
		],
		[
			["verify-report", "--url", "https://x", "--shot-timeout-ms", "300001"],
			"shot-timeout-ms",
		],
		[
			["verify-report", "--url", "https://x", "--shot-window", "huge"],
			"shot-window",
		],
		[
			["verify-report", "--url", "https://x", "--shot-window", "100x100"],
			"shot-window",
		],
		[
			["verify-report", "--url", "https://x", "--screenshot", "relative.png"],
			"absolute",
		],
		[
			[
				"verify-report",
				"--url",
				"https://x",
				"--screenshot",
				"/tmp/x.png",
				"--chrome-bin",
				"relative-chrome",
			],
			"absolute",
		],
		[
			[
				"verify-report",
				"--url",
				"https://x",
				"--screenshot",
				"/tmp/x.png",
				"--chrome-bin",
				"/definitely/missing/chrome",
			],
			"chrome",
		],
	])("returns one JSON failure envelope for %j", (args, error) => {
		const result = runCli(args as string[]);
		expect(result.code).toBe(1);
		expect(result.stdout.split("\n")).toHaveLength(1);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.ok).toBe(false);
		expect(envelope.error).toContain(error);
	});
});
