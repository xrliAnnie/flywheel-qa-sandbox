#!/usr/bin/env node

import fs from "node:fs/promises";

const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_BYTES = 128 * 1024 * 1024;
const MAX_SCAN_MS = 30_000;
const DEFAULT_THRESHOLD = 70;

function emit(fields) {
	process.stdout.write(
		`${JSON.stringify({
			verdict: "unknown",
			estTokens: null,
			base: null,
			tailBytes: null,
			window: null,
			threshold: null,
			reason: "unexpected_error",
			...fields,
		})}\n`,
	);
}

function parseArgs(argv) {
	let transcript;
	let windowRaw;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--transcript") {
			transcript = argv[index + 1];
			index += 1;
		} else if (arg === "--window") {
			windowRaw = argv[index + 1];
			index += 1;
		}
	}
	return { transcript, windowRaw };
}

function parsePositiveInteger(raw) {
	if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseThreshold(raw) {
	const value = parsePositiveInteger(raw);
	return value !== null && value <= 100 ? value : null;
}

function usageBase(line) {
	if (line.length === 0) return null;
	let entry;
	try {
		entry = JSON.parse(line.toString("utf8"));
	} catch {
		return null;
	}
	if (entry?.type !== "assistant" || entry?.message?.model === "<synthetic>") {
		return null;
	}
	const usage = entry?.message?.usage;
	if (!usage || typeof usage !== "object") return null;
	const fields = [
		usage.input_tokens,
		usage.cache_read_input_tokens,
		usage.cache_creation_input_tokens,
		usage.output_tokens,
	];
	let total = 0;
	for (const field of fields) {
		const value = field ?? 0;
		if (!Number.isSafeInteger(value) || value < 0) return null;
		total += value;
		if (!Number.isSafeInteger(total)) return null;
	}
	return total > 0 ? total : null;
}

function classify({ base, tailBytes, window, threshold }) {
	const estTokens = base + tailBytes;
	if (!Number.isSafeInteger(estTokens)) {
		return {
			verdict: "unknown",
			estTokens: null,
			base,
			tailBytes,
			window,
			threshold,
			reason: "estimate_overflow",
		};
	}
	const thresholdReached =
		BigInt(estTokens) * 100n >= BigInt(threshold) * BigInt(window);
	return {
		verdict: thresholdReached ? "unsafe" : "safe_resume",
		estTokens,
		base,
		tailBytes,
		window,
		threshold,
		reason: thresholdReached ? "threshold_reached" : "below_threshold",
	};
}

async function scanTranscript({ transcript, window, threshold }) {
	let handle;
	try {
		handle = await fs.open(transcript, "r");
	} catch (error) {
		return {
			window,
			threshold,
			reason:
				error?.code === "ENOENT"
					? "transcript_missing"
					: "transcript_open_failed",
		};
	}

	try {
		const stat = await handle.stat();
		if (!stat.isFile() || !Number.isSafeInteger(stat.size)) {
			return { window, threshold, reason: "transcript_not_regular" };
		}
		const fileSize = stat.size;
		let position = fileSize;
		let currentLineEnd = fileSize;
		let scannedBytes = 0;
		let suffixParts = [];
		const startedAt = Date.now();

		while (position > 0) {
			if (Date.now() - startedAt >= MAX_SCAN_MS) {
				return { window, threshold, reason: "scan_timeout" };
			}
			const remainingBudget = MAX_SCAN_BYTES - scannedBytes;
			if (remainingBudget <= 0) {
				return { window, threshold, reason: "scan_budget_exceeded" };
			}
			const requested = Math.min(CHUNK_BYTES, position, remainingBudget);
			const chunkStart = position - requested;
			const chunk = Buffer.allocUnsafe(requested);
			const { bytesRead } = await handle.read(chunk, 0, requested, chunkStart);
			if (bytesRead !== requested) {
				return { window, threshold, reason: "short_read" };
			}
			position = chunkStart;
			scannedBytes += bytesRead;
			let segmentEnd = bytesRead;

			for (let index = bytesRead - 1; index >= 0; index -= 1) {
				if (chunk[index] !== 0x0a) continue;
				const segment = chunk.subarray(index + 1, segmentEnd);
				const line = Buffer.concat([segment, ...suffixParts]);
				const base = usageBase(line);
				if (base !== null) {
					return classify({
						base,
						tailBytes: fileSize - currentLineEnd,
						window,
						threshold,
					});
				}
				suffixParts = [];
				segmentEnd = index;
				currentLineEnd = chunkStart + index;
			}

			const prefix = chunk.subarray(0, segmentEnd);
			if (prefix.length > 0) suffixParts.unshift(prefix);
			if (scannedBytes >= MAX_SCAN_BYTES && position > 0) {
				return { window, threshold, reason: "scan_budget_exceeded" };
			}
		}

		if (suffixParts.length > 0) {
			const base = usageBase(Buffer.concat(suffixParts));
			if (base !== null) {
				return classify({
					base,
					tailBytes: fileSize - currentLineEnd,
					window,
					threshold,
				});
			}
		}
		return { window, threshold, reason: "no_real_usage" };
	} catch {
		return { window, threshold, reason: "transcript_read_failed" };
	} finally {
		await handle.close().catch(() => {});
	}
}

async function main() {
	const { transcript, windowRaw } = parseArgs(process.argv.slice(2));
	const window = parsePositiveInteger(windowRaw);
	if (window === null) {
		emit({ reason: "invalid_window" });
		return;
	}
	const threshold = parseThreshold(
		process.env.FLYWHEEL_LEAD_CTX_RESUME_MAX ?? String(DEFAULT_THRESHOLD),
	);
	if (threshold === null) {
		emit({ window, reason: "invalid_threshold" });
		return;
	}
	if (typeof transcript !== "string" || transcript.length === 0) {
		emit({ window, threshold, reason: "transcript_missing" });
		return;
	}
	const result = await scanTranscript({ transcript, window, threshold });
	emit(result);
}

main().catch(() => emit({ reason: "unexpected_error" }));
