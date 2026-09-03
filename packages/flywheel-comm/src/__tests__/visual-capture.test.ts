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
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	const providedRunProofShot = overrides.runProofShot;
	const result: VisualCaptureArgs = {
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
		runAgentBrowser: (args) => {
			if (args.join(" ") === "session list --json") {
				return JSON.stringify({
					success: true,
					data: { sessions: ["default"] },
				});
			}
			if (args.join(" ") === "tab list --json") {
				return JSON.stringify({ success: true, data: { tabs: [] } });
			}
			return undefined;
		},
		findPort: () => 3000, // always returns free
		runNotify: () => {},
		...overrides,
		// expose calls for the test
		...({ _proofShotCalls: proofShotCalls } as Partial<VisualCaptureArgs>),
	};
	result.runProofShot = (args, opts) => {
		if (args[0] === "start") {
			const statePath = join(
				result.output,
				"proofshot-artifacts",
				".session.json",
			);
			if (!existsSync(statePath)) {
				seedSessionState(result.output, "test-current-session");
			}
		}
		if (providedRunProofShot) providedRunProofShot(args, opts);
		else proofShotCalls.push(args);
	};
	return result;
}

/** Helper: seed a fixture output dir with simulated ProofShot artifacts. */
function seedFixture(
	dir: string,
	entries: Array<{ name: string; bytes: number }>,
): void {
	const statePath = join(dir, "proofshot-artifacts", ".session.json");
	const sessionDir = existsSync(statePath)
		? (JSON.parse(readFileSync(statePath, "utf8")) as { sessionDir: string })
				.sessionDir
		: seedSessionState(dir, "test-current-session");
	mkdirSync(sessionDir, { recursive: true });
	for (const e of entries) {
		writeFileSync(join(sessionDir, e.name), Buffer.alloc(e.bytes, "x"));
	}
}

