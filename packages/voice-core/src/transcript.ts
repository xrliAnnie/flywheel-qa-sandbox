/**
 * TranscriptSink — a shared-layer concern (not a backend concern): every
 * transcript event from every backend flows through one JSONL audit record,
 * which is the input FLY-548 (transcript → summary → Linear) will consume.
 * Failures throw (plan.md §3: "失败显式 throw,不静默吞").
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TranscriptEntry, TranscriptSink } from "./types.js";

export class JsonlTranscriptSink implements TranscriptSink {
	private dirEnsured = false;

	constructor(private readonly filePath: string) {}

	append(entry: TranscriptEntry): void {
		if (!this.dirEnsured) {
			mkdirSync(dirname(this.filePath), { recursive: true });
			this.dirEnsured = true;
		}
		appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, {
			encoding: "utf8",
		});
	}
}

/** In-memory sink for tests and dry runs. */
export class MemoryTranscriptSink implements TranscriptSink {
	readonly entries: TranscriptEntry[] = [];
	append(entry: TranscriptEntry): void {
		this.entries.push(entry);
	}
}
