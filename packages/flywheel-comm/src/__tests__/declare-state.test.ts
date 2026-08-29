import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BUSY_DEFAULT_MS,
	BUSY_MAX_MS,
	declareState,
	parseDuration,
} from "../commands/declare-state.js";
import { send } from "../commands/send.js";
import { CommDB } from "../db.js";

describe("parseDuration (FLY-626)", () => {
	it("parses s/m/h/d suffixes", () => {
		expect(parseDuration("45s")).toBe(45_000);
		expect(parseDuration("30m")).toBe(30 * 60_000);
		expect(parseDuration("2h")).toBe(2 * 3_600_000);
		expect(parseDuration("1d")).toBe(24 * 3_600_000);
	});
	it("treats a bare number as minutes", () => {
		expect(parseDuration("60")).toBe(60 * 60_000);
	});
	it("rejects garbage / non-positive", () => {
		expect(parseDuration("abc")).toBeNull();
		expect(parseDuration("0m")).toBeNull();
		expect(parseDuration("-5m")).toBeNull();
		expect(parseDuration("")).toBeNull();
	});
});

describe("declareState (FLY-626)", () => {
	let db: CommDB;
	let tmpDir: string;
	const T0 = 1_700_000_000_000;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-declare-cmd-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});
	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("park writes an indefinite parked marker by default", () => {
		const r = declareState(db, { action: "park", execId: "e1", nowMs: T0 });
		expect(r.kind).toBe("parked");
		expect(r.expiresAtMs).toBeNull();
		expect(db.getEffectiveDeclaredState("e1", T0)?.kind).toBe("parked");
	});

	it("park --until bounds the marker", () => {
		const r = declareState(db, {
			action: "park",
			execId: "e1",
			nowMs: T0,
			durationMs: 60_000,
			reason: "lunch",
		});
		expect(r.expiresAtMs).toBe(T0 + 60_000);
		expect(db.getEffectiveDeclaredState("e1", T0 + 30_000)?.reason).toBe(
			"lunch",
		);
		expect(db.getEffectiveDeclaredState("e1", T0 + 60_000)).toBeNull();
	});

	it("busy defaults to BUSY_DEFAULT_MS when no --expect", () => {
		const r = declareState(db, { action: "busy", execId: "e1", nowMs: T0 });
		expect(r.kind).toBe("long_task");
		expect(r.expiresAtMs).toBe(T0 + BUSY_DEFAULT_MS);
	});

	it("busy caps --expect at BUSY_MAX_MS", () => {
		const r = declareState(db, {
			action: "busy",
			execId: "e1",
			nowMs: T0,
			durationMs: BUSY_MAX_MS + 10 * 3_600_000,
		});
		expect(r.expiresAtMs).toBe(T0 + BUSY_MAX_MS);
	});

	it("unpark clears the marker", () => {
		declareState(db, { action: "park", execId: "e1", nowMs: T0 });
		declareState(db, { action: "unpark", execId: "e1", nowMs: T0 });
		expect(db.getEffectiveDeclaredState("e1", T0)).toBeNull();
	});

	it("a Lead re-engagement (send) clears an indefinite park marker (Codex #1 / FLY-369)", async () => {
		// indefinite park on a runner that is never explicitly unparked
		declareState(db, { action: "park", execId: "runner-e1", nowMs: T0 });
		expect(db.getEffectiveDeclaredState("runner-e1", T0)).not.toBeNull();
		// the Lead sends an instruction — re-engagement → marker must be cleared
		await send({
			fromAgent: "product-lead",
			toAgent: "runner-e1",
			content: "please continue iterating on the report",
			dbPath: join(tmpDir, "comm.db"),
		});
		expect(db.getEffectiveDeclaredState("runner-e1", T0)).toBeNull();
	});
});
