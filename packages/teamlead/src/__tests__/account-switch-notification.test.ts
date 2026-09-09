import { describe, expect, it, vi } from "vitest";
import {
	emptyStore,
	enqueueSwitchNotification,
	peekSwitchNotification,
	type SwitchNotificationIntent,
} from "../account-heal/account-store.js";
import {
	drainSwitchNotification,
	formatSwitchNotification,
	type SwitchNotificationTrigger,
} from "../account-heal/account-switch-notification.js";

const INTENT: SwitchNotificationIntent = {
	eventId: "account-switch-g2",
	generation: 2,
	createdAt: Date.parse("2026-09-01T20:00:00.000Z"),
	alert: {
		kind: "account_switched",
		severity: "info",
		title: "Claude account switched",
		body: "personal1 → school",
		signature: "account-switch-g2",
	},
};

const DEAD_INTENT: SwitchNotificationIntent = {
	eventId: "account-dead-g2",
	generation: 2,
	createdAt: INTENT.createdAt,
	alert: {
		kind: "account_dead",
		severity: "severe",
		title: "Claude account unavailable",
		body: "account_dead:personal1\npersonal1 → school",
		signature: "account-dead-g2",
	},
};

describe("formatSwitchNotification", () => {
	it.each<SwitchNotificationTrigger>([
		{ kind: "manual", mode: "use" },
		{ kind: "quota", scope: "5h" },
		{ kind: "model", models: ["Fable 5"] },
		{ kind: "account_dead", profile: "personal1" },
	])("uses one switch message shape for $kind triggers", (trigger) => {
		const body = formatSwitchNotification({
			from: { name: "personal1", email: "from@example.com" },
			to: { name: "school", email: "to@example.com" },
			trigger,
			timezone: "America/Los_Angeles",
			panorama: [],
		});

		expect(body).toContain("Claude 已切号：**personal1 → school**");
		expect(body).toMatch(
			/（(?:manual:use|quota:5h|model:Fable 5|account_dead:personal1)）/,
		);
	});

	it("summarizes skipped candidates without serializing credentials", () => {
		const body = formatSwitchNotification({
			from: { name: "personal1", email: null },
			to: { name: "school", email: null },
			trigger: { kind: "manual", mode: "next" },
			timezone: "America/Los_Angeles",
			panorama: [
				{
					name: "business",
					status: "freshness_stale",
					excludedBy: "unverifiable",
				},
				{
					name: "shopping",
					status: "quota_exhausted",
					excludedBy: "quota",
				},
			],
		});

		expect(body).toContain(
			"skipped=business:freshness_stale,shopping:quota_exhausted",
		);
		expect(body).not.toContain("secret-access-token");
	});

	it("calls out the exact cooldown fallback target on a successful switch", () => {
		const body = formatSwitchNotification({
			from: { name: "personal", email: "personal@example.com" },
			to: { name: "school", email: "school@example.com" },
			trigger: { kind: "quota", scope: "both" },
			timezone: "America/Los_Angeles",
			panorama: [],
			cooldownFallbackName: "school",
		});

		expect(body).toContain("cooldown fallback to school");
	});

	it("bounds a large skipped panorama so the durable intent always validates", () => {
		const body = formatSwitchNotification({
			from: { name: "personal1", email: null },
			to: { name: "school", email: null },
			trigger: { kind: "manual", mode: "next" },
			timezone: "America/Los_Angeles",
			panorama: Array.from({ length: 200 }, (_, index) => ({
				name: `candidate-${index}`,
				status: `freshness_stale_${"x".repeat(80)}`,
				excludedBy: "unverifiable" as const,
			})),
		});

		expect(body.length).toBeLessThanOrEqual(4_000);
		expect(body).toContain("Claude 已切号：**personal1 → school**");
		expect(body).toContain("truncated");
	});
});

describe("drainSwitchNotification", () => {
	it.each(["sent", "duplicate", "queued_transient", "dead_lettered"] as const)(
		"acknowledges a %s delivery outside the account lock",
		async (primary) => {
			let current = enqueueSwitchNotification(emptyStore(), INTENT);
			let inLock = false;
			const events: string[] = [];
			const send = vi.fn(async () => {
				expect(inLock).toBe(false);
				events.push("send");
				current = { ...current, generation: 9 };
				return { primary };
			});

			const result = await drainSwitchNotification({
				withAccountsLock: async (fn) => {
					inLock = true;
					events.push("lock:start");
					try {
						return await fn();
					} finally {
						inLock = false;
						events.push("lock:end");
					}
				},
				readStore: async () => current,
				writeStore: async (store) => {
					current = store;
				},
				send,
			});

			expect(result).toMatchObject({ outcome: "acknowledged", primary });
			expect(peekSwitchNotification(current)).toBeNull();
			expect(current.generation).toBe(9);
			expect(events).toEqual([
				"lock:start",
				"lock:end",
				"send",
				"lock:start",
				"lock:end",
			]);
		},
	);

	it.each(["config_error", "process_error", "invalid_result"] as const)(
		"retains the intent after %s",
		async (primary) => {
			let current = enqueueSwitchNotification(emptyStore(), INTENT);
			const result = await drainSwitchNotification({
				withAccountsLock: async (fn) => fn(),
				readStore: async () => current,
				writeStore: async (store) => {
					current = store;
				},
				send: async () => ({ primary }),
			});

			expect(result).toMatchObject({ outcome: "pending", primary });
			expect(peekSwitchNotification(current)).toEqual(INTENT);
		},
	);

	it("does not deliver the second intent while the first remains pending", async () => {
		let current = enqueueSwitchNotification(
			enqueueSwitchNotification(emptyStore(), INTENT),
			DEAD_INTENT,
		);
		const send = vi.fn(async () => ({ primary: "process_error" as const }));

		await expect(
			drainSwitchNotification({
				withAccountsLock: async (fn) => fn(),
				readStore: async () => current,
				writeStore: async (store) => {
					current = store;
				},
				send,
			}),
		).resolves.toMatchObject({ outcome: "pending" });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(INTENT.alert);
		expect(current.pendingSwitchNotifications).toEqual([INTENT, DEAD_INTENT]);
	});
});
