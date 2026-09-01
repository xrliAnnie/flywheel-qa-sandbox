#!/usr/bin/env node
/**
 * FLY-2137 — report-only founder-calendar governance sweep.
 *
 * Reads a bounded Calendar event window plus restart-guard P6 JSONL, then
 * delivers at most one aggregate per America/Los_Angeles day. The outbox is
 * written before delivery and cursor high-watermarks advance only after a
 * strict sent/queued receipt. A crash after external delivery but before the
 * local checkpoint is intentionally at-least-once; the next PT day re-buckets
 * the immutable snapshot under a new daily event id rather than risking loss.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const HOME = process.env.HOME;
if (!HOME || !HOME.startsWith("/")) throw new Error("HOME must be absolute");

const SWEEP_ENV_KEYS = [
	"CALENDAR_SWEEP_STATE",
	"CALENDAR_SWEEP_LOCK",
	"CALENDAR_SWEEP_AUDIT_LOG",
	"CALENDAR_SWEEP_GOG",
	"CALENDAR_SWEEP_ALERT",
	"CALENDAR_SWEEP_ACCOUNT",
	"CALENDAR_SWEEP_CLIENT",
	"CALENDAR_SWEEP_CALENDAR",
	"CALENDAR_SWEEP_PROJECT",
	"CALENDAR_SWEEP_FROM",
	"CALENDAR_SWEEP_TO",
	"FLYWHEEL_REPO",
];

function loadSweepEnv() {
	const envFile = process.env.ENV_FILE ?? join(HOME, ".flywheel/.env");
	if (!existsSync(envFile)) return;
	const callerOverrides = new Map(
		SWEEP_ENV_KEYS.filter((key) => Object.hasOwn(process.env, key)).map(
			(key) => [key, process.env[key]],
		),
	);
	const script = [
		"set -euo pipefail",
		'env_file="$1"',
		"shift",
		"set -a",
		'. "$env_file" >/dev/null',
		"set +a",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Bash 3.2 indirect expansion, not a JavaScript template.
		'for name in "$@"; do printf \'%s\\0%s\\0\' "$name" "${!name-}"; done',
	].join("\n");
	const result = spawnSync(
		"/bin/bash",
		["-c", script, "calendar-sweep-env", envFile, ...SWEEP_ENV_KEYS],
		{ encoding: "buffer", timeout: 5_000, maxBuffer: 64 * 1024 },
	);
	if (result.error)
		throw new Error(`cannot load ${envFile}: ${result.error.message}`);
	if (result.status !== 0)
		throw new Error(
			`cannot load ${envFile}: ${String(result.stderr ?? "").trim() || `bash exited ${result.status}`}`,
		);
	const fields = result.stdout.toString("utf8").split("\0");
	if (fields.at(-1) === "") fields.pop();
	if (fields.length !== SWEEP_ENV_KEYS.length * 2)
		throw new Error(`cannot load ${envFile}: malformed selected-env output`);
	for (let index = 0; index < fields.length; index += 2) {
		const key = fields[index];
		const value = fields[index + 1];
		if (value) process.env[key] = value;
		else delete process.env[key];
	}
	for (const [key, value] of callerOverrides) process.env[key] = value;
}

loadSweepEnv();

const STATE_PATH =
	process.env.CALENDAR_SWEEP_STATE ??
	join(HOME, ".flywheel/state/calendar-sweep.json");
const LOCK_PATH =
	process.env.CALENDAR_SWEEP_LOCK ??
	join(HOME, ".flywheel/state/calendar-sweep.lock");
const AUDIT_LOG =
	process.env.CALENDAR_SWEEP_AUDIT_LOG ??
	join(HOME, ".flywheel/logs/restart-guard.log");
const GUARD_DIR = join(HOME, ".flywheel/calendar-guard");
const GOG = process.env.CALENDAR_SWEEP_GOG ?? "gog";
const ALERT =
	process.env.CALENDAR_SWEEP_ALERT ??
	join(
		process.env.FLYWHEEL_REPO ?? join(HOME, "Dev/flywheel"),
		"scripts/lead-alert.sh",
	);
const ACCOUNT = process.env.CALENDAR_SWEEP_ACCOUNT ?? "personal";
const CLIENT = process.env.CALENDAR_SWEEP_CLIENT;
if (!CLIENT) {
	throw new Error(
		"CALENDAR_SWEEP_CLIENT is required for the isolated readonly OAuth grant",
	);
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(CLIENT)) {
	throw new Error("CALENDAR_SWEEP_CLIENT is invalid");
}
const CALENDAR = process.env.CALENDAR_SWEEP_CALENDAR ?? "primary";
// The system route self-loads the delivery token inside lead-alert.sh. A
// named Lead route would depend on launchd inheriting a shell-only bot token.
const LEAD = "system";
const PROJECT = process.env.CALENDAR_SWEEP_PROJECT ?? "flywheel";
const DELIVERY_OK = new Set(["sent", "queued_transient"]);
const LOCK_STALE_MS = 60 * 60 * 1000;
const KEYWORDS =
	/FLY-\d+|GEO-\d+|flywheel|raya|discord\.com\/channels|\bQA\b|验收|测试|Tadashi/i;
const EPOCH = "1970-01-01T00:00:00.000Z";
let testAppendAfterReadUsed = false;

function log(message) {
	process.stderr.write(`[calendar-write-sweep] ${message}\n`);
}

function dayBucket(date) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Los_Angeles",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const value = Object.fromEntries(
		parts.map((part) => [part.type, part.value]),
	);
	return `${value.year}-${value.month}-${value.day}`;
}

function defaultState() {
	return {
		schemaVersion: 2,
		dayBucket: null,
		dayReceipt: null,
		pendingOutbox: null,
		eventCursorISO: EPOCH,
		logCursor: null,
		lastObservedMode: null,
		quarantine: [],
		reportedEventIds: [],
	};
}

function atomicWrite(state) {
	mkdirSync(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
	const temp = `${STATE_PATH}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
	writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, STATE_PATH);
	chmodSync(STATE_PATH, 0o600);
}

function loadState() {
	if (!existsSync(STATE_PATH)) return defaultState();
	try {
		const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
		if (!parsed || parsed.schemaVersion !== 2)
			throw new Error("unsupported schema");
		return { ...defaultState(), ...parsed };
	} catch (error) {
		const corrupt = `${STATE_PATH}.corrupt-${Date.now()}`;
		renameSync(STATE_PATH, corrupt);
		atomicWrite(defaultState());
		throw new Error(`state corrupt; preserved at ${corrupt}: ${error.message}`);
	}
}

function identity(path) {
	const stat = statSync(path);
	return { dev: stat.dev, ino: stat.ino, size: stat.size };
}

function sameIdentity(a, b) {
	return Boolean(
		a &&
			b &&
			Number(a.dev) === Number(b.dev) &&
			Number(a.ino) === Number(b.ino),
	);
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function readLines(path, startOffset, quarantine, seenRows) {
	const fd = openSync(path, "r");
	let buffer;
	let id;
	try {
		id = fstatSync(fd);
		buffer = readFileSync(fd);
		if (
			!testAppendAfterReadUsed &&
			path === AUDIT_LOG &&
			process.env.FLYWHEEL_CALENDAR_SWEEP_TEST_APPEND_AUDIT_AFTER_READ
		) {
			testAppendAfterReadUsed = true;
			appendFileSync(
				path,
				`${process.env.FLYWHEEL_CALENDAR_SWEEP_TEST_APPEND_AUDIT_AFTER_READ}\n`,
			);
		}
	} finally {
		closeSync(fd);
	}
	let offset = Math.min(Math.max(0, Number(startOffset) || 0), buffer.length);
	const rows = [];
	const parseErrors = [];
	while (offset < buffer.length) {
		const newline = buffer.indexOf(0x0a, offset);
		const end = newline === -1 ? buffer.length : newline;
		const line = buffer.subarray(offset, end).toString("utf8").trim();
		const lineOffset = offset;
		offset = newline === -1 ? buffer.length : newline + 1;
		if (!line) continue;
		try {
			const row = JSON.parse(line);
			const dedup = `${row.ts ?? ""}\0${row.pattern ?? ""}\0${row.decision ?? ""}\0${row.command ?? ""}`;
			if (!seenRows.has(dedup)) {
				seenRows.add(dedup);
				rows.push(row);
			}
		} catch {
			const hash = sha256(line);
			const key = `${id.dev}:${id.ino}:${lineOffset}:${hash}`;
			if (!quarantine.some((item) => item.key === key)) {
				const item = {
					key,
					sha256: hash,
					identity: { dev: id.dev, ino: id.ino },
					offset: lineOffset,
					discoveredAt: new Date().toISOString(),
				};
				quarantine.push(item);
				parseErrors.push(item);
			}
		}
	}
	return {
		rows,
		parseErrors,
		cursor: { dev: id.dev, ino: id.ino, offset: buffer.length },
	};
}

function scanAuditLog(cursor, existingQuarantine) {
	const quarantine = [...existingQuarantine];
	if (!existsSync(AUDIT_LOG)) {
		return { findings: [], cursor: null, quarantine };
	}
	const paths = [];
	for (let generation = 3; generation >= 1; generation -= 1) {
		const retained = `${AUDIT_LOG}.${generation}`;
		if (existsSync(retained)) paths.push(retained);
	}
	paths.push(AUDIT_LOG);
	let startIndex = paths.length - 1;
	let firstOffset = 0;
	let rotationGap = false;
	if (cursor) {
		const matched = paths.findIndex((path) =>
			sameIdentity(identity(path), cursor),
		);
		if (matched >= 0) {
			startIndex = matched;
			firstOffset = Number(cursor.offset) || 0;
			if (firstOffset > identity(paths[matched]).size) {
				firstOffset = 0;
				rotationGap = true;
			}
		} else {
			rotationGap = true;
		}
	}
	const seenRows = new Set();
	const rows = [];
	const parseErrors = [];
	let currentCursor = null;
	for (let index = startIndex; index < paths.length; index += 1) {
		const result = readLines(
			paths[index],
			index === startIndex ? firstOffset : 0,
			quarantine,
			seenRows,
		);
		rows.push(...result.rows);
		parseErrors.push(...result.parseErrors);
		if (paths[index] === AUDIT_LOG) currentCursor = result.cursor;
	}
	if (!currentCursor)
		throw new Error("audit log current generation was not readable");
	const findings = [];
	const p6 = rows.filter((row) => row.pattern === "P6");
	if (p6.length > 0) {
		const counts = { would_deny: 0, deny: 0, qa_calendar: 0 };
		const modes = new Map();
		for (const row of p6) {
			if (row.decision === "would_deny") counts.would_deny += 1;
			if (row.decision === "deny") counts.deny += 1;
			if (row.note === "qa_calendar") counts.qa_calendar += 1;
			const mode = String(row.mode ?? "unknown");
			modes.set(mode, (modes.get(mode) ?? 0) + 1);
		}
		findings.push({
			// The uncommitted cursor is rescanned while a prior daily snapshot is
			// carried. A stable key lets the complete rescan replace that subset.
			key: "p6_audit",
			type: "p6_audit",
			detail: `P6 audit: would_deny=${counts.would_deny} deny=${counts.deny} qa_calendar=${counts.qa_calendar} modes=${[...modes.entries()].map(([mode, count]) => `${mode}:${count}`).join(",")}`,
		});
	}
	if (parseErrors.length > 0) {
		findings.push({
			key: `parse:${parseErrors.map((item) => item.sha256).join(",")}`,
			type: "audit_log_parse_error",
			detail: `audit_log_parse_error count=${parseErrors.length} samples=${parseErrors
				.slice(0, 3)
				.map((item) => item.sha256.slice(0, 12))
				.join(",")}`,
		});
	}
	if (rotationGap) {
		findings.push({
			key: `rotation-gap:${currentCursor.dev}:${currentCursor.ino}`,
			type: "log_rotation_gap",
			detail:
				"log_rotation_gap: prior audit-log identity was not fully recoverable; rescanned the current file from offset 0",
		});
	}
	return {
		findings,
		cursor: currentCursor,
		quarantine,
	};
}

function runGog(now) {
	const from =
		process.env.CALENDAR_SWEEP_FROM ??
		new Date(now.getTime() - 7 * 86_400_000).toISOString();
	const to =
		process.env.CALENDAR_SWEEP_TO ??
		new Date(now.getTime() + 90 * 86_400_000).toISOString();
	const args = [
		"--account",
		ACCOUNT,
		...(CLIENT ? ["--client", CLIENT] : []),
		"--json",
		"calendar",
		"events",
		CALENDAR,
		"--from",
		from,
		"--to",
		to,
		"--all-pages",
		"--fields",
		"items(id,summary,created,updated,creator,extendedProperties,reminders),nextPageToken",
	];
	const result = spawnSync(GOG, args, { encoding: "utf8", timeout: 45_000 });
	if (result.error) throw new Error(`gog failed: ${result.error.message}`);
	if (result.status !== 0)
		throw new Error(
			`gog exited ${result.status}: ${(result.stderr ?? "").trim()}`,
		);
	let parsed;
	try {
		parsed = JSON.parse(result.stdout || "{}");
	} catch (error) {
		throw new Error(`gog returned invalid JSON: ${error.message}`);
	}
	// gog v0.10.0 returns `{events,nextPageToken}` even when the fields selector
	// uses the Google API's `items(...)` name. Keep `items` compatibility for
	// older/newer wrappers, but require one explicit array envelope.
	const items = Array.isArray(parsed)
		? parsed
		: Array.isArray(parsed.events)
			? parsed.events
			: parsed.items;
	if (!Array.isArray(items))
		throw new Error("gog JSON did not contain an events/items array");
	return items;
}

function eventFindings(events, state) {
	const cursorMs = Date.parse(state.eventCursorISO || EPOCH);
	const already = new Set(state.reportedEventIds);
	const findings = [];
	for (const event of events) {
		if (!event || typeof event.id !== "string" || already.has(event.id))
			continue;
		if (event.extendedProperties?.private?.raya_meeting_id) continue;
		const changed = Math.max(
			Date.parse(event.created || EPOCH),
			Date.parse(event.updated || EPOCH),
		);
		if (!Number.isFinite(changed) || changed <= cursorMs) continue;
		if (!KEYWORDS.test(String(event.summary ?? ""))) continue;
		findings.push({
			key: `event:${event.id}`,
			type: "suspicious_event",
			eventId: event.id,
			detail: `suspicious_event id=${event.id} summary=${JSON.stringify(String(event.summary ?? "").slice(0, 180))} created=${event.created ?? "unknown"} updated=${event.updated ?? "unknown"}`,
		});
	}
	return findings;
}

function currentMode() {
	const receiptPath = join(GUARD_DIR, "enforce-receipt.json");
	const modePath = join(GUARD_DIR, "mode");
	if (!existsSync(receiptPath))
		return { mode: "audit", receipt: false, messageId: null };
	let messageId = null;
	try {
		messageId =
			JSON.parse(readFileSync(receiptPath, "utf8")).discordMsgId ?? null;
	} catch {
		// Existence is the irreversible enforcement latch; corrupt receipt does
		// not relax it. The mode is still evaluated fail-closed below.
	}
	try {
		const tokens = readFileSync(modePath, "utf8").trim().split(/\s+/);
		const mode = tokens[0];
		const hash = tokens.indexOf("#");
		if (hash >= 0 && tokens[hash + 1]) messageId = tokens[hash + 1];
		return mode === "audit" || mode === "enforce"
			? { mode, receipt: true, messageId }
			: { mode: "invalid", receipt: true, messageId };
	} catch {
		return { mode: "invalid", receipt: true, messageId };
	}
}

function modeFindings(previousMode, observed) {
	const findings = [];
	if (previousMode === "enforce" && observed.mode === "audit") {
		findings.push({
			key: "mode-transition:enforce:audit",
			type: "mode_transition",
			detail: `mode_transition enforce→audit message_id=${observed.messageId ?? "missing"} (${observed.messageId ? "authorized rollback receipt present" : "authorization unproven"})`,
		});
	}
	if (observed.receipt && observed.mode === "invalid") {
		findings.push({
			key: "mode_invalid_with_receipt",
			type: "mode_invalid_with_receipt",
			detail: `mode_invalid_with_receipt: P6 remains fail-closed; founder receipt message_id=${observed.messageId ?? "unknown"}`,
		});
	}
	return findings;
}

function mergeFindings(...groups) {
	const merged = new Map();
	for (const finding of groups.flat()) merged.set(finding.key, finding);
	return [...merged.values()];
}

function buildBody(today, findings) {
	const header = `FLY-2137 calendar governance sweep (${today})`;
	const lines = [header];
	let omitted = 0;
	for (const finding of findings) {
		const candidate = `${lines.join("\n")}\n- ${finding.detail}`;
		if (candidate.length <= 1450) lines.push(`- ${finding.detail}`);
		else omitted += 1;
	}
	if (omitted > 0) lines.push(`- +${omitted} more, see ${AUDIT_LOG}`);
	return lines.join("\n").slice(0, 1500);
}

function commitHighWater(state, outbox, receipt) {
	state.eventCursorISO = outbox.highWater.eventCursorISO;
	state.logCursor = outbox.highWater.logCursor;
	state.lastObservedMode = outbox.highWater.lastObservedMode;
	state.quarantine = outbox.highWater.quarantine;
	state.reportedEventIds = outbox.highWater.reportedEventIds;
	state.dayReceipt = receipt;
	state.pendingOutbox = null;
	atomicWrite(state);
}

function deliver(state, outbox, now) {
	const args = [
		"--lead",
		LEAD,
		"--project",
		PROJECT,
		"--kind",
		"calendar_wild_write",
		"--severity",
		"warning",
		"--signature",
		outbox.eventId,
		"--strict-delivery",
		"--title",
		"Founder calendar write governance finding",
		"--body",
		outbox.body,
	];
	const command = ALERT.endsWith(".sh") ? "bash" : ALERT;
	const commandArgs = ALERT.endsWith(".sh") ? [ALERT, ...args] : args;
	const result = spawnSync(command, commandArgs, {
		encoding: "utf8",
		timeout: 60_000,
	});
	const lines = String(result.stdout ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const strictResult = lines.at(-1) ?? "unknown";
	const statusMatches =
		(strictResult === "sent" && result.status === 0) ||
		(strictResult === "queued_transient" && result.status === 2);
	if (result.error || !DELIVERY_OK.has(strictResult) || !statusMatches) {
		log(
			`strict delivery failed: result=${strictResult} status=${result.status ?? "spawn-error"}`,
		);
		return false;
	}
	if (process.env.FLYWHEEL_CALENDAR_SWEEP_TEST_CRASH_AFTER_ALERT === "1") {
		throw new Error(
			"test crash after strict delivery, before local checkpoint",
		);
	}
	commitHighWater(state, outbox, {
		dayBucket: state.dayBucket,
		eventId: outbox.eventId,
		result: strictResult,
		receivedAt: now.toISOString(),
	});
	return true;
}

function acquireLock() {
	mkdirSync(dirname(LOCK_PATH), { recursive: true, mode: 0o700 });
	try {
		mkdirSync(LOCK_PATH, { mode: 0o700 });
		return true;
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
	}

	let observed;
	try {
		observed = lstatSync(LOCK_PATH);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		return false;
	}
	if (!observed.isDirectory() || observed.isSymbolicLink())
		throw new Error(`lock path is not a safe directory: ${LOCK_PATH}`);
	if (Date.now() - observed.mtimeMs < LOCK_STALE_MS) {
		log(`another run holds ${LOCK_PATH}; exiting`);
		return false;
	}

	const stale = `${LOCK_PATH}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
	try {
		renameSync(LOCK_PATH, stale);
		const moved = lstatSync(stale);
		if (moved.dev !== observed.dev || moved.ino !== observed.ino) {
			if (!existsSync(LOCK_PATH)) renameSync(stale, LOCK_PATH);
			else {
				try {
					rmdirSync(stale);
				} catch {
					log(`lock race quarantine retained at ${stale}`);
				}
			}
			return false;
		}
		mkdirSync(LOCK_PATH, { mode: 0o700 });
	} catch {
		try {
			if (!existsSync(LOCK_PATH) && existsSync(stale))
				renameSync(stale, LOCK_PATH);
			else if (existsSync(stale)) rmdirSync(stale);
		} catch {
			// A concurrent owner won the lock race; never disturb its lock.
		}
		return false;
	}
	try {
		rmdirSync(stale);
	} catch {
		log(`recovered ${LOCK_PATH}; stale quarantine retained at ${stale}`);
	}
	log(`recovered stale lock ${LOCK_PATH}`);
	return true;
}

function main() {
	if (!acquireLock()) return 0;
	try {
		const now = new Date(process.env.CALENDAR_SWEEP_NOW ?? Date.now());
		if (!Number.isFinite(now.getTime()))
			throw new Error("CALENDAR_SWEEP_NOW is invalid");
		const today = dayBucket(now);
		const state = loadState();
		let carried = [];
		if (state.dayBucket !== today) {
			if (state.pendingOutbox) carried = state.pendingOutbox.findings ?? [];
			state.dayBucket = today;
			state.dayReceipt = null;
			state.pendingOutbox = null;
		} else if (state.pendingOutbox) {
			if (state.dayReceipt?.dayBucket === today) return 0;
			return deliver(state, state.pendingOutbox, now) ? 0 : 1;
		}

		const events = runGog(now);
		const audit = scanAuditLog(state.logCursor, state.quarantine ?? []);
		const observedMode = currentMode();
		const eventsFound = eventFindings(events, state);
		const findings = mergeFindings(
			carried,
			eventsFound,
			audit.findings,
			modeFindings(state.lastObservedMode, observedMode),
		);
		const reported = [
			...(state.reportedEventIds ?? []),
			...findings
				.filter((finding) => finding.eventId)
				.map((finding) => finding.eventId),
		].slice(-500);
		const highWater = {
			eventCursorISO: now.toISOString(),
			logCursor: audit.cursor,
			lastObservedMode: observedMode.mode,
			quarantine: audit.quarantine,
			reportedEventIds: [...new Set(reported)],
		};

		if (findings.length === 0) {
			state.eventCursorISO = highWater.eventCursorISO;
			state.logCursor = highWater.logCursor;
			state.lastObservedMode = highWater.lastObservedMode;
			state.quarantine = highWater.quarantine;
			state.reportedEventIds = highWater.reportedEventIds;
			atomicWrite(state);
			return 0;
		}

		const outbox = {
			dayBucket: today,
			eventId: `calendar-sweep-${today}`,
			body: buildBody(today, findings),
			findings,
			highWater,
			createdAt: now.toISOString(),
		};
		state.quarantine = audit.quarantine;
		state.pendingOutbox = outbox;
		atomicWrite(state);
		if (state.dayReceipt?.dayBucket === today) return 0;
		return deliver(state, outbox, now) ? 0 : 1;
	} finally {
		try {
			rmdirSync(LOCK_PATH);
		} catch {
			// The exact single-writer lock is best-effort cleanup only.
		}
	}
}

try {
	process.exitCode = main();
} catch (error) {
	log(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
