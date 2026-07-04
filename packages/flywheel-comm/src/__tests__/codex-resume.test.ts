/**
 * FLY-123 (Codex design review R2 #2): `codex-resume` zero-interpolation
 * contract. Adversarial replies — quotes, newlines, semicolons, backticks,
 * $(), leading options, Unicode — must reach codex byte-exact via stdin and
 * never appear in any shell command. threadId is UUID-validated; non-0600
 * state files are rejected.
 *
 * Harness: FLYWHEEL_CODEX_BIN points at a capture script that records its
 * argv + stdin to files (real spawn, no shell — what production does).
 */
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildCodexCycleArgv,
	type CodexCycleState,
	codexResume,
	validateCycleState,
} from "../commands/codex-resume.js";

const THREAD_ID = "019e9006-0b8e-72b0-bb80-9100d85473cf";

describe("codex-resume (FLY-123)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly123-codex-resume-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeCaptureBin(): {
		bin: string;
		argvOut: string;
		stdinOut: string;
		envOut: string;
	} {
		const argvOut = join(dir, "captured-argv.json");
		const stdinOut = join(dir, "captured-stdin.txt");
		const envOut = join(dir, "captured-env.json");
		const bin = join(dir, "fake-codex.mjs");
		writeFileSync(
			bin,
			[
				"#!/usr/bin/env node",
				"import { writeFileSync, readFileSync } from 'node:fs';",
				`writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(2)));`,
				`writeFileSync(${JSON.stringify(envOut)}, JSON.stringify(process.env));`,
				"const stdin = readFileSync(0, 'utf-8');",
				`writeFileSync(${JSON.stringify(stdinOut)}, stdin);`,
				"console.log(JSON.stringify({type:'thread.started',thread_id:'" +
					THREAD_ID +
					"'}));",
				"process.exit(0);",
			].join("\n"),
			{ mode: 0o755 },
		);
		return { bin, argvOut, stdinOut, envOut };
	}

	function makeState(overrides?: Partial<CodexCycleState>): {
		statePath: string;
		state: CodexCycleState;
	} {
		const promptPath = join(dir, "prompt.txt");
		if (!overrides || !("promptText" in (overrides as object))) {
			writeFileSync(promptPath, "default prompt", { mode: 0o600 });
		}
		const state: CodexCycleState = {
			version: 1,
			mode: "resume",
			threadId: THREAD_ID,
			promptPath,
			cwd: dir,
			jsonlPath: join(dir, "out.jsonl"),
			lastMessagePath: join(dir, "last.txt"),
			doneMarkerPath: join(dir, "done.json"),
			...overrides,
		};
		const statePath = join(dir, "state.json");
		writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
		return { statePath, state };
	}

	describe("argv shapes (Spike-δ verified flag surfaces)", () => {
		it("fresh includes -C and -s; prompt via stdin sentinel", () => {
			const argv = buildCodexCycleArgv({
				version: 1,
				mode: "fresh",
				promptPath: "/p",
				cwd: "/work",
				jsonlPath: "/j",
				lastMessagePath: "/l",
				doneMarkerPath: "/d",
			});
			expect(argv).toEqual([
				"exec",
				"--json",
				"-o",
				"/l",
				"-C",
				"/work",
				"-s",
				"workspace-write",
				"-",
			]);
		});

		it("QA Finding 1: fresh emits writable_roots + network_access -c flags; resume does NOT (params persist)", () => {
			const base = {
				version: 1 as const,
				promptPath: "/p",
				cwd: "/work",
				jsonlPath: "/j",
				lastMessagePath: "/l",
				doneMarkerPath: "/d",
				writableRoots: ["/Users/me/.flywheel", "/tmp/qa-gates"],
				networkAccess: true,
			};
			const fresh = buildCodexCycleArgv({ ...base, mode: "fresh" });
			expect(fresh).toContain(
				'sandbox_workspace_write.writable_roots=["/Users/me/.flywheel","/tmp/qa-gates"]',
			);
			expect(fresh).toContain("sandbox_workspace_write.network_access=true");
			// -c flags precede the stdin sentinel
			expect(fresh[fresh.length - 1]).toBe("-");

			const resume = buildCodexCycleArgv({
				...base,
				mode: "resume",
				threadId: THREAD_ID,
			});
			expect(resume.join(" ")).not.toContain("sandbox_workspace_write");
		});

		it("FLY-123 WS-C: GH_TOKEN never rides the argv (fresh OR resume) — delivered via $CODEX_HOME/config.toml", () => {
			// The token is no longer a cycle-state field; even if a stray
			// `ghToken` were present it must NEVER reach the codex argv (ps leak).
			const base = {
				version: 1 as const,
				promptPath: "/p",
				cwd: "/work",
				jsonlPath: "/j",
				lastMessagePath: "/l",
				doneMarkerPath: "/d",
				// deliberately include a stray ghToken to prove it is ignored
				ghToken: "ghp_TESTTOKEN123",
			} as Record<string, unknown>;
			const fresh = buildCodexCycleArgv({
				...(base as object),
				mode: "fresh",
			} as never);
			expect(fresh.join(" ")).not.toContain("GH_TOKEN");
			expect(fresh.join(" ")).not.toContain("shell_environment_policy");
			const resume = buildCodexCycleArgv({
				...(base as object),
				mode: "resume",
				threadId: THREAD_ID,
			} as never);
			expect(resume.join(" ")).not.toContain("GH_TOKEN");
			expect(resume.join(" ")).not.toContain("shell_environment_policy");
		});

		it("FLY-123 WS-C: validateCycleState no longer requires/parses a credential field", () => {
			// state carries paths/metadata only — never a credential. A state
			// object with no ghToken validates fine; any stray ghToken is simply
			// not surfaced on the validated shape.
			const base = {
				version: 1,
				mode: "fresh" as const,
				promptPath: "/p",
				cwd: "/w",
				jsonlPath: "/j",
				lastMessagePath: "/l",
				doneMarkerPath: "/d",
			};
			const validated = validateCycleState(base) as Record<string, unknown>;
			expect(validated.ghToken).toBeUndefined();
			// argv from a clean state has no credential surface
			expect(
				buildCodexCycleArgv(validateCycleState(base)).join(" "),
			).not.toContain("GH_TOKEN");
		});

		it("QA Finding 1: validation rejects relative/quoted writableRoots and non-bool networkAccess", () => {
			const base = {
				version: 1,
				mode: "fresh" as const,
				promptPath: "/p",
				cwd: "/w",
				jsonlPath: "/j",
				lastMessagePath: "/l",
				doneMarkerPath: "/d",
			};
			expect(() =>
				validateCycleState({ ...base, writableRoots: ["relative/path"] }),
			).toThrow(/writableRoots/);
			expect(() =>
				validateCycleState({ ...base, writableRoots: ['/has"quote'] }),
			).toThrow(/writableRoots/);
			expect(() =>
				validateCycleState({ ...base, networkAccess: "yes" }),
			).toThrow(/networkAccess/);
			expect(
				validateCycleState({
					...base,
					writableRoots: ["/ok"],
					networkAccess: true,
				}).writableRoots,
			).toEqual(["/ok"]);
		});

		it("resume EXCLUDES -C and -s (regression: spike caught unexpected-argument)", () => {
			const argv = buildCodexCycleArgv({
				version: 1,
				mode: "resume",
				threadId: THREAD_ID,
				promptPath: "/p",
				cwd: "/work",
				jsonlPath: "/j",
				lastMessagePath: "/l",
				doneMarkerPath: "/d",
			});
			expect(argv).toEqual([
				"exec",
				"resume",
				THREAD_ID,
				"--json",
				"-o",
				"/l",
				"-",
			]);
			expect(argv).not.toContain("-C");
			expect(argv).not.toContain("-s");
		});

		it("neither shape contains Claude-only flags (R1 #9)", () => {
			for (const mode of ["fresh", "resume"] as const) {
				const argv = buildCodexCycleArgv({
					version: 1,
					mode,
					threadId: THREAD_ID,
					promptPath: "/p",
					cwd: "/w",
					jsonlPath: "/j",
					lastMessagePath: "/l",
					doneMarkerPath: "/d",
				});
				for (const claudeFlag of [
					"--permission-mode",
					"--append-system-prompt-file",
					"--allowed-tools",
					"--agent-id",
					"--session-id",
				]) {
					expect(argv).not.toContain(claudeFlag);
				}
			}
		});
	});

	describe("validation (content gate)", () => {
		it("rejects non-UUID threadId", () => {
			expect(() =>
				validateCycleState({
					version: 1,
					mode: "resume",
					threadId: "abc; rm -rf /",
					promptPath: "/p",
					cwd: "/w",
					jsonlPath: "/j",
					lastMessagePath: "/l",
					doneMarkerPath: "/d",
				}),
			).toThrow(/UUID threadId/);
		});

		it("rejects relative paths", () => {
			expect(() =>
				validateCycleState({
					version: 1,
					mode: "fresh",
					promptPath: "relative/p",
					cwd: "/w",
					jsonlPath: "/j",
					lastMessagePath: "/l",
					doneMarkerPath: "/d",
				}),
			).toThrow(/absolute path/);
		});

		it("rejects unknown sandbox + bad model strings", () => {
			const base = {
				version: 1,
				mode: "fresh" as const,
				promptPath: "/p",
				cwd: "/w",
				jsonlPath: "/j",
				lastMessagePath: "/l",
				doneMarkerPath: "/d",
			};
			expect(() => validateCycleState({ ...base, sandbox: "yolo" })).toThrow(
				/invalid sandbox/,
			);
			expect(() =>
				validateCycleState({ ...base, model: "gpt 5.5; echo" }),
			).toThrow(/invalid model/);
		});

		it("rejects non-0600 state file", async () => {
			const { statePath } = makeState();
			chmodSync(statePath, 0o644);
			await expect(codexResume({ statePath })).rejects.toThrow(/must be 0600/);
		});

		it("rejects malformed --message dedupe keys", async () => {
			const { statePath } = makeState();
			await expect(
				codexResume({ statePath, message: "x; rm -rf /" }),
			).rejects.toThrow(/--message must match/);
		});
	});

	describe("adversarial reply bytes (R2 #2 core contract)", () => {
		const ADVERSARIAL = [
			'double "quotes" inside',
			"single 'quotes' inside",
			"newline\nin the\nmiddle",
			"semicolon; rm -rf /tmp/should-not-run",
			"backtick `whoami` here",
			"dollar $(touch /tmp/should-not-exist) expansion",
			"--model injected-flag-attempt",
			"unicode 中文回复 🚀 émojis",
		].join("\n---\n");

		it("reply reaches codex byte-exact via stdin; argv has only validated tokens", async () => {
			const { bin, argvOut, stdinOut } = writeCaptureBin();
			const { statePath, state } = makeState();
			writeFileSync(state.promptPath, ADVERSARIAL, { mode: 0o600 });

			const exitCode = await codexResume({
				statePath,
				message: "msg-uuid-1234",
				env: { ...process.env, FLYWHEEL_CODEX_BIN: bin },
			});
			expect(exitCode).toBe(0);

			// stdin: byte-exact
			expect(readFileSync(stdinOut, "utf-8")).toBe(ADVERSARIAL);

			// argv: fixed validated tokens only — no reply bytes anywhere
			const argv = JSON.parse(readFileSync(argvOut, "utf-8")) as string[];
			expect(argv).toEqual([
				"exec",
				"resume",
				THREAD_ID,
				"--json",
				"-o",
				state.lastMessagePath,
				"-",
			]);
			for (const token of argv) {
				expect(token).not.toMatch(/rm -rf|whoami|touch|injected-flag/);
			}

			// jsonl captured; done marker written with exit code + thread id
			expect(readFileSync(state.jsonlPath, "utf-8")).toContain(
				"thread.started",
			);
			const marker = JSON.parse(readFileSync(state.doneMarkerPath, "utf-8"));
			expect(marker.exitCode).toBe(0);
			expect(marker.threadId).toBe(THREAD_ID);
			expect(marker.message).toBe("msg-uuid-1234");
		});

		it("FLY-123 WS-C (R1 HIGH #1): inherited GitHub-token env is stripped from the spawned process", async () => {
			const { bin, envOut } = writeCaptureBin();
			const { statePath } = makeState();
			// Pass GH_TOKEN / GITHUB_TOKEN in the env — they must NOT reach the
			// spawned shim/codex process (token's only surface is config.toml).
			const exitCode = await codexResume({
				statePath,
				env: {
					...process.env,
					FLYWHEEL_CODEX_BIN: bin,
					GH_TOKEN: "ghp_INHERITED_SECRET",
					GITHUB_TOKEN: "ghp_INHERITED_SECRET2",
				},
			});
			expect(exitCode).toBe(0);
			const spawnedEnv = JSON.parse(readFileSync(envOut, "utf-8")) as Record<
				string,
				string
			>;
			expect(spawnedEnv.GH_TOKEN).toBeUndefined();
			expect(spawnedEnv.GITHUB_TOKEN).toBeUndefined();
			// non-secret env still passes through
			expect(spawnedEnv.PATH).toBeDefined();
		});

		it("propagates codex non-zero exit through the done marker", async () => {
			const failBin = join(dir, "fail-codex.mjs");
			writeFileSync(failBin, "#!/usr/bin/env node\nprocess.exit(3);\n", {
				mode: 0o755,
			});
			const { statePath, state } = makeState();
			const exitCode = await codexResume({
				statePath,
				env: { ...process.env, FLYWHEEL_CODEX_BIN: failBin },
			});
			expect(exitCode).toBe(3);
			const marker = JSON.parse(readFileSync(state.doneMarkerPath, "utf-8"));
			expect(marker.exitCode).toBe(3);
		});
	});
});
