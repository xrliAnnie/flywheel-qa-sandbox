/**
 * FLY-1547 §2.6 (ruling A): the remote-attached Codex runner form.
 *
 * The launcher spawns a per-session `codex app-server --remote-control`
 * daemon (imported FLY-1188 machinery: single-owner lock, short socket,
 * group-kill teardown), boots the thread with a bounded READY turn (a
 * turnless thread has no rollout and cannot be resumed — FLY-398 lesson,
 * re-proven by the FLY-1547 spike), persists {socket, thread, pgid} into
 * runner-state, and the tmux pane runs `codex resume --remote` so every
 * externally driven turn renders in the founder-visible TUI. The assignment
 * itself is delivered as the first real turn at activation, idempotent under
 * a stable clientUserMessageId.
 *
 * Teardown is restart-safe: with a live in-memory handle it is
 * stop()+ensureDead(); after a host restart it falls back to the persisted
 * process group + socket-gone verification (the pid alone lies — the shim
 * dies while the app-server grandchild lives; QA FLY-1188 HIGH-2).
 */
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import {
	CodexDaemonClient,
	connectDaemonTransport,
	type DaemonHandle,
	spawnCodexDaemon,
} from "flywheel-claude-runner";

export interface CodexDaemonState {
	socket_path: string;
	thread_id: string;
	daemon_pid: number;
	daemon_pgid: number | null;
}

export interface CodexRemotePorts {
	spawnDaemon?: typeof spawnCodexDaemon;
	connect?: typeof connectDaemonTransport;
	clientFactory?: (
		transport: unknown,
	) => Pick<
		CodexDaemonClient,
		"initialize" | "startThread" | "startTurn" | "readThread" | "close"
	>;
	killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
	processGroupOf?: (pid: number) => number | null;
	/** PIDs currently holding the unix socket open (lsof) — the two-fact
	 * authority rule's first fact. Empty = no proof. */
	socketHolderPids?: (socketPath: string) => number[];
	sleep?: (ms: number) => Promise<void>;
}

/** Real PGID lookup — restart teardown must be able to signal the persisted
 * group (R4-F6: a null default made every restart teardown a silent no-op). */
function defaultProcessGroupOf(pid: number): number | null {
	try {
		const out = execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2_000,
		}).trim();
		const pgid = Number(out);
		return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null;
	} catch {
		return null;
	}
}

