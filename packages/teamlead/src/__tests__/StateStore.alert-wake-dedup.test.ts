import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const T0 = "2026-09-25T08:00:00.000Z";
const at = (hours: number) =>
	new Date(Date.parse(T0) + hours * 3_600_000).toISOString();
const identity = {
	leadId: "claw",
	fingerprint: "fingerprint-a",
	projectName: "flywheel",
	eventType: "review_job_failed",
	categoryKey: "review_job_failed:review failed",
	categoryTitle: "review failed",
};
const delivered = (overrides: Record<string, unknown> = {}) => ({
	...identity,
	deliveryId: "delivery-a",
	severityRank: 1,
	ticketGeneration: "generation-1",
	nowIso: T0,
	sourceKind: "discord_chat" as const,
	...overrides,
});

describe("FLY-2910 durable alert wake evidence", () => {
	let store: StateStore;
	let root: string;
	let path: string;
	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "fly2910-storage-"));
		path = join(root, "teamlead.db");
		store = await StateStore.create(path);
	});
	afterEach(() => {
		store.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("migrates a pre-feature database and preserves evidence after restart", async () => {
		store.close();
		const legacy = new BetterSqlite3(path);
		legacy.exec(
			"DROP TABLE IF EXISTS alert_wake_dedup_state; DROP TABLE IF EXISTS alert_wake_letter",
		);
		legacy.close();
		store = await StateStore.create(path);
		expect(
			store.getAlertWakeDedupRecord("claw", identity.fingerprint),
		).toBeUndefined();
		expect(store.recordAlertWakeDelivered(delivered())).toBe(true);
		store.close();
		store = await StateStore.create(path);
		expect(
			store.getAlertWakeDedupRecord("claw", identity.fingerprint),
		).toMatchObject({
			...identity,
			infoOnly: false,
			windowStartedAt: T0,
			deliveredDeliveryId: "delivery-a",
			maxSeverity: 1,
			ticketGeneration: "generation-1",
			occurrences: 1,
			suppressed: 0,
			digestPending: 0,
			lastSeenAt: T0,
		});
		expect(store.recordAlertWakeDelivered(delivered())).toBe(false);
	});

	it("keeps the first A-lane mapping and requires it for delivered evidence", () => {
		const input = delivered({ sourceKind: "infra_alert" });
		expect(store.recordAlertWakeDelivered(input)).toBe(false);
		expect(
			store.recordAlertWakeLetter({
				deliveryId: "delivery-a",
				correlationKey: "correlation-a",
				canonicalEventId: "generation-1",
				recordedAt: T0,
			}),
		).toBe(true);
		expect(
			store.recordAlertWakeLetter({
				deliveryId: "delivery-a",
				correlationKey: "other",
				canonicalEventId: "generation-2",
				recordedAt: at(1),
			}),
		).toBe(false);
		expect(store.getAlertWakeLetter("delivery-a")).toEqual({
			deliveryId: "delivery-a",
			correlationKey: "correlation-a",
			canonicalEventId: "generation-1",
			recordedAt: T0,
			evidenceRecordedAt: null,
		});
		expect(store.recordAlertWakeDelivered(input)).toBe(true);
		expect(store.recordAlertWakeDelivered(input)).toBe(false);
		expect(store.getAlertWakeLetter("delivery-a")?.evidenceRecordedAt).toBe(T0);
	});

	it.each(["infra_alert", "discord_chat"] as const)(
		"records A→B→A→B only twice for %s even across restart",
		async (sourceKind) => {
			for (const deliveryId of ["a", "b"]) {
				if (sourceKind === "infra_alert")
					store.recordAlertWakeLetter({
						deliveryId,
						correlationKey: "correlation-a",
						canonicalEventId: "generation-1",
						recordedAt: T0,
					});
				expect(
					store.recordAlertWakeDelivered(delivered({ deliveryId, sourceKind })),
				).toBe(true);
			}
			store.close();
			store = await StateStore.create(path);
			for (const deliveryId of ["a", "b"])
				expect(
					store.recordAlertWakeDelivered(
						delivered({ deliveryId, sourceKind, nowIso: at(1) }),
					),
				).toBe(false);
			expect(
				store.getAlertWakeDedupRecord("claw", identity.fingerprint),
			).toMatchObject({
				occurrences: 2,
				deliveredDeliveryId: "b",
				lastSeenAt: T0,
			});
		},
	);

	it.each(["infra_alert", "discord_chat"] as const)(
		"rolls back %s delivery marker when evidence writing fails",
		(sourceKind) => {
			if (sourceKind === "infra_alert")
				store.recordAlertWakeLetter({
					deliveryId: "delivery-a",
					correlationKey: "correlation-a",
					canonicalEventId: "generation-1",
					recordedAt: T0,
				});
			const fixture = new BetterSqlite3(path);
			fixture.exec(
				"CREATE TRIGGER reject_wake_evidence BEFORE INSERT ON alert_wake_dedup_state BEGIN SELECT RAISE(ABORT, 'fixture evidence failure'); END",
			);
			expect(() =>
				store.recordAlertWakeDelivered(delivered({ sourceKind })),
			).toThrow("fixture evidence failure");
			expect(
				store.getAlertWakeDedupRecord("claw", identity.fingerprint),
			).toBeUndefined();
			expect(
				store.getAlertWakeLetter("delivery-a")?.evidenceRecordedAt ?? null,
			).toBeNull();
			fixture.exec("DROP TRIGGER reject_wake_evidence");
			fixture.close();
			expect(store.recordAlertWakeDelivered(delivered({ sourceKind }))).toBe(
				true,
			);
		},
	);

	it("resets severity on G1 severe → G2 warning, then records G2 severe in the same fixed window", () => {
		store.recordAlertWakeDelivered(delivered({ severityRank: 2 }));
		store.recordAlertWakeDelivered(
			delivered({
				deliveryId: "g2-warning",
				ticketGeneration: "generation-2",
				nowIso: at(1),
			}),
		);
		expect(
			store.getAlertWakeDedupRecord("claw", identity.fingerprint),
		).toMatchObject({
			maxSeverity: 1,
			ticketGeneration: "generation-2",
			windowStartedAt: T0,
			occurrences: 2,
		});
		store.recordAlertWakeDelivered(
			delivered({
				deliveryId: "g2-severe",
				ticketGeneration: "generation-2",
				severityRank: 2,
				nowIso: at(5),
			}),
		);
		store.recordAlertWakeDelivered(
			delivered({
				deliveryId: "g2-warning-again",
				ticketGeneration: "generation-2",
				nowIso: at(6),
			}),
		);
		expect(
			store.getAlertWakeDedupRecord("claw", identity.fingerprint),
		).toMatchObject({ maxSeverity: 2, windowStartedAt: T0, occurrences: 4 });
		const next = new Date(Date.parse(at(6)) + 1).toISOString();
		store.recordAlertWakeDelivered(
			delivered({
				deliveryId: "expired",
				ticketGeneration: "generation-2",
				nowIso: next,
			}),
		);
		expect(
			store.getAlertWakeDedupRecord("claw", identity.fingerprint),
		).toMatchObject({
			maxSeverity: 1,
			windowStartedAt: next,
			occurrences: 1,
			suppressed: 0,
		});
	});

	it("counts suppression and categories without making evidence for another fingerprint or lead", () => {
		expect(
			store.bumpAlertWakeSuppressed({
				leadId: "claw",
				fingerprint: identity.fingerprint,
				nowIso: T0,
			}),
		).toBe(false);
		store.recordAlertWakeDelivered(delivered());
		store.recordAlertWakeDelivered(
			delivered({
				deliveryId: "other-fingerprint",
				fingerprint: "fingerprint-b",
				nowIso: at(1),
			}),
		);
		store.recordAlertWakeDelivered(
			delivered({ deliveryId: "other-lead", leadId: "engineering" }),
		);
		expect(
			store.bumpAlertWakeSuppressed({
				leadId: "claw",
				fingerprint: identity.fingerprint,
				nowIso: at(2),
			}),
		).toBe(true);
		expect(
			store.getAlertWakeDedupRecord("claw", identity.fingerprint),
		).toMatchObject({
			occurrences: 2,
			suppressed: 1,
			digestPending: 1,
			lastSeenAt: at(2),
			windowStartedAt: T0,
		});
		expect(
			store.sumAlertWakeCategory("claw", identity.categoryKey, T0),
		).toEqual({ occurrences: 3, suppressed: 1 });
		expect(
			store.sumAlertWakeCategory("claw", identity.categoryKey, at(1)),
		).toEqual({ occurrences: 1, suppressed: 0 });
		expect(store.sumAlertWakeCategory("claw", "unknown", T0)).toEqual({
			occurrences: 0,
			suppressed: 0,
		});
		expect(store.listAlertWakeDedup(at(2))).toHaveLength(1);
	});

	it("counts info separately and consumes every pending digest only once with a bounded display", () => {
		for (let index = 0; index < 12; index++) {
			store.bumpAlertWakeInfo({
				...identity,
				fingerprint: `info:${index}`,
				categoryKey: `category-${index}`,
				categoryTitle: `title-${index}`,
				nowIso: T0,
			});
		}
		store.bumpAlertWakeInfo({
			...identity,
			fingerprint: "info:0",
			categoryKey: "category-0",
			categoryTitle: "title-0",
			nowIso: at(1),
		});
		store.bumpAlertWakeInfo({
			...identity,
			leadId: "engineering",
			fingerprint: "info:other",
			nowIso: T0,
		});
		expect(store.getAlertWakeDedupRecord("claw", "info:0")).toMatchObject({
			infoOnly: true,
			deliveredDeliveryId: null,
			ticketGeneration: null,
			maxSeverity: 0,
			occurrences: 2,
			suppressed: 2,
			digestPending: 2,
			windowStartedAt: T0,
		});
		const digest = store.takeAlertWakeDigest("claw", 10);
		expect(digest).toMatchObject({ total: 13, remainingCategories: 2 });
		expect(digest.entries).toHaveLength(10);
		expect(digest.entries[0]).toMatchObject({
			fingerprint: "info:0",
			digestPending: 2,
		});
		expect(store.takeAlertWakeDigest("claw", 10)).toEqual({
			entries: [],
			total: 0,
			remainingCategories: 0,
		});
		expect(store.takeAlertWakeDigest("engineering", 10).total).toBe(1);
		expect(store.getAlertWakeDedupRecord("claw", "info:0")?.suppressed).toBe(2);
	});

	it("retains pending summary counts when the info window expires", () => {
		store.bumpAlertWakeInfo({ ...identity, fingerprint: "info:a", nowIso: T0 });
		store.bumpAlertWakeInfo({
			...identity,
			fingerprint: "info:a",
			nowIso: at(7),
		});
		expect(store.getAlertWakeDedupRecord("claw", "info:a")).toMatchObject({
			occurrences: 1,
			suppressed: 1,
			digestPending: 2,
			windowStartedAt: at(7),
		});
	});

	it("rolls back digest consumption if clearing one of the pending records fails", () => {
		store.bumpAlertWakeInfo({ ...identity, fingerprint: "info:a", nowIso: T0 });
		const fixture = new BetterSqlite3(path);
		fixture.exec(
			"CREATE TRIGGER reject_digest_clear BEFORE UPDATE OF digest_pending ON alert_wake_dedup_state WHEN NEW.digest_pending = 0 BEGIN SELECT RAISE(ABORT, 'fixture clear failure'); END",
		);
		expect(() => store.takeAlertWakeDigest("claw", 10)).toThrow(
			"fixture clear failure",
		);
		fixture.exec("DROP TRIGGER reject_digest_clear");
		fixture.close();
		expect(store.takeAlertWakeDigest("claw", 10).total).toBe(1);
	});

	it("bounds each 48-hour cleanup to 200 rows and protects pending summaries", () => {
		const old = at(-49);
		const fixture = new BetterSqlite3(path);
		const insertState = fixture.prepare(
			"INSERT INTO alert_wake_dedup_state (lead_id, fingerprint, project_name, event_type, category_key, category_title, window_started_at, last_seen_at, digest_pending) VALUES ('claw', ?, 'flywheel', 'old', 'old', 'old', ?, ?, ?)",
		);
		const insertLetter = fixture.prepare(
			"INSERT INTO alert_wake_letter (delivery_id, recorded_at) VALUES (?, ?)",
		);
		fixture.transaction(() => {
			for (let index = 0; index < 205; index++) {
				insertState.run(`old-${index}`, old, old, 0);
				insertLetter.run(`old-${index}`, old);
			}
			insertState.run("pending", old, old, 1);
			insertState.run("boundary", at(-48), at(-48), 0);
			insertLetter.run("boundary", at(-48));
		})();
		fixture.close();
		store.recordAlertWakeDelivered(delivered());
		const inspect = new BetterSqlite3(path, { readonly: true });
		expect(
			inspect
				.prepare(
					"SELECT COUNT(*) AS n FROM alert_wake_dedup_state WHERE fingerprint LIKE 'old-%'",
				)
				.get(),
		).toEqual({ n: 5 });
		expect(
			inspect
				.prepare(
					"SELECT COUNT(*) AS n FROM alert_wake_letter WHERE delivery_id LIKE 'old-%'",
				)
				.get(),
		).toEqual({ n: 5 });
		inspect.close();
		expect(
			store.getAlertWakeDedupRecord("claw", "pending")?.digestPending,
		).toBe(1);
		expect(store.getAlertWakeDedupRecord("claw", "boundary")).toBeDefined();
		expect(store.getAlertWakeLetter("boundary")).toBeDefined();
	});

	it("returns canonical generation for each mailbox ledger disposition without changing its existing projection", () => {
		const input = {
			correlationKey: "correlation-a",
			eventId: "g1",
			deliveryId: "a",
			toAgent: "claw",
			requestedOwner: "claw",
			routeClass: "duty" as const,
			leadId: "claw",
			projectName: "flywheel",
			eventType: "test",
		};
		expect(
			store.upsertAlertMailboxLedger(input, { allowReseed: false }),
		).toMatchObject({ disposition: "inserted", canonicalEventId: "g1" });
		expect(
			store.upsertAlertMailboxLedger(input, { allowReseed: false }),
		).toMatchObject({ disposition: "replayed_same", canonicalEventId: null });
		expect(
			store.upsertAlertMailboxLedger(
				{ ...input, deliveryId: "changed" },
				{ allowReseed: false },
			),
		).toMatchObject({
			disposition: "locked_canonical",
			canonicalEventId: "g1",
			deliveryProjection: { deliveryId: "a" },
		});
		expect(
			store.upsertAlertMailboxLedger(
				{ ...input, deliveryId: "changed" },
				{ allowReseed: true },
			),
		).toMatchObject({ disposition: "reseeded", canonicalEventId: "g1" });
		expect(
			store.upsertAlertMailboxLedger(
				{ ...input, eventId: "second-fire", deliveryId: "b" },
				{ allowReseed: false },
			),
		).toMatchObject({
			disposition: "merged",
			canonicalEventId: "g1",
			deliveryProjection: { eventId: "second-fire", deliveryId: "b" },
		});
		const fixture = new BetterSqlite3(path);
		fixture
			.prepare(
				"UPDATE alert_mailbox_ledger SET resolved_at = opened_at WHERE correlation_key = ?",
			)
			.run(input.correlationKey);
		fixture.close();
		expect(
			store.upsertAlertMailboxLedger(
				{ ...input, eventId: "g2", deliveryId: "c" },
				{ allowReseed: false },
			),
		).toMatchObject({ disposition: "new_episode", canonicalEventId: "g2" });
	});
});
