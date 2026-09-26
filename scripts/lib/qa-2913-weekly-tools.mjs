// FLY-2913: read only explicitly listed transcripts; never enumerate homes.
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const ROLES = new Set([
	"design",
	"implement",
	"qa",
	"review-design",
	"review-code",
]);
const VENDORS = new Set(["claude", "codex"]);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const canonicalName = (value) =>
	typeof value === "string" &&
	/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,199}$/.test(value);
const identity = (value) =>
	typeof value === "string" && /^[A-Za-z0-9_.:-]{1,512}$/.test(value);

function explicitPath(value, baseDir) {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		/[*?[\]{}]/.test(value) ||
		[...value].some((character) => character.charCodeAt(0) < 32) ||
		value.startsWith("~") ||
		/^[a-z]+:\/\//i.test(value) ||
		value.split(/[\\/]/).includes("..")
	) {
		throw new TypeError(
			"An explicit file path is required; globs, home expansion and traversal are unsupported",
		);
	}
	return resolve(baseDir, value);
}

function timestamp(value) {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
			value,
		)
	)
		return NaN;
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(5, 7));
	const day = Number(value.slice(8, 10));
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
		month - 1
	];
	if (!days || day < 1 || day > days || Number(value.slice(11, 13)) > 23)
		return NaN;
	return Date.parse(value);
}

function normalizeManifest(manifest, baseDir) {
	if (
		!manifest ||
		manifest.version !== 1 ||
		!Array.isArray(manifest.transcripts)
	) {
		throw new TypeError(
			"Expected a version 1 transcript manifest with an explicit transcripts array",
		);
	}
	return manifest.transcripts.map((entry, inputIndex) => {
		if (!entry || typeof entry !== "object" || !identity(entry.sessionId)) {
			throw new TypeError(
				"Every transcript manifest entry requires an explicit sessionId",
			);
		}
		const role = ROLES.has(entry.role) ? entry.role : "unattributed";
		const vendor = VENDORS.has(entry.vendor) ? entry.vendor : "unattributed";
		const scope =
			entry.subagent === true
				? "subagent"
				: entry.subagent === false
					? "main"
					: "unattributed";
		const expectedReviewType = role.startsWith("review-")
			? role.slice(7)
			: null;
		if (
			entry.reviewType != null &&
			(!["design", "code"].includes(entry.reviewType) ||
				(role !== "unattributed" && entry.reviewType !== expectedReviewType))
		) {
			throw new TypeError(
				"Manifest reviewType must match its explicit review role",
			);
		}
		return {
			inputIndex,
			path: explicitPath(entry.path, baseDir),
			sessionId: entry.sessionId,
			role,
			vendor,
			scope,
			reviewType: entry.reviewType ?? expectedReviewType,
		};
	});
}

/** Read a small explicit JSON manifest, resolving relative paths beside it.
 * Entries: {path, sessionId, role, vendor: 'claude'|'codex', subagent: boolean,
 * reviewType?: 'design'|'code'}. Unknown roles/scopes stay unattributed.
 * Transcript data is never embedded in the returned manifest.
 */
export async function readWeeklyToolManifest(manifestPath) {
	const path = explicitPath(manifestPath, process.cwd());
	let manifest;
	try {
		manifest = JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new TypeError(
			"Transcript manifest is missing, unreadable or invalid JSON",
		);
	}
	const normalized = normalizeManifest(manifest, dirname(path));
	return {
		version: 1,
		transcripts: normalized.map((entry) => ({
			path: entry.path,
			sessionId: entry.sessionId,
			role: entry.role,
			vendor: entry.vendor,
			subagent:
				entry.scope === "unattributed" ? null : entry.scope === "subagent",
			reviewType: entry.reviewType,
		})),
	};
}

// readline buffers a whole line, including tool payloads. Discard oversized
// lines while streaming, then resume at the next newline. Only one line's
// bytes are retained; deduplication retains identity tuples, never payloads.
async function* lines(stream, maxLineBytes) {
	let parts = [];
	let size = 0;
	let oversized = false;
	for await (const chunk of stream) {
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(10, offset);
			const end = newline === -1 ? chunk.length : newline;
			size += end - offset;
			if (size > maxLineBytes) {
				oversized = true;
				parts = [];
			} else if (!oversized) {
				parts.push(chunk.subarray(offset, end));
			}
			if (newline !== -1) {
				yield {
					text: oversized ? null : Buffer.concat(parts).toString("utf8"),
					oversized,
				};
				parts = [];
				size = 0;
				oversized = false;
			}
			offset = end + 1;
		}
	}
	if (size > 0 || oversized)
		yield {
			text: oversized ? null : Buffer.concat(parts).toString("utf8"),
			oversized,
		};
}

