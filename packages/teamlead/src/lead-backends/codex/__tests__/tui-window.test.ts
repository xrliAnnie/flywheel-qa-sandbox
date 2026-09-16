/**
 * FLY-259 PR-C — tui-window unit tests: command builder (pins + boundary
 * validation), ensure lifecycle (unconditional stale-kill, fail-open),
 * identity-echo liveness probe.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildTuiCommand,
	ensureTuiWindow,
	isTuiWindowAlive,
	killTuiWindow,
	type TuiWindowSpec,
} from "../tui-window.js";

const SPEC: TuiWindowSpec = {
	projectName: "growth",
	leadId: "mufasa-lead",
	codexHome: "/Users/x/.codex-mufasa-tui",
	threadId: "019eb-thread-id",
	cwd: "/Users/x/Dev/growth",
};

describe("buildTuiCommand", () => {
	it("carries the full R4 HIGH-4 command-line pin layer + remote socket + cwd + thread", () => {
		const cmd = buildTuiCommand(SPEC);
		expect(cmd).toContain('CODEX_HOME="/Users/x/.codex-mufasa-tui"');
		expect(cmd).toContain("codex resume");
		expect(cmd).toContain(
			'--remote "unix:///Users/x/.codex-mufasa-tui/app-server-control/app-server-control.sock"',
		);
		expect(cmd).toContain('-C "/Users/x/Dev/growth"'); // kills the cwd menu
		expect(cmd).toContain("-s read-only"); // pin layer
		expect(cmd).toContain(`-c 'approval_policy="never"'`); // pin layer
		expect(cmd.trim().endsWith("019eb-thread-id")).toBe(true);
	});

	it("FLY-398 fullAccess: emits -s workspace-write (windowed full-access TUI), never -s read-only", () => {
		const cmd = buildTuiCommand({ ...SPEC, fullAccess: true });
		expect(cmd).toContain("-s workspace-write");
		expect(cmd).not.toContain("-s read-only");
		expect(cmd).toContain(`-c 'approval_policy="never"'`); // still pinned
		expect(cmd).toContain("codex resume");
		expect(cmd.trim().endsWith("019eb-thread-id")).toBe(true);
	});

	it("FLY-398 fullAccess=false/undefined keeps -s read-only (byte-compat)", () => {
		expect(buildTuiCommand({ ...SPEC, fullAccess: false })).toContain(
			"-s read-only",
		);
		expect(buildTuiCommand(SPEC)).not.toContain("-s workspace-write");
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
		expect(nw?.[nw.length - 1]).toContain("codex resume");
	});

	it("injects the carrier capability through tmux window env without exposing it in pane argv", () => {
		const raw = "generation_capability";
		const { calls } = makeEnsure({
			spec: { ...SPEC, carrierInstanceId: raw },
		});
		const nw = calls[3] ?? [];
		expect(nw).toContain(
			"FLYWHEEL_LEAD_CARRIER_INSTANCE_ID=generation_capability",
		);
		expect(nw).toContain("FLYWHEEL_LEAD_ID=mufasa-lead");
		expect(nw).toContain("FLYWHEEL_PROJECT_NAME=growth");
		expect(nw.at(-1)).not.toContain(raw);
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
	it("uses the parent socket and named permissions for the founder client", () => {
		const command = buildTuiCommand({
			...SPEC,
			capabilityModelEnv: { pins, env: {} },
			capabilitySocketPath: "/tmp/owned/app.sock",
		});
		expect(command).toContain("unix:///tmp/owned/app.sock");
		expect(command).not.toContain("app-server-control");
		expect(command).toContain('default_permissions="flywheel-lead-v2"');
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
