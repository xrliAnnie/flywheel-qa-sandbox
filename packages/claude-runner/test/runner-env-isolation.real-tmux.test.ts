import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecFileFn } from "../src/TmuxAdapter.js";
import { RUNNER_PANE_BASE_ALLOWLIST, TmuxAdapter } from "../src/TmuxAdapter.js";

const CODEX_ACCOUNT_REGISTRY = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL("../agents/codex-account-registry.json", import.meta.url),
		),
		"utf8",
	),
) as { profiles: Array<{ name: string; email: string }> };

function canonicalEmail(name: string): string {
	const profile = CODEX_ACCOUNT_REGISTRY.profiles.find(
		(candidate) => candidate.name === name,
	);
	if (!profile) throw new Error(`missing canonical Codex profile: ${name}`);
	return profile.email;
}

function tmuxUsable(): boolean {
	return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
}

const describeReal = tmuxUsable() ? describe : describe.skip;

class IdentityProbeAdapter extends TmuxAdapter {
	protected override readonly binaryName: string;

	constructor(sessionName: string, binaryName: string, execFileFn: ExecFileFn) {
		super(sessionName, execFileFn, 10, 5000);
		this.binaryName = binaryName;
	}
}

function auth(email: string): string {
	const payload = Buffer.from(JSON.stringify({ email })).toString("base64url");
	return JSON.stringify({
		tokens: { id_token: `header.${payload}.signature` },
	});
}

describeReal("FLY-1999 runner identity isolation (real tmux)", () => {
	const sockets: string[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const socket of sockets.splice(0)) {
			spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a poisoned server identity and follows a real codex-profile use switch", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1999-identity-"));
		tempDirs.push(root);
		const home = join(root, "home");
		const codexDir = join(home, ".codex");
		const poisonedCodexDir = join(root, "infra-bot-codex");
		const recordFile = join(root, "records.jsonl");
		const probe = join(root, "codex");
		writeFileSync(recordFile, "");
		for (const profile of ["personal", "school"] as const) {
			const profileDir = join(codexDir, "profiles", profile);
			mkdirSync(profileDir, { recursive: true });
			writeFileSync(
				join(profileDir, "auth.json"),
				auth(canonicalEmail(profile)),
			);
		}
		mkdirSync(poisonedCodexDir, { recursive: true });
		writeFileSync(
			join(poisonedCodexDir, "auth.json"),
			auth("infra-bot@example.test"),
		);
		writeFileSync(
			probe,
			`#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-identity-probe 1.0\\n");
  process.exit(0);
}
const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME, ".codex");
const token = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8")).tokens.id_token;
const email = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).email;
const envNames = Object.keys(process.env).filter((name) => name !== "__CF_USER_TEXT_ENCODING").sort();
fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
  label: process.argv.includes("raw-positive") ? "raw-positive" : process.env.FLYWHEEL_EXEC_ID,
  codexHome: process.env.CODEX_HOME || null,
  email,
  envNames
}) + "\\n");
`,
			{ mode: 0o700 },
		);
		chmodSync(probe, 0o700);

		const profileBin = fileURLToPath(
			new URL("../bin/flywheel-codex-profile", import.meta.url),
		);
		const canonicalPath = `${home}/.local/bin:${home}/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
		const profileEnv = { HOME: home, PATH: canonicalPath };
		execFileSync(profileBin, ["use", "personal"], {
			env: profileEnv,
			stdio: "ignore",
		});

		const socket = `fly1999-${randomUUID().slice(0, 8)}`;
		const session = `runner-fly1999-${randomUUID().slice(0, 8)}`;
		sockets.push(socket);
		const birthEnv = {
			HOME: home,
			PATH: canonicalPath,
			SHELL: process.env.SHELL ?? "/bin/sh",
			USER: process.env.USER ?? "runner",
			LOGNAME: process.env.LOGNAME ?? "runner",
			LANG: process.env.LANG ?? "en_US.UTF-8",
			TERM: "xterm-256color",
			TMPDIR: root,
			CODEX_HOME: poisonedCodexDir,
			FLYWHEEL_CODEX_BIN: "/poison/infra-bot/codex",
			OPENAI_API_KEY: "must-not-cross",
		};
		execFileSync(
			"tmux",
			["-L", socket, "new-session", "-d", "-s", session, "sleep", "120"],
			{ env: birthEnv, timeout: 5000 },
		);
		execFileSync(
			"tmux",
			[
				"-L",
				socket,
				"new-window",
				"-d",
				"-t",
				`=${session}`,
				probe,
				"raw-positive",
			],
			{ timeout: 5000 },
		);
		for (let attempts = 0; attempts < 50; attempts += 1) {
			if (readFileSync(recordFile, "utf8").includes("raw-positive")) break;
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
		}

		const newWindowCalls: string[][] = [];
		const execFileFn: ExecFileFn = (cmd, args, opts) => {
			if (cmd === "tmux" && args.includes("new-window"))
				newWindowCalls.push(args);
			return {
				stdout: execFileSync(
					cmd,
					cmd === "tmux" ? ["-L", socket, ...args] : args,
					{
						encoding: "utf8",
						timeout: opts?.timeoutMs ?? 5000,
						...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
					},
				),
			};
		};
		const adapter = new IdentityProbeAdapter(session, probe, execFileFn);
		for (const [executionId, profile] of [
			["profile-one", "personal"],
			["profile-two", "school"],
		] as const) {
			execFileSync(profileBin, ["use", profile], {
				env: profileEnv,
				stdio: "ignore",
			});
			const result = await adapter.execute({
				executionId,
				issueId: "FLY-1999",
				label: executionId,
				prompt: "identity probe",
				cwd: root,
				onTmuxWindowOpened: () => {},
			});
			expect(result.success).toBe(true);
		}

		const records = readFileSync(recordFile, "utf8")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						label: string;
						codexHome: string | null;
						email: string;
						envNames: string[];
					},
			);
		expect(
			records.map(({ label, codexHome, email }) => ({
				label,
				codexHome,
				email,
			})),
		).toEqual([
			{
				label: "raw-positive",
				codexHome: poisonedCodexDir,
				email: "infra-bot@example.test",
			},
			{
				label: "profile-one",
				codexHome: null,
				email: canonicalEmail("personal"),
			},
			{
				label: "profile-two",
				codexHome: null,
				email: canonicalEmail("school"),
			},
		]);

		for (const [index, record] of records.slice(1).entries()) {
			const launch = newWindowCalls[index] ?? [];
			const injected = launch
				.filter((_arg, argIndex) => launch[argIndex - 1] === "-e")
				.map((assignment) => assignment.slice(0, assignment.indexOf("=")));
			const inheritedBase = [
				...Object.keys(birthEnv),
				"PWD",
				"TMUX",
				"TMUX_PANE",
			].filter((name) =>
				(RUNNER_PANE_BASE_ALLOWLIST as readonly string[]).includes(name),
			);
			expect(record.envNames).toEqual(
				[...new Set([...inheritedBase, ...injected])].sort(),
			);
			expect(record.envNames).not.toContain("OPENAI_API_KEY");
			expect(record.envNames).not.toContain("FLYWHEEL_CODEX_BIN");
		}
	});
});
