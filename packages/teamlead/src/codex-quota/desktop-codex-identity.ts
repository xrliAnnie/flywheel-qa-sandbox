/**
 * FLY-2869 — the founder ruled (2026-09-25) that the codex app-server embedded
 * in the ChatGPT desktop app does not count as a Flywheel credential reader.
 * It is excluded only on verifiable identity, never by name: argv0, the
 * kernel's executable path (`lsof -d txt`) and the code signature must all
 * agree. Anything else stays an unattributed reader (fail closed).
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";

export const DESKTOP_CODEX_PATH =
	"/Applications/ChatGPT.app/Contents/Resources/codex";
const LEAF_AUTHORITY =
	"Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)";
const TEAM_IDENTIFIER = "2DC432GLL2";
const MAX_OUTPUT = 64 * 1024;

export interface DesktopCodexToolResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface DesktopCodexVerifierOptions {
	run?: (
		file: string,
		args: string[],
		timeoutMs: number,
	) => Promise<DesktopCodexToolResult>;
	stat?: (path: string) => { ino: number; mtimeMs: number };
}

function runTool(
	file: string,
	args: string[],
	timeoutMs: number,
): Promise<DesktopCodexToolResult> {
	return new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{ timeout: timeoutMs, maxBuffer: MAX_OUTPUT, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error && typeof error.code !== "number") {
					reject(error);
					return;
				}
				resolve({
					exitCode: typeof error?.code === "number" ? error.code : 0,
					stdout,
					stderr,
				});
			},
		);
	});
}

/** Exact signature contract: leaf Authority and a single TeamIdentifier. */
function signedByOpenAi(describe: string): boolean {
	const lines = describe.split("\n");
	const authorities = lines.filter((line) => line.startsWith("Authority="));
	const teams = lines.filter((line) => line.startsWith("TeamIdentifier="));
	return (
		authorities[0] === `Authority=${LEAF_AUTHORITY}` &&
		teams.length === 1 &&
		teams[0] === `TeamIdentifier=${TEAM_IDENTIFIER}`
	);
}

export function createDesktopCodexVerifier(
	options: DesktopCodexVerifierOptions = {},
): (pid: number, argv0: string) => Promise<boolean> {
	const run = options.run ?? runTool;
	const stat =
		options.stat ??
		((path: string) => {
			const value = statSync(path);
			return { ino: value.ino, mtimeMs: value.mtimeMs };
		});
	const signatureCache = new Map<string, boolean>();
	const signatureValid = async (): Promise<boolean> => {
		const { ino, mtimeMs } = stat(DESKTOP_CODEX_PATH);
		const key = `${DESKTOP_CODEX_PATH}\0${ino}\0${mtimeMs}`;
		const cached = signatureCache.get(key);
		if (cached !== undefined) return cached;
		const verified = await run(
			"/usr/bin/codesign",
			["--verify", DESKTOP_CODEX_PATH],
			20_000,
		);
		const described =
			verified.exitCode === 0
				? await run(
						"/usr/bin/codesign",
						["-dv", "--verbose=2", DESKTOP_CODEX_PATH],
						20_000,
					)
				: null;
		const valid =
			described !== null &&
			described.exitCode === 0 &&
			signedByOpenAi(described.stderr);
		signatureCache.clear();
		signatureCache.set(key, valid);
		return valid;
	};
	return async (pid, argv0) => {
		if (argv0 !== DESKTOP_CODEX_PATH || !Number.isSafeInteger(pid))
			return false;
		try {
			const lsof = await run(
				"/usr/sbin/lsof",
				["-a", "-p", String(pid), "-d", "txt", "-Fn"],
				5_000,
			);
			const kernelPath = lsof.stdout
				.split("\n")
				.find((line) => line.startsWith("n"))
				?.slice(1);
			if (lsof.exitCode !== 0 || kernelPath !== DESKTOP_CODEX_PATH)
				return false;
			return await signatureValid();
		} catch {
			return false;
		}
	};
}
