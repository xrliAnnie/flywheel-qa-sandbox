/** Bounded, read-only OS evidence. No process title or window is an identity. */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import {
	type CodexDaemonOwnershipDeps,
	probeCodexDaemonEvidence,
	probeCodexDaemonProcessBinding,
	resolveDaemonSocketPath,
} from "./codex-daemon-runtime.js";
import type {
	ExecutionProcessBinding,
	ExecutionProcessIdentity,
	ExecutionProcessSample,
} from "./execution-process-liveness.js";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 100_000;
const NONCE_KEY = "FLYWHEEL_EXECUTION_NONCE";
const LEGACY_EXEC_KEY = "FLYWHEEL_EXEC_ID";
const DATE =
	"((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2} \\d{2}:\\d{2}:\\d{2} \\d{4})";
const CENSUS_LINE = new RegExp(
	`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+([RSDTtWZIU?][<N+slLWE]*)\\s+${DATE}\\s*$`,
);
const ARGS_LINE = new RegExp(`^\\s*(\\d+)\\s+${DATE}\\s+(.*)$`);
const CENSUS_FIELDS = "pid=,ppid=,pgid=,uid=,stat=,lstart=";
type ProcessRow = ExecutionProcessSample["processes"][number] & { uid: number };
export interface ExecutionProbeControl {
	timeoutMs: number;
	signal?: AbortSignal;
}
export interface ExecutionProbeOutput {
	stdout: string;
	pid?: number;
}
export type ExecutionProbeCommand = (
	file: string,
	args: readonly string[],
	control: ExecutionProbeControl,
) => Promise<ExecutionProbeOutput>;
export interface ExecutionProcessInspectorOptions {
	platform?: NodeJS.Platform;
	uid?: number;
	now?: () => number;
	/** Total elapsed budget, clamped to 5 seconds. */
	deadlineMs?: number;
	signal?: AbortSignal;
	executionId?: string;
	env?: NodeJS.ProcessEnv;
	registeredViewers?: ExecutionProcessIdentity[];
	/** Collaborators must honor timeout/signal and settle only after their owned work drains. */
	runCommand?: ExecutionProbeCommand;
	socketProbe?: (
		path: string,
		control: ExecutionProbeControl,
	) => Promise<boolean>;
}
export type InspectedExecutionProcess = ExecutionProcessIdentity & {
	pgid: number;
	executable: string;
	cwd: string;
};

export type SpawnedExecutionProcessInput = Pick<
	ExecutionProcessBinding,
	"adapter" | "pgid" | "executable" | "cwd" | "nonce" | "nativeSessionId"
> & {
	/** Tmux exec preserves this registered shell identity; never adopt a sibling. */
	expectedLeader?: ExecutionProcessIdentity;
};

/** Accept only an independently identified native worker in the newly spawned group. */
export async function bindSpawnedExecutionProcessGroup(
	input: SpawnedExecutionProcessInput,
	options: ExecutionProcessInspectorOptions = {},
): Promise<ExecutionProcessBinding | null> {
	try {
		if (
			!Number.isSafeInteger(input.pgid) ||
			input.pgid <= 1 ||
			input.nonce === null
		)
			return null;
		absolutePath(input.executable);
		absolutePath(input.cwd);
		const c = capture(options);
		const hostBootId = await c.boot();
		const { expectedLeader, ...bindingInput } = input;
		if (
			expectedLeader &&
			(expectedLeader.pid !== input.pgid ||
				expectedLeader.hostBootId !== hostBootId)
		)
			return null;
		const group = (await c.processes()).filter(
			(row) => row.pgid === input.pgid && row.state === "running",
		);
		if (group.length === 0 || group.length > 32) return null;
		const candidates: ExecutionProcessBinding[] = [];
		for (const row of group) {
			if (expectedLeader && !matches(row, expectedLeader, hostBootId)) continue;
			const worker = await c.worker(row.pid);
			if (worker.executable !== input.executable || worker.cwd !== input.cwd)
				continue;
			candidates.push({
				version: 1,
				...bindingInput,
				...identity(row, hostBootId),
				writers: group
					.filter((writer) => writer.pid !== row.pid)
					.map((writer) => identity(writer, hostBootId)),
			});
		}
		if (candidates.length !== 1) return null;
		const candidate = candidates[0]!;
		const sample = await captureExecutionProcessSample(candidate, {
			...options,
			deadlineMs: c.control().timeoutMs,
		});
		c.control();
		if (
			!sample ||
			!sample.writersComplete ||
			sample.worker?.executable !== input.executable ||
			sample.worker.cwd !== input.cwd ||
			(input.adapter === "codex-tmux" && sample.daemon !== "alive")
		)
			return null;
		if (
			!sample.nonceWriters?.some(
				(writer) =>
					writer.pid === candidate.pid &&
					writer.startIdentity === candidate.startIdentity &&
					writer.hostBootId === candidate.hostBootId,
			)
		)
			return null;
		candidate.writers = (sample.discoveredWriters ?? []).filter(
			(writer) => writer.pid !== candidate.pid,
		);
		return candidate;
	} catch {
		return null;
	}
}

