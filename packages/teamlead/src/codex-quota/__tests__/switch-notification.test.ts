import { expect, it } from "vitest";
import {
	formatCodexSwitchNotification,
	parseCodexSwitchNotificationSnapshot,
} from "../switch-notification.js";

it("marks unavailable and ambiguous Codex window cells without inventing numbers", () => {
	const body = formatCodexSwitchNotification(
		{
			version: 1,
			from: {
				profile: "business",
				accountKey: "business-key",
				email: null,
				windows: [],
			},
			to: {
				profile: "personal",
				accountKey: "personal-key",
				email: "personal@example.test",
				windows: [{ usedPercent: 38, resetsAt: null }],
			},
		},
		"America/Los_Angeles",
	);
	expect(body).toContain(
		"原账号 **business**\n邮箱暂时未读到\n```text\nwindow  used   left   reset (PT)\nweekly  n/a    n/a    n/a",
	);
	expect(body).toContain("weekly  38%    62%    n/a");
	expect(body).not.toContain("100%");

	const ambiguousBody = formatCodexSwitchNotification(
		{
			version: 1,
			from: {
				profile: "business",
				accountKey: "business-key",
				email: null,
				windows: [],
			},
			to: {
				profile: "personal",
				accountKey: "personal-key",
				email: "personal@example.test",
				windows: [
					{ usedPercent: 4, resetsAt: 1_800_000_000_000 },
					{ usedPercent: 38, resetsAt: 1_800_086_400_000 },
				],
			},
		},
		"America/Los_Angeles",
	);
	expect(ambiguousBody).toContain(
		"新账号 **personal**\npersonal@example.test\n```text\nwindow  used   left   reset (PT)\nweekly  n/a    n/a    n/a",
	);
	expect(ambiguousBody).not.toContain("4%");
	expect(ambiguousBody).not.toContain("38%");
});

it("rejects malformed durable snapshots before they reach Discord copy", () => {
	expect(
		parseCodexSwitchNotificationSnapshot({
			version: 1,
			from: {
				profile: "business",
				accountKey: "business-key",
				email: "bad\n@example.test",
				windows: [],
			},
			to: {
				profile: "personal",
				accountKey: "personal-key",
				email: "personal@example.test",
				windows: [{ usedPercent: 101, resetsAt: null }],
			},
		}),
	).toBeNull();
	expect(
		parseCodexSwitchNotificationSnapshot({
			version: 1,
			from: {
				profile: "business",
				accountKey: "business-key",
				email: null,
				windows: [],
			},
			to: {
				profile: "personal",
				accountKey: "personal-key",
				email: null,
				windows: [{ usedPercent: 38, resetsAt: Number.MAX_SAFE_INTEGER }],
			},
		}),
	).toBeNull();
});

it("accepts an unregistered source identity and a dynamically named target slot", () => {
	const parsed = parseCodexSwitchNotificationSnapshot({
		version: 1,
		from: {
			profile: "account-xrliannie-1",
			accountKey: "source-key",
			email: null,
			windows: [],
		},
		to: {
			profile: "shopping",
			accountKey: "target-key",
			email: "shopping@example.test",
			windows: [],
		},
	});
	expect(parsed).not.toBeNull();
	expect(
		formatCodexSwitchNotification(parsed!, "America/Los_Angeles"),
	).toContain("account-xrliannie-1 → shopping");
	expect(
		parseCodexSwitchNotificationSnapshot({
			...parsed,
			to: { ...parsed!.to, profile: "account-reserved" },
		}),
	).toBeNull();
});

it("FLY-2869: a manual switch keeps the N1 shape and only changes the trigger label", () => {
	const snapshot = {
		version: 1 as const,
		from: {
			profile: "business",
			accountKey: "business-key",
			email: "business@example.test",
			windows: [
				{ usedPercent: 100, resetsAt: Date.parse("2026-09-30T20:59:55.000Z") },
			],
		},
		to: {
			profile: "school",
			accountKey: "school-key",
			email: "school@example.test",
			windows: [],
		},
	};
	const auto = formatCodexSwitchNotification(snapshot, "America/Los_Angeles");
	const manual = formatCodexSwitchNotification(
		snapshot,
		"America/Los_Angeles",
		"manual",
	);
	expect(auto.split("\n")[0]).toBe(
		"Codex 已切号：**business → school**（quota:weekly）",
	);
	expect(manual.split("\n")[0]).toBe(
		"Codex 已切号：**business → school**（手动）",
	);
	expect(manual.split("\n").slice(1)).toEqual(auto.split("\n").slice(1));
	expect(manual).toContain("weekly  100%   0%     09-30 Wed 13:59");
});

it("FLY-2869: a manual target may be any identity label, an automatic one must be a slot", () => {
	const value = {
		version: 1,
		from: { profile: "business", accountKey: "k1", email: null, windows: [] },
		to: {
			profile: "account-unregistered",
			accountKey: "k2",
			email: null,
			windows: [],
		},
	};
	expect(parseCodexSwitchNotificationSnapshot(value)).toBeNull();
	expect(
		parseCodexSwitchNotificationSnapshot(value, { manual: true })?.to.profile,
	).toBe("account-unregistered");
});
