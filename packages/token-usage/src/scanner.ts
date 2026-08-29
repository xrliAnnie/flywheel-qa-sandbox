import { createReadStream, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { classifyCwd } from "./classifier.js";
import type { UsageRecord } from "./types.js";

export const DEFAULT_TIMEZONE = "America/Los_Angeles";

/** Derive the local report date (YYYY-MM-DD) from a UTC ISO timestamp in the given IANA tz. */
export function dayFromTimestamp(
	iso: string,
	timeZone: string = DEFAULT_TIMEZONE,
): string {
	// en-CA formats as YYYY-MM-DD; timeZone shifts the instant to local civil date.
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return fmt.format(new Date(iso));
}

export interface ScanOptions {
	timeZone?: string;
	/** Inclusive lower bound (YYYY-MM-DD, local). */
	since?: string;
	/** Inclusive upper bound (YYYY-MM-DD, local). */
	until?: string;
	homeDir?: string;
}

/**
 * Parse a single CC jsonl line into a UsageRecord, or null if it is not a usable
 * assistant turn. Pure (no dedup) — the caller dedups by requestId.
 */
export function parseUsageLine(
	line: string,
	opts: ScanOptions = {},
): UsageRecord | null {
	const trimmed = line.trim();
	if (!trimmed || !trimmed.includes('"usage"')) return null;
	let o: Record<string, unknown>;
	try {
		o = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (o.type !== "assistant") return null;
	const message = o.message as Record<string, unknown> | undefined;
	const usage = message?.usage as Record<string, unknown> | undefined;
	const ts = o.timestamp as string | undefined;
	if (!message || !usage || !ts) return null;

	const requestId =
		(o.requestId as string | undefined) ?? (o.uuid as string | undefined);
	if (!requestId) return null;

	const day = dayFromTimestamp(ts, opts.timeZone ?? DEFAULT_TIMEZONE);
	if (opts.since && day < opts.since) return null;
	if (opts.until && day > opts.until) return null;

	const cwd = (o.cwd as string | undefined) ?? "";
	const cls = classifyCwd(cwd, opts.homeDir);
	const num = (v: unknown): number =>
		typeof v === "number" && Number.isFinite(v) ? v : 0;

	return {
		requestId,
		cwd,
		gitBranch: (o.gitBranch as string | undefined) ?? null,
		model: (message.model as string | undefined) ?? "?",
		day,
		inputTokens: num(usage.input_tokens),
		outputTokens: num(usage.output_tokens),
		cacheReadTokens: num(usage.cache_read_input_tokens),
		cacheWriteTokens: num(usage.cache_creation_input_tokens),
		kind: cls.kind,
		project: cls.project,
		issue: cls.issue,
		leadWho: cls.kind === "lead" ? cls.who : null,
	};
}

/**
 * Turn an iterable of raw jsonl lines into deduplicated UsageRecords.
 * Dedup key = requestId (multiple iterations of one turn share a requestId).
 */
export function recordsFromLines(
	lines: Iterable<string>,
	opts: ScanOptions = {},
	seen?: Set<string>,
): UsageRecord[] {
	const dedup = seen ?? new Set<string>();
	const out: UsageRecord[] = [];
	for (const line of lines) {
		const rec = parseUsageLine(line, opts);
		if (!rec) continue;
		if (dedup.has(rec.requestId)) continue;
		dedup.add(rec.requestId);
		out.push(rec);
	}
	return out;
}

async function* walkJsonl(dir: string): AsyncGenerator<string> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			yield* walkJsonl(full);
		} else if (e.isFile() && e.name.endsWith(".jsonl")) {
			yield full;
		}
	}
}

/**
 * Scan all CC jsonl logs under baseDir (default ~/.claude/projects) into deduplicated
 * UsageRecords. Streams line-by-line to bound memory over very large logs.
 */
export async function scanLogs(
	baseDir: string,
	opts: ScanOptions = {},
): Promise<UsageRecord[]> {
	const seen = new Set<string>();
	const out: UsageRecord[] = [];
	for await (const file of walkJsonl(baseDir)) {
		const rl = createInterface({
			input: createReadStream(file),
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		for await (const line of rl) {
			const rec = parseUsageLine(line, opts);
			if (!rec) continue;
			if (seen.has(rec.requestId)) continue;
			seen.add(rec.requestId);
			out.push(rec);
		}
	}
	return out;
}
