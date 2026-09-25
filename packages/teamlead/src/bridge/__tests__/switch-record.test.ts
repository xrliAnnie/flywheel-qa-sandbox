import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	defaultSwitchRecordPath,
	lastSwitchOf,
	newerSwitchRecord,
	readSwitchRecord,
	resolvePageLastSwitch,
	type SwitchRecord,
	withSwitch,
	writeSwitchRecord,
} from "../switch-record.js";

const NOW = Date.parse("2026-09-25T20:00:00.000Z");
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		try {
			chmodSync(root, 0o700);
		} catch {
			/* already gone */
		}
		rmSync(root, { recursive: true, force: true });
	}
});
function dir() {
	const root = mkdtempSync(join(tmpdir(), "fly2830-switch-record-"));
	roots.push(root);
	return root;
}
const record = (
	codex: SwitchRecord["codex"],
	claude: SwitchRecord["claude"] = null,
): SwitchRecord => ({ schemaVersion: 1, codex, claude });

describe("FLY-2830 last-switch record", () => {
	it("round-trips an owner-only file", () => {
		const path = join(dir(), "codex-quota", "last-switch.json");
		const value = record(
			{ generation: 7, observedAt: "2026-09-25T19:59:00.000Z" },
			{ generation: 3, observedAt: "2026-09-25T18:00:00.000Z" },
		);
		writeSwitchRecord(path, value);
		expect(readSwitchRecord(path, { now: () => NOW })).toEqual(value);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
	});

	it("defaults under the Flywheel state dir", () => {
		expect(
			defaultSwitchRecordPath({ FLYWHEEL_STATE_DIR: "/state" }, "/home/u"),
		).toBe("/state/codex-quota/last-switch.json");
		expect(defaultSwitchRecordPath({}, "/home/u")).toBe(
			"/home/u/.flywheel/codex-quota/last-switch.json",
		);
	});

	it.each([
		["an unknown key", { ...record(null), extra: 1 }],
		["a wrong schema version", { ...record(null), schemaVersion: 2 }],
		[
			"a negative generation",
			record({ generation: -1, observedAt: "2026-09-25T19:00:00.000Z" }),
		],
		[
			"a fractional generation",
			record({ generation: 1.5, observedAt: "2026-09-25T19:00:00.000Z" }),
		],
		[
			"a non-canonical time",
			record({ generation: 1, observedAt: "2026-09-25 19:00" }),
		],
		[
			"a time far in the future",
			record({ generation: 1, observedAt: "2026-09-25T20:05:00.000Z" }),
		],
		[
			"an unknown entry key",
			{
				...record(null),
				claude: {
					generation: 1,
					observedAt: "2026-09-25T19:00:00.000Z",
					from: "x",
				},
			},
		],
	])("reads %s as no record", (_name, value) => {
		const path = join(dir(), "last-switch.json");
		writeFileSync(path, JSON.stringify(value));
		const lines: string[] = [];
		expect(
			readSwitchRecord(path, { now: () => NOW, log: (l) => lines.push(l) }),
		).toBeNull();
		expect(lines).toHaveLength(1);
	});

	it("refuses a symlink, an oversized file and a missing file", () => {
		const root = dir();
		const real = join(root, "real.json");
		writeFileSync(real, JSON.stringify(record(null)));
		const link = join(root, "link.json");
		symlinkSync(real, link);
		expect(readSwitchRecord(link, { now: () => NOW })).toBeNull();
		const big = join(root, "big.json");
		writeFileSync(big, " ".repeat(5000));
		expect(readSwitchRecord(big, { now: () => NOW })).toBeNull();
		expect(readSwitchRecord(join(root, "none.json"))).toBeNull();
	});

	it("cleans up the temp file when the rename fails", () => {
		const root = dir();
		const path = join(root, "last-switch.json");
		// A non-empty directory at the target makes rename fail after the write.
		mkdirSync(path);
		writeFileSync(join(path, "occupied"), "x");
		expect(() => writeSwitchRecord(path, record(null))).toThrow();
		expect(readdirSync(root).filter((name) => name.includes(".tmp"))).toEqual(
			[],
		);
		expect(existsSync(join(path, "occupied"))).toBe(true);
	});

	it("updates only the vendor that switched", () => {
		const base = record(
			{ generation: 1, observedAt: "2026-09-25T10:00:00.000Z" },
			{ generation: 9, observedAt: "2026-09-25T11:00:00.000Z" },
		);
		expect(
			withSwitch(base, "codex", {
				generation: 2,
				observedAt: "2026-09-25T12:00:00.000Z",
			}),
		).toEqual(
			record(
				{ generation: 2, observedAt: "2026-09-25T12:00:00.000Z" },
				{ generation: 9, observedAt: "2026-09-25T11:00:00.000Z" },
			),
		);
		expect(
			withSwitch(null, "claude", {
				generation: 1,
				observedAt: "2026-09-25T12:00:00.000Z",
			}),
		).toEqual(
			record(null, { generation: 1, observedAt: "2026-09-25T12:00:00.000Z" }),
		);
	});

	it("merges per vendor by the later observation and names the last switch", () => {
		const memory = record(
			{ generation: 5, observedAt: "2026-09-25T19:00:00.000Z" },
			null,
		);
		const disk = record(
			{ generation: 4, observedAt: "2026-09-25T18:00:00.000Z" },
			{ generation: 2, observedAt: "2026-09-25T19:30:00.000Z" },
		);
		const merged = newerSwitchRecord(memory, disk);
		expect(merged).toEqual(
			record(
				{ generation: 5, observedAt: "2026-09-25T19:00:00.000Z" },
				{ generation: 2, observedAt: "2026-09-25T19:30:00.000Z" },
			),
		);
		expect(lastSwitchOf(merged)).toEqual({
			at: "2026-09-25T19:30:00.000Z",
			vendor: "Claude",
		});
		expect(lastSwitchOf(record(null))).toBeNull();
		expect(lastSwitchOf(null)).toBeNull();
		expect(newerSwitchRecord(null, null)).toBeNull();
	});

	it("never stores free text", () => {
		const path = join(dir(), "last-switch.json");
		writeSwitchRecord(
			path,
			record({ generation: 1, observedAt: "2026-09-25T19:00:00.000Z" }),
		);
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual([
			"schemaVersion",
			"codex",
			"claude",
		]);
	});
});