function seedSessionState(outputDir: string, sessionName: string): string {
	const sessionRoot = join(outputDir, "proofshot-artifacts");
	const sessionDir = join(sessionRoot, sessionName);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionRoot, ".session.json"),
		JSON.stringify({ outputDir: sessionRoot, sessionDir }),
	);
	return sessionDir;
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
					seedFixture(output, [
						{ name: "SUMMARY.md", bytes: 100 },
						{ name: "step-ui.png", bytes: 5000 },
					]);
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

		it("stops the owned recording after start succeeds and screenshot fails", async () => {
			const output = join(tmpRoot, "session-shot-fails");
			const proofShotCalls: string[][] = [];
			const browserCalls: string[][] = [];
			const args = baseArgs({
				output,
				runProofShot: (call) => {
					proofShotCalls.push(call);
					if (call[0] === "exec" && call[1] === "screenshot") {
						throw new Error("screenshot failed after start");
					}
				},
				runAgentBrowser: (call) => {
					browserCalls.push(call);
					if (call.join(" ") === "session list --json") {
						return JSON.stringify({ data: { sessions: ["default"] } });
					}
					if (call.join(" ") === "tab list --json") {
						return JSON.stringify({ data: { tabs: [] } });
					}
					return undefined;
				},
			});

			await expect(visualCapture(args)).rejects.toThrow(
				"screenshot failed after start",
			);
			expect(browserCalls).toContainEqual(["record", "stop"]);
			expect(proofShotCalls.some((call) => call[0] === "stop")).toBe(false);
			// The visual lock must still be released after the cleanup attempt.
			const lock = acquireProofShotLock();
			lock.release();
		});

		it("warns when recording cleanup fails without masking the screenshot error", async () => {
			const output = join(tmpRoot, "session-shot-and-stop-fail");
			const browserCalls: string[][] = [];
			const warnings: string[] = [];
			const overrides: Partial<VisualCaptureArgs> & {
				warn: (message: string) => void;
			} = {
				output,
				runProofShot: (call) => {
					if (call[0] === "exec" && call[1] === "screenshot") {
						throw new Error("primary screenshot failure");
					}
				},
				runAgentBrowser: (call) => {
					browserCalls.push(call);
					if (call.join(" ") === "session list --json") {
						return JSON.stringify({ data: { sessions: ["default"] } });
					}
					if (call.join(" ") === "tab list --json") {
						return JSON.stringify({ data: { tabs: [] } });
					}
					if (call.join(" ") === "record stop") {
						throw new Error("cleanup stop failure");
					}
					return undefined;
				},
				warn: (message) => warnings.push(message),
			};

			await expect(visualCapture(baseArgs(overrides))).rejects.toThrow(
				"primary screenshot failure",
			);
			expect(
				browserCalls.filter((call) => call.join(" ") === "record stop"),
			).toHaveLength(2);
			expect(warnings).toHaveLength(2);
			expect(
				warnings.every((warning) => warning.includes("cleanup stop failure")),
			).toBe(true);
		});

		it("uses stderr as the default cleanup warning sink", async () => {
			const output = join(tmpRoot, "session-default-warning");
			const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
			const args = baseArgs({
				output,
				runProofShot: (call) => {
					if (call[0] === "exec" && call[1] === "screenshot") {
						throw new Error("primary failure for default warning");
					}
				},
				runAgentBrowser: (call) => {
					if (call.join(" ") === "session list --json") {
						return JSON.stringify({ data: { sessions: ["default"] } });
					}
					if (call.join(" ") === "tab list --json") {
						return JSON.stringify({ data: { tabs: [] } });
					}
					if (call.join(" ") === "record stop") {
						throw new Error("default cleanup stop failure");
					}
					return undefined;
				},
			});

			await expect(visualCapture(args)).rejects.toThrow(
				"primary failure for default warning",
			);
			expect(stderr).toHaveBeenCalledTimes(2);
			expect(String(stderr.mock.calls[0]?.[0])).toContain(
				"default cleanup stop failure",
			);
			stderr.mockRestore();
		});

		it("retries record stop once and degrades on the normal success path", async () => {
			const output = join(tmpRoot, "session-normal-stop-fails");
			const browserCalls: string[][] = [];
			const warnings: string[] = [];
			const args = baseArgs({
				output,
				runProofShot: () => {
					seedFixture(output, [{ name: "step-ui.png", bytes: 5000 }]);
				},
				runAgentBrowser: (call) => {
					browserCalls.push(call);
					if (call.join(" ") === "session list --json") {
						return JSON.stringify({ data: { sessions: ["default"] } });
					}
					if (call.join(" ") === "tab list --json") {
						return JSON.stringify({ data: { tabs: [] } });
					}
					if (call.join(" ") === "record stop") {
						throw new Error("normal stop failure");
					}
					return undefined;
				},
				warn: (message) => warnings.push(message),
			});

			await expect(visualCapture(args)).resolves.toMatchObject({
				captureKind: "ui",
			});
			expect(
				browserCalls.filter((call) => call.join(" ") === "record stop"),
			).toHaveLength(2);
			expect(warnings).toHaveLength(2);
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
					if (a[0] === "exec" && a[1] === "screenshot") {
						seedFixture(output, [
							{ name: "SUMMARY.md", bytes: 100 },
							{ name: "step-ui.png", bytes: 5000 },
						]);
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
					seedFixture(output, [
						{ name: "SUMMARY.md", bytes: 100 },
						{ name: "step-ui.png", bytes: 5000 },
					]);
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

	describe("FLY-2269 — browser ownership cleanup", () => {
		type AgentBrowserCall = {
			args: string[];
			opts?: { cwd?: string; env?: NodeJS.ProcessEnv };
		};
		type RunAgentBrowser = (
			args: string[],
			opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
		) => unknown;

		function withAgentBrowser(
			args: VisualCaptureArgs,
			runAgentBrowser: RunAgentBrowser,
		): VisualCaptureArgs {
			return Object.assign(args, { runAgentBrowser }) as VisualCaptureArgs;
		}

		function sessions(...names: string[]): string {
			return JSON.stringify({ success: true, data: { sessions: names } });
		}

		function tabs(...ids: string[]): string {
			return JSON.stringify({
				success: true,
				data: {
					tabs: ids.map((tabId) => ({
						tabId,
						url: `https://example.test/${tabId}`,
					})),
				},
			});
		}

		it("present/shared captures successfully, preserves the foreign baseline tab, and closes only the new tab", async () => {
			const output = join(tmpRoot, "present-shared");
			const agentCalls: AgentBrowserCall[] = [];
			let tabListCount = 0;
			const runAgentBrowser: RunAgentBrowser = (args, opts) => {
				agentCalls.push({ args, opts });
				if (args.join(" ") === "session list --json") {
					return sessions("default");
				}
				if (args.join(" ") === "tab list --json") {
					tabListCount += 1;
					return tabListCount === 1 ? tabs("t9") : tabs("t9", "t10");
				}
				return undefined;
			};
			const args = withAgentBrowser(
				baseArgs({
					output,
					runProofShot: () => {
						seedFixture(output, [{ name: "step-ui.png", bytes: 5000 }]);
					},
				}),
				runAgentBrowser,
			);

			await visualCapture(args);

			expect(agentCalls.map((call) => call.args)).toContainEqual([
				"tab",
				"close",
				"t10",
			]);
			expect(agentCalls.map((call) => call.args)).not.toContainEqual([
				"tab",
				"close",
				"t9",
			]);
			expect(agentCalls.map((call) => call.args)).not.toContainEqual(["close"]);
		});

		it("takes the initial membership snapshot before preparation and the second immediately before start", async () => {
			const output = join(tmpRoot, "membership-window");
			const events: string[] = [];
			const args = baseArgs({
				output,
				findPort: () => {
					events.push("find-port");
					return 3000;
				},
				runProofShot: (command) => {
					events.push(`proofshot-${command[0]}`);
					if (command[0] === "exec") {
						seedFixture(output, [{ name: "step-ui.png", bytes: 5000 }]);
					}
				},
				runAgentBrowser: (command) => {
					const joined = command.join(" ");
					events.push(joined);
					if (joined === "session list --json") return sessions("default");
					if (joined === "tab list --json") return tabs();
					return undefined;
				},
			});

			await visualCapture(args);

			const sessionIndexes = events.flatMap((event, index) =>
				event === "session list --json" ? [index] : [],
			);
			expect(sessionIndexes[0]).toBeLessThan(events.indexOf("find-port"));
			expect(sessionIndexes[1]).toBeGreaterThan(events.indexOf("find-port"));
			expect(sessionIndexes[1]).toBeLessThan(events.indexOf("proofshot-start"));
		});

		it("absent/owned bootstraps without a pre tab-list and closes the whole session", async () => {
			const output = join(tmpRoot, "absent-owned");
			const agentCalls: AgentBrowserCall[] = [];
			let sessionListCount = 0;
			const runAgentBrowser: RunAgentBrowser = (args, opts) => {
				agentCalls.push({ args, opts });
				if (args.join(" ") === "session list --json") {
					sessionListCount += 1;
					return sessionListCount < 3 ? sessions() : sessions("default");
				}
				if (args.join(" ") === "tab list --json") return tabs("t1", "t2");
				return undefined;
			};
			const args = withAgentBrowser(
				baseArgs({
					output,
					runProofShot: () => {
						seedFixture(output, [{ name: "step-ui.png", bytes: 5000 }]);
					},
				}),
				runAgentBrowser,
			);

			await visualCapture(args);

			const commands = agentCalls.map((call) => call.args.join(" "));
			expect(commands.indexOf("tab list --json")).toBeGreaterThan(
				commands.lastIndexOf("session list --json"),
			);
			expect(commands).toContain("record stop");
			expect(commands).toContain("close");
			expect(commands).not.toContain("tab close t1");
		});

		it("probe failure remains degradable: capture succeeds and performs no tab or browser close", async () => {
			const output = join(tmpRoot, "probe-unknown");
			const agentCalls: AgentBrowserCall[] = [];
			const warnings: string[] = [];
			const runAgentBrowser: RunAgentBrowser = (args, opts) => {
				agentCalls.push({ args, opts });
				if (args.join(" ") === "session list --json") {
					throw new Error("membership probe timed out");
				}
				throw new Error(`unexpected guarded command: ${args.join(" ")}`);
			};
			const args = withAgentBrowser(
				baseArgs({
					output,
					warn: (message) => warnings.push(message),
					runProofShot: () => {
						seedFixture(output, [{ name: "step-ui.png", bytes: 5000 }]);
					},
				}),
				runAgentBrowser,
			);

			await expect(visualCapture(args)).resolves.toMatchObject({
				captureKind: "ui",
			});
			expect(warnings.some((message) => message.includes("timed out"))).toBe(
				true,
			);
			expect(
				agentCalls.some(
					(call) =>
						call.args[0] === "tab" ||
						call.args[0] === "close" ||
						(call.args[0] === "record" && call.args[1] === "stop"),
				),
			).toBe(false);
		});

		it("never treats malformed session members as an absent session with close authority", async () => {
			const output = join(tmpRoot, "malformed-session-list");
			const agentCalls: AgentBrowserCall[] = [];
			let membershipProbe = 0;
			const args = baseArgs({
				output,
				runProofShot: (command) => {
					if (command[0] === "exec") {
						seedFixture(output, [{ name: "step-ui.png", bytes: 5000 }]);
					}
				},
				runAgentBrowser: (command, opts) => {
					agentCalls.push({ args: command, opts });
					if (command.join(" ") === "session list --json") {
						membershipProbe += 1;
						return membershipProbe < 3
							? JSON.stringify({ data: { sessions: [42] } })
							: sessions("default");
					}
					return undefined;
				},
			});

			await visualCapture(args);

			const commands = agentCalls.map((call) => call.args.join(" "));
			expect(commands).toContain("record stop");
			expect(commands).not.toContain("tab list --json");
			expect(commands).not.toContain("close");
		});

		it("a malformed shared tab baseline grants no tab-close authority", async () => {
			const output = join(tmpRoot, "malformed-tab-baseline");
			const agentCalls: AgentBrowserCall[] = [];
			let tabProbe = 0;
			const args = baseArgs({
				output,
				runProofShot: (command) => {
					if (command[0] === "exec") {
						seedFixture(output, [{ name: "step-ui.png", bytes: 5000 }]);
					}
				},
				runAgentBrowser: (command, opts) => {
					agentCalls.push({ args: command, opts });
					if (command.join(" ") === "session list --json") {
						return sessions("default");
					}
					if (command.join(" ") === "tab list --json") {
						tabProbe += 1;
						return tabProbe === 1
							? JSON.stringify({ data: { tabs: [{ url: "https://foreign" }] } })
							: tabs("t10");
					}
					return undefined;
				},
			});

			await visualCapture(args);

			expect(agentCalls.map((call) => call.args)).not.toContainEqual([
				"tab",
				"close",
				"t10",
			]);
			expect(agentCalls.map((call) => call.args)).not.toContainEqual(["close"]);
		});

		it("deduplicates stable post-minus-pre tab ids before closing", async () => {
			const output = join(tmpRoot, "duplicate-post-tabs");
			const agentCalls: AgentBrowserCall[] = [];
			let tabProbe = 0;
			const args = baseArgs({
				output,
				runProofShot: (command) => {
					if (command[0] === "exec") {
						seedFixture(output, [{ name: "step-ui.png", bytes: 5000 }]);
					}
				},
				runAgentBrowser: (command, opts) => {
					agentCalls.push({ args: command, opts });
					if (command.join(" ") === "session list --json") {
						return sessions("default");
					}
					if (command.join(" ") === "tab list --json") {
						tabProbe += 1;
						return tabProbe === 1
							? tabs("t9")
							: JSON.stringify({
									data: {
										tabs: [{ tabId: "t9" }, { tabId: "t10" }, { tabId: "t10" }],
									},
								});
					}
					return undefined;
				},
			});

			await visualCapture(args);

			expect(
				agentCalls.filter((call) => call.args.join(" ") === "tab close t10"),
			).toHaveLength(1);
		});

		it("start failure after an absent session opens tabs closes the owned tree without stopping a recording", async () => {
			const output = join(tmpRoot, "owned-start-failure");
			const agentCalls: AgentBrowserCall[] = [];
			let membershipProbe = 0;
			const args = baseArgs({
				output,
				runAgentBrowser: (command, opts) => {
					agentCalls.push({ args: command, opts });
					if (command.join(" ") === "session list --json") {
						membershipProbe += 1;
						return membershipProbe < 3 ? sessions() : sessions("default");
					}
					if (command.join(" ") === "tab list --json") {
						return tabs("t1", "t2");
					}
					return undefined;
				},
			});
			args.runProofShot = () => {
				throw new Error("Recording already active");
			};

			await expect(visualCapture(args)).rejects.toThrow(
				"Recording already active",
			);
			const commands = agentCalls.map((call) => call.args.join(" "));
			expect(commands).toContain("tab list --json");
			expect(commands).toContain("close");
			expect(commands).not.toContain("record stop");
			expect(commands.some((command) => command.startsWith("tab close"))).toBe(
				false,
			);
		});

		it("start failure before an absent session appears performs no tab, record, or close command", async () => {
			const output = join(tmpRoot, "absent-start-failure");
			const agentCalls: AgentBrowserCall[] = [];
			const args = baseArgs({
				output,
				runAgentBrowser: (command, opts) => {
					agentCalls.push({ args: command, opts });
					if (command.join(" ") === "session list --json") return sessions();
					throw new Error(`unexpected guarded command: ${command.join(" ")}`);
				},
			});
			args.runProofShot = () => {
				throw new Error("start failed before browser open");
			};

			await expect(visualCapture(args)).rejects.toThrow(
				"start failed before browser open",
			);
			expect(
				agentCalls.some(
					(call) =>
						call.args[0] === "tab" ||
						call.args[0] === "record" ||
						call.args[0] === "close",
				),
			).toBe(false);
		});

		it("shared start failure closes only the guarded post-minus-pre tab", async () => {
			const output = join(tmpRoot, "shared-start-failure");
			const agentCalls: AgentBrowserCall[] = [];
			let tabProbe = 0;
			const args = baseArgs({
				output,
				runAgentBrowser: (command, opts) => {
					agentCalls.push({ args: command, opts });
					if (command.join(" ") === "session list --json") {
						return sessions("default");
					}
					if (command.join(" ") === "tab list --json") {
						tabProbe += 1;
						return tabProbe === 1 ? tabs("t9") : tabs("t9", "t10");
					}
					return undefined;
				},
			});
			args.runProofShot = () => {
				throw new Error("shared start failed");
			};

			await expect(visualCapture(args)).rejects.toThrow("shared start failed");
			expect(agentCalls.map((call) => call.args)).toContainEqual([
				"tab",
				"close",
				"t10",
			]);
			expect(agentCalls.map((call) => call.args)).not.toContainEqual([
				"tab",
				"close",
				"t9",
			]);
			expect(agentCalls.map((call) => call.args)).not.toContainEqual(["close"]);
			expect(agentCalls.map((call) => call.args)).not.toContainEqual([
				"record",
				"stop",
			]);
		});

		it("a failed pre-start membership probe preserves tabs but still stops this successful recording", async () => {
			const output = join(tmpRoot, "unknown-with-recording");
			const agentCalls: AgentBrowserCall[] = [];
			let membershipProbe = 0;
			const warnings: string[] = [];
			const args = baseArgs({
				output,
				warn: (message) => warnings.push(message),
				runProofShot: (command) => {
					if (command[0] === "exec") {
						seedFixture(output, [{ name: "step-ui.png", bytes: 5000 }]);
					}
				},
				runAgentBrowser: (command, opts) => {
					agentCalls.push({ args: command, opts });
					if (command.join(" ") === "session list --json") {
						membershipProbe += 1;
						if (membershipProbe === 1) throw new Error("preflight timeout");
						return sessions("default");
					}
					throw new Error(`unexpected guarded command: ${command.join(" ")}`);
				},
			});

			await visualCapture(args);

			const commands = agentCalls.map((call) => call.args.join(" "));
			expect(commands).toContain("record stop");
			expect(commands).not.toContain("tab list --json");
			expect(commands).not.toContain("close");
			expect(
				warnings.some((warning) => warning.includes("preflight timeout")),
			).toBe(true);
		});

		it("post membership failure skips post tab-list, recording stop, and every close", async () => {
			const output = join(tmpRoot, "post-membership-failure");
			const agentCalls: AgentBrowserCall[] = [];
			let membershipProbe = 0;
			const args = baseArgs({
				output,
				runProofShot: (command) => {
					if (command[0] === "exec") {
						seedFixture(output, [{ name: "step-ui.png", bytes: 5000 }]);
					}
				},
				runAgentBrowser: (command, opts) => {
					agentCalls.push({ args: command, opts });
					if (command.join(" ") === "session list --json") {
						membershipProbe += 1;
						if (membershipProbe === 3) throw new Error("post timeout");
						return sessions();
					}
					throw new Error(`unexpected guarded command: ${command.join(" ")}`);
				},
			});

			await visualCapture(args);

			expect(
				agentCalls.some(
					(call) =>
						call.args[0] === "tab" ||
						call.args[0] === "record" ||
						call.args[0] === "close",
				),
			).toBe(false);
		});

		it("owned whole-close failure falls back to every stable captured tab", async () => {
			const output = join(tmpRoot, "owned-close-fallback");
			const agentCalls: AgentBrowserCall[] = [];
			let membershipProbe = 0;
			const args = baseArgs({
				output,
				runProofShot: (command) => {
					if (command[0] === "exec") {
						seedFixture(output, [{ name: "step-ui.png", bytes: 5000 }]);
					}
				},
				runAgentBrowser: (command, opts) => {
					agentCalls.push({ args: command, opts });
					if (command.join(" ") === "session list --json") {
						membershipProbe += 1;
						return membershipProbe < 3 ? sessions() : sessions("default");
					}
					if (command.join(" ") === "tab list --json") {
						return tabs("t1", "unsafe", "t2");
					}
					if (command.join(" ") === "close") throw new Error("close failed");
					if (command.join(" ") === "tab close t1") {
						throw new Error("t1 close failed");
					}
					return undefined;
				},
			});

			await visualCapture(args);

			const commands = agentCalls.map((call) => call.args.join(" "));
			expect(commands).toContain("close");
			expect(commands).toContain("tab close t1");
			expect(commands).toContain("tab close t2");
			expect(commands).not.toContain("tab close unsafe");
		});

		it("freezes the shared tab difference immediately after start", async () => {
			const output = join(tmpRoot, "frozen-tab-difference");
			const agentCalls: AgentBrowserCall[] = [];
			let tabProbe = 0;
			const args = baseArgs({
				output,
				runProofShot: (command) => {
					if (command[0] === "exec") {
						seedFixture(output, [{ name: "step-ui.png", bytes: 5000 }]);
					}
				},
				runAgentBrowser: (command, opts) => {
					agentCalls.push({ args: command, opts });
					if (command.join(" ") === "session list --json") {
						return sessions("default");
					}
					if (command.join(" ") === "tab list --json") {
						tabProbe += 1;
						if (tabProbe === 1) return tabs("t9");
						if (tabProbe === 2) return tabs("t9", "t10");
						return tabs("t9", "t10", "t11");
					}
					return undefined;
				},
			});

			await visualCapture(args);

			expect(tabProbe).toBe(2);
			expect(agentCalls.map((call) => call.args)).toContainEqual([
				"tab",
				"close",
				"t10",
			]);
			expect(agentCalls.map((call) => call.args)).not.toContainEqual([
				"tab",
				"close",
				"t11",
			]);
		});

		it("invalid shared post-tab JSON stops recording but closes no page or browser", async () => {
			const output = join(tmpRoot, "post-tab-invalid");
			const agentCalls: AgentBrowserCall[] = [];
			let tabProbe = 0;
			const args = baseArgs({
				output,
				runProofShot: (command) => {
					if (command[0] === "exec") {
						seedFixture(output, [{ name: "step-ui.png", bytes: 5000 }]);
					}
				},
				runAgentBrowser: (command, opts) => {
					agentCalls.push({ args: command, opts });
					if (command.join(" ") === "session list --json") {
						return sessions("default");
					}
					if (command.join(" ") === "tab list --json") {
						tabProbe += 1;
						return tabProbe === 1 ? tabs("t9") : "{}";
					}
					return undefined;
				},
			});

			await visualCapture(args);

			const commands = agentCalls.map((call) => call.args.join(" "));
			expect(commands).toContain("record stop");
			expect(commands).not.toContain("close");
			expect(commands.some((command) => command.startsWith("tab close"))).toBe(
				false,
			);
		});
	});

	describe("FLY-2269 — current ProofShot session artifacts", () => {
		it("keeps start in project cwd, runs exec from output, and selects a nested current-session PNG", async () => {
			const output = join(tmpRoot, "real-session-shape");
			const sessionRoot = join(output, "proofshot-artifacts");
			const calls: Array<{
				args: string[];
				opts?: { cwd?: string; env?: NodeJS.ProcessEnv };
			}> = [];
			let execConfig: unknown;
			const env = {
				PATH: process.env.PATH,
				AGENT_BROWSER_SESSION: "default",
			} as NodeJS.ProcessEnv;
			const args = baseArgs({
				output,
				env,
				runProofShot: (command, opts) => {
					calls.push({ args: command, opts });
					if (command[0] === "start") {
						seedSessionState(output, "2026-09-03_current");
					}
					if (command[0] === "exec") {
						execConfig = JSON.parse(
							readFileSync(join(output, "proofshot.config.json"), "utf8"),
						);
						const nested = join(sessionRoot, "2026-09-03_current", "nested");
						mkdirSync(nested, { recursive: true });
						writeFileSync(join(nested, "step-ui.png"), Buffer.alloc(5000));
					}
				},
			});

			const result = await visualCapture(args);
			const start = calls.find((call) => call.args[0] === "start")!;
			const exec = calls.find((call) => call.args[0] === "exec")!;
			const outputIndex = start.args.indexOf("--output");

			expect(start.opts?.cwd).toBe(process.cwd());
			expect(start.opts?.env).toEqual(env);
			expect(start.args[outputIndex + 1]).toBe(sessionRoot);
			expect(exec.opts?.cwd).toBe(output);
			expect(exec.opts?.env).toEqual(env);
			expect(execConfig).toEqual({ output: "./proofshot-artifacts" });
			expect(result.selection.selected.map((file) => file.path)).toContain(
				join(sessionRoot, "2026-09-03_current", "nested", "step-ui.png"),
			);
			expect(existsSync(join(sessionRoot, ".session.json"))).toBe(false);
			expect(existsSync(join(output, "proofshot.config.json"))).toBe(false);
		});

		it("discovers only the state-selected new session on a reused output directory", async () => {
			const output = join(tmpRoot, "reused-output");
			const oldSession = seedSessionState(output, "2026-09-02_old");
			rmSync(join(output, "proofshot-artifacts", ".session.json"));
			writeFileSync(join(oldSession, "old.png"), Buffer.alloc(5000));
			const newSession = join(output, "proofshot-artifacts", "2026-09-03_new");
			const args = baseArgs({
				output,
				runProofShot: (command) => {
					if (command[0] === "start") {
						seedSessionState(output, "2026-09-03_new");
					}
					if (command[0] === "exec") {
						writeFileSync(join(newSession, "new.png"), Buffer.alloc(5000));
					}
				},
			});

			const result = await visualCapture(args);

			expect(result.selection.selected.map((file) => file.path)).toEqual([
				join(newSession, "new.png"),
			]);
			expect(
				result.selection.selected.some((file) => file.path.includes("old.png")),
			).toBe(false);
		});

		it("rejects and preserves a pre-existing active session before any browser command", async () => {
			const output = join(tmpRoot, "stale-state");
			seedSessionState(output, "2026-09-02_stale");
			const statePath = join(output, "proofshot-artifacts", ".session.json");
			const originalState = readFileSync(statePath, "utf8");
			const proofShotCalls: string[][] = [];
			const browserCalls: string[][] = [];
			const args = baseArgs({
				output,
				runProofShot: (command) => proofShotCalls.push(command),
				runAgentBrowser: (command) => {
					browserCalls.push(command);
					return undefined;
				},
			});

			await expect(visualCapture(args)).rejects.toThrow(
				/pre-existing.*session/i,
			);
			expect(proofShotCalls).toEqual([]);
			expect(browserCalls).toEqual([]);
			expect(readFileSync(statePath, "utf8")).toBe(originalState);
		});

		it("fails loudly when the validated current session produces no PNG", async () => {
			const output = join(tmpRoot, "no-png");
			const args = baseArgs({
				output,
				runProofShot: (command) => {
					if (command[0] === "start") {
						const sessionDir = seedSessionState(output, "2026-09-03_no-png");
						writeFileSync(join(sessionDir, "session.webm"), "video");
					}
				},
			});

			await expect(visualCapture(args)).rejects.toThrow(/at least one PNG/i);
			expect(existsSync(join(output, "manifest.json"))).toBe(false);
		});

		it("preserves a compatible pre-existing output-local config", async () => {
			const output = join(tmpRoot, "compatible-config");
			mkdirSync(output, { recursive: true });
			const configPath = join(output, "proofshot.config.json");
			const originalConfig =
				'{"output":"./proofshot-artifacts","viewport":{"width":900}}\n';
			writeFileSync(configPath, originalConfig);
			const args = baseArgs({
				output,
				runProofShot: (command) => {
					if (command[0] === "exec") {
						seedFixture(output, [{ name: "step-ui.png", bytes: 5000 }]);
					}
				},
			});

			await visualCapture(args);

			expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
		});

		it("rejects an incompatible pre-existing config without overwriting it or probing the browser", async () => {
			const output = join(tmpRoot, "incompatible-config");
			mkdirSync(output, { recursive: true });
			const configPath = join(output, "proofshot.config.json");
			const originalConfig = '{"output":"../foreign-artifacts"}\n';
			writeFileSync(configPath, originalConfig);
			const proofShotCalls: string[][] = [];
			const browserCalls: string[][] = [];
			const args = baseArgs({
				output,
				runProofShot: (command) => proofShotCalls.push(command),
				runAgentBrowser: (command) => {
					browserCalls.push(command);
					return undefined;
				},
			});

			await expect(visualCapture(args)).rejects.toThrow(
				/existing ProofShot config must resolve output/,
			);
			expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
			expect(proofShotCalls).toEqual([]);
			expect(browserCalls).toEqual([]);
		});

		it.each([
			{
				name: "missing state",
				expected: /did not create readable current session state/,
				onStart: (_output: string) => {},
			},
			{
				name: "malformed state",
				expected: /did not create readable current session state/,
				onStart: (output: string) => {
					writeFileSync(
						join(output, "proofshot-artifacts", ".session.json"),
						"not-json",
					);
				},
			},
			{
				name: "out-of-root state",
				expected: /direct child of the session root/,
				onStart: (output: string) => {
					const outside = join(output, "outside-session");
					mkdirSync(outside, { recursive: true });
					writeFileSync(
						join(output, "proofshot-artifacts", ".session.json"),
						JSON.stringify({ sessionDir: outside }),
					);
				},
			},
			{
				name: "symlink session directory",
				expected: /real directory/,
				onStart: (output: string) => {
					const target = join(output, "real-session-target");
					const link = join(output, "proofshot-artifacts", "linked-session");
					mkdirSync(target, { recursive: true });
					symlinkSync(target, link);
					writeFileSync(
						join(output, "proofshot-artifacts", ".session.json"),
						JSON.stringify({ sessionDir: link }),
					);
				},
			},
		])(
			"rejects $name before exec while still stopping its successful recording",
			async ({ expected, onStart }) => {
				const output = join(tmpRoot, `invalid-state-${Math.random()}`);
				const proofShotCalls: string[][] = [];
				const browserCalls: string[][] = [];
				const args = baseArgs({
					output,
					runAgentBrowser: (command) => {
						browserCalls.push(command);
						if (command.join(" ") === "session list --json") {
							return JSON.stringify({ data: { sessions: ["default"] } });
						}
						if (command.join(" ") === "tab list --json") {
							return JSON.stringify({ data: { tabs: [] } });
						}
						return undefined;
					},
				});
				args.runProofShot = (command) => {
					proofShotCalls.push(command);
					if (command[0] === "start") onStart(output);
				};

				await expect(visualCapture(args)).rejects.toThrow(expected);
				expect(proofShotCalls.map((command) => command[0])).toEqual(["start"]);
				expect(browserCalls).toContainEqual(["record", "stop"]);
				expect(existsSync(join(output, "proofshot.config.json"))).toBe(false);
				expect(
					existsSync(join(output, "proofshot-artifacts", ".session.json")),
				).toBe(false);
			},
		);

		it("rejects state that points back to a session directory present before start", async () => {
			const output = join(tmpRoot, "old-session-state");
			const oldSession = join(output, "proofshot-artifacts", "2026-09-02_old");
			mkdirSync(oldSession, { recursive: true });
			const browserCalls: string[][] = [];
			const args = baseArgs({
				output,
				runAgentBrowser: (command) => {
					browserCalls.push(command);
					if (command.join(" ") === "session list --json") {
						return JSON.stringify({ data: { sessions: ["default"] } });
					}
					if (command.join(" ") === "tab list --json") {
						return JSON.stringify({ data: { tabs: [] } });
					}
					return undefined;
				},
			});
			args.runProofShot = (command) => {
				if (command[0] === "start") {
					writeFileSync(
						join(output, "proofshot-artifacts", ".session.json"),
						JSON.stringify({ sessionDir: oldSession }),
					);
				}
			};

			await expect(visualCapture(args)).rejects.toThrow(
				/existed before this capture/,
			);
			expect(browserCalls).toContainEqual(["record", "stop"]);
			expect(existsSync(oldSession)).toBe(true);
			expect(
				existsSync(join(output, "proofshot-artifacts", ".session.json")),
			).toBe(false);
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
					if (a[0] === "exec" && a[1] === "screenshot") {
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
					if (a[0] === "exec" && a[1] === "screenshot") {
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
					if (a[0] === "exec" && a[1] === "screenshot") {
						seedFixture(output, [
							{ name: "SUMMARY.md", bytes: 100 },
							{ name: "step-ui.png", bytes: 5000 },
						]);
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
					if (a[0] === "exec" && a[1] === "screenshot") {
						seedFixture(output, [
							{ name: "SUMMARY.md", bytes: 100 },
							{ name: "step-ui.png", bytes: 5000 },
						]);
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
					seedFixture(output, [
						{ name: "SUMMARY.md", bytes: 100 },
						{ name: "step-ui.png", bytes: 5000 },
					]);
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
					seedFixture(output, [
						{ name: "SUMMARY.md", bytes: 100 },
						{ name: "step-ui.png", bytes: 5000 },
					]);
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

	it("passes an explicit process env baseline when no overlay is set", async () => {
		const output = join(tmpRoot, "none");
		const seen: Array<{ args: string[]; opts?: { env?: NodeJS.ProcessEnv } }> =
			[];
		await visualCapture(recordingArgs(output, {}, seen));
		expect(seen.length).toBeGreaterThan(0);
		for (const call of seen) {
			expect(call.opts?.env?.PATH).toBe(process.env.PATH);
			expect(call.opts?.env?.AGENT_BROWSER_PROFILE).toBeUndefined();
			expect(call.opts?.env?.AGENT_BROWSER_STREAM_PORT).toBeUndefined();
		}
	});
});
