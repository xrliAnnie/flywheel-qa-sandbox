/**
 * FLY-2830 — when did an account switch last happen.
 *
 * The only thing persisted about a switch-triggered refresh is the moment the
 * Bridge saw each vendor's switch generation move. The account page compares
 * every cell's own data-source reading time against it, so a refresh that
 * failed or has not finished simply shows as "not yet re-read" — there is no
 * refresh state to go stale, and no second writer.
 *
 * Single writer: the SwitchRefreshTrigger. No free text is ever stored.
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { preparePrivateDirectory } from "../private-directory.js";

export type SwitchVendor = "codex" | "claude";

export interface SwitchRecordEntry {
	generation: number;
	observedAt: string;
}

export interface SwitchRecord {
	schemaVersion: 1;
	codex: SwitchRecordEntry | null;
	claude: SwitchRecordEntry | null;
}

const MAX_RECORD_BYTES = 4 * 1024;
const FUTURE_SKEW_MS = 60_000;
const RECORD_KEYS = ["schemaVersion", "codex", "claude"];
const ENTRY_KEYS = ["generation", "observedAt"];

export function defaultSwitchRecordPath(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	const stateDir = env.FLYWHEEL_STATE_DIR?.trim() || join(home, ".flywheel");
	return join(stateDir, "codex-quota", "last-switch.json");
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
	Object.keys(value).length === keys.length &&
	keys.every((key) => Object.hasOwn(value, key));

function parseEntry(value: unknown, nowMs: number): SwitchRecordEntry | null {
	if (!plainObject(value) || !exactKeys(value, ENTRY_KEYS))
		throw new Error("switch_record_entry_invalid");
	const { generation, observedAt } = value;
	if (
		typeof generation !== "number" ||
		!Number.isSafeInteger(generation) ||
		generation < 0
	)
		throw new Error("switch_record_generation_invalid");
	if (
		typeof observedAt !== "string" ||
		!Number.isFinite(Date.parse(observedAt)) ||
		new Date(Date.parse(observedAt)).toISOString() !== observedAt ||
		Date.parse(observedAt) > nowMs + FUTURE_SKEW_MS
	)
		throw new Error("switch_record_time_invalid");
	return { generation, observedAt };
}

function parseRecord(value: unknown, nowMs: number): SwitchRecord {
	if (
		!plainObject(value) ||
		!exactKeys(value, RECORD_KEYS) ||
		value.schemaVersion !== 1
	)
		throw new Error("switch_record_shape_invalid");
	return {
		schemaVersion: 1,
		codex: value.codex === null ? null : parseEntry(value.codex, nowMs),
		claude: value.claude === null ? null : parseEntry(value.claude, nowMs),
	};
}

/** Missing → null silently; anything else invalid → null with one log line. */
export function readSwitchRecord(
	path: string,
	opts: { now?: () => number; log?: (line: string) => void } = {},
): SwitchRecord | null {
	const log = opts.log ?? ((line) => console.warn(line));
	try {
		const stat = lstatSync(path);
		if (!stat.isFile()) throw new Error("switch_record_not_plain_file");
		if (stat.size > MAX_RECORD_BYTES)
			throw new Error("switch_record_too_large");
		const raw = readFileSync(path, "utf8");
		if (raw.length > MAX_RECORD_BYTES)
			throw new Error("switch_record_too_large");
		return parseRecord(JSON.parse(raw), (opts.now ?? Date.now)());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		const reason =
			error instanceof Error && /^switch_record_[a-z_]+$/.test(error.message)
				? error.message
				: "switch_record_unreadable";
		log(`[switch-record] ignored reason=${reason}`);
		return null;
	}
}

/**
 * Atomic owner-only write. The temp name is unpredictable and created
 * exclusively (`wx`: O_CREAT|O_EXCL, which never follows a link), so nothing
 * pre-planted at a temp path can be truncated or redirected; the parent is
 * opened without following a link and (re)tightened to 0700; only a temp
 * file this call created is removed.
 */
export function writeSwitchRecord(
	path: string,
	record: SwitchRecord,
	opts: { randomSuffix?: () => string } = {},
): void {
	preparePrivateDirectory(dirname(path));
	const temp = `${path}.tmp-${process.pid}-${(opts.randomSuffix ?? randomUUID)()}`;
	let created = false;
	try {
		const handle = openSync(temp, "wx", 0o600);
		created = true;
		try {
			writeSync(handle, `${JSON.stringify(record)}\n`);
			fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
		renameSync(temp, path);
	} catch (error) {
		if (created) {
			try {
				unlinkSync(temp);
			} catch {
				/* the temp file is already gone */
			}
		}
		throw error;
	}
}

export function withSwitch(
	record: SwitchRecord | null,
	vendor: SwitchVendor,
	entry: SwitchRecordEntry,
): SwitchRecord {
	return {
		schemaVersion: 1,
		codex: record?.codex ?? null,
		claude: record?.claude ?? null,
		[vendor]: entry,
	};
}

function later(
	a: SwitchRecordEntry | null | undefined,
	b: SwitchRecordEntry | null | undefined,
): SwitchRecordEntry | null {
	if (!a) return b ?? null;
	if (!b) return a;
	return Date.parse(b.observedAt) > Date.parse(a.observedAt) ? b : a;
}

/** In-process and on-disk records, per vendor, whichever was observed later. */
export function newerSwitchRecord(
	a: SwitchRecord | null,
	b: SwitchRecord | null,
): SwitchRecord | null {
	if (!a && !b) return null;
	return {
		schemaVersion: 1,
		codex: later(a?.codex, b?.codex),
		claude: later(a?.claude, b?.claude),
	};
}

export function lastSwitchOf(
	record: SwitchRecord | null,
): { at: string; vendor: "Codex" | "Claude" } | null {
	const codex = record?.codex ?? null;
	const claude = record?.claude ?? null;
	if (!codex && !claude) return null;
	if (
		codex &&
		(!claude || Date.parse(codex.observedAt) >= Date.parse(claude.observedAt))
	)
		return { at: codex.observedAt, vendor: "Codex" };
	return { at: claude!.observedAt, vendor: "Claude" };
}

/**
 * The account page's last switch: in-process record (survives a failed disk
 * write) and the disk record (survives a Bridge restart), per vendor newer.
 * Never throws — a broken record means "no marks", not a broken page.
 */
export function resolvePageLastSwitch(
	inProcess: SwitchRecord | null,
	readDisk: () => SwitchRecord | null,
): { at: string; vendor: "Codex" | "Claude" } | null {
	let disk: SwitchRecord | null = null;
	try {
		disk = readDisk();
	} catch {
		disk = null;
	}
	return lastSwitchOf(newerSwitchRecord(inProcess, disk));
}
