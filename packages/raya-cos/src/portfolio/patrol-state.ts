import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface PatrolState {
	v: 1;
	lastPatrol?: { at: string; snapshotId: string; outcome: string };
	lastProactive?: { at: string; messageId: string };
	injected?: { threadId: string; snapshotId: string };
	attempt?: {
		attemptId: string;
		snapshotId: string;
		status: "posting" | "posted" | "abandoned";
		at: string;
	};
	startupProbe?: {
		processStartId: string;
		at: string;
		outcome: "ok" | "no_activity_readings";
	};
}

export interface PatrolStateStoreOptions {
	nowMs?: () => number;
	onCorrupt?: (backupPath: string) => void;
}

function string(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function validState(value: unknown): value is PatrolState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const state = value as Record<string, unknown>;
	if (state.v !== 1) return false;
	for (const key of [
		"lastPatrol",
		"lastProactive",
		"injected",
		"attempt",
		"startupProbe",
	]) {
		if (
			state[key] !== undefined &&
			(!state[key] || typeof state[key] !== "object")
		) {
			return false;
		}
	}
	const lastPatrol = state.lastPatrol as Record<string, unknown> | undefined;
	if (
		lastPatrol &&
		(!string(lastPatrol.at) ||
			!string(lastPatrol.snapshotId) ||
			!string(lastPatrol.outcome))
	) {
		return false;
	}
	const lastProactive = state.lastProactive as
		| Record<string, unknown>
		| undefined;
	if (
		lastProactive &&
		(!string(lastProactive.at) || !string(lastProactive.messageId))
	) {
		return false;
	}
	const injected = state.injected as Record<string, unknown> | undefined;
	if (
		injected &&
		(!string(injected.threadId) || !string(injected.snapshotId))
	) {
		return false;
	}
	const attempt = state.attempt as Record<string, unknown> | undefined;
	if (
		attempt &&
		(!string(attempt.attemptId) ||
			!string(attempt.snapshotId) ||
			!string(attempt.at) ||
			!new Set(["posting", "posted", "abandoned"]).has(String(attempt.status)))
	) {
		return false;
	}
	const startup = state.startupProbe as Record<string, unknown> | undefined;
	if (
		startup &&
		(!string(startup.processStartId) ||
			!string(startup.at) ||
			!new Set(["ok", "no_activity_readings"]).has(String(startup.outcome)))
	) {
		return false;
	}
	return true;
}

export class PatrolStateStore {
	readonly root: string;
	readonly statePath: string;
	readonly eventsPath: string;
	private readonly nowMs: () => number;
	private readonly onCorrupt: (backupPath: string) => void;
	private tail: Promise<void> = Promise.resolve();

	constructor(stateDir: string, options: PatrolStateStoreOptions = {}) {
		this.root = join(stateDir, "portfolio");
		this.statePath = join(this.root, "patrol-state.json");
		this.eventsPath = join(this.root, "patrols.jsonl");
		this.nowMs = options.nowMs ?? Date.now;
		this.onCorrupt = options.onCorrupt ?? (() => {});
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		chmodSync(this.root, 0o700);
	}

	read(): PatrolState {
		if (!existsSync(this.statePath)) return { v: 1 };
		try {
			const value: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
			if (!validState(value)) throw new Error("invalid patrol state");
			return value;
		} catch {
			const backupPath = `${this.statePath}.corrupt-${this.nowMs()}`;
			renameSync(this.statePath, backupPath);
			this.onCorrupt(backupPath);
			return { v: 1 };
		}
	}

	update(mutator: (state: PatrolState) => PatrolState): Promise<PatrolState> {
		const operation = this.tail.then(() => {
			const next = mutator(this.read());
			if (!validState(next)) throw new Error("invalid patrol state update");
			this.atomicJson(next);
			return next;
		});
		this.tail = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}

	appendEvent(
		kind: string,
		metadata: Record<string, string | number | boolean | null> = {},
	): void {
		const descriptor = openSync(this.eventsPath, "a", 0o600);
		try {
			appendFileSync(
				descriptor,
				`${JSON.stringify({ ...metadata, at: new Date().toISOString(), kind })}\n`,
			);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		chmodSync(this.eventsPath, 0o600);
	}

	private atomicJson(state: PatrolState): void {
		const temporary = `${this.statePath}.tmp-${process.pid}-${this.nowMs()}`;
		const descriptor = openSync(temporary, "w", 0o600);
		try {
			writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, this.statePath);
		chmodSync(this.statePath, 0o600);
	}
}
