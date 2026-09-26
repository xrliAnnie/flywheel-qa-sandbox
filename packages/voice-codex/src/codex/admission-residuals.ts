import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * FLY-2886 plan v12 §14.2: processes left behind by a failed voice background
 * admission. Only exact identities are ever signalled — (pid, start time), read
 * from `ps`; never a process group. Ownership is inherited, never inferred: a
 * process is ours when we spawned it, or when a snapshot shows it as the child
 * of a registered process that is alive in that same snapshot. A registered
 * process that exits before we could observe its descendants breaks the chain;
 * its orphans are reported, never killed.
 */
export interface ProcessRow {
	pid: number;
	ppid: number;
	/** `ps -o lstart` text; with the pid it names exactly one process. */
	start: string;
	zombie: boolean;
}

export interface ResidualSystem {
	/** Every process on the host. */
	snapshot(): ProcessRow[];
	signal(pid: number, signal: "SIGSTOP" | "SIGKILL"): void;
	removeDirectory(path: string): void;
	/** Lets the event loop reap killed children between checks. */
	pause(ms: number): Promise<void>;
}

type IdentityState = "alive" | "gone" | "unprovable";
interface IdentityRecord {
	pid: number;
	start: string;
	parent?: { pid: number; start: string };
	/** Seen alive in a reap snapshot, so its descendants were observable. */
	observed: boolean;
	frozen: boolean;
	killed: boolean;
	state: IdentityState;
}
interface ResidualFile {
	version: 1;
	sessionId: string;
	identities: IdentityRecord[];
	directories: string[];
	attempts: number;
	reportedUnsettled: boolean;
}

export type ResidualOutcome = "settled" | "pending";
const MAX_FREEZE_ROUNDS = 8;
/** Confirmation polls after SIGKILL (50ms apart), bounding one attempt to ~2s. */
const KILL_CONFIRM_ROUNDS = 40;
const REPORT_AFTER_ATTEMPTS = 3;
const key = (row: { pid: number; start: string }) => `${row.pid}@${row.start}`;
const startMs = (start: string) => Date.parse(start);

/** macOS `ps`: `pid ppid stat lstart…` (lstart has spaces). */
export function parseProcessTable(text: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of text.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
		if (!match) continue;
		rows.push({
			pid: Number(match[1]),
			ppid: Number(match[2]),
			start: match[4]!,
			zombie: match[3]!.startsWith("Z"),
		});
	}
	return rows;
}