/** Read-only backfill candidate for a pre-binding Claude launch. The native
 * session argument is association metadata only: executable/cwd and PID/start/
 * boot come from independent OS reads. A rewritten title with no native session
 * association stays unknown; it never proves absence. No window participates. */
export async function discoverLegacyClaudeProcessBinding(
	input: {
		executionId: string;
		nativeSessionId: string;
		executable: string;
		cwd: string;
	},
	options: ExecutionProcessInspectorOptions = {},
): Promise<ExecutionProcessBinding | null> {
	try {
		if (
			!/^[A-Za-z0-9_-]{1,256}$/.test(input.executionId) ||
			!/^[a-fA-F0-9-]{36}$/.test(input.nativeSessionId)
		)
			return null;
		absolutePath(input.executable);
		absolutePath(input.cwd);
		const c = capture(options);
		const hostBootId = await c.boot();
		const rows = await c.processes();
		const argv = argvIndex(
			await c.run("/bin/ps", ["-axww", "-o", "pid=,lstart=,command="]),
		);
		const uid = options.uid ?? process.getuid?.();
		if (uid === undefined) return null;
		const candidates: ExecutionProcessBinding[] = [];
		for (const row of rows) {
			if (row.uid !== uid || row.state !== "running" || c.owned.has(row.pid))
				continue;
			const args = argv.get(row.pid);
			if (!args || args.start !== row.startIdentity) return null;
			const tokens = args.text.trim().split(/\s+/);
			const sessionArgs = tokens.flatMap((token, i) =>
				token === "--session-id" || token === "--resume" ? [tokens[i + 1]] : [],
			);
			if (sessionArgs.length !== 1 || sessionArgs[0] !== input.nativeSessionId)
				continue;
			const worker = await c.worker(row.pid);
			if (worker.executable !== input.executable || worker.cwd !== input.cwd)
				continue;
			candidates.push({
				version: 1,
				adapter: "claude-tmux",
				...identity(row, hostBootId),
				pgid: row.pgid,
				executable: input.executable,
				cwd: input.cwd,
				nonce: null,
				legacyExecutionId: input.executionId,
				nativeSessionId: input.nativeSessionId,
				writers: [],
			});
			if (candidates.length > 1) return null;
		}
		if (candidates.length !== 1) return null;
		const candidate = candidates[0]!;
		const sample = await captureExecutionProcessSample(candidate, {
			...options,
			executionId: input.executionId,
			deadlineMs: c.control().timeoutMs,
		});
		c.control();
		if (
			!sample?.writersComplete ||
			sample.worker?.executable !== input.executable ||
			sample.worker.cwd !== input.cwd ||
			!sample.processes.some(
				(row) =>
					row.pid === candidate.pid &&
					row.startIdentity === candidate.startIdentity &&
					row.state === "running",
			)
		)
			return null;
		// Recheck uniqueness after all discovery awaits: a concurrent native
		// worker cannot turn the initially unique candidate into accepted identity.
		const finalRows = await c.processes();
		const finalArgs = argvIndex(
			await c.run("/bin/ps", ["-axww", "-o", "pid=,lstart=,command="]),
		);
		let finalCandidate: ProcessRow | undefined;
		for (const row of finalRows) {
			if (row.uid !== uid || row.state !== "running" || c.owned.has(row.pid))
				continue;
			const args = finalArgs.get(row.pid);
			if (!args || args.start !== row.startIdentity) return null;
			const tokens = args.text.trim().split(/\s+/);
			const sessions = tokens.flatMap((token, i) =>
				token === "--session-id" || token === "--resume" ? [tokens[i + 1]] : [],
			);
			if (sessions.length !== 1 || sessions[0] !== input.nativeSessionId)
				continue;
			const worker = await c.worker(row.pid);
			if (worker.executable !== input.executable || worker.cwd !== input.cwd)
				continue;
			if (finalCandidate) return null;
			finalCandidate = row;
		}
		if (
			!finalCandidate ||
			!matches(finalCandidate, candidate, hostBootId) ||
			finalCandidate.pgid !== candidate.pgid ||
			(await c.boot()) !== hostBootId
		)
			return null;
		c.control();
		candidate.writers = (sample.discoveredWriters ?? []).filter(
			(writer) => writer.pid !== candidate.pid,
		);
		return candidate;
	} catch {
		return null;
	}
}