function malformedEnvelope(record, vendor) {
	if (vendor === "claude" && record.type === "assistant") {
		return (
			!record.message ||
			typeof record.message !== "object" ||
			Array.isArray(record.message) ||
			!Array.isArray(record.message.content) ||
			record.message.content.some(
				(block) =>
					!block ||
					typeof block !== "object" ||
					Array.isArray(block) ||
					typeof block.type !== "string" ||
					!block.type.trim(),
			)
		);
	}
	if (vendor === "codex" && record.type === "response_item") {
		return (
			!record.payload ||
			typeof record.payload !== "object" ||
			Array.isArray(record.payload) ||
			typeof record.payload.type !== "string" ||
			!record.payload.type
		);
	}
	return false;
}

function extractCalls(record, vendor) {
	if (
		vendor === "claude" &&
		record.type === "assistant" &&
		Array.isArray(record.message?.content)
	) {
		return record.message.content
			.filter((block) => ["tool_use", "server_tool_use"].includes(block?.type))
			.map((block) => ({
				unsupported: block.type !== "tool_use",
				assistantMessageId: record.message.id,
				toolUseId: block.id,
				name: block.name,
				// This single metadata leaf is the only argument content inspected.
				skill: block.name === "Skill" ? block.input?.skill : null,
			}));
	}
	if (
		vendor === "codex" &&
		record.type === "response_item" &&
		["function_call", "custom_tool_call"].includes(record.payload?.type)
	) {
		const item = record.payload;
		return [
			{
				assistantMessageId:
					item.assistant_message_id ??
					item.assistantMessageId ??
					record.assistant_message_id ??
					record.assistantMessageId,
				toolUseId: item.call_id,
				name: item.name,
				skill: null,
			},
		];
	}
	if (
		vendor === "codex" &&
		record.type === "response_item" &&
		typeof record.payload?.type === "string" &&
		record.payload.type.endsWith("_call")
	) {
		return [{ unsupported: true }];
	}
	return [];
}

/** Metadata-only seven-day census. Window is [cutoff - 7*24h, cutoff).
 * No CLI/provider/token estimates are inferred. Native Codex function calls
 * lacking an explicit assistant-message ID are reported as unsupported.
 * Input buffering is bounded by maxLineBytes; dedup memory is O(unique calls).
 */
