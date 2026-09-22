import { writeFileSync } from "node:fs";
import {
	buildAccountQuotaView,
	renderAccountsPageHtml,
} from "../../../../packages/teamlead/dist/bridge/account-quota-view.js";

const generatedAt = "2026-09-19T04:30:00.000Z";
const base = {
	fiveHPct: 10,
	sevenDPct: 24,
	fableSevenDPct: 12,
	observedAt: "2026-09-19T04:25:00.000Z",
	ageMinutes: 5,
	stale: false,
	fiveHResetAt: "2026-09-19T06:00:00.000Z",
	weeklyResetAt: "2026-09-22T16:00:00.000Z",
	fableWeeklyResetAt: "2026-09-22T16:00:00.000Z",
	exhaustedUntil: null,
	authUnusable: false,
};


const codexAccount = (over) => ({
	active: false,
	registeredProfile: null,
	planType: "pro",
	fiveHPct: 0,
	weeklyPct: 0,
	fiveHResetAt: null,
	weeklyResetAt: null,
	credits: { known: true, hasCredits: false, unlimited: false, balance: "0" },
	resetCredits: { known: true, value: null },
	observedAt: "2026-09-19T04:25:00.000Z",
	ageMinutes: 5,
	stale: false,
	exhausted: false,
	recoveryAt: null,
	authUnusable: false,
	note: null,
	unclassifiedWindows: 0,
	...over,
});

const view = buildAccountQuotaView({
	generatedAt,
	quota: {
		claude: {
			source: "claude-accounts.json",
			activeAccount: "shopping",
			staleAfterMinutes: 30,
			accounts: [
				{
					...base,
					name: "shopping",
					active: true,
					subscriptionTier: {
						subscriptionType: "max",
						rateLimitTier: "default_claude_max_20x",
					},
				},
				{
					...base,
					name: "business",
					active: false,
					subscriptionTier: {
						subscriptionType: "pro",
						rateLimitTier: "default_claude_pro",
					},
				},
				{
					...base,
					name: "personal",
					active: false,
					observedAt: "2026-09-19T02:00:00.000Z",
					ageMinutes: 150,
					stale: true,
				},
			],
		},
		// FLY-2688 2026-09-21 rework: six real Codex slots, earliest-recovery
		// ordering, capped accounts in red, credits column.
		codex: {
			source: "codex-accounts.json",
			activeAccount: "personal",
			staleAfterMinutes: 30,
			unavailable: [],
			accounts: [
				codexAccount({
					name: "school",
					planType: "plus",
					fiveHPct: 4,
					weeklyPct: 18,
					fiveHResetAt: "2026-09-19T08:00:00.000Z",
					weeklyResetAt: "2026-09-24T08:00:00.000Z",
				}),
				codexAccount({
					name: "personal",
					active: true,
					planType: "pro",
					fiveHPct: 100,
					weeklyPct: 100,
					fiveHResetAt: "2026-09-19T09:00:00.000Z",
					weeklyResetAt: "2026-09-26T09:00:00.000Z",
					exhausted: true,
					recoveryAt: "2026-09-26T09:00:00.000Z",
					credits: {
						known: true,
						hasCredits: true,
						unlimited: false,
						balance: "12.5",
					},
					resetCredits: { known: true, value: "1" },
				}),
				codexAccount({
					name: "business",
					planType: "pro",
					fiveHPct: 0,
					weeklyPct: 2,
					fiveHResetAt: "2026-09-19T05:30:00.000Z",
					weeklyResetAt: "2026-09-23T05:30:00.000Z",
				}),
				codexAccount({
					name: "shopping",
					planType: "plus",
					fiveHPct: 61,
					weeklyPct: 74,
					fiveHResetAt: "2026-09-19T07:00:00.000Z",
					weeklyResetAt: "2026-09-25T07:00:00.000Z",
					observedAt: "2026-09-19T01:00:00.000Z",
					ageMinutes: 210,
					stale: true,
					note: "in_use_unshared",
				}),
				codexAccount({
					name: "personal1",
					planType: "free",
					fiveHPct: 0,
					weeklyPct: 0,
					fiveHResetAt: "2026-09-19T12:00:00.000Z",
					weeklyResetAt: "2026-09-27T12:00:00.000Z",
					credits: {
						known: false,
						hasCredits: null,
						unlimited: null,
						balance: null,
					},
					resetCredits: { known: false, value: null },
				}),
				codexAccount({
					name: "personal2",
					planType: null,
					fiveHPct: null,
					weeklyPct: null,
					fiveHResetAt: null,
					weeklyResetAt: null,
					observedAt: null,
					ageMinutes: null,
					stale: null,
					note: "read_failed",
					credits: {
						known: false,
						hasCredits: null,
						unlimited: null,
						balance: null,
					},
					resetCredits: { known: false, value: null },
				}),
			],
		},
	},
});

writeFileSync(
	"/tmp/fly2688-accounts-page.html",
	renderAccountsPageHtml(view),
);