export interface PendingExecutionSpawn {
	hostBootId: string;
	nonce: string;
	pgid: number | null;
}
export interface PendingExecutionSpawnAbsence extends PendingExecutionSpawn {
	observedAtMs: number;
	expiresAtMs: number;
}
/** A failed native admission has no accepted worker identity. Prove absence using
 * its durable launch nonce and actual child group, never a fabricated binding. */
export async function capturePendingExecutionSpawnAbsence(
	pending: PendingExecutionSpawn,
	options: ExecutionProcessInspectorOptions = {},
): Promise<PendingExecutionSpawnAbsence | null> {
	try {
		if (
			!options.executionId ||
			!/^[A-Za-z0-9_-]{1,256}$/.test(pending.nonce) ||
			(pending.pgid !== null &&
				(!Number.isSafeInteger(pending.pgid) || pending.pgid <= 1))
		)
			return null;
		const c = capture(options);
		const hostBootId = await c.boot();
		if (hostBootId !== pending.hostBootId) return null;
		const before = await c.processes();
		const argvBefore = argvIndex(
			await c.run("/bin/ps", ["-axww", "-o", "pid=,lstart=,command="]),
		);
		const environment = argvIndex(
			await c.run("/bin/ps", [
				c.platform === "darwin" ? "-axwwE" : "-axwwe",
				"-o",
				"pid=,lstart=,command=",
			]),
		);
		const argvAfter = argvIndex(
			await c.run("/bin/ps", ["-axww", "-o", "pid=,lstart=,command="]),
		);
		if (
			await (options.socketProbe ?? probeSocket)(
				resolveDaemonSocketPath(options.executionId, options.env),
				c.control(),
			)
		)
			return null;
		const after = await c.processes();
		if ((await c.boot()) !== hostBootId) return null;
		const uid = options.uid ?? process.getuid?.();
		if (uid === undefined) return null;
		const rowsByIdentity = new Map(
			[...before, ...after].map((row) => [
				`${row.pid}:${row.startIdentity}`,
				row,
			]),
		);
		for (const row of rowsByIdentity.values()) {
			if (row.state === "zombie" || c.owned.has(row.pid)) continue;
			// A reused group is also a refusal: absence must be independently certain.
			if (pending.pgid !== null && row.pgid === pending.pgid) return null;
			if (row.uid !== uid) continue;
			const tokens = stableEnvironmentTokens(
				row,
				argvBefore,
				environment,
				argvAfter,
			);
			// A same-uid process outside the failed launch's group is not a writer
			// candidate merely because macOS hides its environment.
			if (!tokens) continue;
			const nonces = tokens.filter((token) =>
				token.startsWith(`${NONCE_KEY}=`),
			);
			if (nonces.includes(`${NONCE_KEY}=${pending.nonce}`)) return null;
		}
		c.control();
		return {
			...pending,
			observedAtMs: c.sampledAtMs,
			expiresAtMs: c.sampledAtMs + 10_000,
		};
	} catch {
		return null;
	}
}