export async function collectWeeklyToolUse({
	manifest,
	cutoff,
	baseDir = process.cwd(),
	maxLineBytes = 8 * 1024 * 1024,
	chunkBytes = 64 * 1024,
} = {}) {
	const end = timestamp(cutoff);
	if (!Number.isFinite(end))
		throw new TypeError(
			"An explicit ISO timestamp with timezone is required for cutoff",
		);
	if (
		!Number.isInteger(maxLineBytes) ||
		maxLineBytes < 128 ||
		maxLineBytes > 16 * 1024 * 1024 ||
		!Number.isInteger(chunkBytes) ||
		chunkBytes < 1 ||
		chunkBytes > 1024 * 1024
	) {
		throw new TypeError("Invalid transcript stream buffer limits");
	}
	const entries = normalizeManifest(manifest, baseDir);
	const start = end - WEEK_MS;
	const diagnostics = Object.fromEntries(
		[
			"readInputs",
			"missingInputs",
			"unreadableInputs",
			"duplicateInputs",
			"unsupportedInputs",
			"noCallInputs",
			"unattributedInputs",
			"malformedRecords",
			"malformedCalls",
			"duplicateCalls",
			"unattributedCalls",
			"unsupportedCalls",
			"outsideWindowCalls",
			"sessionMismatchRecords",
			"invalidSkillNames",
			"oversizedRecords",
		].map((key) => [key, 0]),
	);
	const inputs = [];
	const counts = new Map();
	const seenCalls = new Set();
	const seenInputs = new Set();
	let totalCalls = 0;

	for (const entry of entries) {
		const { path, ...metadata } = entry;
		const input = {
			...metadata,
			status: "no_calls",
			calls: 0,
			duplicateCalls: 0,
			malformedRecords: 0,
			malformedCalls: 0,
			unsupportedCalls: 0,
			sessionMismatchRecords: 0,
		};
		inputs.push(input);
		const inputKey = JSON.stringify([
			path,
			entry.sessionId,
			entry.role,
			entry.vendor,
			entry.scope,
			entry.reviewType,
		]);
		if (seenInputs.has(inputKey)) {
			diagnostics.duplicateInputs++;
			input.status = "duplicate";
			continue;
		}
		seenInputs.add(inputKey);
		const unattributed =
			entry.role === "unattributed" || entry.scope === "unattributed";
		if (unattributed) diagnostics.unattributedInputs++;
		if (entry.vendor === "unattributed") {
			diagnostics.unsupportedInputs++;
			input.status = "unsupported";
			continue;
		}
		let handle;
		try {
			// O_NONBLOCK prevents a supplied FIFO from waiting forever before stat.
			handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
			if (!(await handle.stat()).isFile()) throw new Error("not_regular_file");
			const stream = handle.createReadStream({
				highWaterMark: chunkBytes,
				autoClose: false,
			});
			for await (const line of lines(stream, maxLineBytes)) {
				if (line.oversized) diagnostics.oversizedRecords++;
				if (!line.oversized && !line.text.trim()) continue;
				let record;
				try {
					record = line.oversized ? null : JSON.parse(line.text);
					if (!record || typeof record !== "object" || Array.isArray(record))
						throw new Error("invalid_record");
				} catch {
					record = null;
				}
				if (!record || malformedEnvelope(record, entry.vendor)) {
					diagnostics.malformedRecords++;
					input.malformedRecords++;
					continue;
				}
				const calls = extractCalls(record, entry.vendor);
				if (calls.length === 0) continue;
				const recordSession = record.sessionId ?? record.session_id;
				if (recordSession != null && recordSession !== entry.sessionId) {
					diagnostics.sessionMismatchRecords++;
					input.sessionMismatchRecords++;
					continue;
				}
				const at = timestamp(record.timestamp);
				if (!Number.isFinite(at)) {
					diagnostics.malformedCalls += calls.length;
					input.malformedCalls += calls.length;
					continue;
				}
				if (at < start || at >= end) {
					diagnostics.outsideWindowCalls += calls.length;
					continue;
				}
				for (const call of calls) {
					if (
						call.unsupported ||
						(entry.vendor === "codex" && !identity(call.assistantMessageId))
					) {
						diagnostics.unsupportedCalls++;
						input.unsupportedCalls++;
						continue;
					}
					if (
						!identity(call.assistantMessageId) ||
						!identity(call.toolUseId) ||
						!canonicalName(call.name)
					) {
						diagnostics.malformedCalls++;
						input.malformedCalls++;
						continue;
					}
					const callKey = JSON.stringify([
						entry.sessionId,
						call.assistantMessageId,
						call.toolUseId,
					]);
					if (seenCalls.has(callKey)) {
						diagnostics.duplicateCalls++;
						input.duplicateCalls++;
						continue;
					}
					seenCalls.add(callKey);
					const skill =
						call.name === "Skill" && canonicalName(call.skill)
							? call.skill
							: null;
					if (call.name === "Skill" && skill === null)
						diagnostics.invalidSkillNames++;
					const group = {
						role: entry.role,
						vendor: entry.vendor,
						reviewType: entry.reviewType,
						scope: entry.scope,
						tool: call.name,
						skill,
					};
					const groupKey = JSON.stringify(group);
					if (!counts.has(groupKey))
						counts.set(groupKey, { ...group, calls: 0 });
					counts.get(groupKey).calls++;
					input.calls++;
					totalCalls++;
					if (unattributed) diagnostics.unattributedCalls++;
				}
			}
			diagnostics.readInputs++;
			if (
				input.malformedRecords +
					input.malformedCalls +
					input.unsupportedCalls +
					input.sessionMismatchRecords >
				0
			) {
				input.status = "partial";
			} else if (input.calls > 0) {
				input.status = "counted";
			} else if (input.duplicateCalls > 0) {
				input.status = "duplicates_only";
			} else {
				diagnostics.noCallInputs++;
			}
		} catch (error) {
			if (error.code === "ENOENT") {
				diagnostics.missingInputs++;
				input.status = "missing";
			} else {
				diagnostics.unreadableInputs++;
				input.status = "unreadable";
			}
		} finally {
			if (handle) await handle.close();
		}
	}
	return {
		version: 1,
		window: {
			startInclusive: new Date(start).toISOString(),
			endExclusive: new Date(end).toISOString(),
		},
		measurementMethod: "observed-tool-calls",
		inputCount: entries.length,
		totalCalls,
		diagnostics,
		counts: [...counts.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([, value]) => value),
		inputs,
		limitations: [
			"Counts cover only explicitly supplied transcripts; no observed call is not evidence that a capability is removable.",
			"Claude assistant tool_use blocks and Codex response_item function_call/custom_tool_call metadata are supported. Codex calls without an explicit assistant message ID are unsupported; IDs are never invented.",
			"Only canonical Skill names are retained. Arguments, prompt text, tool results and token usage are excluded.",
			"Line buffering is bounded; exact deduplication retains identity tuples proportional to unique observed calls.",
		],
	};
}