export const hostResidualSystem: ResidualSystem = {
	snapshot: () =>
		parseProcessTable(
			execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,stat=,lstart="], {
				encoding: "utf8",
				timeout: 5_000,
				maxBuffer: 16 * 1024 * 1024,
				stdio: ["ignore", "pipe", "ignore"],
				env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
			}),
		),
	signal: (pid, signal) => {
		process.kill(pid, signal);
	},
	removeDirectory: (path) => rmSync(path, { recursive: true, force: true }),
	pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class AdmissionResiduals {
	private readonly identities = new Map<string, IdentityRecord>();
	private readonly directories = new Set<string>();
	private attempts = 0;
	private reportedUnsettled = false;
	private removed = false;

	constructor(
		private readonly options: {
			path: string;
			sessionId: string;
			system: ResidualSystem;
			report(line: string): void;
		},
		file?: ResidualFile,
	) {
		if (file) {
			for (const row of file.identities) this.identities.set(key(row), row);
			for (const path of file.directories) this.directories.add(path);
			this.attempts = file.attempts;
			this.reportedUnsettled = file.reportedUnsettled;
		}
	}

	get sessionId(): string {
		return this.options.sessionId;
	}

	/** A child we just spawned. Its identity is read now, before it can be reused. */
	registerSpawned(pid: number): void {
		let row: ProcessRow | undefined;
		try {
			row = this.options.system
				.snapshot()
				.find((candidate) => candidate.pid === pid);
		} catch {
			row = undefined;
		}
		const identity: IdentityRecord = row
			? {
					pid,
					start: row.start,
					observed: false,
					frozen: false,
					killed: false,
					state: row.zombie ? "gone" : "alive",
				}
			: {
					pid,
					start: "unknown",
					observed: false,
					frozen: false,
					killed: false,
					state: "gone",
				};
		this.identities.set(key(identity), identity);
		if (identity.state === "gone") this.unprovable(identity);
		// A late continuation may register after an earlier attempt settled.
		this.removed = false;
		this.persist();
	}

	registerDirectory(path: string): void {
		this.directories.add(path);
		this.removed = false;
		this.persist();
	}

	get pending(): boolean {
		return (
			[...this.identities.values()].some((row) => row.state === "alive") ||
			this.directories.size > 0
		);
	}

	/**
	 * Snapshot, freeze, re-snapshot until no new descendant appears, kill, confirm.
	 * Settled only once every registered identity is gone and every directory is
	 * removed; the file is then deleted.
	 */
	async reap(
		evidence?: (record: Record<string, unknown>) => void,
	): Promise<ResidualOutcome> {
		this.attempts++;
		const record = (outcome: string) => {
			const summary = {
				kind: "codex_voice_admission_residual",
				sessionId: this.options.sessionId,
				attempt: this.attempts,
				outcome,
				identities: [...this.identities.values()].map((row) => ({
					pid: row.pid,
					start: row.start,
					state: row.state,
					...(row.parent ? { parent: row.parent } : {}),
				})),
				directories: this.directories.size,
			};
			evidence?.(summary);
		};
		try {
			let table = this.observe();
			for (const row of this.alive()) this.freeze(row, table);
			let settledTree = false;
			for (let round = 0; round < MAX_FREEZE_ROUNDS; round++) {
				table = this.observe();
				const fresh = this.alive().filter((row) => !row.frozen);
				if (!fresh.length) {
					settledTree = true;
					break;
				}
				for (const row of fresh) this.freeze(row, table);
			}
			if (!settledTree) {
				this.persist();
				record("pending");
				this.reportIfStuck();
				return "pending";
			}
			for (const row of this.alive()) this.kill(row, table);
			for (
				let round = 0;
				round < KILL_CONFIRM_ROUNDS && this.alive().length;
				round++
			) {
				await this.options.system.pause(50);
				this.observe(false);
			}
			for (const path of [...this.directories]) {
				try {
					this.options.system.removeDirectory(path);
					if (!existsSync(path)) this.directories.delete(path);
				} catch {
					/* Retried on the next attempt. */
				}
			}
			if (!this.pending) {
				this.remove();
				record("settled");
				return "settled";
			}
		} catch {
			/* A failed ps or signal leaves the file for the next attempt. */
		}
		this.persist();
		record("pending");
		this.reportIfStuck();
		return "pending";
	}

	private alive(): IdentityRecord[] {
		return [...this.identities.values()].filter((row) => row.state === "alive");
	}

	/** Update states from one snapshot and inherit observable descendants. */
	private observe(inherit = true): Map<number, ProcessRow> {
		const table = new Map(
			this.options.system.snapshot().map((row) => [row.pid, row]),
		);
		for (const identity of this.alive()) {
			const row = table.get(identity.pid);
			if (!row || row.start !== identity.start || row.zombie) {
				identity.state = "gone";
				// It left before we could see its children: orphans are unattributable.
				if (!identity.observed && !identity.killed) this.unprovable(identity);
			} else identity.observed = true;
		}
		if (inherit) {
			let changed = true;
			while (changed) {
				changed = false;
				for (const row of table.values()) {
					if (row.zombie || this.identities.has(key(row))) continue;
					const parentRow = table.get(row.ppid);
					if (!parentRow) continue;
					const parent = this.identities.get(key(parentRow));
					if (
						!parent ||
						parent.state !== "alive" ||
						startMs(row.start) < startMs(parent.start)
					)
						continue;
					this.identities.set(key(row), {
						pid: row.pid,
						start: row.start,
						parent: { pid: parent.pid, start: parent.start },
						observed: true,
						frozen: false,
						killed: false,
						state: "alive",
					});
					changed = true;
				}
			}
		}
		this.persist();
		return table;
	}

	private signal(
		identity: IdentityRecord,
		table: Map<number, ProcessRow>,
		signal: "SIGSTOP" | "SIGKILL",
	): boolean {
		// Re-check the exact identity immediately before signalling.
		const row = table.get(identity.pid);
		if (!row || row.start !== identity.start) {
			identity.state = "gone";
			return false;
		}
		try {
			this.options.system.signal(identity.pid, signal);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH")
				identity.state = "gone";
			return false;
		}
	}

	private freeze(identity: IdentityRecord, table: Map<number, ProcessRow>) {
		if (this.signal(identity, table, "SIGSTOP")) identity.frozen = true;
	}

	private kill(identity: IdentityRecord, table: Map<number, ProcessRow>) {
		if (this.signal(identity, table, "SIGKILL")) identity.killed = true;
	}

	private unprovable(identity: IdentityRecord): void {
		identity.state = "unprovable";
		this.options.report(
			`[voice] admission residual unprovable reasonClass=admission_residual_unprovable operation=session_runtime sessionId=${this.options.sessionId} parent=${identity.pid}@${identity.start}`,
		);
	}

	private reportIfStuck(): void {
		if (this.reportedUnsettled || this.attempts < REPORT_AFTER_ATTEMPTS) return;
		this.reportedUnsettled = true;
		this.persist();
		this.options.report(
			`[voice] admission residual unsettled reasonClass=admission_residual_unsettled operation=session_runtime sessionId=${this.options.sessionId} attempts=${this.attempts}`,
		);
	}

	private persist(): void {
		if (this.removed) return;
		const file: ResidualFile = {
			version: 1,
			sessionId: this.options.sessionId,
			identities: [...this.identities.values()],
			directories: [...this.directories],
			attempts: this.attempts,
			reportedUnsettled: this.reportedUnsettled,
		};
		const temp = `${this.options.path}.tmp`;
		writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
		chmodSync(temp, 0o600);
		renameSync(temp, this.options.path);
	}

	private remove(): void {
		this.removed = true;
		try {
			unlinkSync(this.options.path);
		} catch {
			/* Already gone. */
		}
	}
}

