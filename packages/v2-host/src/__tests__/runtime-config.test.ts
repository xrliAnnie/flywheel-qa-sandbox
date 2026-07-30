import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "../cli.js";
import {
	CommandRunnerLauncher,
	type RuntimeLaunchRequest,
} from "../runtime-ports.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("host runtime config and launcher protocol", () => {
	it("parses only the exact, absolute runtime configuration", () => {
		expect(
			parseRuntimeConfig({
				v: 1,
				dispatch_interval_ms: 1000,
				lock_root: "/tmp/v2-locks",
				injection_root: "/tmp/v2-injection",
				launcher: {
					kind: "tmux",
					tmux_bin: "/usr/local/bin/tmux",
					claude_bin: "/opt/flywheel/claude",
					// Codex R4 MEDIUM-2: required. Without a named credentials source a
					// per-activation config dir has none, and the runner parks on a login
					// screen instead of failing.
					claude_credentials: "/opt/flywheel/claude-credentials.json",
					codex_bin: "/opt/flywheel/codex",
					client_cli: "/opt/flywheel/v2-cli.js",
					release_root: "/tmp/v2-release",
					state_root: "/tmp/v2-runner-state",
				},
				git_bin: "/usr/bin/git",
				gh_bin: "/usr/local/bin/gh",
			}),
		).toMatchObject({
			dispatchIntervalMs: 1000,
			launcher: {
				kind: "tmux",
				tmuxBin: "/usr/local/bin/tmux",
			},
		});
		expect(
			parseRuntimeConfig({
				v: 1,
				dispatch_interval_ms: 1000,
				lock_root: "/tmp/v2-locks",
				injection_root: "/tmp/v2-injection",
				launcher: {
					kind: "command",
					command: ["/usr/bin/node", "/opt/flywheel/launcher.js"],
					request_root: "/tmp/v2-requests",
				},
				git_bin: "/usr/bin/git",
				gh_bin: "/usr/local/bin/gh",
			}),
		).toMatchObject({
			launcher: {
				kind: "command",
				command: ["/usr/bin/node", "/opt/flywheel/launcher.js"],
			},
		});
		expect(() =>
			parseRuntimeConfig({
				v: 1,
				dispatch_interval_ms: 50,
				lock_root: "relative",
				injection_root: "/tmp/v2-injection",
				launcher: {
					kind: "command",
					command: ["node"],
					request_root: "/tmp/v2-requests",
				},
				git_bin: "/usr/bin/git",
				gh_bin: "/usr/local/bin/gh",
			}),
		).toThrow();
	});

	it("uses a 0600 request file and exact JSON replies for launch/probe/stop", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-v2-launcher-"));
		roots.push(root);
		const script = join(root, "launcher.mjs");
		writeFileSync(
			script,
			[
				'import { readFileSync } from "node:fs";',
				"const [action, flag, path] = process.argv.slice(2);",
				'if (flag !== "--request") process.exit(2);',
				"const request = JSON.parse(readFileSync(path, 'utf8'));",
				"if (action === 'launch') console.log(JSON.stringify({v:1,hostEpoch:'host-test',sessionId:request.sessionRef,pid:77,pidStart:'start-77'}));",
				"else if (action === 'probe') console.log(JSON.stringify({state:'absent',confirmedAt:'2026-07-29T00:00:00.000Z'}));",
				"else if (action === 'stop') console.log(JSON.stringify({status:'stopped'}));",
				"else process.exit(3);",
				"",
			].join("\n"),
		);
		const requestRoot = join(root, "requests");
		const launcher = new CommandRunnerLauncher({
			command: [process.execPath, script],
			requestRoot,
		});
		const request = {
			sessionRef: "session-runtime",
			context: {},
		} as unknown as RuntimeLaunchRequest;
		await expect(launcher.launch(request)).resolves.toMatchObject({
			sessionId: "session-runtime",
			hostEpoch: "host-test",
		});
		await expect(launcher.probe("session-runtime")).resolves.toEqual({
			state: "absent",
			confirmedAt: "2026-07-29T00:00:00.000Z",
		});
		await expect(launcher.stop("session-runtime")).resolves.toBeUndefined();
		const launchRequest = join(
			requestRoot,
			`${createHash("sha256").update("session-runtime").digest("hex")}.launch.json`,
		);
		expect(statSync(requestRoot).mode & 0o777).toBe(0o700);
		expect(statSync(launchRequest).mode & 0o777).toBe(0o600);
	});
});
