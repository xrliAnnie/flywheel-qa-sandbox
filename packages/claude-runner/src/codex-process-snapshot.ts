/**
 * FLY-2877 — which live processes hold a keyed Codex home lease.
 *
 * The process authority below is a verbatim copy of FLY-2869's
 * `packages/teamlead/src/codex-quota/host-process-snapshot.ts` contract, so the
 * lease guard calls a process "codex" exactly when the readiness collector
 * does. teamlead depends on this package, not the other way round, which is why
 * the contract lives here twice until FLY-2869 lands and one copy can import
 * the other (follow-up F2).
 *
 * A process is Codex only when the kernel's executable name (`ucomm`, set from
 * the exec'd file, not from argv0) is `codex`, and its environment is read only
 * from the part of the authoritative line after a stable argv: args are
 * captured before and after the authoritative snapshot and must be byte-equal,
 * so neither an exec between snapshots nor an argv token that looks like
 * `CODEX_HOME=…` can pass for an environment fact. Anything that does not line
 * up is an unattributed reader (fail closed).
 *
 * On top of it, a holder probe answers "which codex processes still read this
 * home for this execution" with pids only — never a command line, which can
 * carry credentials — and answers unknown whenever the authority cannot vouch
 * for every codex process on the host.
 */

import { execFile } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const PS_TIMEOUT_MS = 3000;
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

export type CodexLeaseHolderProbeResult =
	| { status: "ok"; holders: number[] }
	| {
			status: "unknown";
			reason:
				| "process_authority_invalid"
				| "unattributed_present"
				| "probe_failed";
	  };

/**
 * Which codex processes read `home` for `executionId`. `deadlineMs` bounds the
 * whole capture; without it each of the three `ps` calls gets its own 3 s.
 */
export type CodexLeaseHolderProbe = (
	home: string,
	executionId: string,
	options?: { deadlineMs?: number },
) => Promise<CodexLeaseHolderProbeResult>;

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

/**
 * Three `ps` reads sharing one remaining deadline. Each read is still capped
 * at 3 s; a read that cannot start before the deadline throws.
 */
export async function captureCodexProcessSnapshot(
	deadlineMs?: number,
): Promise<CodexProcessSnapshot> {
	const startedAt = Date.now();
	const ps = async (args: string[]) => {
		let timeout = PS_TIMEOUT_MS;
		if (deadlineMs !== undefined) {
			const remaining = deadlineMs - (Date.now() - startedAt);
			if (remaining <= 0) throw new Error("process_probe_deadline");
			timeout = Math.min(timeout, remaining);
		}
		return (
			await execFileAsync("/bin/ps", args, {
				timeout,
				maxBuffer: MAX_SNAPSHOT_BYTES,
				encoding: "utf8",
			})
		).stdout;
	};
	const argsBefore = await ps(["-axww", "-o", "pid=,lstart=,command="]);
	const authoritative = await ps([
		"-axwwE",
		"-o",
		"pid=,lstart=,stat=,ucomm=,command=",
	]);
	const argsAfter = await ps(["-axww", "-o", "pid=,lstart=,command="]);
	return { argsBefore, authoritative, argsAfter };
}

/**
 * Holders of one execution's lease in one home. Paths compare after lexical
 * normalisation only, so a trailing slash never hides a live reader.
 */
export function holdersFromSnapshot(
	snapshot: CodexProcessSnapshot,
	home: string,
	executionId: string,
): CodexLeaseHolderProbeResult {
	let parsed: ReturnType<typeof parseCodexProcessSnapshot>;
	try {
		parsed = parseCodexProcessSnapshot(snapshot);
	} catch {
		return { status: "unknown", reason: "process_authority_invalid" };
	}
	if (parsed.unattributed.length > 0) {
		return { status: "unknown", reason: "unattributed_present" };
	}
	const target = resolvePath(home);
	const holders = parsed.codex
		.filter(
			(record) =>
				record.executionId === executionId &&
				record.codexHome !== null &&
				resolvePath(record.codexHome) === target,
		)
		.map((record) => record.pid)
		.sort((a, b) => a - b);
	return { status: "ok", holders };
}

export const defaultCodexLeaseHolderProbe: CodexLeaseHolderProbe = async (
	home,
	executionId,
	options,
) => {
	let snapshot: CodexProcessSnapshot;
	try {
		snapshot = await captureCodexProcessSnapshot(options?.deadlineMs);
	} catch {
		return { status: "unknown", reason: "probe_failed" };
	}
	return holdersFromSnapshot(snapshot, home, executionId);
};