/** Daemon-level registry: one file per session under `<voiceRoot>/codex-containers/residuals`. */
export class AdmissionResidualRegistry {
	constructor(
		private readonly options: {
			root: string;
			system?: ResidualSystem;
			report?: (line: string) => void;
			evidence?: (record: Record<string, unknown>) => void;
		},
	) {}

	private directory(): string {
		mkdirSync(this.options.root, { recursive: true, mode: 0o700 });
		chmodSync(this.options.root, 0o700);
		return this.options.root;
	}

	private path(sessionId: string): string {
		if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId))
			throw new Error("voice_residual_session_invalid");
		return join(this.directory(), `${sessionId}.json`);
	}

	/** The residual set for one admission; resumes an existing file if present. */
	forSession(sessionId: string): AdmissionResiduals {
		const path = this.path(sessionId);
		return new AdmissionResiduals(
			{
				path,
				sessionId,
				system: this.options.system ?? hostResidualSystem,
				report: this.options.report ?? ((line) => console.error(line)),
			},
			existsSync(path) ? this.read(path) : undefined,
		);
	}

	/** Periodic and restart continuation: one reap attempt per unsettled file. */
	async sweep(): Promise<void> {
		let names: string[] = [];
		try {
			names = readdirSync(this.directory()).filter((name) =>
				/^[A-Za-z0-9_-]{1,128}\.json$/u.test(name),
			);
		} catch {
			return;
		}
		for (const name of names) {
			const residuals = this.forSession(name.slice(0, -5));
			await residuals.reap(this.options.evidence);
		}
	}

	private read(path: string): ResidualFile | undefined {
		try {
			const file = JSON.parse(readFileSync(path, "utf8")) as ResidualFile;
			return file.version === 1 && Array.isArray(file.identities)
				? file
				: undefined;
		} catch {
			return undefined;
		}
	}
}
