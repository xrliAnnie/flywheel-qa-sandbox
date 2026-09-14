import { expect, it } from "vitest";
import { canonicalDigest } from "../contract.js";
import { bindingFixture, CHANNEL, NOW } from "./binding-fixture.js";

it("uses CAS receipts, restores uncertain posts by scan, and does not repeat an acknowledged opinion", async () => {
	const { store, db } = await bindingFixture();
	try {
		const now = Date.parse(NOW),
			binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		store.getShipJudgmentOpinions().offer(
			{
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: canonicalDigest(binding),
				inputId: null,
				reason: "missing_qa",
				mechanical: {
					verdict: "undetermined",
					reason: "missing",
					digest: "a".repeat(64),
					checkedAt: NOW,
					scope: "main+files",
					checkedRepos: 0,
					openPrCount: null,
					overlaps: [],
				},
			},
			now,
		);
		const delivery = store.getShipJudgmentDelivery();
		const claim = delivery.claim("q", CHANNEL, "worker", now);
		expect(claim.status).toBe("claimed");
		if (claim.status !== "claimed") throw new Error(claim.status);
		expect(claim.action).toBe("post");
		expect(delivery.claim("q", CHANNEL, "other", now).status).toBe("busy");
		expect(delivery.failed(claim, "connection_lost", now + 1, true)).toBe(true);
		const errors = () =>
			db
				.prepare(
					"SELECT payload FROM workflow_run_event WHERE kind='ship_judgment_delivery_error' ORDER BY seq",
				)
				.all() as { payload: string }[];
		expect(errors()).toHaveLength(1);
		expect(JSON.parse(errors()[0]!.payload)).toMatchObject({
			question_id: "q",
			opinion_id: claim.opinionId,
			action: "post",
			code: "connection_lost",
			certainty: "unknown",
			observed_at: new Date(now + 1).toISOString(),
		});
		expect(delivery.failed(claim, "connection_lost", now + 2, true)).toBe(
			false,
		);
		expect(errors()).toHaveLength(1);

		db.prepare(
			"UPDATE state_store_migration SET applied_at=? WHERE migration_id='fly-2399-delivery-error-audit-v1'",
		).run(NOW);
		const uncertainStats = () =>
			store.getShipJudgmentStatistics().read({
				from: NOW,
				to: new Date(now + 2).toISOString(),
				asOf: new Date(now + 2).toISOString(),
			});
		expect(uncertainStats()).toMatchObject({
			deliveryFailureCount: 0,
			deliveryEvidence: {
				failedAttempts: 0,
				uncertainAttempts: 1,
				complete: true,
			},
		});
		const scan = delivery.claim("q", CHANNEL, "worker", now + 60_001);
		expect(scan.status).toBe("claimed");
		if (scan.status !== "claimed") throw new Error(scan.status);
		expect(scan.action).toBe("scan");
		expect(
			delivery.confirm(claim, "123456789012345680", NOW, now + 60_002),
		).toBe(false);
		expect(
			delivery.confirm(scan, "123456789012345680", NOW, now + 60_002),
		).toBe(true);
		const event = db
			.prepare(
				"SELECT run_id,payload FROM workflow_run_event WHERE kind='ship_judgment_visible'",
			)
			.get() as { run_id: string; payload: string };
		expect(event.run_id).toBe("r");
		expect(JSON.parse(event.payload)).toMatchObject({
			opinion_id: scan.opinionId,
			message_id: "123456789012345680",
			receipt_time: NOW,
		});
		expect(
			delivery.confirm(scan, "123456789012345680", NOW, now + 60_003),
		).toBe(false);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM workflow_run_event WHERE kind='ship_judgment_visible'",
				)
				.get(),
		).toEqual({ n: 1 });
		expect(delivery.claim("q", CHANNEL, "worker", now + 60_003).status).toBe(
			"settled",
		);
		expect(
			db
				.prepare(
					"SELECT state,message_id,posted_id=desired_id AS current FROM ship_judgment_delivery WHERE subject_id='q'",
				)
				.get(),
		).toEqual({
			state: "delivered",
			message_id: "123456789012345680",
			current: 1,
		});
	} finally {
		store.close();
	}
});

