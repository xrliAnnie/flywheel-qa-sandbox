import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	parseEnvFileVariableNames,
	scrubManagedTmuxEnvironments,
	TMUX_ENVIRONMENT_SCRUB_TIMEOUT_MS,
} from "../tmux-environment-scrub.js";

const tmuxLabels = new Set<string>();

afterEach(() => {
	for (const label of tmuxLabels) {
		spawnSync("tmux", ["-L", label, "kill-server"], { stdio: "ignore" });
	}
	tmuxLabels.clear();
});

describe("parseEnvFileVariableNames", () => {
	it("reads assignment names without returning values", () => {
		expect(
			parseEnvFileVariableNames(`
OPENAI_API_KEY=plain-secret
 export TADASHI_BOT_TOKEN="quoted secret"
PATH=/poisoned/bin
# IGNORED=value
not an assignment
`),
		).toEqual(new Set(["OPENAI_API_KEY", "TADASHI_BOT_TOKEN", "PATH"]));
	});
});

describe("scrubManagedTmuxEnvironments", () => {
	it.runIf(spawnSync("tmux", ["-V"]).status === 0)(
		"cleans every scope on a real isolated tmux server and is state-idempotent",
		() => {
			const label = `fly1999-${process.pid}-${randomUUID().slice(0, 8)}`;
			tmuxLabels.add(label);
			const home = process.env.HOME ?? "/tmp";
			const birthEnv = {
				HOME: home,
				PATH: process.env.PATH,
				SHELL: process.env.SHELL,
				USER: process.env.USER,
				LOGNAME: process.env.LOGNAME,
				TERM: "xterm-256color",
				CODEX_HOME: "/poison/codex-home",
				OPENAI_API_KEY: "real-tmux-secret",
			};
			const tmux = (args: string[]) =>
				spawnSync("tmux", ["-L", label, ...args], {
					encoding: "utf8",
					env: birthEnv,
				});
			expect(tmux(["new-session", "-d", "-s", "flywheel"]).status).toBe(0);
			expect(
				tmux(["new-session", "-d", "-s", "runner-real-project"]).status,
			).toBe(0);
			expect(
				tmux([
					"set-environment",
					"-t",
					"=runner-real-project",
					"DISCORD_BOT_TOKEN",
					"session-secret",
				]).status,
			).toBe(0);
			const exec = (args: string[]) => {
				const result = tmux(args);
				return {
					ok: result.status === 0,
					stdout: result.stdout ?? "",
				};
			};
			const options = {
				env: {
					HOME: home,
					FLYWHEEL_STATE_DIR: "/unused",
					FLYWHEEL_TMUX_SOCKET_OVERRIDE: "/tmp/injected-test.sock",
				},
				readFile: () => "OPENAI_API_KEY=must-not-be-logged",
				exec,
				log: () => {},
			};

			scrubManagedTmuxEnvironments(
				[{ projectName: "real-project", projectRoot: "/repo", leads: [] }],
				options,
			);
			const first = [
				tmux(["show-environment", "-g"]).stdout,
				tmux(["show-environment", "-t", "=flywheel"]).stdout,
				tmux(["show-environment", "-t", "=runner-real-project"]).stdout,
			];
			expect(first.join("\n")).not.toMatch(
				/CODEX_HOME|OPENAI_API_KEY|DISCORD_BOT_TOKEN/,
			);
			const canonicalPath = `${home}/.local/bin:${home}/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
			for (const scope of first)
				expect(scope).toContain(`PATH=${canonicalPath}`);

			scrubManagedTmuxEnvironments(
				[{ projectName: "real-project", projectRoot: "/repo", leads: [] }],
				options,
			);
			expect([
				tmux(["show-environment", "-g"]).stdout,
				tmux(["show-environment", "-t", "=flywheel"]).stdout,
				tmux(["show-environment", "-t", "=runner-real-project"]).stdout,
			]).toEqual(first);
		},
	);

	it("cleans global and every managed session, preserves OS names, and never exposes values", () => {
		const secretValues = [
			"global-openai-value",
			"lead-token-value",
			"env-file-only-value",
		];
		const calls: string[][] = [];
		const log: string[] = [];
		const shown = new Map([
			[
				"global",
				`CODEX_HOME=/poison/home\nOPENAI_API_KEY=${secretValues[0]}\nHOME=/Users/x\nPATH=/poisoned/bin\nSAFE_NAME=keep`,
			],
			[
				"flywheel",
				`FLYWHEEL_CODEX_LEAD_STATE_DIR=/poison/state\nDISCORD_BOT_TOKEN=${secretValues[1]}\nTERM=xterm-256color`,
			],
			[
				"runner-Geo-Forge",
				"FLYWHEEL_CODEX_BIN=/poison/codex\nTADASHI_BOT_TOKEN=project-secret\nLANG=en_US.UTF-8",
			],
		]);
		const result = scrubManagedTmuxEnvironments(
			[
				{
					projectName: "Geo Forge",
					projectRoot: "/repo",
					leads: [],
				},
			],
			{
				env: {
					HOME: "/Users/x",
					FLYWHEEL_STATE_DIR: "/state",
					FLYWHEEL_TMUX_SOCKET_OVERRIDE: "/tmp/injected-test.sock",
				},
				readFile: () =>
					`OPENAI_API_KEY=${secretValues[0]}\nTADASHI_BOT_TOKEN=${secretValues[2]}\nPATH=/must-preserve`,
				exec: (args) => {
					calls.push(args);
					if (args[0] !== "show-environment") return { ok: true, stdout: "" };
					const target = args.includes("-g")
						? "global"
						: args.at(-1)?.replace(/^=/, "");
					const stdout = target ? shown.get(target) : undefined;
					return { ok: stdout !== undefined, stdout: stdout ?? "" };
				},
				log: (line) => log.push(line),
			},
		);

		expect(result).toEqual({ scopesScrubbed: 3, namesRemoved: 6 });
		const mutations = calls.filter((args) => args[0] === "set-environment");
		expect(mutations).toHaveLength(3);
		expect(mutations[0]).toEqual(
			expect.arrayContaining(["CODEX_HOME", "OPENAI_API_KEY"]),
		);
		expect(mutations[1]).toEqual(
			expect.arrayContaining([
				"FLYWHEEL_CODEX_LEAD_STATE_DIR",
				"DISCORD_BOT_TOKEN",
			]),
		);
		expect(mutations[2]).toEqual(
			expect.arrayContaining(["FLYWHEEL_CODEX_BIN", "TADASHI_BOT_TOKEN"]),
		);
		for (const args of mutations) {
			expect(args).not.toContain("HOME");
			expect(args).not.toContain("LANG");
			expect(args).not.toContain("TERM");
			expect(args.at(-1)).toBe(
				"/Users/x/.local/bin:/Users/x/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
			);
		}
		const observable = JSON.stringify({ calls, log, result });
		for (const value of secretValues) expect(observable).not.toContain(value);
	});

	it("refuses a relative socket override without probing or reading secrets", () => {
		let calls = 0;
		let reads = 0;
		const log: string[] = [];
		expect(
			scrubManagedTmuxEnvironments([], {
				env: {
					HOME: "/Users/x",
					FLYWHEEL_TMUX_SOCKET_OVERRIDE: "relative.sock",
				},
				readFile: () => {
					reads += 1;
					return "OPENAI_API_KEY=secret";
				},
				exec: () => {
					calls += 1;
					return { ok: true, stdout: "OPENAI_API_KEY=secret" };
				},
				log: (line) => log.push(line),
			}),
		).toEqual({ scopesScrubbed: 0, namesRemoved: 0 });
		expect({ calls, reads }).toEqual({ calls: 0, reads: 0 });
		expect(log).toEqual([
			"[tmux-env-scrub] skipped: invalid tmux socket override",
		]);
	});

	it("refuses an implicit socket whose managed-session ownership is unproven", () => {
		const calls: string[][] = [];
		let reads = 0;
		const log: string[] = [];
		expect(
			scrubManagedTmuxEnvironments([{ projectName: "test-slot-529" }], {
				env: { HOME: "/Users/x", TMUX_TMPDIR: "/tmp" },
				readFile: () => {
					reads += 1;
					return "OPENAI_API_KEY=secret";
				},
				exec: (args) => {
					calls.push(args);
					return { ok: true, stdout: "runner-flywheel\n" };
				},
				log: (line) => log.push(line),
			}),
		).toEqual({ scopesScrubbed: 0, namesRemoved: 0 });
		expect(calls).toEqual([["list-sessions", "-F", "#{session_name}"]]);
		expect(reads).toBe(0);
		expect(log).toEqual([
			"[tmux-env-scrub] skipped: tmux server ownership unproven",
		]);
	});

	it("boot scrub cleans an ownership-proven default socket without an override", () => {
		const calls: string[][] = [];
		const result = scrubManagedTmuxEnvironments([{ projectName: "flywheel" }], {
			env: { HOME: "/Users/x", TMUX_TMPDIR: "/tmp" },
			readFile: () => "OPENAI_API_KEY=secret",
			exec: (args) => {
				calls.push(args);
				if (args[0] === "list-sessions") {
					return { ok: true, stdout: "runner-flywheel\n" };
				}
				if (args[0] === "show-environment") {
					return {
						ok: true,
						stdout: "OPENAI_API_KEY=secret\nPATH=/poisoned/bin",
					};
				}
				return { ok: true, stdout: "" };
			},
		});

		const mutations = calls.filter((args) => args[0] === "set-environment");
		expect(result.scopesScrubbed).toBeGreaterThan(0);
		expect(mutations.length).toBeGreaterThan(0);
		expect(mutations.flat()).toContain("OPENAI_API_KEY");
	});

	it("shares one timeout budget across every managed scope", () => {
		let now = 1_000;
		const timeouts: number[] = [];
		const log: string[] = [];
		const result = scrubManagedTmuxEnvironments([{ projectName: "test" }], {
			env: {
				HOME: "/Users/x",
				FLYWHEEL_TMUX_SOCKET_OVERRIDE: "/tmp/injected-test.sock",
			},
			readFile: () => "",
			now: () => now,
			exec: (_args, timeoutMs) => {
				timeouts.push(timeoutMs);
				now += 6_000;
				return { ok: true, stdout: "" };
			},
			log: (line) => log.push(line),
		});

		expect(timeouts).toEqual([
			TMUX_ENVIRONMENT_SCRUB_TIMEOUT_MS,
			TMUX_ENVIRONMENT_SCRUB_TIMEOUT_MS - 6_000,
		]);
		expect(result).toEqual({ scopesScrubbed: 1, namesRemoved: 0 });
		expect(log).toContain(
			`[tmux-env-scrub] timed out after ${TMUX_ENVIRONMENT_SCRUB_TIMEOUT_MS}ms`,
		);
	});

	it("is fail-open when tmux has no server", () => {
		const log: string[] = [];
		expect(
			scrubManagedTmuxEnvironments([], {
				env: {
					HOME: "/Users/x",
					FLYWHEEL_TMUX_SOCKET_OVERRIDE: "/tmp/injected-test.sock",
				},
				readFile: () => {
					throw Object.assign(new Error("missing"), { code: "ENOENT" });
				},
				exec: () => ({ ok: false, stdout: "" }),
				log: (line) => log.push(line),
			}),
		).toEqual({ scopesScrubbed: 0, namesRemoved: 0 });
		expect(log).toEqual([
			"[tmux-env-scrub] env-name file missing: /Users/x/.flywheel/.env",
			"[tmux-env-scrub] skipped: tmux server unavailable",
		]);
	});

	it.runIf(spawnSync("tmux", ["-V"]).status === 0)(
		"cleans an ownership-proven real default socket without an override",
		() => {
			const root = mkdtempSync(join(tmpdir(), "fly1999-default-"));
			const uid = process.getuid?.();
			if (!Number.isSafeInteger(uid)) return;
			const socket = join(root, `tmux-${uid}`, "default");
			const tmuxEnv = {
				HOME: process.env.HOME,
				PATH: process.env.PATH,
				SHELL: process.env.SHELL,
				USER: process.env.USER,
				LOGNAME: process.env.LOGNAME,
				TERM: "xterm-256color",
				TMUX_TMPDIR: root,
			};
			const tmux = (args: string[]) =>
				spawnSync("tmux", args, { encoding: "utf8", env: tmuxEnv });
			try {
				expect(
					tmux(["new-session", "-d", "-s", "runner-owned-project"]).status,
				).toBe(0);
				expect(
					spawnSync(
						"tmux",
						[
							"-S",
							socket,
							"set-environment",
							"-g",
							"OPENAI_API_KEY",
							"socket-secret",
						],
						{ encoding: "utf8", env: tmuxEnv },
					).status,
				).toBe(0);

				const result = scrubManagedTmuxEnvironments(
					[{ projectName: "owned-project" }],
					{
						env: { HOME: "/Users/x", TMUX_TMPDIR: root },
						readFile: () => "OPENAI_API_KEY=must-not-log",
					},
				);

				expect(result.scopesScrubbed).toBeGreaterThan(0);
				expect(
					spawnSync("tmux", ["-S", socket, "show-environment", "-g"], {
						encoding: "utf8",
						env: tmuxEnv,
					}).stdout,
				).not.toContain("OPENAI_API_KEY");
			} finally {
				spawnSync("tmux", ["-S", socket, "kill-server"], {
					stdio: "ignore",
					env: tmuxEnv,
				});
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it.runIf(spawnSync("tmux", ["-V"]).status === 0)(
		"honors the configured tmux socket when using the production executor",
		() => {
			const socket = `/tmp/fly1999-scrub-${process.pid}-${randomUUID().slice(0, 8)}.sock`;
			const tmux = (args: string[]) =>
				spawnSync("tmux", ["-S", socket, ...args], {
					encoding: "utf8",
				});
			try {
				expect(tmux(["new-session", "-d", "-s", "flywheel"]).status).toBe(0);
				expect(
					tmux(["set-environment", "-g", "OPENAI_API_KEY", "socket-secret"])
						.status,
				).toBe(0);

				scrubManagedTmuxEnvironments([], {
					env: {
						HOME: "/Users/x",
						FLYWHEEL_TMUX_SOCKET_OVERRIDE: socket,
					},
					readFile: () => "OPENAI_API_KEY=must-not-log",
				});

				expect(tmux(["show-environment", "-g"]).stdout).not.toContain(
					"OPENAI_API_KEY",
				);
			} finally {
				tmux(["kill-server"]);
			}
		},
	);
});
