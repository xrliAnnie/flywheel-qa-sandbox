/**
 * FLY-259 PR-C — tui-window unit tests: command builder (pins + boundary
 * validation), ensure lifecycle (unconditional stale-kill, fail-open),
 * identity-echo liveness probe.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	beginTuiWindowVisibilityProof,
	buildTuiCommand,
	ensureTuiWindow,
	isTuiWindowAlive,
	killTuiWindow,
	readTuiWindowExitEvidenceAsync,
	readTuiWindowIdentity,
	TuiWindowRetryBackoff,
	type TuiWindowSpec,
} from "../tui-window.js";

const SPEC: TuiWindowSpec = {
	projectName: "growth",
	leadId: "mufasa-lead",
	codexHome: "/Users/x/.codex-mufasa-tui",
	threadId: "019eb-thread-id",
	cwd: "/Users/x/Dev/growth",
};

const HAS_TMUX = (() => {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

function withoutTmuxClientLocale(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.TMUX;
	delete env.LANG;
	delete env.LC_ALL;
	delete env.LC_CTYPE;
	return env;
}

/**
 * Real-tmux exit evidence budget: the child exits after one second, but a
 * loaded CI host may need several more seconds before tmux reports both
 * `pane_dead` and `pane_dead_status`. A fixed 30-sample loop (~3.4 s) failed on
 * CI with `qa-tui 1` (dead, status not yet ready) while passing locally.
 */
const EXIT_EVIDENCE_POLL_BUDGET_MS = 20_000;

function runIsolatedTmux(socket: string, args: string[]): string {
	return execFileSync("tmux", ["-S", socket, ...args], {
		encoding: "utf8",
		env: withoutTmuxClientLocale(),
	});
}

describe("buildTuiCommand", () => {
	it("lets the remote thread own permissions while carrying socket, cwd, and thread", () => {
		const cmd = buildTuiCommand(SPEC);
		expect(cmd).toContain('CODEX_HOME="/Users/x/.codex-mufasa-tui"');
		expect(cmd).toContain("codex resume");
		expect(cmd).toContain(
			'--remote "unix:///Users/x/.codex-mufasa-tui/app-server-control/app-server-control.sock"',
		);
		expect(cmd).toContain('-C "/Users/x/Dev/growth"'); // kills the cwd menu
		expect(cmd).not.toMatch(/(?:^|\s)-s\s/);
		expect(cmd).not.toContain("approval_policy");
		expect(cmd.trim().endsWith("019eb-thread-id")).toBe(true);
	});

	it("fullAccess remote resume also inherits permissions without CLI overrides", () => {
		const cmd = buildTuiCommand({ ...SPEC, fullAccess: true });
		expect(cmd).not.toMatch(/(?:^|\s)-s\s/);
		expect(cmd).not.toContain("approval_policy");
		expect(cmd).toContain("codex resume");
		expect(cmd.trim().endsWith("019eb-thread-id")).toBe(true);
	});

	it("fullAccess does not change the remote resume command", () => {
		expect(buildTuiCommand({ ...SPEC, fullAccess: false })).toBe(
			buildTuiCommand({ ...SPEC, fullAccess: true }),
		);
	});

	it("keeps the carrier capability out of the founder TUI shell command", () => {
		const cmd = buildTuiCommand({
			...SPEC,
			carrierInstanceId: "generation_capability",
		});
		expect(cmd).not.toContain("generation_capability");
		expect(cmd).not.toContain("FLYWHEEL_LEAD_CARRIER_INSTANCE_ID");
		expect(() =>
			buildTuiCommand({ ...SPEC, carrierInstanceId: 'bad";rm' }),
		).toThrow(/carrierInstanceId/);
	});

	it("boundary validation: shell-unsafe config values throw (fail-loud)", () => {
		expect(() =>
			buildTuiCommand({ ...SPEC, threadId: 'x"; rm -rf /; "' }),
		).toThrow(/threadId/);
		expect(() =>
			buildTuiCommand({ ...SPEC, codexHome: '/tmp/$(evil)"' }),
		).toThrow(/codexHome/);
		expect(() => buildTuiCommand({ ...SPEC, cwd: "/has space/dir" })).toThrow(
			/cwd/,
		);
	});
});

