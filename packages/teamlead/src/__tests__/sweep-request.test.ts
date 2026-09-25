import {
	chmodSync,
	existsSync,
	lstatSync,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	defaultSweepRequestPath,
	readSweepRequest,
	writeSweepRequest,
} from "../account-heal/sweep-request.js";

const NOW = Date.parse("2026-09-25T20:00:00.000Z");
const ID = "3f2a8c1e-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
let dir: string;
let path: string;
let logs: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly2830-sweep-"));
	path = join(dir, "claude-quota", "sweep-request.json");
	logs = [];
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const read = () =>
	readSweepRequest({ path, now: () => NOW, log: (line) => logs.push(line) });
const raw = (value: unknown) => {
	mkdirSync(join(dir, "claude-quota"), { recursive: true });
	writeFileSync(
		path,
		typeof value === "string" ? value : JSON.stringify(value),
	);
};
const valid = {
	schemaVersion: 1,
	requestId: ID,
	requestedAt: new Date(NOW - 5_000).toISOString(),
	reason: "codex_switch",
};

describe("FLY-2830 — Claude sweep request file", () => {
	it("round-trips a request written owner-only under a 0700 parent", () => {
		const written = writeSweepRequest(
			{ reason: "claude_switch" },
			{ path, now: () => NOW, randomUUID: () => ID },
		);
		expect(written).toEqual({
			schemaVersion: 1,
			requestId: ID,
			requestedAt: new Date(NOW).toISOString(),
			reason: "claude_switch",
		});
		expect(read()).toEqual(written);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "claude-quota")).mode & 0o777).toBe(0o700);
		expect(readdirSync(join(dir, "claude-quota"))).toEqual([
			"sweep-request.json",
		]);
		expect(logs).toEqual([]);
	});

	it("replaces an earlier request atomically", () => {
		writeSweepRequest({ reason: "codex_switch" }, { path, now: () => NOW });
		const second = writeSweepRequest(
			{ reason: "claude_switch" },
			{ path, now: () => NOW, randomUUID: () => ID },
		);
		expect(read()).toEqual(second);
		expect(readdirSync(join(dir, "claude-quota"))).toEqual([
			"sweep-request.json",
		]);
	});

	it("cleans up the temp file and throws when the rename fails", () => {
		// A directory at the target path makes rename fail after the temp write.
		mkdirSync(path, { recursive: true });
		expect(() =>
			writeSweepRequest({ reason: "codex_switch" }, { path, now: () => NOW }),
		).toThrow();
		expect(readdirSync(join(dir, "claude-quota"))).toEqual([
			"sweep-request.json",
		]);
		expect(lstatSync(path).isDirectory()).toBe(true);
	});

	it("rejects an unknown reason at write time", () => {
		expect(() =>
			writeSweepRequest({ reason: "evil" as never }, { path, now: () => NOW }),
		).toThrow();
		expect(existsSync(path)).toBe(false);
	});

	it("reads nothing when no request exists, without logging", () => {
		expect(read()).toBeNull();
		expect(logs).toEqual([]);
	});

	it.each([
		["an unknown key", { ...valid, extra: 1 }],
		["a missing key", { ...valid, reason: undefined }],
		["a non-UUID id", { ...valid, requestId: "not-a-uuid" }],
		["an unknown reason", { ...valid, reason: "manual" }],
		["a wrong schema version", { ...valid, schemaVersion: 2 }],
		["a non-canonical time", { ...valid, requestedAt: "2026-09-25 20:00" }],
		[
			"a time more than 60 s in the future",
			{ ...valid, requestedAt: new Date(NOW + 61_000).toISOString() },
		],
		[
			"a time older than 24 h",
			{
				...valid,
				requestedAt: new Date(NOW - 24 * 3_600_000 - 1).toISOString(),
			},
		],
		["an array", [valid]],
		["broken JSON", "{"],
	])("treats %s as no request and logs once", (_label, value) => {
		raw(value);
		expect(read()).toBeNull();
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatch(/^\[sweep-request\] invalid /);
	});

	it("accepts a slightly future time within the 60 s skew", () => {
		raw({ ...valid, requestedAt: new Date(NOW + 30_000).toISOString() });
		expect(read()?.requestId).toBe(ID);
	});

	it("treats an oversized file as no request", () => {
		raw(`${JSON.stringify(valid)}${" ".repeat(4096)}`);
		expect(read()).toBeNull();
		expect(logs).toHaveLength(1);
	});

	it("never follows a symlink", () => {
		const target = join(dir, "elsewhere.json");
		writeFileSync(target, JSON.stringify(valid));
		mkdirSync(join(dir, "claude-quota"), { recursive: true });
		symlinkSync(target, path);
		expect(read()).toBeNull();
		expect(logs).toHaveLength(1);
		expect(readFileSync(target, "utf8")).toBe(JSON.stringify(valid));
	});

	it("resolves the default path from the override, the state dir, then home", () => {
		expect(
			defaultSweepRequestPath(
				{ FLYWHEEL_CLAUDE_SWEEP_REQUEST_PATH: "/x/req.json" },
				"/home/u",
			),
		).toBe("/x/req.json");
		expect(
			defaultSweepRequestPath({ FLYWHEEL_STATE_DIR: "/state" }, "/home/u"),
		).toBe("/state/claude-quota/sweep-request.json");
		expect(defaultSweepRequestPath({}, "/home/u")).toBe(
			"/home/u/.flywheel/claude-quota/sweep-request.json",
		);
	});
});

describe("FLY-2830 R2 — the request's parent directory is never followed", () => {
	it("refuses a symlinked parent and leaves the link target untouched", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2830-sweep-parent-"));
		try {
			const elsewhere = join(root, "elsewhere");
			mkdirSync(elsewhere, { mode: 0o755 });
			chmodSync(elsewhere, 0o755);
			symlinkSync(elsewhere, join(root, "claude-quota"));
			expect(() =>
				writeSweepRequest(
					{ reason: "codex_switch" },
					{ path: join(root, "claude-quota", "sweep-request.json") },
				),
			).toThrow();
			expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
			expect(readdirSync(elsewhere)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
