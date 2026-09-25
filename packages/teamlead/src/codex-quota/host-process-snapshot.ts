/**
 * FLY-2869 — which live processes are Codex, and which home they read.
 *
 * The collector used to regex the whole `ps eww` line (argv + environment), so
 * any process whose environment merely mentioned `…/codex` (a Claude runner's
 * XDG_CACHE_HOME, a zsh wrapper, a node script) looked like a Codex reader
 * without CODEX_HOME and kept readiness permanently unavailable.
 *
 * Now a process is Codex only when the kernel's executable name (`ucomm`, set
 * from the exec'd file, not from argv0) is `codex`, and its environment is read
 * only from the part of the authoritative line after a stable argv: args are
 * captured before and after the authoritative snapshot and must be byte-equal,
 * so neither an exec between snapshots nor an argv token that looks like
 * `CODEX_HOME=…` can pass for an environment fact. Anything that does not line
 * up is an unattributed reader (fail closed).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const LINE_RE =
	/^\s*(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;
const ENV_TOKEN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const EXECUTION_ID_RE = /^[A-Za-z0-9_.-]{1,160}$/;
const SINGLE_KEYS = ["CODEX_HOME", "HOME", "FLYWHEEL_EXEC_ID"] as const;

export interface CodexProcessSnapshot {
	/** `ps -axww -o pid=,lstart=,command=` before the authoritative snapshot. */
	argsBefore: string;
	/**
	 * `ps -axwwE -o pid=,lstart=,stat=,ucomm=,command=` (argv followed by the
	 * launch environment). On macOS `-E` shows the environment; `-e` is `-A`.
	 */
	authoritative: string;
	/** Same as argsBefore, taken after the authoritative snapshot. */
	argsAfter: string;
}

export interface CodexProcessRecord {
	pid: number;
	startIdentity: string;
	argv0: string;
	codexHome: string | null;
	home: string | null;
	executionId: string | null;
}

export interface CodexUnattributedProcess {
	pid: number;
	startIdentity: string;
	executable: string;
	reason: "process_home_unknown";
}

function snapshotLines(text: string): string[] {
	if (
		typeof text !== "string" ||
		!text.trim() ||
		text.length > MAX_SNAPSHOT_BYTES
	)
		throw new Error("process_authority_invalid");
	return text.split("\n").filter((line) => line.trim());
}

function parseLine(line: string): {
	pid: number;
	startIdentity: string;
	rest: string;
} {
	const match = LINE_RE.exec(line);
	const pid = Number(match?.[1]);
	if (!match || !Number.isSafeInteger(pid) || pid <= 0)
		throw new Error("process_authority_invalid");
	return { pid, startIdentity: match[2]!, rest: match[3]! };
}

/** A process appears once per snapshot; a repeated (pid, lstart) is not authority. */
function uniqueKey(seen: Set<string>, pid: number, startIdentity: string) {
	const key = `${pid}\0${startIdentity}`;
	if (seen.has(key)) throw new Error("process_authority_invalid");
	seen.add(key);
	return key;
}

function argsIndex(text: string): Map<string, string> {
	const index = new Map<string, string>();
	const seen = new Set<string>();
	for (const line of snapshotLines(text)) {
		const { pid, startIdentity, rest } = parseLine(line);
		index.set(uniqueKey(seen, pid, startIdentity), rest);
	}
	return index;
}

export function parseCodexProcessSnapshot(snapshot: CodexProcessSnapshot): {
	codex: CodexProcessRecord[];
	unattributed: CodexUnattributedProcess[];
} {
	const before = argsIndex(snapshot.argsBefore);
	const after = argsIndex(snapshot.argsAfter);
	const codex: CodexProcessRecord[] = [];
	const unattributed: CodexUnattributedProcess[] = [];
	const seen = new Set<string>();
	for (const line of snapshotLines(snapshot.authoritative)) {
		const { pid, startIdentity, rest: withState } = parseLine(line);
		const key = uniqueKey(seen, pid, startIdentity);
		const state = /^(\S+)\s+(.*)$/.exec(withState);
		if (!state) throw new Error("process_authority_invalid");
		// A zombie has exited: it holds no credentials and has no environment.
		if (state[1]!.startsWith("Z")) continue;
		const rest = state[2]!;
		// ucomm is left-aligned and space padded; only the exact name "codex" counts.
		if (!/^codex\s/.test(rest)) continue;
		const command = rest.slice("codex".length).trimStart();
		const unknown = () =>
			unattributed.push({
				pid,
				startIdentity,
				executable: "codex",
				reason: "process_home_unknown",
			});
		const argvBefore = before.get(key);
		const argvAfter = after.get(key);
		if (argvBefore === undefined || argvBefore !== argvAfter) {
			unknown();
			continue;
		}
		const argv = argvBefore;
		if (command !== argv && !command.startsWith(`${argv} `)) {
			unknown();
			continue;
		}
		const env = new Map<string, string[]>();
		for (const token of command.slice(argv.length).trim().split(/\s+/)) {
			const match = ENV_TOKEN_RE.exec(token);
			if (!match) continue;
			env.set(match[1]!, [...(env.get(match[1]!) ?? []), match[2]!]);
		}
		if (SINGLE_KEYS.some((name) => (env.get(name)?.length ?? 0) > 1)) {
			unknown();
			continue;
		}
		const executionId = env.get("FLYWHEEL_EXEC_ID")?.[0] ?? null;
		if (executionId !== null && !EXECUTION_ID_RE.test(executionId)) {
			unknown();
			continue;
		}
		codex.push({
			pid,
			startIdentity,
			argv0: argv.split(/\s+/)[0]!,
			codexHome: env.get("CODEX_HOME")?.[0] ?? null,
			home: env.get("HOME")?.[0] ?? null,
			executionId,
		});
	}
	return { codex, unattributed };
}

export async function captureCodexProcessSnapshot(): Promise<CodexProcessSnapshot> {
	const ps = async (args: string[]) =>
		(
			await execFileAsync("/bin/ps", args, {
				timeout: 3000,
				maxBuffer: MAX_SNAPSHOT_BYTES,
				encoding: "utf8",
			})
		).stdout;
	const argsBefore = await ps(["-axww", "-o", "pid=,lstart=,command="]);
	const authoritative = await ps([
		"-axwwE",
		"-o",
		"pid=,lstart=,stat=,ucomm=,command=",
	]);
	const argsAfter = await ps(["-axww", "-o", "pid=,lstart=,command="]);
	return { argsBefore, authoritative, argsAfter };
}
