/**
 * TranscriptSink — a shared-layer concern (not a backend concern): every
 * transcript event from every backend flows through one JSONL audit record,
 * which is the input FLY-548 (transcript → summary → Linear) will consume.
 *
 * QA R4 (d): append used to be appendFileSync ON THE EVENT PATH — every
 * turn-final blocked the event loop on a disk write, and under load that
 * starves the ws keepalives of EVERY live Gemini session on this loop (the
 * repeated-abort root). Writes are now an ordered async chain; the first
 * failure surfaces ONCE through onError (default: stderr) and further writes
 * are dropped fail-visibly instead of throwing where no caller can catch.
 * Readers that consume the file (landing/record) must await flush() first —
 * GeminiLiveBackend.close() drains it before resolving.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TranscriptEntry, TranscriptSink } from "./types.js";

/** durable completeness ledger: a file that lost writes must never be read
 * back as a "complete verbatim record" (Codex R27 HIGH). Keyed by path so the
 * reader (landing) and the writer (sink, created in a different scope) meet
 * without threading refs through factory layers. */
const writeFailures = new Map<string, Error>();

/** the first write error for this transcript file, if any. */
export function getTranscriptWriteFailure(filePath: string): Error | undefined {
	return writeFailures.get(filePath);
}

/** test seam: forget a recorded failure. */
export function clearTranscriptWriteFailure(filePath: string): void {
	writeFailures.delete(filePath);
}

export class JsonlTranscriptSink implements TranscriptSink {
	private tail: Promise<void> = Promise.resolve();
	private dirEnsured = false;
	private failed = false;

	constructor(
		private readonly filePath: string,
		private readonly onError: (err: Error) => void = (err) =>
			console.error(
				`[transcript-sink] write failed (${err.message}) — ` +
					"further entries for this file are dropped",
			),
	) {}

	append(entry: TranscriptEntry): void {
		const line = `${JSON.stringify(entry)}\n`;
		this.tail = this.tail.then(async () => {
			if (this.failed) return;
			try {
				if (!this.dirEnsured) {
					await mkdir(dirname(this.filePath), { recursive: true });
					this.dirEnsured = true;
				}
				await appendFile(this.filePath, line, { encoding: "utf8" });
			} catch (err) {
				this.failed = true;
				const e = err instanceof Error ? err : new Error(String(err));
				writeFailures.set(this.filePath, e);
				this.onError(e);
			}
		});
	}

	/** drain pending writes — call before READING the file back. */
	flush(): Promise<void> {
		return this.tail;
	}
}

/** In-memory sink for tests and dry runs. */
export class MemoryTranscriptSink implements TranscriptSink {
	readonly entries: TranscriptEntry[] = [];
	append(entry: TranscriptEntry): void {
		this.entries.push(entry);
	}
}
