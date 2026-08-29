import {
	existsSync,
	mkdtempSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DaemonState, loadState, saveState } from "../state-file.js";

const state = (): DaemonState => ({
	schemaVersion: 1,
	modeOn: true,
	cursors: { "chan-1": "111", "thread-2": "222" },
	queue: { items: [], seenMessageIds: ["m-1"] },
	turn: undefined,
});

function tmpStatePath(): string {
	return join(mkdtempSync(join(tmpdir(), "hp-state-")), "headphone-state.json");
}

describe("state-file", () => {
	it("save/load round-trips and creates the file 0600", () => {
		const p = tmpStatePath();
		saveState(p, state());
		const loaded = loadState(p);
		expect(loaded).toEqual(state());
		const mode = statSync(p).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("load returns undefined when no state file exists (fresh install)", () => {
		expect(loadState(tmpStatePath())).toBeUndefined();
	});

	it("corrupt state is QUARANTINED (renamed aside) and throws — never silently reset", () => {
		const p = tmpStatePath();
		writeFileSync(p, "{not-json", "utf8");
		expect(() => loadState(p)).toThrow(/quarantine|corrupt/i);
		// original renamed aside, not deleted
		expect(existsSync(p)).toBe(false);
		const siblings = readdirSync(join(p, ".."));
		expect(siblings.some((f) => f.includes("corrupt"))).toBe(true);
	});

	it("unknown schemaVersion is quarantined and throws (no silent migration)", () => {
		const p = tmpStatePath();
		writeFileSync(p, JSON.stringify({ schemaVersion: 99 }), "utf8");
		expect(() => loadState(p)).toThrow(/schemaVersion/);
		expect(existsSync(p)).toBe(false);
	});

	it("save overwrites atomically (no partial tmp left behind)", () => {
		const p = tmpStatePath();
		saveState(p, state());
		saveState(p, { ...state(), modeOn: false });
		expect(loadState(p)?.modeOn).toBe(false);
		const siblings = readdirSync(join(p, ".."));
		expect(siblings.filter((f) => f.includes("tmp"))).toEqual([]);
	});
});
