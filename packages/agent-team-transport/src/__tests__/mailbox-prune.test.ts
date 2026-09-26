/**
 * FLY-182 Track A — mailbox/sidecar prune + unread-overflow marker tests.
 *
 * Validates the safety invariants from the Codex-approved plan:
 * - NEVER drop read:false (A1); malformed read → unread.
 * - Output preserves original order (only old read dropped).
 * - Sidecar idempotency-first (within-retention finalized never dropped by cap).
 * - Overflow marker write/overwrite/cleanup + {team,recipient} identity.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	SidecarRecord,
	TeammateMessage,
} from "../claude/ClaudeMailboxCodec.js";
import {
	DEFAULT_PRUNE_POLICY,
	overflowMarkerPath,
	type PrunePolicy,
	parseInboxIdentity,
	pruneMainEntries,
	pruneSidecarRecords,
	resolvePrunePolicy,
	updateOverflowMarker,
} from "../claude/mailbox-prune.js";

const NOW = Date.parse("2026-05-29T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

function msg(
	overrides: Partial<TeammateMessage> & { tsOffsetMs?: number },
): TeammateMessage {
	const { tsOffsetMs, ...rest } = overrides;
	return {
		from: "bridge",
		text: "x",
		timestamp: new Date(NOW + (tsOffsetMs ?? 0)).toISOString(),
		read: true,
		...rest,
	};
}

const policy = (over: Partial<PrunePolicy> = {}): PrunePolicy => ({
	...DEFAULT_PRUNE_POLICY,
	...over,
});

describe("pruneMainEntries", () => {
	it("never drops unread, no matter how old", () => {
		const entries = [
			msg({ read: false, tsOffsetMs: -100 * DAY }),
			msg({ read: false, tsOffsetMs: -50 * DAY }),
			msg({ read: false, tsOffsetMs: 0 }),
		];
		const r = pruneMainEntries(entries, policy({ readKeep: 1 }), NOW);
		expect(r.kept).toHaveLength(3);
		expect(r.unreadCount).toBe(3);
		expect(r.droppedCount).toBe(0);
	});

	it("treats malformed/undefined read as unread (never dropped)", () => {
		const entries: TeammateMessage[] = [
			// @ts-expect-error intentional malformed read
			{
				from: "a",
				text: "1",
				timestamp: new Date(NOW - 100 * DAY).toISOString(),
			},
			// @ts-expect-error intentional non-boolean read
			{
				from: "a",
				text: "2",
				timestamp: new Date(NOW - 100 * DAY).toISOString(),
				read: "yes",
			},
		];
		const r = pruneMainEntries(entries, policy({ readKeep: 0 }), NOW);
		expect(r.kept).toHaveLength(2);
		expect(r.unreadCount).toBe(2);
		expect(r.droppedCount).toBe(0);
	});

	it("drops read entries older than retention and beyond keep", () => {
		const entries = [
			msg({ text: "old1", tsOffsetMs: -10 * DAY }),
			msg({ text: "old2", tsOffsetMs: -9 * DAY }),
			msg({ text: "recent", tsOffsetMs: -1 * HOUR }),
		];
		const r = pruneMainEntries(
			entries,
			policy({ readKeep: 1, readRetentionMs: DAY }),
			NOW,
		);
		// recent kept by retention + keep; old1/old2 dropped.
		expect(r.kept.map((m) => m.text)).toEqual(["recent"]);
		expect(r.droppedCount).toBe(2);
	});

	it("keeps the most recent READ_KEEP read entries regardless of age", () => {
		const entries = [
			msg({ text: "a", tsOffsetMs: -100 * DAY }),
			msg({ text: "b", tsOffsetMs: -99 * DAY }),
			msg({ text: "c", tsOffsetMs: -98 * DAY }),
		];
		const r = pruneMainEntries(
			entries,
			policy({ readKeep: 2, readRetentionMs: DAY }),
			NOW,
		);
		// All old, but keep most recent 2 by timestamp → b, c (original order).
		expect(r.kept.map((m) => m.text)).toEqual(["b", "c"]);
		expect(r.droppedCount).toBe(1);
	});

	it("keeps all read within retention even when far beyond keep count", () => {
		const entries = Array.from(
			{ length: 100 },
			(_, i) => msg({ text: `r${i}`, tsOffsetMs: -i * 60_000 }), // all within last ~100min
		);
		const r = pruneMainEntries(
			entries,
			policy({ readKeep: 5, readRetentionMs: DAY }),
			NOW,
		);
		// retention window (24h) covers all 100 → none dropped.
		expect(r.kept).toHaveLength(100);
		expect(r.droppedCount).toBe(0);
	});

	it("preserves original order (unread interleaved with kept read)", () => {
		const entries = [
			msg({ text: "oldRead", tsOffsetMs: -10 * DAY }),
			msg({ text: "unread1", read: false, tsOffsetMs: -10 * DAY }),
			msg({ text: "recentRead", tsOffsetMs: -1 * HOUR }),
			msg({ text: "unread2", read: false, tsOffsetMs: 0 }),
		];
		const r = pruneMainEntries(
			entries,
			policy({ readKeep: 1, readRetentionMs: DAY }),
			NOW,
		);
		// oldRead dropped; order of survivors preserved.
		expect(r.kept.map((m) => m.text)).toEqual([
			"unread1",
			"recentRead",
			"unread2",
		]);
	});

	it("is deterministic on equal timestamps (index tie-break)", () => {
		const ts = new Date(NOW - 10 * DAY).toISOString();
		const entries = [
			{ from: "a", text: "A", timestamp: ts, read: true },
			{ from: "a", text: "B", timestamp: ts, read: true },
			{ from: "a", text: "C", timestamp: ts, read: true },
		];
		const r = pruneMainEntries(
			entries,
			policy({ readKeep: 1, readRetentionMs: DAY }),
			NOW,
		);
		// Equal ts → most-recent-1 is the LAST by index → "C".
		expect(r.kept.map((m) => m.text)).toEqual(["C"]);
	});

	it("invalid-timestamp read entries are not retained by the time rule", () => {
		const entries = [
			{ from: "a", text: "bad", timestamp: "not-a-date", read: true },
			msg({ text: "good", tsOffsetMs: -1 * HOUR }),
		];
		// readKeep 0 → recent-keep retains nothing; only retention applies.
		// "good" is within retention; "bad" (invalid ts) cannot prove freshness.
		const r = pruneMainEntries(
			entries,
			policy({ readKeep: 0, readRetentionMs: DAY }),
			NOW,
		);
		expect(r.kept.map((m) => m.text)).toEqual(["good"]);
		expect(r.droppedCount).toBe(1);
	});

	it("invalid-timestamp read entry CAN survive via recent-keep", () => {
		const entries = [
			{ from: "a", text: "bad", timestamp: "not-a-date", read: true },
			msg({ text: "old", tsOffsetMs: -100 * DAY }),
		];
		// readKeep 1 → most-recent-1: invalid ts sorts last (+Inf) → "bad" kept.
		const r = pruneMainEntries(
			entries,
			policy({ readKeep: 1, readRetentionMs: DAY }),
			NOW,
		);
		expect(r.kept.map((m) => m.text)).toEqual(["bad"]);
		expect(r.droppedCount).toBe(1);
	});

	it("handles empty array", () => {
		const r = pruneMainEntries([], policy(), NOW);
		expect(r.kept).toEqual([]);
		expect(r.unreadCount).toBe(0);
		expect(r.oldestUnreadTs).toBeNull();
	});

	it("reports oldestUnreadTs as the minimum unread timestamp", () => {
		const entries = [
			msg({ read: false, tsOffsetMs: -2 * DAY }),
			msg({ read: false, tsOffsetMs: -5 * DAY }),
			msg({ read: false, tsOffsetMs: -1 * DAY }),
		];
		const r = pruneMainEntries(entries, policy(), NOW);
		expect(r.oldestUnreadTs).toBe(NOW - 5 * DAY);
	});
});

describe("pruneSidecarRecords", () => {
	function rec(over: Partial<SidecarRecord>): SidecarRecord {
		return {
			flywheelId: "f",
			status: "finalized",
			idempotency: "stable",
			payloadFingerprint: "fp",
			pendingAt: NOW,
			finalizedAt: NOW,
			...over,
		};
	}

	it("keeps all pending records (never time-pruned)", () => {
		const records = [
			rec({
				flywheelId: "p1",
				status: "pending",
				pendingAt: NOW - 30 * DAY,
				finalizedAt: undefined,
			}),
			rec({
				flywheelId: "p2",
				status: "pending",
				pendingAt: NOW - 100 * DAY,
				finalizedAt: undefined,
			}),
		];
		const r = pruneSidecarRecords(records, policy({ sidecarKeep: 0 }), NOW);
		expect(r).toHaveLength(2);
	});

	it("keeps ALL finalized within retention even beyond keep cap (idempotency-first)", () => {
		const records = Array.from({ length: 50 }, (_, i) =>
			rec({ flywheelId: `f${i}`, finalizedAt: NOW - i * HOUR }),
		);
		// retention 7d covers all (max 49h old); keep cap 5 must NOT drop them.
		const r = pruneSidecarRecords(
			records,
			policy({ sidecarRetentionMs: 7 * DAY, sidecarKeep: 5 }),
			NOW,
		);
		expect(r).toHaveLength(50);
	});

	it("drops older-than-retention finalized beyond keep, keeping most recent keep", () => {
		const records = [
			rec({ flywheelId: "old1", finalizedAt: NOW - 30 * DAY }),
			rec({ flywheelId: "old2", finalizedAt: NOW - 20 * DAY }),
			rec({ flywheelId: "old3", finalizedAt: NOW - 10 * DAY }),
			rec({ flywheelId: "fresh", finalizedAt: NOW - 1 * HOUR }),
		];
		const r = pruneSidecarRecords(
			records,
			policy({ sidecarRetentionMs: 7 * DAY, sidecarKeep: 1 }),
			NOW,
		);
		const ids = r.map((x) => x.flywheelId).sort();
		// fresh (within retention) + old3 (most recent of the older) kept.
		expect(ids).toEqual(["fresh", "old3"]);
	});

	it("preserves original order", () => {
		const records = [
			rec({ flywheelId: "a", finalizedAt: NOW - 1 * HOUR }),
			rec({
				flywheelId: "b",
				status: "pending",
				finalizedAt: undefined,
				pendingAt: NOW,
			}),
			rec({ flywheelId: "c", finalizedAt: NOW - 2 * HOUR }),
		];
		const r = pruneSidecarRecords(records, policy(), NOW);
		expect(r.map((x) => x.flywheelId)).toEqual(["a", "b", "c"]);
	});
});

describe("parseInboxIdentity", () => {
	it("parses standard inbox path", () => {
		expect(
			parseInboxIdentity(
				"/home/u/.claude/teams/product-lead/inboxes/product-lead.json",
			),
		).toEqual({ team: "product-lead", recipient: "product-lead" });
	});

	it("distinguishes team vs recipient for the team-lead-in-product-lead case", () => {
		expect(
			parseInboxIdentity(
				"/home/u/.claude/teams/product-lead/inboxes/team-lead.json",
			),
		).toEqual({ team: "product-lead", recipient: "team-lead" });
	});

	it("parses runner inbox", () => {
		expect(
			parseInboxIdentity("/x/teams/ops-lead/inboxes/runner-abcd1234.json"),
		).toEqual({ team: "ops-lead", recipient: "runner-abcd1234" });
	});
});

describe("resolvePrunePolicy", () => {
	const saved = { ...process.env };
	afterEach(() => {
		process.env = { ...saved };
	});

	it("returns defaults when env unset", () => {
		for (const k of [
			"FLYWHEEL_MAILBOX_READ_KEEP",
			"FLYWHEEL_MAILBOX_READ_RETENTION_MS",
			"FLYWHEEL_MAILBOX_UNREAD_WARN",
			"FLYWHEEL_MAILBOX_SIDECAR_RETENTION_MS",
			"FLYWHEEL_MAILBOX_SIDECAR_KEEP",
		]) {
			delete process.env[k];
		}
		expect(resolvePrunePolicy()).toEqual(DEFAULT_PRUNE_POLICY);
	});

	it("honors valid positive-int env overrides", () => {
		process.env.FLYWHEEL_MAILBOX_READ_KEEP = "10";
		process.env.FLYWHEEL_MAILBOX_UNREAD_WARN = "500";
		const p = resolvePrunePolicy();
		expect(p.readKeep).toBe(10);
		expect(p.unreadWarn).toBe(500);
	});

	it("falls back to default on invalid/zero/negative env", () => {
		process.env.FLYWHEEL_MAILBOX_READ_KEEP = "0";
		process.env.FLYWHEEL_MAILBOX_UNREAD_WARN = "-5";
		process.env.FLYWHEEL_MAILBOX_SIDECAR_KEEP = "abc";
		const p = resolvePrunePolicy();
		expect(p.readKeep).toBe(DEFAULT_PRUNE_POLICY.readKeep);
		expect(p.unreadWarn).toBe(DEFAULT_PRUNE_POLICY.unreadWarn);
		expect(p.sidecarKeep).toBe(DEFAULT_PRUNE_POLICY.sidecarKeep);
	});
});

describe("updateOverflowMarker", () => {
	let stateDir: string;
	const savedStateDir = process.env.FLYWHEEL_STATE_DIR;
	const inboxPath =
		"/home/u/.claude/teams/product-lead/inboxes/product-lead.json";

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "fly182-overflow-"));
		process.env.FLYWHEEL_STATE_DIR = stateDir;
	});
	afterEach(async () => {
		if (savedStateDir === undefined) delete process.env.FLYWHEEL_STATE_DIR;
		else process.env.FLYWHEEL_STATE_DIR = savedStateDir;
		await rm(stateDir, { recursive: true, force: true });
	});

	it("writes marker with {team,recipient,inboxPath} when unread >= threshold", async () => {
		await updateOverflowMarker({
			inboxPath,
			unreadCount: 250,
			oldestUnreadTs: NOW - 5 * DAY,
			policy: policy({ unreadWarn: 200 }),
			now: NOW,
			logger: () => {},
		});
		const raw = await readFile(overflowMarkerPath(inboxPath), "utf-8");
		const m = JSON.parse(raw);
		expect(m.team).toBe("product-lead");
		expect(m.recipient).toBe("product-lead");
		expect(m.inboxPath).toBe(inboxPath);
		expect(m.unread).toBe(250);
	});

	it("idempotently overwrites (not appends)", async () => {
		const args = {
			inboxPath,
			oldestUnreadTs: NOW,
			policy: policy({ unreadWarn: 200 }),
			now: NOW,
			logger: () => {},
		};
		await updateOverflowMarker({ ...args, unreadCount: 250 });
		await updateOverflowMarker({ ...args, unreadCount: 300 });
		const raw = await readFile(overflowMarkerPath(inboxPath), "utf-8");
		const m = JSON.parse(raw); // single valid JSON object, not appended
		expect(m.unread).toBe(300);
	});

	it("deletes marker when unread drops below threshold", async () => {
		await updateOverflowMarker({
			inboxPath,
			unreadCount: 250,
			oldestUnreadTs: NOW,
			policy: policy({ unreadWarn: 200 }),
			now: NOW,
			logger: () => {},
		});
		await updateOverflowMarker({
			inboxPath,
			unreadCount: 5,
			oldestUnreadTs: NOW,
			policy: policy({ unreadWarn: 200 }),
			now: NOW,
			logger: () => {},
		});
		await expect(stat(overflowMarkerPath(inboxPath))).rejects.toThrow();
	});

	it("is a no-op (no throw) when clearing a non-existent marker", async () => {
		await expect(
			updateOverflowMarker({
				inboxPath,
				unreadCount: 0,
				oldestUnreadTs: null,
				policy: policy({ unreadWarn: 200 }),
				now: NOW,
				logger: () => {},
			}),
		).resolves.toBeUndefined();
	});

	it("never throws even if the marker write target is invalid", async () => {
		// Point at a path whose parent cannot be created (a file as a dir).
		const filePath = join(stateDir, "afile");
		await writeFile(filePath, "x", "utf-8");
		process.env.FLYWHEEL_STATE_DIR = filePath; // state dir is a file → mkdir fails
		await expect(
			updateOverflowMarker({
				inboxPath,
				unreadCount: 999,
				oldestUnreadTs: NOW,
				policy: policy({ unreadWarn: 200 }),
				now: NOW,
				logger: () => {},
			}),
		).resolves.toBeUndefined();
	});
});