it("requires two equal empty scan frontiers and retains the post cap across store instances", async () => {
	const { store, db } = await bindingFixture();
	try {
		const initial = Date.parse(NOW),
			binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		const offer = (now: number) =>
			store.getShipJudgmentOpinions().offer(
				{
					questionId: "q",
					channelId: CHANNEL,
					bindingDigest: canonicalDigest(binding),
					inputId: null,
					reason: String(now),
					mechanical: {
						verdict: "undetermined",
						reason: "missing",
						digest: "a".repeat(64),
						checkedAt: new Date(now).toISOString(),
						scope: "main+files",
						checkedRepos: 0,
						openPrCount: null,
						overlaps: [],
					},
				},
				now,
			);
		for (let round = 0; round < 2; round++) {
			const now = initial + round * 600_000;
			expect(offer(now).status).toBe("created");
			const delivery = store.getShipJudgmentDelivery();
			const post = delivery.claim("q", CHANNEL, "worker", now);
			if (post.status !== "claimed") throw new Error(post.status);
			expect(post.action).toBe("post");
			delivery.failed(post, "lost", now + 1, true);
			let scanTime = now + 120_000;
			for (const frontier of ["frontier-a", "frontier-b", "frontier-b"]) {
				const scan = store
					.getShipJudgmentDelivery()
					.claim("q", CHANNEL, "worker", scanTime);
				if (scan.status !== "claimed") throw new Error(scan.status);
				expect(scan.action).toBe("scan");
				delivery.emptyScan(scan, frontier, scanTime + 1);
				scanTime += 30_001;
			}
			expect(
				db
					.prepare(
						"SELECT state FROM ship_judgment_delivery WHERE subject_id='q'",
					)
					.get(),
			).toEqual({ state: "pending" });
		}
		const now = initial + 1_200_000;
		expect(offer(now).status).toBe("created");
		expect(
			store.getShipJudgmentDelivery().claim("q", CHANNEL, "worker", now).status,
		).toBe("rate_limited");
	} finally {
		store.close();
	}
});

it("requires fresh validation while retaining unchanged opinion identity and original display time", async () => {
	const { store, db } = await bindingFixture();
	try {
		const now = Date.parse(NOW),
			binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		const candidate = {
			questionId: "q",
			channelId: CHANNEL,
			bindingDigest: canonicalDigest(binding),
			inputId: null,
			reason: "missing_qa",
			mechanical: {
				verdict: "undetermined" as const,
				reason: "missing",
				digest: "a".repeat(64),
				checkedAt: NOW,
				scope: "main+files",
				checkedRepos: 0,
				openPrCount: null,
				overlaps: [],
			},
		};
		const first = store.getShipJudgmentOpinions().offer(candidate, now);
		if (first.status !== "created") throw new Error(first.status);
		const stateClock = () =>
			(
				db
					.prepare(
						"SELECT presentation_state_changed_at AS at FROM ship_judgment_delivery",
					)
					.get() as { at: string }
			).at;
		expect(stateClock()).toBe(NOW);
		expect(
			store
				.getShipJudgmentDelivery()
				.claim("q", CHANNEL, "worker", now + 60_001).status,
		).toBe("stale");
		expect(
			store.getShipJudgmentOpinions().offer(
				{
					...candidate,
					mechanical: {
						...candidate.mechanical,
						checkedAt: new Date(now + 60_001).toISOString(),
					},
				},
				now + 60_001,
			).status,
		).toBe("unchanged");
		expect(stateClock()).toBe(NOW);
		expect(
			store.getShipJudgmentOpinions().offer(
				{
					...candidate,
					reason: "changed_scope",
					mechanical: {
						...candidate.mechanical,
						checkedAt: new Date(now + 60_001).toISOString(),
					},
				},
				now + 60_001,
			).status,
		).toBe("deferred");
		expect(stateClock()).toBe(new Date(now + 60_001).toISOString());
		expect(
			store
				.getShipJudgmentDelivery()
				.claim("q", CHANNEL, "worker", now + 60_002).status,
		).toBe("stale");
		store.getShipJudgmentOpinions().offer(
			{
				...candidate,
				mechanical: {
					...candidate.mechanical,
					checkedAt: new Date(now + 60_001).toISOString(),
				},
			},
			now + 60_001,
		);
		const claim = store
			.getShipJudgmentDelivery()
			.claim("q", CHANNEL, "worker", now + 60_002);
		expect(claim.status).toBe("claimed");
		if (claim.status !== "claimed") throw new Error(claim.status);
		expect(claim.opinionId).toBe(first.opinionId);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n,MIN(created_at) AS at FROM ship_judgment_opinion",
				)
				.get(),
		).toEqual({ n: 1, at: NOW });
	} finally {
		store.close();
	}
});