describe("FLY-2830 page last-switch resolution", () => {
	const memory = record({
		generation: 5,
		observedAt: "2026-09-25T19:50:00.000Z",
	});
	it("uses the in-process record when the disk read throws or is empty", () => {
		expect(
			resolvePageLastSwitch(memory, () => {
				throw new Error("EIO");
			}),
		).toEqual({ at: "2026-09-25T19:50:00.000Z", vendor: "Codex" });
		expect(resolvePageLastSwitch(memory, () => null)).toEqual({
			at: "2026-09-25T19:50:00.000Z",
			vendor: "Codex",
		});
	});

	it("prefers a later disk entry (e.g. after a Bridge restart) and returns null with nothing", () => {
		expect(
			resolvePageLastSwitch(null, () =>
				record(null, { generation: 2, observedAt: "2026-09-25T19:55:00.000Z" }),
			),
		).toEqual({ at: "2026-09-25T19:55:00.000Z", vendor: "Claude" });
		expect(resolvePageLastSwitch(null, () => null)).toBeNull();
	});
});

describe("FLY-2830 R1 — last-switch write cannot be redirected", () => {
	it("refuses to follow a pre-planted link at the temp name and leaves its target alone", () => {
		const root = dir();
		const path = join(root, "codex-quota", "last-switch.json");
		mkdirSync(join(root, "codex-quota"), { mode: 0o700 });
		const victim = join(root, "victim.txt");
		writeFileSync(victim, "keep me");
		symlinkSync(victim, `${path}.tmp-${process.pid}-fixed`);
		expect(() =>
			writeSwitchRecord(path, record(null), { randomSuffix: () => "fixed" }),
		).toThrow();
		expect(readFileSync(victim, "utf8")).toBe("keep me");
		expect(existsSync(path)).toBe(false);
	});

	it("tightens an existing parent directory to 0700", () => {
		const root = dir();
		const parent = join(root, "codex-quota");
		mkdirSync(parent, { mode: 0o755 });
		chmodSync(parent, 0o755);
		const path = join(parent, "last-switch.json");
		writeSwitchRecord(path, record(null));
		expect(statSync(parent).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});
});

describe("FLY-2830 R2 — the record's parent directory is never followed", () => {
	it("refuses a symlinked parent and leaves the link target untouched", () => {
		const root = dir();
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o755 });
		chmodSync(elsewhere, 0o755);
		writeFileSync(join(elsewhere, "keep.txt"), "x");
		symlinkSync(elsewhere, join(root, "codex-quota"));
		expect(() =>
			writeSwitchRecord(
				join(root, "codex-quota", "last-switch.json"),
				record(null),
			),
		).toThrow();
		expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
		expect(readdirSync(elsewhere)).toEqual(["keep.txt"]);
	});
});
