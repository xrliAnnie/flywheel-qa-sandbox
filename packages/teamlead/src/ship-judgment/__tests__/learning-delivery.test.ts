import { expect, it } from "vitest";
import { LearningDelivery } from "../learning-delivery.js";
import { bindingFixture, NOW } from "./binding-fixture.js";

it("requires two stable empty scans before repost, preserves unknown posts across off and reserves retries", async () => {
	const { store, db } = await bindingFixture();
	try {
		db.prepare(`INSERT INTO ship_judgment_delivery(purpose,subject_id,question_id,thread_id,card_message_id,desired_id,state,marker)
 VALUES ('clarification','root','q','123456789012345679','123456789012345678','root','pending','fixture')`).run();
		let mode = "off";
		const delivery = new LearningDelivery(db, () => mode),
			now = Date.parse(NOW);
		expect(delivery.claim("clarification", "root", "sender", now).status).toBe(
			"inactive",
		);
		mode = "dry_run";
		const first = delivery.claim("clarification", "root", "sender", now);
		if (first.status !== "claimed") throw new Error(first.status);
		expect(delivery.fail(first, now + 1, "lost", true)).toBe(true);
		mode = "off";
		expect(
			delivery.claim("clarification", "root", "sender", now + 60_002).status,
		).toBe("inactive");
		mode = "dry_run";
		const scan = delivery.claim(
			"clarification",
			"root",
			"sender",
			now + 60_002,
		);
		if (scan.status !== "claimed") throw new Error(scan.status);
		expect(scan.action).toBe("scan");
		expect(delivery.emptyScan(scan, "frontier", now + 60_003)).toBe(true);
		expect(
			delivery.claim("clarification", "root", "sender", now + 80_000).status,
		).toBe("busy");
		const changed = delivery.claim(
			"clarification",
			"root",
			"sender",
			now + 90_004,
		);
		if (changed.status !== "claimed") throw new Error(changed.status);
		delivery.emptyScan(changed, "changed-frontier", now + 90_005);
		const second = delivery.claim(
			"clarification",
			"root",
			"sender",
			now + 120_006,
		);
		if (second.status !== "claimed") throw new Error(second.status);
		delivery.emptyScan(second, "changed-frontier", now + 120_007);
		mode = "off";
		expect(
			delivery.claim("clarification", "root", "sender", now + 120_008).status,
		).toBe("inactive");
		mode = "dry_run";
		const retry = delivery.claim(
			"clarification",
			"root",
			"sender",
			now + 120_009,
		);
		if (retry.status !== "claimed") throw new Error(retry.status);
		expect(retry.action).toBe("post");
		delivery.fail(retry, now + 120_010, "known_failure", false);
		expect(
			delivery.claim("clarification", "root", "sender", now + 180_011).status,
		).toBe("rate_limited");
		expect(
			delivery.claim("clarification", "root", "sender", now + 3_600_001).status,
		).toBe("claimed");
	} finally {
		store.close();
	}
});

it("bounds queued work, respects mode/leases/backoff, and retains unavailable evidence", async () => {
	const { store, db } = await bindingFixture();
	try {
		const insert =
			db.prepare(`INSERT INTO ship_judgment_delivery(purpose,subject_id,question_id,thread_id,card_message_id,desired_id,state,marker)
 VALUES (? ,?,'q','123456789012345679','123456789012345678',?,'pending','fixture')`);
		for (let i = 0; i < 25; i++)
			insert.run("clarification", `root-${i}`, `root-${i}`);
		insert.run("ack", "ack", "ack");
		let mode = "off";
		const now = Date.parse(NOW),
			delivery = new LearningDelivery(db, () => mode);
		expect(delivery.work(now)).toEqual([]);
		expect(delivery.claim("ack", "ack", "sender", now).status).toBe("inactive");
		mode = "dry_run";
		expect(delivery.work(now)).toHaveLength(20);
		const claim = delivery.claim("ack", "ack", "sender", now);
		if (claim.status !== "claimed") throw new Error(claim.status);
		expect(delivery.work(now).some((row) => row.subjectId === "ack")).toBe(
			false,
		);
		expect(delivery.unavailable(claim, "thread_archived", now + 1)).toBe(true);
		expect(delivery.confirm(claim, "123456789012345692", NOW, now + 2)).toBe(
			false,
		);
		expect(
			db
				.prepare(
					"SELECT state,last_error FROM ship_judgment_delivery WHERE purpose='ack'",
				)
				.get(),
		).toEqual({ state: "unavailable", last_error: "thread_archived" });
		db.prepare(
			"UPDATE ship_judgment_delivery SET post_reserved_times=? WHERE subject_id='root-0'",
		).run(JSON.stringify([now - 1000, now - 500]));
		expect(
			delivery.claim("clarification", "root-0", "sender", now).status,
		).toBe("rate_limited");
		expect(delivery.work(now).some((row) => row.subjectId === "root-0")).toBe(
			false,
		);
		expect(
			delivery.work(now + 3_599_000).some((row) => row.subjectId === "root-0"),
		).toBe(true);
	} finally {
		store.close();
	}
});