it("invalidates old receipts durably on mode changes and reserves history PATCH slots", async () => {
	const { store, db } = await bindingFixture();
	try {
		const now = Date.parse(NOW),
			binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		const candidate = {
			questionId: "q",
			channelId: CHANNEL,
			bindingDigest: canonicalDigest(binding),
			inputId: null,
			reason: "missing",
			mechanical: {
				verdict: "undetermined" as const,
				reason: "missing",
				digest: "a".repeat(64),
				checkedAt: NOW,
				scope: "main",
				checkedRepos: 0,
				openPrCount: null,
				overlaps: [],
			},
		};
		store.getShipJudgmentOpinions().offer(candidate, now);
		const delivery = store.getShipJudgmentDelivery();
		const posted = delivery.claim("q", CHANNEL, "sender", now);
		if (posted.status !== "claimed") throw new Error(posted.status);
		expect(delivery.confirm(posted, "123456789012345681", NOW, now)).toBe(true);
		delivery.setMode("auto", now + 1);
		expect(delivery.claim("q", CHANNEL, "sender", now + 2).status).toBe(
			"inactive",
		);
		expect(delivery.historyWork()).toEqual(["q"]);
		const history = delivery.claimHistory("q", "history", now + 2);
		if (history.status !== "claimed") throw new Error(history.status);
		expect(history.messageId).toBe("123456789012345681");
		expect(delivery.historyWork(now + 2)).toEqual([]);
		delivery.setMode("dry_run", now + 3);
		expect(delivery.confirmHistory(history, now + 4)).toBe(false);
		delivery.setMode("off", now + 5);
		const retried = delivery.claimHistory("q", "history", now + 6);
		if (retried.status !== "claimed") throw new Error(retried.status);
		expect(delivery.confirmHistory(retried, now + 7)).toBe(true);
		expect(delivery.historyWork()).toEqual([]);
		delivery.setMode("dry_run", now + 8);
		expect(delivery.claim("q", CHANNEL, "sender", now + 9).status).toBe(
			"stale",
		);
		store.getShipJudgmentOpinions().offer(
			{
				...candidate,
				mechanical: {
					...candidate.mechanical,
					checkedAt: new Date(now + 10).toISOString(),
				},
			},
			now + 10,
		);
		const restored = delivery.claim("q", CHANNEL, "sender", now + 11);
		if (restored.status !== "claimed") throw new Error(restored.status);
		expect(restored.action).toBe("patch");
		expect(
			db
				.prepare(
					"SELECT json_array_length(patch_reserved_times) AS n FROM ship_judgment_delivery",
				)
				.get(),
		).toEqual({ n: 3 });
	} finally {
		store.close();
	}
});

