/**
 * FLY-1282 Part D (M10): Lead disposition receipts — durable outbox + tick
 * single-consumer. Design contract (plan.md Part D, Codex R16–R20 APPROVED):
 *   - prepare (via:'lead', changed=true) commits with the ack in ONE real
 *     transaction; ON CONFLICT(4-col generation key) DO NOTHING — only a
 *     same-generation duplicate no-ops, other constraint failures roll the
 *     WHOLE disposition back;
 *   - recovery (single + bulk) never touches the outbox; revive touches
 *     nothing — old pending receipts survive and deliver/expire, the new
 *     generation earns its own row via the anchor UNIQUE;
 *   - delivery: single consumer, confirmed-post-only stamping keyed by
 *     receipt_id + state='pending', bounded post, fair rotation, 7d expiry,
 *     one always-on delivery path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import {
	createDispositionReceiptPass,
	formatDispositionReceipt,
	postThreadMessage,
	RECEIPT_EXPIRY_MS,
	sanitizeReceiptNote,
} from "../disposition-receipt.js";

const KIND = "detection_stuck_confirmed";
const NOW = 1_800_000_000_000;

const PROJECTS = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/fw",
		leads: [
			{
				agentId: "tadashi",
				chatChannel: "ch-eng",
				match: { labels: ["Flywheel"] },
				botToken: "tok-tadashi",
			},
			{
				agentId: "peter",
				chatChannel: "ch-product",
				match: { labels: ["Product"] },
				botToken: "tok-peter",
			},
		],
	},
] as unknown as ProjectEntry[];

let dir: string;
let store: StateStore;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "fly1282-receipt-"));
	store = await StateStore.create(join(dir, "state.db"));
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function seedEpisode(
	over: Partial<{
		targetKey: string;
		fingerprint: string;
		issueId: string | null;
		firstDetectedAtMs: number;
	}> = {},
) {
	const input = {
		targetKey: over.targetKey ?? "exec-1",
		kind: KIND,
		episodeFingerprint: over.fingerprint ?? "aaaaaaaaaaaaaaaa",
		issueId: over.issueId === undefined ? "FLY-1282" : over.issueId,
		ownerLeadId: "tadashi",
		firstDetectedAtMs: over.firstDetectedAtMs ?? NOW - 60_000,
	};
	store.upsertDetectionEscalation(input);
	return input;
}

function receiptInput(over: Partial<Record<string, string>> = {}) {
	return {
		actorLeadId: over.actorLeadId ?? "tadashi",
		rawDisposition: over.rawDisposition ?? "ack",
		content:
			over.content ??
			formatDispositionReceipt({
				actorLeadId: over.actorLeadId ?? "tadashi",
				kind: KIND,
				rawDisposition: over.rawDisposition ?? "ack",
			}),
		executionId: "exec-1",
		projectName: "flywheel",
	};
}

function allReceipts(): Array<Record<string, unknown>> {
	// getPendingDispositionReceipts filters by state — for assertions we want
	// every row regardless of state.
	const raw = (
		store as unknown as {
			db: { exec: (sql: string) => Array<{ values: unknown[][] }> };
		}
	).db.exec(
		"SELECT receipt_id, state, content, disposition, actor_lead_id, episode_first_detected_at_ms, created_at_ms FROM disposition_receipts ORDER BY receipt_id",
	);
	return (raw[0]?.values ?? []).map((v) => ({
		receipt_id: v[0],
		state: v[1],
		content: v[2],
		disposition: v[3],
		actor_lead_id: v[4],
		episode_first_detected_at_ms: v[5],
		created_at_ms: v[6],
	}));
}

describe("M10 prepare — transactional ack + receipt", () => {
	it("first via:'lead' disposition creates exactly one pending receipt with the final content", () => {
		seedEpisode();
		const out = store.ackDetectionEscalationWithReceipt(
			"exec-1",
			KIND,
			"aaaaaaaaaaaaaaaa",
			{ atMs: NOW, disposition: "ack", receipt: receiptInput() },
		);
		expect(out).toEqual({ changed: true, receiptPrepared: true });
		const rows = allReceipts();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("pending");
		expect(rows[0]?.content).toContain("处置回执");
		expect(rows[0]?.content).toContain("tadashi");
		expect(rows[0]?.content).toContain("已接手在处理");
	});

	it("second disposition on the same generation → zero new rows (UNIQUE), even with a rolled-back wall clock", () => {
		seedEpisode();
		store.ackDetectionEscalationWithReceipt(
			"exec-1",
			KIND,
			"aaaaaaaaaaaaaaaa",
			{
				atMs: NOW,
				disposition: "ack",
				receipt: receiptInput(),
			},
		);
		// ACKED → RESOLVED is a real state change (changed=true), but the
		// generation UNIQUE blocks a second receipt — including when the clock
		// rolled BACK between the two requests (anchor-keyed, not time-keyed).
		const out = store.ackDetectionEscalationWithReceipt(
			"exec-1",
			KIND,
			"aaaaaaaaaaaaaaaa",
			{
				atMs: NOW - 3_600_000,
				disposition: "resolve",
				receipt: receiptInput({ rawDisposition: "resolve" }),
			},
		);
		expect(out.changed).toBe(true);
		expect(out.receiptPrepared).toBe(false);
		expect(allReceipts()).toHaveLength(1);
	});

	it("late ack after RESOLVED (recovery won) → changed=false, zero receipts", () => {
		seedEpisode();
		store.ackDetectionEscalation("exec-1", KIND, "aaaaaaaaaaaaaaaa", {
			atMs: NOW,
			disposition: "resolve",
			via: "recovery",
		});
		const out = store.ackDetectionEscalationWithReceipt(
			"exec-1",
			KIND,
			"aaaaaaaaaaaaaaaa",
			{ atMs: NOW + 1, disposition: "ack", receipt: receiptInput() },
		);
		expect(out).toEqual({ changed: false, receiptPrepared: false });
		expect(allReceipts()).toHaveLength(0);
	});

	it("non-UNIQUE constraint failure (content NULL) THROWS and rolls the ack back too (reopen shows all-or-nothing)", async () => {
		seedEpisode();
		expect(() =>
			store.ackDetectionEscalationWithReceipt(
				"exec-1",
				KIND,
				"aaaaaaaaaaaaaaaa",
				{
					atMs: NOW,
					disposition: "ack",
					receipt: {
						...receiptInput(),
						content: null as unknown as string, // NOT NULL violation
					},
				},
			),
		).toThrow();
		store.close();
		const reopened = await StateStore.create(join(dir, "state.db"));
		const row = reopened.getDetectionEscalation(
			"exec-1",
			KIND,
			"aaaaaaaaaaaaaaaa",
		);
		expect(row?.status).toBe("NEW"); // ack rolled back
		expect(row?.lead_ack_at_ms).toBeNull();
		const raw = (
			reopened as unknown as {
				db: { exec: (sql: string) => Array<{ values: unknown[][] }> };
			}
		).db.exec("SELECT COUNT(*) FROM disposition_receipts");
		expect(raw[0]?.values[0]?.[0]).toBe(0);
		reopened.close();
		store = await StateStore.create(join(dir, "state.db")); // for afterEach
	});

	it("two same-millisecond unroutable episodes (different fingerprints) each keep their own audit row (code R1 #3)", () => {
		seedEpisode({
			issueId: null,
			fingerprint: "aaaaaaaaaaaaaaaa",
			firstDetectedAtMs: NOW - 60_000,
		});
		seedEpisode({
			issueId: null,
			fingerprint: "bbbbbbbbbbbbbbbb",
			firstDetectedAtMs: NOW - 60_000,
		});
		for (const fp of ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]) {
			store.ackDetectionEscalationWithReceipt("exec-1", KIND, fp, {
				atMs: NOW,
				disposition: "ack",
				receipt: receiptInput(),
			});
		}
		expect(allReceipts()).toHaveLength(2);
		expect(
			store.getEventsByType("disposition_receipt_unroutable"),
		).toHaveLength(2);
	});

	it("issue_id empty → immediate terminal unroutable + session_events audit (only on real insert)", () => {
		seedEpisode({ issueId: null });
		const out = store.ackDetectionEscalationWithReceipt(
			"exec-1",
			KIND,
			"aaaaaaaaaaaaaaaa",
			{ atMs: NOW, disposition: "ack", receipt: receiptInput() },
		);
		expect(out.receiptPrepared).toBe(true);
		const rows = allReceipts();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("unroutable");
		const events = store.getEventsByType("disposition_receipt_unroutable");
		expect(events).toHaveLength(1);
	});

	it("applyStuckDispositionWithReceipts: N=2 episodes → 2 independent receipts; repeat request → zero new", () => {
		seedEpisode({ fingerprint: "aaaaaaaaaaaaaaaa" });
		seedEpisode({ fingerprint: "bbbbbbbbbbbbbbbb" });
		const call = () =>
			store.applyStuckDispositionWithReceipts({
				stuck: {
					execution_id: "exec-1",
					episode_fingerprint: "*",
					disposition: "legitimate_wait",
					noted_by: "tadashi",
					note: "(episode aaaaaaaaaaaaaaaa)",
				},
				episodes: [
					{
						targetKey: "exec-1",
						kind: KIND,
						episodeFingerprint: "aaaaaaaaaaaaaaaa",
						disposition: "ack",
					},
					{
						targetKey: "exec-1",
						kind: KIND,
						episodeFingerprint: "bbbbbbbbbbbbbbbb",
						disposition: "ack",
					},
				],
				atMs: NOW,
				receipt: receiptInput({ rawDisposition: "legitimate_wait" }),
			});
		expect(call().receiptsPrepared).toBe(2);
		expect(allReceipts()).toHaveLength(2);
		// Repeat: episodes already ACKED → runDetectionAckUpdate still matches
		// (status != RESOLVED) but the generation UNIQUE blocks new receipts.
		expect(call().receiptsPrepared).toBe(0);
		expect(allReceipts()).toHaveLength(2);
	});

	it("applyStuckDispositionWithReceipts rolls EVERYTHING back on failure (stuck write included)", async () => {
		seedEpisode();
		expect(() =>
			store.applyStuckDispositionWithReceipts({
				stuck: {
					execution_id: "exec-1",
					episode_fingerprint: "*",
					disposition: "legitimate_wait",
				},
				episodes: [
					{
						targetKey: "exec-1",
						kind: KIND,
						episodeFingerprint: "aaaaaaaaaaaaaaaa",
						disposition: "ack",
					},
				],
				atMs: NOW,
				receipt: {
					...receiptInput(),
					content: null as unknown as string, // forces the receipt INSERT to throw
				},
			}),
		).toThrow();
		store.close();
		const reopened = await StateStore.create(join(dir, "state.db"));
		expect(reopened.getStuckDisposition("exec-1", "*")).toBeUndefined(); // authoritative stuck write rolled back
		expect(
			reopened.getDetectionEscalation("exec-1", KIND, "aaaaaaaaaaaaaaaa")
				?.status,
		).toBe("NEW"); // ack rolled back
		reopened.close();
		store = await StateStore.create(join(dir, "state.db"));
	});
});

describe("M10 recovery / revive lifecycle", () => {
	it("recovery ack (single) and bulk resolveDetectionEscalationsForTarget never touch the outbox", () => {
		seedEpisode();
		store.ackDetectionEscalation("exec-1", KIND, "aaaaaaaaaaaaaaaa", {
			atMs: NOW,
			disposition: "resolve",
			via: "recovery",
		});
		expect(allReceipts()).toHaveLength(0);
		seedEpisode({ fingerprint: "cccccccccccccccc" });
		store.resolveDetectionEscalationsForTarget("exec-1");
		expect(allReceipts()).toHaveLength(0);
	});

	it("old-generation pending receipt survives revive; the new generation earns its own row", () => {
		const gen1 = seedEpisode({ firstDetectedAtMs: NOW - 120_000 });
		store.ackDetectionEscalationWithReceipt(
			"exec-1",
			KIND,
			"aaaaaaaaaaaaaaaa",
			{
				atMs: NOW - 100_000,
				disposition: "ack",
				receipt: receiptInput(),
			},
		);
		expect(allReceipts()).toHaveLength(1);
		// recovery closes the episode, then it revives with a NEWER anchor.
		store.ackDetectionEscalation("exec-1", KIND, "aaaaaaaaaaaaaaaa", {
			atMs: NOW - 90_000,
			disposition: "resolve",
			via: "recovery",
		});
		const revived = store.upsertDetectionEscalation({
			...gen1,
			firstDetectedAtMs: NOW - 30_000,
		});
		expect(revived.created).toBe(true);
		// Old pending receipt untouched by the revive.
		const afterRevive = allReceipts();
		expect(afterRevive).toHaveLength(1);
		expect(afterRevive[0]?.state).toBe("pending");
		// New generation Lead ack → second, independent receipt row.
		const out = store.ackDetectionEscalationWithReceipt(
			"exec-1",
			KIND,
			"aaaaaaaaaaaaaaaa",
			{ atMs: NOW, disposition: "ack", receipt: receiptInput() },
		);
		expect(out.receiptPrepared).toBe(true);
		const rows = allReceipts();
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.episode_first_detected_at_ms)).toEqual([
			NOW - 120_000,
			NOW - 30_000,
		]);
	});

	it("ESCALATED → Lead ack still earns a receipt (closure)", () => {
		seedEpisode();
		store.markDetectionEscalationLeadNotified(
			"exec-1",
			KIND,
			"aaaaaaaaaaaaaaaa",
			NOW - 50_000,
		);
		store.markDetectionEscalationEscalated(
			"exec-1",
			KIND,
			"aaaaaaaaaaaaaaaa",
			NOW - 10_000,
		);
		const out = store.ackDetectionEscalationWithReceipt(
			"exec-1",
			KIND,
			"aaaaaaaaaaaaaaaa",
			{ atMs: NOW, disposition: "ack", receipt: receiptInput() },
		);
		expect(out).toEqual({ changed: true, receiptPrepared: true });
	});
});

describe("M10 copy — formatter goldens", () => {
	it("covers the full disposition set (incl. snooze horizon + needs_founder)", () => {
		const base = { actorLeadId: "tadashi", kind: KIND };
		expect(formatDispositionReceipt({ ...base, rawDisposition: "ack" })).toBe(
			"🧾 处置回执:tadashi 已处理「会话疑似卡死」— 判定:已接手在处理",
		);
		expect(
			formatDispositionReceipt({
				...base,
				rawDisposition: "handled_remanaged",
			}),
		).toContain("已解决(已重新接管 Runner)");
		expect(
			formatDispositionReceipt({ ...base, rawDisposition: "false_positive" }),
		).toContain("判定误报关闭");
		expect(
			formatDispositionReceipt({ ...base, rawDisposition: "legitimate_wait" }),
		).toContain("判定为正常等待");
		expect(
			formatDispositionReceipt({ ...base, rawDisposition: "needs_founder" }),
		).toContain("已转呈 founder 决定");
		const snooze = formatDispositionReceipt({
			...base,
			rawDisposition: "snooze",
			snoozeUntilMs: Date.UTC(2026, 6, 16, 12, 0, 0),
		});
		expect(snooze).toContain("已挂起(至 2026-07-16T12:00:00.000Z)");
	});

	it("sanitizes mentions and caps the note at 200 chars; no pane text ever enters", () => {
		expect(sanitizeReceiptNote("<@123456> please @everyone look")).toBe(
			"＠ please ＠everyone look",
		);
		expect(sanitizeReceiptNote("x".repeat(300))).toHaveLength(201); // 200 + …
		const receipt = formatDispositionReceipt({
			actorLeadId: "tadashi",
			kind: KIND,
			rawDisposition: "ack",
			note: "<@99> handled",
		});
		expect(receipt).not.toMatch(/<@\d+>/);
	});
});

describe("M10 delivery — single consumer", () => {
	function seedPendingReceipt(
		over: Partial<{ createdAtMs: number; actor: string; issueId: string }> = {},
	) {
		seedEpisode({
			fingerprint: `${Math.random().toString(16).slice(2, 10)}00000000`.slice(
				0,
				16,
			),
			issueId: over.issueId ?? "FLY-1282",
			firstDetectedAtMs: (over.createdAtMs ?? NOW - 60_000) - 1,
		});
		// Simplest deterministic path: direct INSERT (the prepare path is
		// covered above; delivery only reads the row shape).
		const db = (
			store as unknown as {
				db: { run: (sql: string, p?: unknown[]) => void };
			}
		).db;
		db.run(
			`INSERT INTO disposition_receipts (
				target_key, kind, episode_fingerprint, episode_first_detected_at_ms,
				actor_lead_id, disposition, content, issue_id, state, created_at_ms
			 ) VALUES (?, ?, ?, ?, ?, 'ack', ?, ?, 'pending', ?)`,
			[
				"exec-1",
				KIND,
				`fp${Math.random().toString(16).slice(2, 12)}`,
				(over.createdAtMs ?? NOW - 60_000) - 1,
				over.actor ?? "tadashi",
				"🧾 处置回执:test",
				over.issueId ?? "FLY-1282",
				over.createdAtMs ?? NOW - 60_000,
			],
		);
	}

	it("pending + resolvable thread → posts once (owner token) and stamps posted", async () => {
		store.upsertChatThread("thread-1", "ch-eng", "FLY-1282", "tadashi");
		seedPendingReceipt();
		const postFn = vi.fn().mockResolvedValue(undefined);
		const pass = createDispositionReceiptPass({
			store,
			projects: PROJECTS,
			globalBotToken: "tok-global",
			now: () => NOW,
			postFn,
		});
		await pass();
		expect(postFn).toHaveBeenCalledTimes(1);
		expect(postFn.mock.calls[0]?.[0]).toBe("tok-tadashi"); // thread owner token
		expect(postFn.mock.calls[0]?.[1]).toBe("thread-1");
		expect(store.getPendingDispositionReceipts(10)).toHaveLength(0);
		await pass();
		expect(postFn).toHaveBeenCalledTimes(1); // no double post
	});

	it("actor ≠ thread creation-time owner → the OWNER's token is used (R19 #2)", async () => {
		// Thread created by peter in peter's channel; the acting lead is tadashi
		// whose chatChannel lookup still finds nothing in ch-eng — so seed the
		// thread in the ACTOR's channel but owned by peter (issue reassigned).
		store.upsertChatThread("thread-2", "ch-eng", "FLY-1282", "peter");
		seedPendingReceipt({ actor: "tadashi" });
		const postFn = vi.fn().mockResolvedValue(undefined);
		const pass = createDispositionReceiptPass({
			store,
			projects: PROJECTS,
			globalBotToken: "tok-global",
			now: () => NOW,
			postFn,
		});
		await pass();
		expect(postFn.mock.calls[0]?.[0]).toBe("tok-peter");
	});

	it("post throw → attempt stamped, row stays pending, next pass retries; poison first item never starves the rest (≤5/pass rotation)", async () => {
		store.upsertChatThread("thread-1", "ch-eng", "FLY-1282", "tadashi");
		for (let i = 0; i < 6; i++) {
			seedPendingReceipt({ createdAtMs: NOW - 60_000 + i });
		}
		// Deterministic poison: mark the OLDEST row's content and throw on it.
		const firstId = store.getPendingDispositionReceipts(1)[0]?.receipt_id;
		const db = (
			store as unknown as {
				db: { run: (sql: string, p?: unknown[]) => void };
			}
		).db;
		db.run(
			"UPDATE disposition_receipts SET content = 'POISON' WHERE receipt_id = ?",
			[firstId],
		);
		const post = vi.fn(async (_t: string, _th: string, content: string) => {
			if (content === "POISON") throw new Error("boom");
		});
		const pass = createDispositionReceiptPass({
			store,
			projects: PROJECTS,
			globalBotToken: "tok-global",
			now: () => NOW,
			postFn: post,
		});
		await pass(); // 5 attempts: poison fails, 4 posted
		expect(post).toHaveBeenCalledTimes(5);
		let pending = store.getPendingDispositionReceipts(10);
		expect(pending).toHaveLength(2); // poison + the 6th
		// Fair rotation: the never-attempted 6th sorts BEFORE the failed poison.
		expect(pending[0]?.content).not.toBe("POISON");
		await pass();
		pending = store.getPendingDispositionReceipts(10);
		expect(pending).toHaveLength(1);
		expect(pending[0]?.content).toBe("POISON"); // only the poison remains
	});

	it("rows older than 7 days expire loudly instead of retrying forever", async () => {
		seedPendingReceipt({ createdAtMs: NOW - RECEIPT_EXPIRY_MS - 1 });
		const postFn = vi.fn();
		const log = vi.fn();
		const pass = createDispositionReceiptPass({
			store,
			projects: PROJECTS,
			now: () => NOW,
			postFn,
			log,
		});
		await pass();
		expect(postFn).not.toHaveBeenCalled();
		expect(store.getPendingDispositionReceipts(10)).toHaveLength(0);
		expect(log.mock.calls.some((c) => String(c[0]).includes("EXPIRED"))).toBe(
			true,
		);
		// Annie 铁律: the give-up leaves a durable audit row, not just a log line.
		expect(store.getEventsByType("disposition_receipt_expired")).toHaveLength(
			1,
		);
	});

	it("expiry audit failure rolls the expiry back — the receipt STAYS pending for retry (atomic, code R1 #3)", async () => {
		seedPendingReceipt({ createdAtMs: NOW - RECEIPT_EXPIRY_MS - 1 });
		const receiptId = (
			store as unknown as {
				db: { exec: (sql: string) => Array<{ values: unknown[][] }> };
			}
		).db.exec("SELECT receipt_id FROM disposition_receipts")[0]?.values[0]?.[0];
		// Occupy the audit event id — the in-transaction INSERT will hit UNIQUE
		// and throw, which must roll the expired-state flip back too.
		store.insertEvent({
			event_id: `receipt-expired-${receiptId}`,
			execution_id: "exec-1",
			issue_id: "FLY-1282",
			project_name: "flywheel",
			event_type: "occupied",
			source: "test",
		});
		const pass = createDispositionReceiptPass({
			store,
			projects: PROJECTS,
			now: () => NOW,
			postFn: vi.fn(),
			log: () => {},
		});
		await pass();
		const row = store.getPendingDispositionReceipts(10)[0];
		expect(row).toBeDefined(); // still pending — never expired without audit
		expect(row?.attempts).toBe(1); // the failure was stamped for rotation
	});

	it("unresolvable thread counts as a FAILED attempt (stamped, rotates) — never a zero-stamp squatter", async () => {
		seedPendingReceipt(); // no chat thread seeded at all
		const pass = createDispositionReceiptPass({
			store,
			projects: PROJECTS,
			now: () => NOW,
			postFn: vi.fn(),
		});
		await pass();
		const row = store.getPendingDispositionReceipts(10)[0];
		expect(row?.attempts).toBe(1);
		expect(row?.last_attempt_at_ms).toBe(NOW);
	});

	it("overlapping invocation is skipped by the single-flight latch", async () => {
		store.upsertChatThread("thread-1", "ch-eng", "FLY-1282", "tadashi");
		seedPendingReceipt();
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const postFn = vi.fn().mockImplementation(() => gate);
		const pass = createDispositionReceiptPass({
			store,
			projects: PROJECTS,
			now: () => NOW,
			postFn,
		});
		const first = pass();
		await pass(); // overlaps while first awaits Discord → returns immediately
		expect(postFn).toHaveBeenCalledTimes(1);
		release();
		await first;
	});

	it("never-resolving fetch: bounded by the REAL AbortController timeout; next pass re-enters", async () => {
		store.upsertChatThread("thread-1", "ch-eng", "FLY-1282", "tadashi");
		seedPendingReceipt();
		const hangingFetch = ((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new Error("aborted")),
				);
			})) as unknown as typeof fetch;
		const pass = createDispositionReceiptPass({
			store,
			projects: PROJECTS,
			now: () => NOW,
			fetchImpl: hangingFetch,
			postFn: (tok, thread, content, opts) =>
				postThreadMessage(tok, thread, content, {
					...opts,
					fetchImpl: hangingFetch,
					timeoutMs: 30,
				}),
		});
		const started = Date.now();
		await pass();
		expect(Date.now() - started).toBeLessThan(5_000); // bounded return
		const row = store.getPendingDispositionReceipts(10)[0];
		expect(row?.attempts).toBe(1); // failed attempt stamped
		await pass(); // latch released — the pass re-enters
		expect(row).toBeDefined();
	});
});

describe("M10 migration", () => {
	it("reopening an existing DB is idempotent (CREATE TABLE IF NOT EXISTS)", async () => {
		store.close();
		const again = await StateStore.create(join(dir, "state.db"));
		expect(again.getPendingDispositionReceipts(1)).toEqual([]);
		again.close();
		store = await StateStore.create(join(dir, "state.db"));
	});
});