/** Timeout/cancel signals ONLY this probe child; resolution waits for its close. */
export function runExecutionProbeCommand(
	file: string,
	args: readonly string[],
	control: ExecutionProbeControl,
	spawnProbe: typeof spawn = spawn,
): Promise<ExecutionProbeOutput> {
	return new Promise((resolve, reject) => {
		const fail = () => reject(new Error("process_probe_unavailable"));
		if (control.signal?.aborted || control.timeoutMs <= 0) {
			fail();
			return;
		}
		let child: ReturnType<typeof spawn>;
		try {
			child = spawnProbe(file, [...args], {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC0" },
			});
		} catch {
			fail();
			return;
		}
		let invalid = false;
		let bytes = 0;
		const chunks: Buffer[] = [];
		const cancel = () => {
			invalid = true;
			try {
				child.kill("SIGKILL");
			} catch {
				/* close remains the drain fence */
			}
		};
		const timer = setTimeout(cancel, Math.min(5000, control.timeoutMs));
		control.signal?.addEventListener("abort", cancel, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_BYTES) {
				cancel();
				return;
			}
			chunks.push(chunk);
		});
		// Drain stderr without retaining potentially credential-bearing diagnostics.
		child.stderr?.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_BYTES) cancel();
		});
		child.on("error", () => {
			invalid = true;
		});
		child.on("close", (code: number | null) => {
			clearTimeout(timer);
			control.signal?.removeEventListener("abort", cancel);
			if (invalid || code !== 0) {
				fail();
				return;
			}
			resolve({
				stdout: Buffer.concat(chunks).toString("utf8"),
				pid: child.pid,
			});
		});
		if (control.signal?.aborted) cancel();
	});
}

/** Socket timeout cleanup also drains the owned handle before returning. */
function probeSocket(
	path: string,
	control: ExecutionProbeControl,
): Promise<boolean> {
	return new Promise((resolve, reject) => {
		if (control.signal?.aborted || control.timeoutMs <= 0) {
			reject(new Error("process_probe_unavailable"));
			return;
		}
		const socket = connect(path);
		let alive = false;
		let unknown = false;
		const cancel = () => {
			unknown = true;
			socket.destroy();
		};
		const timer = setTimeout(cancel, control.timeoutMs);
		control.signal?.addEventListener("abort", cancel, { once: true });
		socket.on("connect", () => {
			alive = true;
			socket.destroy();
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			unknown = error.code !== "ENOENT" && error.code !== "ECONNREFUSED";
			socket.destroy();
		});
		socket.on("close", () => {
			clearTimeout(timer);
			control.signal?.removeEventListener("abort", cancel);
			if (unknown) reject(new Error("process_probe_unavailable"));
			else resolve(alive);
		});
		if (control.signal?.aborted) cancel();
	});
}