function makeEnsure(overrides: {
	tmuxAvailable?: boolean;
	newWindowOk?: boolean;
	execThrows?: boolean;
	spec?: TuiWindowSpec;
}) {
	const calls: string[][] = [];
	const result = ensureTuiWindow(overrides.spec ?? SPEC, {
		exec: (cmd, args) => {
			if (overrides.execThrows) throw new Error("spawn failed");
			calls.push([cmd, ...args]);
			if (args[0] === "-V") return { ok: overrides.tmuxAvailable ?? true };
			if (args[0] === "new-window")
				return { ok: overrides.newWindowOk ?? true };
			return { ok: true };
		},
		log: () => {},
	});
	return { result, calls };
}

describe("ensureTuiWindow", () => {
	it("reports creation as unverified and never claims the real TUI is healthy", () => {
		const logs: string[] = [];
		expect(
			ensureTuiWindow(SPEC, {
				exec: () => ({ ok: true }),
				log: (message) => logs.push(message),
			}),
		).toBe(true);
		expect(logs).toContain(
			"tui-window: window_created_unverified (growth-mufasa-lead, thread 019eb-thread-id)",
		);
		expect(logs.join("\n")).not.toContain("real TUI up");
	});

	it("creates the tmux server with only canonical coordinates, never inherited identity or secrets", () => {
		let birthEnv: NodeJS.ProcessEnv | undefined;
		ensureTuiWindow(SPEC, {
			exec: (_cmd, args, options) => {
				if (args[0] === "new-session") birthEnv = options?.env;
				return { ok: true };
			},
			log: () => {},
		});

		expect(birthEnv).toBeDefined();
		expect(Object.keys(birthEnv ?? {}).sort()).toEqual(
			Object.keys(birthEnv ?? {})
				.filter((name) =>
					[
						"HOME",
						"SHELL",
						"USER",
						"LOGNAME",
						"LANG",
						"TERM",
						"TMPDIR",
						"PATH",
					].includes(name),
				)
				.sort(),
		);
		expect(birthEnv?.PATH).toBe(
			`${birthEnv?.HOME}/.local/bin:${birthEnv?.HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
		);
		expect(birthEnv).not.toHaveProperty("CODEX_HOME");
		expect(birthEnv).not.toHaveProperty("FLYWHEEL_CODEX_BIN");
		expect(birthEnv).not.toHaveProperty("OPENAI_API_KEY");
	});

	it("probe → session ensure → UNCONDITIONAL stale-kill → window create with the TUI command", () => {
		const { result, calls } = makeEnsure({});
		expect(result).toBe(true);
		expect(calls[0]).toEqual(["tmux", "-V"]);
		expect(calls[1]?.[1]).toBe("new-session");
		expect(calls[2]).toEqual([
			"tmux",
			"kill-window",
			"-t",
			"=flywheel:=growth-mufasa-lead",
		]);
		const nw = calls[3];
		expect(nw?.[1]).toBe("new-window");
		const nameIdx = nw?.indexOf("-n") ?? -1;
		expect(nw?.[nameIdx + 1]).toBe("growth-mufasa-lead"); // FLY-169 title contract
		expect(calls[4]).toEqual([
			"tmux",
			"set-window-option",
			"-t",
			"=flywheel:=growth-mufasa-lead",
			"remain-on-exit",
			"on",
		]);
		expect(calls[5]?.[1]).toBe("respawn-pane");
		expect(calls[5]?.at(-1)).toContain("codex resume");
	});

	it("injects the carrier capability into the respawned TUI environment without exposing it in pane argv", () => {
		const raw = "generation_capability";
		const { calls } = makeEnsure({
			spec: { ...SPEC, carrierInstanceId: raw },
		});
		const nw = calls[3] ?? [];
		const respawn = calls[5] ?? [];
		expect(nw).not.toContain(
			"FLYWHEEL_LEAD_CARRIER_INSTANCE_ID=generation_capability",
		);
		expect(respawn).toContain(
			"FLYWHEEL_LEAD_CARRIER_INSTANCE_ID=generation_capability",
		);
		expect(respawn).toContain("FLYWHEEL_LEAD_ID=mufasa-lead");
		expect(respawn).toContain("FLYWHEEL_PROJECT_NAME=growth");
		expect(respawn.at(-1)).not.toContain(raw);
	});

	it("tmux unavailable → only the probe runs (Lead unaffected)", () => {
		const { result, calls } = makeEnsure({ tmuxAvailable: false });
		expect(result).toBe(false);
		expect(calls).toHaveLength(1);
	});

	it("create failure / exec throw → false, never throws (fail-open)", () => {
		expect(makeEnsure({ newWindowOk: false }).result).toBe(false);
		expect(() => makeEnsure({ execThrows: true })).not.toThrow();
		expect(makeEnsure({ execThrows: true }).result).toBe(false);
	});

	it.runIf(HAS_TMUX)(
		"real tmux preserves a one-second TUI child exit code under remain-on-exit",
		() => {
			const root = mkdtempSync(join(tmpdir(), "fly2643-tui-exit-"));
			const socket = join(root, "tmux.sock");
			const codex = join(root, "codex");
			writeFileSync(codex, "#!/bin/sh\nsleep 1\nexit 42\n", { mode: 0o700 });
			chmodSync(codex, 0o700);
			try {
				execFileSync("tmux", [
					"-S",
					socket,
					"-f",
					"/dev/null",
					"new-session",
					"-d",
					"-s",
					"fly2643",
				]);
				execFileSync("tmux", [
					"-S",
					socket,
					"set-window-option",
					"-g",
					"remain-on-exit",
					"on",
				]);
				execFileSync("tmux", [
					"-S",
					socket,
					"new-window",
					"-d",
					"-t",
					"=fly2643",
					"-n",
					"qa-tui",
					buildTuiCommand({
						...SPEC,
						codexBin: codex,
						codexHome: root,
						cwd: root,
					}),
				]);
				// tmux marks `pane_dead` on pty EOF and fills `pane_dead_status` on
				// SIGCHLD; both trail the one-second child on a loaded CI host, so
				// poll against a generous deadline instead of a fixed sample count.
				// The assertion stays exact: the retained pane must carry code 42.
				let paneState = "";
				const deadline = Date.now() + EXIT_EVIDENCE_POLL_BUDGET_MS;
				while (true) {
					paneState = execFileSync(
						"tmux",
						[
							"-S",
							socket,
							"display-message",
							"-p",
							"-t",
							"=fly2643:=qa-tui",
							"#{window_name} #{pane_dead} #{pane_dead_status}",
						],
						{ encoding: "utf8" },
					).trim();
					if (paneState === "qa-tui 1 42" || Date.now() >= deadline) break;
					execFileSync("/bin/sleep", ["0.1"]);
				}
				expect(paneState).toBe("qa-tui 1 42");
			} finally {
				try {
					execFileSync("tmux", ["-S", socket, "kill-server"], {
						stdio: "ignore",
					});
				} catch {}
				rmSync(root, { recursive: true, force: true });
			}
		},
		EXIT_EVIDENCE_POLL_BUDGET_MS + 10_000,
	);
});

describe("dead TUI evidence and retry backoff", () => {
	it("reads only an exact dead pane, preserves its exit code, and redacts a bounded tail", async () => {
		const bearerToken = "eyJhbGciOiJIUzI1NiJ9.SECRETPAYLOAD";
		const outputs = [
			"growth-mufasa-lead|1|%9|42",
			[
				"OpenAI Codex",
				"API_TOKEN=super-secret",
				`Authorization: Bearer ${bearerToken}`,
				"Resuming session…",
			].join("\n"),
		];
		const evidence = await readTuiWindowExitEvidenceAsync(SPEC, {
			execOut: async () => outputs.shift(),
		});
		expect(evidence).toEqual({
			windowName: "growth-mufasa-lead",
			paneId: "%9",
			exitStatus: 42,
			terminalTail: [
				"OpenAI Codex",
				"API_TOKEN=[redacted]",
				"Authorization=[redacted]",
				"Resuming session…",
			],
		});
		expect(JSON.stringify(evidence?.terminalTail)).not.toContain(bearerToken);
	});

	it("backs off after three consecutive failed stability proofs and resets only on health", () => {
		const retry = new TuiWindowRetryBackoff();
		expect(retry.recordFailure(0)).toBe(0);
		expect(retry.recordFailure(20_000)).toBe(0);
		expect(retry.recordFailure(40_000)).toBe(60_000);
		expect(retry.canAttempt(99_999)).toBe(false);
		expect(retry.canAttempt(100_000)).toBe(true);
		expect(retry.recordFailure(100_000)).toBe(120_000);
		retry.recordHealthy();
		expect(retry.canAttempt(100_001)).toBe(true);
		expect(retry.recordFailure(100_001)).toBe(0);
	});
});

describe("stable TUI visibility proof", () => {
	const live =
		"growth-mufasa-lead|0|%12|4312|codex resume --remote unix:///tmp/sock|codex";

	it.runIf(HAS_TMUX)(
		"parses the production pane with no tmux client locale even though tmux 3.7c rewrites tabs",
		() => {
			const root = mkdtempSync(join(tmpdir(), "fly2643-tui-locale-"));
			const socket = join(root, "tmux.sock");
			try {
				runIsolatedTmux(socket, [
					"-f",
					"/dev/null",
					"new-session",
					"-d",
					"-s",
					"flywheel",
					"-n",
					"keeper",
					"/bin/sleep",
					"120",
				]);
				runIsolatedTmux(socket, [
					"new-window",
					"-d",
					"-t",
					"=flywheel",
					"-n",
					"growth-mufasa-lead",
					"/bin/sleep",
					"120",
				]);
				const target = "=flywheel:=growth-mufasa-lead";
				const legacyTabSample = runIsolatedTmux(socket, [
					"display-message",
					"-p",
					"-t",
					target,
					"#{window_name}\t#{pane_dead}\t#{pane_id}",
				]).trim();
				expect(legacyTabSample).not.toContain("\t");
				expect(legacyTabSample).toMatch(/^growth-mufasa-lead_0_%[0-9]+$/);

				const identity = readTuiWindowIdentity(
					{ ...SPEC, codexBin: "/bin/sleep" },
					{
						execOut: (_cmd, args) => runIsolatedTmux(socket, args),
					},
				);
				expect(identity).toMatchObject({
					windowName: "growth-mufasa-lead",
					modelAlive: true,
					currentCommand: "sleep",
				});
			} finally {
				try {
					runIsolatedTmux(socket, ["kill-server"]);
				} catch {}
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("parses an exact live pane identity and rejects dead or non-model panes", () => {
		expect(readTuiWindowIdentity(SPEC, { execOut: () => live })).toEqual({
			windowName: "growth-mufasa-lead",
			paneId: "%12",
			panePid: 4312,
			startCommand: "codex resume --remote unix:///tmp/sock",
			currentCommand: "codex",
			modelAlive: true,
		});
		expect(
			readTuiWindowIdentity(SPEC, {
				execOut: () => live.replace("|0|", "|1|"),
			}),
		).toBeNull();
		expect(
			readTuiWindowIdentity(SPEC, {
				execOut: () => live.replace(/codex$/, "zsh"),
			}),
		).toMatchObject({ modelAlive: false });
	});

	it("requires the same pane tuple and a live model after five seconds", async () => {
		let callback: (() => void) | undefined;
		let cleared = false;
		const samples = [
			readTuiWindowIdentity(SPEC, { execOut: () => live }),
			readTuiWindowIdentity(SPEC, { execOut: () => live }),
		];
		const proof = beginTuiWindowVisibilityProof(SPEC, samples[0]!, {
			readIdentity: () => samples[1]!,
			setTimeoutFn: (fn, ms) => {
				expect(ms).toBe(5_000);
				callback = fn;
				return 7 as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimeoutFn: () => {
				cleared = true;
			},
		});
		let settled = false;
		void proof.promise.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		callback?.();
		await expect(proof.promise).resolves.toEqual(samples[1]);
		expect(cleared).toBe(false);
	});

	it("never proves a pane that dies or changes identity, and cancellation is final", async () => {
		const first = readTuiWindowIdentity(SPEC, { execOut: () => live })!;
		const callbacks: Array<() => void> = [];
		const make = (
			readIdentity: () => ReturnType<typeof readTuiWindowIdentity>,
		) =>
			beginTuiWindowVisibilityProof(SPEC, first, {
				readIdentity,
				setTimeoutFn: (fn) => {
					callbacks.push(fn);
					return callbacks.length as unknown as ReturnType<typeof setTimeout>;
				},
				clearTimeoutFn: () => {},
			});
		const dead = make(() => null);
		callbacks.shift()?.();
		await expect(dead.promise).resolves.toBeNull();

		const changed = make(() => ({ ...first, panePid: first.panePid + 1 }));
		callbacks.shift()?.();
		await expect(changed.promise).resolves.toBeNull();

		const cancelled = make(() => first);
		cancelled.cancel();
		callbacks.shift()?.();
		await expect(cancelled.promise).resolves.toBeNull();
	});

	it("never proves the same live pane after its Codex model body exits", async () => {
		const first = readTuiWindowIdentity(SPEC, { execOut: () => live })!;
		let callback: (() => void) | undefined;
		const proof = beginTuiWindowVisibilityProof(SPEC, first, {
			readIdentity: () => ({
				...first,
				currentCommand: "zsh",
				modelAlive: false,
			}),
			setTimeoutFn: (fn) => {
				callback = fn;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimeoutFn: () => {},
		});
		callback?.();
		await expect(proof.promise).resolves.toBeNull();
	});
});

describe("real tmux exit evidence without a client locale", () => {
	it.runIf(HAS_TMUX)(
		"reads a retained dead pane through the same printable protocol",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "fly2643-tui-dead-locale-"));
			const socket = join(root, "tmux.sock");
			try {
				runIsolatedTmux(socket, [
					"-f",
					"/dev/null",
					"new-session",
					"-d",
					"-s",
					"flywheel",
					"-n",
					"keeper",
					"/bin/sleep 120",
				]);
				runIsolatedTmux(socket, ["set-option", "-g", "remain-on-exit", "on"]);
				runIsolatedTmux(socket, [
					"new-window",
					"-d",
					"-t",
					"=flywheel",
					"-n",
					"growth-mufasa-lead",
					"/bin/sh -c 'sleep 1; exit 42'",
				]);
				const target = "=flywheel:=growth-mufasa-lead";
				let dead = "";
				const deadline = Date.now() + EXIT_EVIDENCE_POLL_BUDGET_MS;
				while (true) {
					dead = runIsolatedTmux(socket, [
						"display-message",
						"-p",
						"-t",
						target,
						"#{pane_dead} #{pane_dead_status}",
					]).trim();
					if (dead === "1 42" || Date.now() >= deadline) break;
					execFileSync("/bin/sleep", ["0.1"]);
				}
				expect(dead).toBe("1 42");

				const evidence = await readTuiWindowExitEvidenceAsync(SPEC, {
					execOut: async (_cmd, args) => runIsolatedTmux(socket, args),
				});
				expect(evidence).toMatchObject({
					windowName: "growth-mufasa-lead",
					exitStatus: 42,
				});
			} finally {
				try {
					runIsolatedTmux(socket, ["kill-server"]);
				} catch {}
				rmSync(root, { recursive: true, force: true });
			}
		},
		EXIT_EVIDENCE_POLL_BUDGET_MS + 10_000,
	);
});

describe("isTuiWindowAlive (identity echo — #248 smoke finding)", () => {
	const probe = (out: string | undefined) =>
		isTuiWindowAlive(SPEC, { execOut: () => out });
	it("alive only on exact name echo + pane_dead=0", () => {
		expect(probe("growth-mufasa-lead 0")).toBe(true);
		expect(probe("growth-mufasa-lead 1")).toBe(false); // dead pane
		expect(probe("other-window 0")).toBe(false); // tmux fell back to current window
		expect(probe(undefined)).toBe(false); // tmux error → fail closed
	});
});

describe("killTuiWindow (shutdown orphan teardown — review HIGH-1)", () => {
	it.each([
		[false, undefined, true],
		[true, "growth-mufasa-lead 0", false],
		[true, undefined, true],
	] as const)("kill ok=%s, probe=%s ⇒ verified=%s", (ok, out, expected) => {
		expect(
			killTuiWindow(SPEC, {
				exec: () => ({ ok }),
				execOut: () => out,
			}),
		).toBe(expected);
	});

	it("issues a name-scoped kill-window for the lead's TUI window", () => {
		const calls: string[][] = [];
		killTuiWindow(SPEC, {
			execOut: () => undefined,
			exec: (cmd, args) => {
				calls.push([cmd, ...args]);
				return { ok: true };
			},
			log: () => {},
		});
		expect(calls).toEqual([
			["tmux", "kill-window", "-t", "=flywheel:=growth-mufasa-lead"],
		]);
	});

	it("fail-open: never throws when tmux exec throws (window already gone)", () => {
		expect(() =>
			killTuiWindow(SPEC, {
				exec: () => {
					throw new Error("no server running");
				},
				log: () => {},
			}),
		).not.toThrow();
	});
});

describe("v2 visible process boundary", () => {
	const pins = {
		codexHome: SPEC.codexHome,
		brokerSocket: "/tmp/cap/socket",
		manifestPath: "/tmp/cap/manifest.json",
		artifactRoot: "/tmp/cap/artifacts",
		modelTempRoot: "/tmp/cap/model-tmp",
		projectName: SPEC.projectName,
		leadId: SPEC.leadId,
		activationId: "activation-1",
	};
	it("uses the parent socket without overriding remote thread permissions", () => {
		const command = buildTuiCommand({
			...SPEC,
			capabilityModelEnv: { pins, env: {} },
			capabilitySocketPath: "/tmp/owned/app.sock",
		});
		expect(command).toContain("unix:///tmp/owned/app.sock");
		expect(command).not.toContain("app-server-control");
		expect(command).not.toContain("approval_policy");
		expect(command).not.toContain("default_permissions");
		expect(() =>
			buildTuiCommand({ ...SPEC, capabilitySocketPath: "/tmp/owned/app.sock" }),
		).toThrow("invalid capability socket");
	});
	it("rejects parent pins for a different identity or home", () => {
		for (const changed of [
			{ leadId: "other" },
			{ projectName: "other" },
			{ codexHome: "/tmp/other" },
			{ brokerSocket: "relative" },
		]) {
			expect(() =>
				buildTuiCommand({
					...SPEC,
					capabilityModelEnv: { pins: { ...pins, ...changed }, env: {} },
				}),
			).toThrow();
		}
	});
	it("omits carrier injection from v2 tmux window arguments", () => {
		const calls: string[][] = [];
		expect(
			ensureTuiWindow(
				{
					...SPEC,
					carrierInstanceId: "private-claim",
					capabilityModelEnv: { pins, env: {} },
				},
				{
					exec: (_cmd, args) => {
						calls.push(args);
						return { ok: true };
					},
				},
			),
		).toBe(true);
		const args = calls.find((args) => args[0] === "new-window")!;
		expect(args).not.toContain("-e");
		expect(args.join(" ")).not.toContain("private-claim");
	});
	it("executes the final process with only washed env and no legacy sandbox override", () => {
		const dir = mkdtempSync(join(tmpdir(), "tui-boundary-"));
		try {
			const stub = join(dir, "codex");
			writeFileSync(
				stub,
				`#!${process.execPath}\nprocess.stdout.write(JSON.stringify({env:process.env,args:process.argv.slice(2)}));`,
				{ mode: 0o700 },
			);
			const command = buildTuiCommand({
				...SPEC,
				codexBin: stub,
				fullAccess: true,
				carrierInstanceId: "private-claim",
				capabilityModelEnv: {
					pins,
					env: {
						PATH: "/usr/bin:/bin",
						SHELL: "literal'$(echo unsafe)`value",
						GH_TOKEN: "private-token",
					},
				},
			});
			const result = JSON.parse(
				execFileSync("/bin/sh", ["-c", command], {
					encoding: "utf8",
					env: {
						PATH: "/usr/bin:/bin",
						GH_TOKEN: "inherited-token",
						FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "inherited-claim",
					},
				}),
			);
			expect(result.env.GH_TOKEN).toBeUndefined();
			expect(result.env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID).toBeUndefined();
			expect(result.env.SHELL).toBe("literal'$(echo unsafe)`value");
			expect(result.env.FLYWHEEL_LEAD_CAPABILITY_SOCKET).toBe(
				pins.brokerSocket,
			);
			expect(result.args).not.toContain("-s");
			expect(result.args).toContain(
				"unix://" +
					SPEC.codexHome +
					"/app-server-control/app-server-control.sock",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
