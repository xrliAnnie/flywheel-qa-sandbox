import {
	chmodSync,
	closeSync,
	constants,
	fsyncSync,
	mkdirSync,
	openSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

const DEFAULT_BUFFER_INTERVAL_MS = 250;
const DEFAULT_MAX_BUFFERED_RECORDS = 100;

interface EvidenceLogOptions {
	fsync?: typeof fsyncSync;
	bufferIntervalMs?: number;
	maxBufferedRecords?: number;
}

interface EvidenceBufferState {
	buffered: string[];
	flushTimer?: ReturnType<typeof setTimeout>;
}

const buffersByPath = new Map<string, EvidenceBufferState>();

export class EvidenceLog {
	constructor(
		readonly path: string,
		private readonly options: EvidenceLogOptions = {},
	) {}

	append(record: Record<string, unknown>): void {
		const lines = this.takeBuffered();
		lines.push(`${JSON.stringify(record)}\n`);
		this.write(lines, true);
	}

	appendBuffered(record: Record<string, unknown>): void {
		const state = this.bufferState();
		state.buffered.push(`${JSON.stringify(record)}\n`);
		if (
			state.buffered.length >=
			(this.options.maxBufferedRecords ?? DEFAULT_MAX_BUFFERED_RECORDS)
		) {
			this.flushBuffered();
			return;
		}
		if (state.flushTimer) return;
		state.flushTimer = setTimeout(
			() => this.flushBuffered(),
			this.options.bufferIntervalMs ?? DEFAULT_BUFFER_INTERVAL_MS,
		);
		state.flushTimer.unref?.();
	}

	private flushBuffered(): void {
		const lines = this.takeBuffered();
		if (lines.length > 0) this.write(lines, false);
	}

	private takeBuffered(): string[] {
		const state = buffersByPath.get(this.path);
		if (!state) return [];
		if (state.flushTimer) clearTimeout(state.flushTimer);
		buffersByPath.delete(this.path);
		return state.buffered;
	}

	private bufferState(): EvidenceBufferState {
		const current = buffersByPath.get(this.path);
		if (current) return current;
		const created = { buffered: [] };
		buffersByPath.set(this.path, created);
		return created;
	}

	private write(lines: string[], durable: boolean): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const fd = openSync(
			this.path,
			constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
			0o600,
		);
		try {
			chmodSync(this.path, 0o600);
			writeSync(fd, lines.join(""));
			if (durable) (this.options.fsync ?? fsyncSync)(fd);
		} finally {
			closeSync(fd);
		}
	}
}