/** lsof-based socket holder resolution (mirrors the FLY-1188 machinery). */
function defaultSocketHolderPids(socketPath: string): number[] {
	try {
		const out = execFileSync("lsof", ["-t", "--", socketPath], {
			encoding: "utf8",
			timeout: 2_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out
			.split("\n")
			.map((line) => Number.parseInt(line.trim(), 10))
			.filter((n) => Number.isInteger(n) && n > 0);
	} catch {
		return [];
	}
}

const BOOTSTRAP_TURN_TIMEOUT_MS = 120_000;
const ASSIGNMENT_TURN_TIMEOUT_MS = 30_000;
const TEARDOWN_WAIT_MS = 5_000;

function defaultPorts(ports: CodexRemotePorts): Required<CodexRemotePorts> {
	return {
		spawnDaemon: ports.spawnDaemon ?? spawnCodexDaemon,
		connect: ports.connect ?? connectDaemonTransport,
		clientFactory:
			ports.clientFactory ??
			((transport) =>
				new CodexDaemonClient({
					transport: transport as ConstructorParameters<
						typeof CodexDaemonClient
					>[0]["transport"],
				})),
		killGroup:
			ports.killGroup ??
			((pgid, signal) => {
				process.kill(-pgid, signal);
			}),
		processGroupOf: ports.processGroupOf ?? defaultProcessGroupOf,
		socketHolderPids: ports.socketHolderPids ?? defaultSocketHolderPids,
		sleep: ports.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
	};
}

/** Spawn the daemon, boot + persistably identify the thread. Any failure
 * tears the daemon down before rethrowing — a daemon without a recorded
 * thread is an unowned resident, exactly what must never leak. */
export async function prepareCodexRemote(
	input: {
		codexBin: string;
		codexHome: string;
		socketPath: string;
		cwd: string;
		model: string;
		effort: string;
		/** R3-F5 crash-phase hook: called the moment the daemon is up (before
		 * thread creation) so the caller can persist {socket,pgid} — a crash
		 * between phases leaves a RECORDED orphan the next launch tears down
		 * instead of an unowned resident. */
		onDaemonUp?: (partial: {
			socket_path: string;
			daemon_pid: number;
			daemon_pgid: number | null;
		}) => void;
	},
	ports: CodexRemotePorts = {},
): Promise<{ state: CodexDaemonState; handle: DaemonHandle }> {
	const resolved = defaultPorts(ports);
	const handle = await resolved.spawnDaemon({
		codexBin: input.codexBin,
		codexHome: input.codexHome,
		socketPath: input.socketPath,
		effort: input.effort,
	});
	try {
		// Inside the cleanup scope (R4 new-1): a throwing persistence hook must
		// tear the fresh daemon down, not leak it.
		input.onDaemonUp?.({
			socket_path: input.socketPath,
			daemon_pid: handle.child.pid ?? -1,
			daemon_pgid:
				handle.child.pid != null
					? resolved.processGroupOf(handle.child.pid)
					: null,
		});
		const transport = await resolved.connect({
			socketPath: input.socketPath,
			connectTimeoutMs: 10_000,
		});
		const client = resolved.clientFactory(transport);
		await client.initialize();
		const threadId = await client.startThread({
			cwd: input.cwd,
			sandbox: "workspace-write",
			approvalPolicy: "never",
			model: input.model,
		});
		const readyId = `bootstrap-ready:${threadId}`;
		await client.startTurn(
			threadId,
			"Flywheel v2 runner session initializing. Reply READY and wait silently for your assignment.",
			BOOTSTRAP_TURN_TIMEOUT_MS,
			readyId,
		);
		// R4-F5: startTurn resolves on RPC acceptance, not completion. Resume
		// needs the thread to carry a durable rollout, so wait until thread/read
		// proves the READY message landed (bounded, fail-loud on timeout).
		const deadline = Date.now() + BOOTSTRAP_TURN_TIMEOUT_MS;
		for (;;) {
			const thread = await client.readThread(threadId, 10_000);
			// R5-B1: wait for the READY turn to COMPLETE (not merely land) — the
			// assignment must never race an active bootstrap turn.
			if (threadTurnCompleted(thread, readyId)) break;
			if (Date.now() >= deadline) {
				throw new Error(
					`codex bootstrap turn ${readyId} did not complete within the bound`,
				);
			}
			await resolved.sleep(500);
		}
		client.close?.();
		return {
			handle,
			state: {
				socket_path: input.socketPath,
				thread_id: threadId,
				daemon_pid: handle.child.pid ?? -1,
				daemon_pgid:
					handle.child.pid != null
						? resolved.processGroupOf(handle.child.pid)
						: null,
			},
		};
	} catch (error) {
		handle.stop();
		await handle.ensureDead();
		throw error;
	}
}

/** Does the thread already carry a user message with this correlation id?
 * Structural walk over thread/read (the SAME reconciliation the production
 * Codex executor uses); a stringify fallback keeps unknown shapes safe-side
 * (present ⇒ never replay). */
/** R5-B1: the turn CONTAINING the correlation id must have completed — mere
 * message presence is durable acceptance, not READY completion, and the
 * assignment must not race a still-active bootstrap turn. */
export function threadTurnCompleted(thread: unknown, id: string): boolean {
	const turns = (thread as { turns?: unknown[] })?.turns;
	if (!Array.isArray(turns)) return false;
	for (const turn of turns) {
		const record = turn as { status?: unknown; items?: unknown[] };
		if (!Array.isArray(record.items)) continue;
		for (const item of record.items) {
			const candidate = item as { type?: string; clientId?: unknown };
			if (candidate.type === "userMessage" && candidate.clientId === id) {
				return record.status === "completed";
			}
		}
	}
	return false;
}

function threadCarriesClientMessage(thread: unknown, id: string): boolean {
	try {
		const turns = (thread as { turns?: unknown[] })?.turns;
		if (Array.isArray(turns)) {
			for (const turn of turns) {
				const items = (turn as { items?: unknown[] })?.items;
				if (!Array.isArray(items)) continue;
				for (const item of items) {
					const candidate = item as { type?: string; clientId?: unknown };
					if (candidate.type === "userMessage" && candidate.clientId === id) {
						return true;
					}
				}
			}
		}
	} catch {
		// fall through to the conservative check
	}
	return JSON.stringify(thread ?? "").includes(JSON.stringify(id));
}

/**
 * Deliver a turn into the session's thread (assignment at activation; the
 * mailbox bell later).
 *
 * R3-F5: `clientUserMessageId` is correlation data, NOT an app-server dedup
 * primitive — so the sender RECONCILES FIRST: `thread/read` proves whether a
 * turn with this id already exists (crash-replayed doorbell/activation), and
 * only proven absence starts a new token-consuming turn.
 */
export async function sendCodexTurn(
	state: Pick<CodexDaemonState, "socket_path" | "thread_id">,
	text: string,
	clientUserMessageId: string,
	ports: CodexRemotePorts = {},
	timeoutMs = ASSIGNMENT_TURN_TIMEOUT_MS,
): Promise<"started" | "already_present"> {
	const resolved = defaultPorts(ports);
	const transport = await resolved.connect({
		socketPath: state.socket_path,
		connectTimeoutMs: 10_000,
	});
	const client = resolved.clientFactory(transport);
	try {
		await client.initialize();
		const thread = await client.readThread(state.thread_id, 10_000);
		if (threadCarriesClientMessage(thread, clientUserMessageId)) {
			return "already_present";
		}
		await client.startTurn(
			state.thread_id,
			text,
			timeoutMs,
			clientUserMessageId,
		);
		return "started";
	} finally {
		client.close?.();
	}
}

/** Is anything actually LISTENING on the socket? The socket FILE outlives a
 * dead daemon (a stale path is normal), so liveness is a connect probe —
 * refused/none = dead. Same evidence rule as ensureDead (never trust a pid). */
async function socketAlive(
	socketPath: string,
	connect: Required<CodexRemotePorts>["connect"],
): Promise<boolean> {
	try {
		const transport = await connect({ socketPath, connectTimeoutMs: 1_000 });
		(transport as { close?: () => void }).close?.();
		return true;
	} catch {
		return false;
	}
}

/**
 * Restart-safe teardown from persisted state — R5-B2: DESTRUCTIVE AUTHORITY
 * requires proof, never a bare persisted PGID (which may be recycled by an
 * unrelated process after a restart).
 *
 *  - socket dead → NEVER signal anything; just unlink the stale path.
 *  - socket live → resolve the actual holder pids (lsof) and require every
 *    holder's CURRENT process group to agree (and to match the persisted PGID
 *    when one was recorded). Only that proven group is signalled.
 *  - proof unavailable / mismatched / would hit OUR OWN group → refuse
 *    destructively and surface the orphan (return false).
 */
export async function teardownCodexRemote(
	state: Pick<CodexDaemonState, "socket_path" | "daemon_pgid">,
	ports: CodexRemotePorts = {},
): Promise<boolean> {
	const resolved = defaultPorts(ports);
	const cleanupStalePath = () => {
		if (existsSync(state.socket_path)) {
			try {
				unlinkSync(state.socket_path);
			} catch {
				// already unlinked
			}
		}
	};
	if (!(await socketAlive(state.socket_path, resolved.connect))) {
		cleanupStalePath();
		return true;
	}
	const provenGroup = (): number | null => {
		const holders = resolved.socketHolderPids(state.socket_path);
		if (holders.length === 0) return null;
		let group: number | null = null;
		for (const holder of holders) {
			const pgid = resolved.processGroupOf(holder);
			if (pgid == null) return null;
			if (group == null) group = pgid;
			else if (group !== pgid) return null;
		}
		if (group == null) return null;
		if (state.daemon_pgid != null && group !== state.daemon_pgid) return null;
		const ownGroup = resolved.processGroupOf(process.pid);
		if (ownGroup != null && group === ownGroup) return null;
		return group;
	};
	const target = provenGroup();
	if (target == null) return false;
	try {
		resolved.killGroup(target, "SIGTERM");
	} catch {
		// group vanished between proof and signal — the probe below decides
	}
	const deadline = Date.now() + TEARDOWN_WAIT_MS;
	while (
		(await socketAlive(state.socket_path, resolved.connect)) &&
		Date.now() < deadline
	) {
		await resolved.sleep(200);
	}
	if (await socketAlive(state.socket_path, resolved.connect)) {
		// Escalation needs FRESH proof — the group may have changed hands.
		const again = provenGroup();
		if (again == null) return false;
		try {
			resolved.killGroup(again, "SIGKILL");
		} catch {
			// probe decides
		}
		await resolved.sleep(500);
	}
	if (await socketAlive(state.socket_path, resolved.connect)) return false;
	cleanupStalePath();
	return true;
}
