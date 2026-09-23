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
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	DurableTranscriptEntry,
	DurableTranscriptSink,
	TranscriptDurabilityReceipt,
	TranscriptEntry,
	VoiceAttribution,
} from "./types.js";

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

export class JsonlTranscriptSink implements DurableTranscriptSink {
	private tail: Promise<void> = Promise.resolve();
	private dirEnsured = false;
	private failed = false;
	private durableIndex:
		| Map<
				string,
				{
					contentDigest: string;
					receipt: TranscriptDurabilityReceipt;
				}
		  >
		| undefined;

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

	appendDurable(
		entry: DurableTranscriptEntry,
	): Promise<TranscriptDurabilityReceipt> {
		const result = this.tail.then(async () => {
			if (this.failed) throw new Error("transcript_sink_failed");
			validateDurableEntry(entry);
			await this.loadDurableIndex();
			const contentDigest = durableDigest(entry);
			const key = durableKey(entry.sessionId, entry.transcriptId);
			const prior = this.durableIndex?.get(key);
			if (prior) {
				if (prior.contentDigest !== contentDigest)
					throw new Error("transcript_identity_conflict");
				return prior.receipt;
			}

			const receipt: TranscriptDurabilityReceipt = {
				version: 1,
				durable: true,
				sessionId: entry.sessionId,
				transcriptId: entry.transcriptId,
				contentDigest,
				persistedAt: new Date().toISOString(),
			};
			const line = `${JSON.stringify({ ...entry, durability: receipt })}\n`;
			try {
				await this.ensureDirectory();
				const existed = await pathExists(this.filePath);
				const file = await open(this.filePath, "a");
				try {
					await file.writeFile(line, { encoding: "utf8" });
					await file.sync();
				} finally {
					await file.close();
				}
				if (!existed) await syncDirectory(dirname(this.filePath));
				await verifyDurableReadback(this.filePath, entry, receipt);
			} catch (error) {
				const failure = asError(error);
				this.recordFailure(failure);
				throw failure;
			}

			this.durableIndex?.set(key, { contentDigest, receipt });
			return receipt;
		});
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async readReceipt(
		sessionId: string,
		transcriptId: string,
		contentDigest: string,
	): Promise<TranscriptDurabilityReceipt | undefined> {
		if (!sessionId || !transcriptId || !/^[a-f0-9]{64}$/.test(contentDigest))
			throw new Error("transcript_receipt_query_invalid");
		await this.flush();
		if (this.failed) throw new Error("transcript_sink_failed");
		await this.loadDurableIndex();
		const prior = this.durableIndex?.get(durableKey(sessionId, transcriptId));
		if (!prior) return undefined;
		if (prior.contentDigest !== contentDigest)
			throw new Error("transcript_identity_conflict");
		return prior.receipt;
	}

	/** drain pending writes — call before READING the file back. */
	flush(): Promise<void> {
		return this.tail;
	}

	private async ensureDirectory(): Promise<void> {
		if (this.dirEnsured) return;
		await mkdir(dirname(this.filePath), { recursive: true });
		this.dirEnsured = true;
	}

	private async loadDurableIndex(): Promise<void> {
		if (this.durableIndex) return;
		const index = new Map<
			string,
			{
				contentDigest: string;
				receipt: TranscriptDurabilityReceipt;
			}
		>();
		let content: string;
		try {
			content = await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.durableIndex = index;
				return;
			}
			throw error;
		}
		if (content && !content.endsWith("\n"))
			throw new Error("transcript_tail_corrupt");
		for (const line of content.split("\n")) {
			if (!line) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				throw new Error("transcript_tail_corrupt");
			}
			if (!isDurableRecord(parsed)) continue;
			const contentDigest = durableDigest(parsed);
			if (parsed.durability.contentDigest !== contentDigest)
				throw new Error("transcript_receipt_corrupt");
			const key = durableKey(parsed.sessionId, parsed.transcriptId);
			const prior = index.get(key);
			if (prior && prior.contentDigest !== contentDigest)
				throw new Error("transcript_identity_conflict");
			index.set(key, {
				contentDigest,
				receipt: parsed.durability,
			});
		}
		this.durableIndex = index;
	}

	private recordFailure(error: Error): void {
		if (this.failed) return;
		this.failed = true;
		writeFailures.set(this.filePath, error);
		this.onError(error);
	}
}