it("recovers an uncertain post while paused without reserving another POST or a PATCH", async () => {
	const { store, db } = await bindingFixture();
	try {
		const now = Date.parse(NOW),
			binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		store.getShipJudgmentOpinions().offer(
			{
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: canonicalDigest(binding),
				inputId: null,
				reason: "missing",
				mechanical: {
					verdict: "undetermined",
					reason: "missing",
					digest: "a".repeat(64),
					checkedAt: NOW,
					scope: "main",
					checkedRepos: 0,
					openPrCount: null,
					overlaps: [],
				},
			},
			now,
		);
		const delivery = store.getShipJudgmentDelivery(),
			post = delivery.claim("q", CHANNEL, "sender", now);
		if (post.status !== "claimed") throw new Error(post.status);
		delivery.setMode("off", now + 1);
		expect(delivery.confirm(post, "123456789012345681", NOW, now + 2)).toBe(
			false,
		);
		const scan = delivery.claimHistory("q", "history", now + 3);
		expect(scan.status).toBe("claimed");
		if (scan.status !== "claimed") throw new Error(scan.status);
		expect(scan.action).toBe("scan");
		expect(delivery.confirm(scan, "123456789012345681", NOW, now + 4)).toBe(
			true,
		);
		expect(
			db
				.prepare(
					"SELECT json_array_length(post_reserved_times) AS posts,json_array_length(patch_reserved_times) AS patches FROM ship_judgment_delivery",
				)
				.get(),
		).toEqual({ posts: 1, patches: 0 });
		expect(delivery.historyWork()).toEqual(["q"]);
	} finally {
		store.close();
	}
});

it("commits definite failure audit atomically and recomputes historical failure counts", async () => {
	const { store, db } = await bindingFixture();
	try {
		const now = Date.parse(NOW),
			binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		store.getShipJudgmentOpinions().offer(
			{
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: canonicalDigest(binding),
				inputId: null,
				reason: "missing_qa",
				mechanical: {
					verdict: "undetermined",
					reason: "missing",
					digest: "a".repeat(64),
					checkedAt: NOW,
					scope: "main+files",
					checkedRepos: 0,
					openPrCount: null,
					overlaps: [],
				},
			},
			now,
		);

		const delivery = store.getShipJudgmentDelivery();
		const claim = delivery.claim("q", CHANNEL, "worker", now);
		if (claim.status !== "claimed") throw new Error(claim.status);
		const iso = (offset: number) => new Date(now + offset).toISOString();
		db.exec(
			`CREATE TRIGGER reject_delivery_error BEFORE INSERT ON workflow_run_event WHEN NEW.kind='ship_judgment_delivery_error' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`,
		);
		expect(() => delivery.failed(claim, "forbidden", now + 1, false)).toThrow(
			"audit unavailable",
		);
		expect(delivery.claim("q", CHANNEL, "other", now + 2).status).toBe("busy");
		db.exec("DROP TRIGGER reject_delivery_error");
		expect(delivery.failed(claim, "forbidden", now + 3, false)).toBe(true);
		const stats = store.getShipJudgmentStatistics();
		db.prepare(
			"UPDATE state_store_migration SET applied_at=? WHERE migration_id='fly-2399-delivery-error-audit-v1'",
		).run(NOW);
		expect(
			stats.read({ from: NOW, to: iso(3), asOf: iso(3) }).deliveryFailureCount,
		).toBe(0);
		expect(stats.read({ from: NOW, to: iso(4), asOf: iso(4) })).toMatchObject({
			deliveryFailureCount: 1,
			deliveryEvidence: {
				failedAttempts: 1,
				uncertainAttempts: 0,
				complete: true,
				coveredFrom: NOW,
			},
		});
		db.prepare(
			"UPDATE ship_judgment_delivery SET last_error=NULL WHERE subject_id='q'",
		).run();
		expect(
			stats.read({ from: NOW, to: iso(4), asOf: iso(4) }).deliveryFailureCount,
		).toBe(1);
		expect(
			stats.read({ from: iso(-1), to: iso(4), asOf: iso(4) }),
		).toMatchObject({
			deliveryFailureCount: null,
			deliveryEvidence: { observedFailedCards: 1, complete: false },
		});
	} finally {
		store.close();
	}
});