function lines(text: string, empty = false): string[] {
	if (
		typeof text !== "string" ||
		Buffer.byteLength(text) > MAX_BYTES ||
		(!empty && !text.trim())
	)
		throw new Error("invalid_snapshot");
	const result = text.split("\n").filter((line) => line.trim());
	if (result.length > MAX_ROWS) throw new Error("invalid_snapshot");
	return result;
}
function number(text: string, minimum: number): number {
	const value = Number(text);
	if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum)
		throw new Error("invalid_snapshot");
	return value;
}
function census(text: string): ProcessRow[] {
	const seen = new Set<number>();
	return lines(text).map((line) => {
		const m = CENSUS_LINE.exec(line);
		if (!m) throw new Error("invalid_snapshot");
		const pid = number(m[1]!, 1);
		if (seen.has(pid)) throw new Error("invalid_snapshot");
		seen.add(pid);
		return {
			pid,
			ppid: number(m[2]!, 0),
			pgid: number(m[3]!, 0),
			uid: number(m[4]!, 0),
			state: m[5]!.startsWith("Z") ? "zombie" : "running",
			startIdentity: m[6]!,
		};
	});
}
function argvIndex(text: string): Map<number, { start: string; text: string }> {
	const rows = new Map<number, { start: string; text: string }>();
	for (const line of lines(text)) {
		const m = ARGS_LINE.exec(line);
		if (!m) throw new Error("invalid_snapshot");
		const pid = number(m[1]!, 1);
		if (rows.has(pid)) throw new Error("invalid_snapshot");
		rows.set(pid, { start: m[2]!, text: m[3]! });
	}
	return rows;
}
function stableEnvironmentTokens(
	row: ProcessRow,
	argvBefore: Map<number, { start: string; text: string }>,
	environment: Map<number, { start: string; text: string }>,
	argvAfter: Map<number, { start: string; text: string }>,
): string[] | undefined {
	const before = argvBefore.get(row.pid);
	const env = environment.get(row.pid);
	const after = argvAfter.get(row.pid);
	if (
		!before ||
		!env ||
		!after ||
		before.start !== row.startIdentity ||
		env.start !== row.startIdentity ||
		after.start !== row.startIdentity ||
		before.text !== after.text ||
		!env.text.startsWith(`${before.text} `)
	)
		return undefined;
	const tokens = env.text
		.slice(before.text.length + 1)
		.trim()
		.split(/\s+/);
	return tokens.some((token) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
		? tokens
		: undefined;
}
function writerCandidatePids(
	rows: ProcessRow[],
	binding: ExecutionProcessBinding,
	hostBootId: string,
	isViewer: (row: ProcessRow) => boolean,
): Set<number> {
	const candidates = new Set<number>();
	for (const row of rows) {
		if (row.state === "zombie" || isViewer(row)) continue;
		if (
			row.pgid === binding.pgid ||
			binding.writers.some((writer) => matches(row, writer, hostBootId))
		)
			candidates.add(row.pid);
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows) {
			if (
				row.state !== "zombie" &&
				!isViewer(row) &&
				candidates.has(row.ppid) &&
				!candidates.has(row.pid)
			) {
				candidates.add(row.pid);
				changed = true;
			}
		}
	}
	return candidates;
}
function identity(
	row: ProcessRow,
	hostBootId: string,
): ExecutionProcessIdentity {
	return { pid: row.pid, startIdentity: row.startIdentity, hostBootId };
}
function matches(
	row: ProcessRow,
	value: ExecutionProcessIdentity,
	boot: string,
): boolean {
	return (
		row.pid === value.pid &&
		row.startIdentity === value.startIdentity &&
		value.hostBootId === boot
	);
}
function absolutePath(value: string): string {
	if (!value.startsWith("/") || value.length > 4096 || /\p{Cc}/u.test(value))
		throw new Error("invalid_path");
	return value;
}
function capture(options: ExecutionProcessInspectorOptions) {
	const platform = options.platform ?? process.platform;
	if (platform !== "darwin" && platform !== "linux")
		throw new Error("unsupported_platform");
	const now = options.now ?? Date.now;
	const sampledAtMs = now();
	const budget = Math.min(5000, options.deadlineMs ?? 5000);
	if (!Number.isFinite(budget) || budget <= 0)
		throw new Error("invalid_deadline");
	const owned = new Set<number>();
	const control = (): ExecutionProbeControl => {
		const elapsed = now() - sampledAtMs;
		const remaining = budget - elapsed;
		if (elapsed < 0 || remaining <= 0 || options.signal?.aborted)
			throw new Error("process_probe_unavailable");
		return { timeoutMs: remaining, signal: options.signal };
	};
	const run = async (file: string, args: string[]) => {
		const result = await (options.runCommand ?? runExecutionProbeCommand)(
			file,
			args,
			control(),
		);
		control();
		if (result.pid !== undefined) owned.add(result.pid);
		lines(result.stdout, true);
		return result.stdout;
	};
	const boot = async () => {
		const result = (
			await run(
				platform === "darwin" ? "/usr/sbin/sysctl" : "/bin/cat",
				platform === "darwin"
					? ["-n", "kern.bootsessionuuid"]
					: ["/proc/sys/kernel/random/boot_id"],
			)
		).trim();
		if (!/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(result))
			throw new Error("invalid_boot");
		return result;
	};
	const processes = async () =>
		census(await run("/bin/ps", ["-ax", "-o", CENSUS_FIELDS]));
	const worker = async (pid: number) => {
		if (platform === "linux") {
			const executable = absolutePath(
				(await run("/usr/bin/readlink", [`/proc/${pid}/exe`])).trimEnd(),
			);
			const cwd = absolutePath(
				(await run("/usr/bin/readlink", [`/proc/${pid}/cwd`])).trimEnd(),
			);
			return { executable, cwd };
		}
		const output = await run("/usr/sbin/lsof", [
			"-nP",
			"-a",
			"-p",
			String(pid),
			"-d",
			"cwd,txt",
			"-F",
			"pfn",
		]);
		let currentFd = "";
		let currentPid: number | undefined;
		let executable: string | undefined;
		let cwd: string | undefined;
		for (const line of lines(output)) {
			if (line[0] === "p") {
				if (currentPid !== undefined) throw new Error("invalid_lsof");
				currentPid = number(line.slice(1), 1);
			} else if (line[0] === "f") currentFd = line.slice(1);
			else if (line[0] === "n") {
				if (currentPid !== pid) throw new Error("invalid_lsof");
				if (currentFd === "cwd") {
					if (cwd !== undefined) throw new Error("invalid_lsof");
					cwd = absolutePath(line.slice(1));
				}
				// The first txt entry is the executable; later txt mappings are libraries.
				else if (currentFd === "txt" && executable === undefined)
					executable = absolutePath(line.slice(1));
				else if (currentFd !== "txt") throw new Error("invalid_lsof");
			} else throw new Error("invalid_lsof");
		}
		if (!cwd || !executable) throw new Error("invalid_lsof");
		return { executable, cwd };
	};
	return {
		platform,
		sampledAtMs,
		owned,
		run,
		boot,
		processes,
		worker,
		control,
	};
}