/** In-memory sink for tests and dry runs. */
export class MemoryTranscriptSink implements DurableTranscriptSink {
	readonly entries: TranscriptEntry[] = [];
	append(entry: TranscriptEntry): void {
		this.entries.push(entry);
	}

	async appendDurable(
		entry: DurableTranscriptEntry,
	): Promise<TranscriptDurabilityReceipt> {
		validateDurableEntry(entry);
		this.entries.push(entry);
		return {
			version: 1,
			durable: false,
			sessionId: entry.sessionId,
			transcriptId: entry.transcriptId,
			contentDigest: durableDigest(entry),
			persistedAt: new Date().toISOString(),
		};
	}

	async readReceipt(
		_sessionId: string,
		_transcriptId: string,
		_contentDigest: string,
	): Promise<undefined> {
		return undefined;
	}
}

function durableKey(sessionId: string, transcriptId: string): string {
	return `${sessionId}\0${transcriptId}`;
}

function durableDigest(entry: DurableTranscriptEntry): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				transcriptId: entry.transcriptId,
				utteranceId: entry.utteranceId,
				sessionId: entry.sessionId,
				generation: entry.generation,
				sequence: entry.sequence,
				timestamp: entry.timestamp,
				backendId: entry.backendId,
				source: entry.source,
				face: entry.face,
				role: entry.role,
				text: entry.text,
				final: entry.final,
				interrupted: entry.interrupted === true,
				attribution: attributionDigestShape(entry.attribution),
			}),
		)
		.digest("hex");
}

function attributionDigestShape(attribution: VoiceAttribution): object {
	return attribution.kind === "known"
		? {
				kind: attribution.kind,
				speakerUserId: attribution.speakerUserId,
				speakerName: attribution.speakerName ?? null,
			}
		: { kind: attribution.kind, reason: attribution.reason };
}

function validateDurableEntry(entry: DurableTranscriptEntry): void {
	if (
		!entry.transcriptId ||
		!entry.utteranceId ||
		!entry.sessionId ||
		!Number.isSafeInteger(entry.generation) ||
		entry.generation < 1 ||
		!Number.isSafeInteger(entry.sequence) ||
		entry.sequence < 0 ||
		!entry.timestamp ||
		!Number.isFinite(Date.parse(entry.timestamp)) ||
		!entry.backendId ||
		!entry.source ||
		entry.final !== true ||
		!entry.text ||
		!validAttribution(entry.attribution)
	)
		throw new Error("transcript_durable_entry_invalid");
}

type DurableTranscriptRecord = DurableTranscriptEntry & {
	durability: TranscriptDurabilityReceipt;
};

function isDurableRecord(value: unknown): value is DurableTranscriptRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	try {
		validateDurableEntry(value as DurableTranscriptEntry);
		const record = value as DurableTranscriptRecord;
		return (
			record.durability?.version === 1 &&
			record.durability.durable === true &&
			record.durability.sessionId === record.sessionId &&
			record.durability.transcriptId === record.transcriptId &&
			/^[a-f0-9]{64}$/.test(record.durability.contentDigest) &&
			Number.isFinite(Date.parse(record.durability.persistedAt))
		);
	} catch {
		return false;
	}
}

function validAttribution(value: unknown): value is VoiceAttribution {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const attribution = value as Record<string, unknown>;
	return attribution.kind === "known"
		? typeof attribution.speakerUserId === "string" &&
				attribution.speakerUserId.length > 0
		: attribution.kind === "unknown" &&
				typeof attribution.reason === "string" &&
				attribution.reason.length > 0;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

async function verifyDurableReadback(
	filePath: string,
	entry: DurableTranscriptEntry,
	receipt: TranscriptDurabilityReceipt,
): Promise<void> {
	const content = await readFile(filePath, "utf8");
	if (!content.endsWith("\n")) throw new Error("transcript_readback_failed");
	const line = content.split("\n").at(-2);
	let parsed: unknown;
	try {
		parsed = line ? JSON.parse(line) : undefined;
	} catch {
		throw new Error("transcript_readback_failed");
	}
	if (
		!isDurableRecord(parsed) ||
		parsed.sessionId !== entry.sessionId ||
		parsed.transcriptId !== entry.transcriptId ||
		parsed.durability.contentDigest !== receipt.contentDigest
	)
		throw new Error("transcript_readback_failed");
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
