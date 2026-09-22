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