export async function readExecutionProcessIdentity(
	pid = process.pid,
	options: ExecutionProcessInspectorOptions = {},
): Promise<InspectedExecutionProcess | null> {
	try {
		if (!Number.isSafeInteger(pid) || pid <= 1) return null;
		const c = capture(options);
		const hostBootId = await c.boot();
		const before = (await c.processes()).find((row) => row.pid === pid);
		if (!before || before.state !== "running") return null;
		const worker = await c.worker(pid);
		const verifiedWorker = await c.worker(pid);
		const after = (await c.processes()).find((row) => row.pid === pid);
		if (
			!after ||
			after.state !== "running" ||
			after.startIdentity !== before.startIdentity ||
			after.pgid !== before.pgid ||
			verifiedWorker.executable !== worker.executable ||
			verifiedWorker.cwd !== worker.cwd ||
			(await c.boot()) !== hostBootId
		)
			return null;
		return { ...identity(before, hostBootId), pgid: before.pgid, ...worker };
	} catch {
		return null;
	}
}

export async function captureExecutionProcessSample(
	binding: ExecutionProcessBinding,
	options: ExecutionProcessInspectorOptions = {},
): Promise<ExecutionProcessSample | null> {
	try {
		const c = capture(options);
		const hostBootId = await c.boot();
		const legacy = binding.legacyExecutionId !== undefined;
		if (
			binding.hostBootId !== hostBootId ||
			(legacy
				? binding.adapter !== "claude-tmux" ||
					binding.nonce !== null ||
					!binding.nativeSessionId ||
					!/^[A-Za-z0-9_-]{1,256}$/.test(binding.legacyExecutionId!) ||
					options.executionId !== binding.legacyExecutionId
				: binding.nonce === null ||
					!/^[A-Za-z0-9_-]{1,256}$/.test(binding.nonce))
		)
			return null;
		const attributionKey = legacy ? LEGACY_EXEC_KEY : NONCE_KEY;
		const attributionValue = legacy ? binding.legacyExecutionId : binding.nonce;
		const before = await c.processes();
		const initial = before.find((row) => row.pid === binding.pid);
		if (
			initial &&
			(!matches(initial, binding, hostBootId) || initial.pgid !== binding.pgid)
		)
			return null;
		const worker =
			initial?.state === "running" ? await c.worker(binding.pid) : null;
		const args = ["-axww"];
		const argvBefore = argvIndex(
			await c.run("/bin/ps", [...args, "-o", "pid=,lstart=,command="]),
		);
		const environment = argvIndex(
			await c.run("/bin/ps", [
				c.platform === "darwin" ? "-axwwE" : "-axwwe",
				"-o",
				"pid=,lstart=,command=",
			]),
		);
		const argvAfter = argvIndex(
			await c.run("/bin/ps", [...args, "-o", "pid=,lstart=,command="]),
		);
		if (worker) {
			const verifiedWorker = await c.worker(binding.pid);
			if (
				worker.executable !== verifiedWorker.executable ||
				worker.cwd !== verifiedWorker.cwd
			)
				return null;
		}
		const rows = await c.processes();
		if ((await c.boot()) !== hostBootId) return null;
		const current = rows.find((row) => row.pid === binding.pid);
		if (
			(initial === undefined) !== (current === undefined) ||
			(current &&
				(!matches(current, binding, hostBootId) ||
					current.pgid !== binding.pgid ||
					current.state !== initial?.state))
		)
			return null;
		for (const accepted of binding.writers) {
			const row = rows.find((row) => row.pid === accepted.pid);
			if (
				accepted.hostBootId !== hostBootId ||
				(row && !matches(row, accepted, hostBootId))
			)
				return null;
		}
		const viewers = (options.registeredViewers ?? []).filter((viewer) =>
			rows.some((row) => matches(row, viewer, hostBootId)),
		);
		const isViewer = (row: ProcessRow) =>
			viewers.some((viewer) => matches(row, viewer, hostBootId));
		const scopedWriterPids = writerCandidatePids(
			rows,
			binding,
			hostBootId,
			isViewer,
		);
		const initialScopedWriterPids = writerCandidatePids(
			before,
			binding,
			hostBootId,
			isViewer,
		);
		const discovered = new Map<number, ExecutionProcessIdentity>();
		const nonceWriters = new Map<number, ExecutionProcessIdentity>();
		let legacyWorkerAttributed = false;
		let writersComplete = true;
		const uid = options.uid ?? process.getuid?.();
		if (uid === undefined) writersComplete = false;
		for (const row of rows) {
			if (row.state === "zombie" || c.owned.has(row.pid)) continue;
			if (scopedWriterPids.has(row.pid))
				discovered.set(row.pid, identity(row, hostBootId));
			if (row.uid !== uid) continue;
			const tokens = stableEnvironmentTokens(
				row,
				argvBefore,
				environment,
				argvAfter,
			);
			if (!tokens) {
				// Exact group, accepted-writer, and descendant membership already
				// attributes scoped writers. Environment evidence is only needed to
				// discover nonce holders outside that process tree.
				continue;
			}
			const nonces = tokens.filter((token) =>
				token.startsWith(`${attributionKey}=`),
			);
			if (nonces.length > 1) {
				if (
					scopedWriterPids.has(row.pid) ||
					nonces.includes(`${attributionKey}=${attributionValue}`)
				)
					writersComplete = false;
				continue;
			}
			if (nonces[0] === `${attributionKey}=${attributionValue}`) {
				discovered.set(row.pid, identity(row, hostBootId));
				if (!legacy) nonceWriters.set(row.pid, identity(row, hostBootId));
				else if (row.pid === binding.pid) legacyWorkerAttributed = true;
			}
		}
		if (legacy && worker && !legacyWorkerAttributed) return null;
		// A process lost between the first census and attribution could have forked a
		// detached writer during capture. Require a later stable sample for death.
		if (
			before.some(
				(row) =>
					row.uid === uid &&
					row.state === "running" &&
					!c.owned.has(row.pid) &&
					initialScopedWriterPids.has(row.pid) &&
					!rows.some(
						(after) =>
							after.pid === row.pid &&
							after.startIdentity === row.startIdentity,
					),
			)
		)
			writersComplete = false;
		let daemon: ExecutionProcessSample["daemon"];
		if (binding.adapter === "codex-tmux") {
			daemon = "unknown";
			if (options.executionId) {
				const socketPath = resolveDaemonSocketPath(
					options.executionId,
					options.env,
				);
				const socketLive = await (options.socketProbe ?? probeSocket)(
					socketPath,
					c.control(),
				);
				c.control();
				let holders: number[] = [];
				if (socketLive) {
					const output = await c.run(
						c.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof",
						["-nP", "-t", "--", socketPath],
					);
					holders = lines(output).map((line) => number(line.trim(), 1));
					if (new Set(holders).size !== holders.length) return null;
				}
				// Socket holder numbers must still refer to the processes in our census.
				// A new/reused holder, or a fork after nonce attribution, invalidates capture.
				const afterSocket = await c.processes();
				const stableRows = (list: ProcessRow[]) =>
					list
						.filter((row) => !c.owned.has(row.pid))
						.map((row) => JSON.stringify(row))
						.sort()
						.join("\n");
				if (
					stableRows(rows) !== stableRows(afterSocket) ||
					(await c.boot()) !== hostBootId
				)
					return null;
				const deps: CodexDaemonOwnershipDeps = {
					env: options.env,
					isSocketLive: async () => socketLive,
					socketHolderPids: () => holders,
					processStartIdentity: (pid) =>
						rows.find((row) => row.pid === pid)?.startIdentity,
					processGroupOf: (pid) =>
						rows.find((row) => row.pid === pid && row.state === "running")
							?.pgid,
					// A stale ledger group must never lend authority to the accepted binding.
					processGroupState: (pgid) =>
						pgid !== binding.pgid
							? "unknown"
							: rows.some((row) => row.pgid === pgid && row.state === "running")
								? "alive"
								: "absent",
					isPidAlive: (pid) =>
						rows.some((row) => row.pid === pid && row.state === "running"),
				};
				const evidence = await probeCodexDaemonEvidence(
					options.executionId,
					deps,
				);
				c.control();
				if (evidence.liveness === "absent") daemon = "absent";
				else if (
					evidence.liveness === "alive" &&
					(
						await probeCodexDaemonProcessBinding(
							options.executionId,
							binding,
							deps,
						)
					).bound
				)
					daemon = "alive";
			}
		}
		c.control();
		return {
			sampledAtMs: c.sampledAtMs,
			hostBootId,
			processes: rows.map(({ uid: _uid, ...row }) => row),
			worker,
			...(daemon ? { daemon } : {}),
			writersComplete,
			viewers: viewers.filter((viewer) => !discovered.has(viewer.pid)),
			discoveredWriters: [...discovered.values()],
			nonceWriters: [...nonceWriters.values()],
		};
	} catch {
		return null;
	}
}
