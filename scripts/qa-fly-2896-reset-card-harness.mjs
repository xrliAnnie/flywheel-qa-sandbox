#!/usr/bin/env node
/**
 * QA · FLY-2896 — local harness for the Claude reset-card ("充值卡") flow.
 *
 * Drives the BUILT production modules (packages/teamlead/dist): the real
 * quota-monitor pollOnce, the real reset-card runtime (probe + redeem over real
 * HTTP), the real hand-off files and the real Bridge consent ticker. Only these
 * are fakes:
 *   - Anthropic: a local HTTP server on 127.0.0.1 (records every request)
 *   - the profile switch: rewrites the throwaway account store (no Keychain,
 *     never calls flywheel-claude-profile)
 *   - Discord: an in-memory channel where the scenario plays the founder
 *
 * Everything lives in a fresh temp dir; nothing reads or writes ~/.flywheel,
 * no child process is spawned, no real account or card is touched.
 *
 * Usage:  pnpm --filter flywheel-teamlead build
 *         node scripts/qa-fly-2896-reset-card-harness.mjs [--evidence <dir>]
 * Exit 0 = every scenario held its assertions. JSON summary on stdout.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "packages", "teamlead", "dist");
const load = (path) => import(join(DIST, path));

const { pollOnce } = await load("account-heal/quota-monitor.js");
const { DEFAULT_QUOTA_MONITOR_CONFIG } = await load(
	"account-heal/quota-monitor-config.js",
);
const { emptyQuotaMonitorState } = await load(
	"account-heal/quota-monitor-state.js",
);
const { readStoreStrict, writeStore } = await load(
	"account-heal/account-store.js",
);
const { readPoolMonitorCredential } = await load(
	"account-heal/quota-monitor-credentials.js",
);
const { fetchAccountUsage } = await load("account-heal/quota-usage-api.js");
const { makeResetCardRuntime } = await load("account-heal/reset-card-probe.js");
const { makeResetCardFiles } = await load("account-heal/reset-card-files.js");
const { createResetCardConsentTicker, renderResetCardText } = await load(
	"bridge/reset-card-consent.js",
);

const FOUNDER = "111111111111111111";
const CHANNEL = "222222222222222222";
const ORG = "12345678-1234-4abc-8def-1234567890ab";
const GRANT_ID = "opus55-launch-promax-20260921";
const T0 = Date.parse("2026-09-25T23:05:00.000Z");
const RECOVERY = {
	business: "2026-10-01T02:00:00+00:00",
	shopping: "2026-09-30T02:00:00+00:00",
	school: "2026-09-29T02:00:00+00:00",
};

const evidenceIndex = process.argv.indexOf("--evidence");
const evidenceDir =
	evidenceIndex > 0 ? process.argv[evidenceIndex + 1] : undefined;

function usageBody(five, seven, fiveReset, sevenReset, cedar) {
	return {
		five_hour: { utilization: five, resets_at: fiveReset },
		seven_day: { utilization: seven, resets_at: sevenReset },
		...(cedar === undefined ? {} : { cedar_ember: cedar }),
	};
}

function cedarBlock(atLimit, resetsLeft) {
	return {
		eligible: true,
		ineligible_reason: null,
		at_limit: atLimit,
		exhausted: atLimit ? ["seven_day", "seven_day_overage_included"] : [],
		grants: [
			{
				id: GRANT_ID,
				label: "server free text that must never reach the card",
				resets_total: 1,
				resets_left: resetsLeft,
				starts_at: "2026-09-22T16:00:00+00:00",
				ends_at: "2026-10-22T16:00:00+00:00",
				clears: ["five_hour", "seven_day", "seven_day_overage_included"],
				paused: false,
				usable_now: true,
			},
		],
		next_grant_id: GRANT_ID,
	};
}

/** The fake Anthropic: per-account usage/card state + a request log. */
async function startFakeAnthropic(accounts) {
	const requests = [];
	const server = createServer((req, res) => {
		const token = (req.headers.authorization ?? "").replace("Bearer ", "");
		const name = token.replace("tok-", "");
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			requests.push({
				method: req.method,
				path: req.url,
				account: name,
				userAgent: req.headers["user-agent"] ?? null,
				body: body === "" ? null : JSON.parse(body),
			});
			const account = accounts[name];
			const send = (status, payload) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			if (account === undefined) return send(401, {});
			if (req.url === "/api/oauth/profile") {
				return send(200, {
					organization: { uuid: ORG, subscription_status: "active" },
				});
			}
			if (req.url?.startsWith("/api/oauth/usage")) {
				const withCard = req.url.includes("cedar_ember=1");
				return send(
					200,
					usageBody(
						account.five,
						account.seven,
						account.fiveReset,
						account.sevenReset,
						withCard ? account.cedar : undefined,
					),
				);
			}
			if (
				req.method === "POST" &&
				req.url === `/api/organizations/${ORG}/reset_rate_limits`
			) {
				account.five = 0;
				account.seven = 0;
				account.cedar = cedarBlock(false, 0);
				return send(200, {
					result: "reset",
					resets_left: 0,
					cleared: ["five_hour", "seven_day"],
				});
			}
			return send(404, {});
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

async function runScenario(name, options) {
	const root = mkdtempSync(join(tmpdir(), `fly2896-harness-${name}-`));
	const poolDir = join(root, "pool");
	const storePath = join(root, "claude-accounts.json");
	const resetCardDir = join(root, "claude-quota");
	const accounts = {
		personal: {
			five: 88,
			seven: 41,
			fiveReset: "2026-09-26T02:00:00+00:00",
			sevenReset: "2026-09-29T02:00:00+00:00",
		},
		business: {
			five: 12,
			seven: 100,
			fiveReset: "2026-09-26T03:00:00+00:00",
			sevenReset: RECOVERY.business,
			cedar: cedarBlock(true, 1),
		},
		school: {
			five: options.directTarget ? 30 : 12,
			seven: options.directTarget ? 20 : 100,
			fiveReset: "2026-09-26T03:00:00+00:00",
			sevenReset: RECOVERY.school,
			cedar: cedarBlock(!options.directTarget, 1),
		},
		shopping: {
			five: 12,
			seven: 100,
			fiveReset: "2026-09-26T03:00:00+00:00",
			sevenReset: RECOVERY.shopping,
			cedar: cedarBlock(true, 1),
		},
	};
	const anthropic = await startFakeAnthropic(accounts);
	let now = T0;
	for (const account of Object.keys(accounts)) {
		mkdirSync(join(poolDir, account), { recursive: true, mode: 0o700 });
		writeFileSync(
			join(poolDir, account, ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: {
					accessToken: `tok-${account}`,
					expiresAt: T0 + 24 * 3_600_000,
				},
			}),
			{ mode: 0o600 },
		);
	}
	writeStore(
		{
			generation: 7,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{
					name: "business",
					quotaExhaustedUntil: "2026-10-01T02:00:00.000Z",
					switchCooldownUntil: "2026-10-01T02:00:00.000Z",
					weeklyResetAt: "2026-10-01T02:00:00.000Z",
				},
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "shopping", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		},
		storePath,
	);
	const store = () => readStoreStrict(storePath);
	const rc = makeResetCardRuntime({
		dir: resetCardDir,
		poolDir,
		storePath,
		baseUrl: anthropic.baseUrl,
		fetchFn: fetch,
		readCliVersion: async () => "2.1.283",
	});
	const files = makeResetCardFiles(resetCardDir);
	const alerts = [];
	const switches = [];
	let state = emptyQuotaMonitorState(7);
	const deps = () => ({
		now: () => now,
		founderTimezone: () => "America/Los_Angeles",
		config: {
			config: {
				...DEFAULT_QUOTA_MONITOR_CONFIG,
				order: ["business", "school", "shopping"],
			},
			monitorOnly: false,
		},
		state,
		reconcileActive: async () => ({
			result: "noop",
			generation: store().generation,
		}),
		reconcileMachine: async () => ({
			ok: true,
			outcome: "already_consistent",
			exitCode: 0,
			detail: "",
		}),
		withAccountsLock: async (fn) => fn(),
		readSnapshot: async () => {
			const current = store();
			const active = current.activeAccount;
			return {
				activeName: active,
				store: current,
				activeCredential: rc.readPoolCredentialSnapshot
					? await rc.readPoolCredentialSnapshot(active)
					: null,
				poolAccounts: Object.keys(accounts),
			};
		},
		readIdentity: async () => ({
			activeName: store().activeAccount,
			storeGeneration: store().generation,
		}),
		readPoolCredential: async (account) =>
			readPoolMonitorCredential(poolDir, account),
		verifyCandidate: async () => ({
			fresh: "refreshed",
			expiresAt: T0 + 24 * 3_600_000,
		}),
		fetchUsage: (token) =>
			fetchAccountUsage(token, { baseUrl: anthropic.baseUrl, fetchFn: fetch }),
		fetchIdentity: async (token) => ({
			email: `${token.replace("tok-", "")}@example.test`,
			uuid: "uuid",
		}),
		resolveIdentityName: async (identity) => identity.email.split("@")[0],
		recordObservation: async () => "updated",
		writeStatuslineCache: async () => undefined,
		persistState: async () => undefined,
		switchAccount: async (input) => {
			switches.push(input);
			const current = store();
			const target = input.preferredOrder[0];
			const generation = current.generation + 1;
			writeStore(
				{
					...current,
					generation,
					activeAccount: target,
					lastSwitch: {
						generation,
						triggerKind: "quota",
						from: input.observedAccount,
						to: target,
						at: new Date(now).toISOString(),
					},
				},
				storePath,
			);
			return {
				outcome: "switched",
				from: input.observedAccount,
				to: target,
				generation,
			};
		},
		alert: async (alert) => {
			alerts.push({ kind: alert.kind, title: alert.title, body: alert.body });
			return { primary: "sent" };
		},
		log: () => undefined,
		resetCard: rc,
	});
	const poll = async () => {
		const result = await pollOnce(deps());
		state = { ...result.state, nextUsageDueAt: 0 };
		return result.outcome;
	};

	// The Bridge side: one in-memory card; the scenario plays the founder.
	const discord = { posted: [], edits: [], reactions: [] };
	const founder = { approve: false, reject: false };
	const ticker = createResetCardConsentTicker({
		files,
		now: () => now,
		founderId: () => FOUNDER,
		channelId: () => CHANNEL,
		botToken: () => "fake-bot-token",
		discord: {
			post: async (args) => {
				discord.posted.push(args);
				return { ok: true, messageId: "333333333333333333" };
			},
			edit: async (args) => {
				discord.edits.push(args.text.split("\n").at(-1));
				return { ok: true };
			},
			react: async (args) => {
				discord.reactions.push(args.emoji);
				return { ok: true };
			},
			checkReaction: async ({ emoji, founderId }) => {
				const yes =
					founderId === FOUNDER &&
					(emoji === "✅" ? founder.approve : founder.reject);
				return yes
					? { confirmed: true, reason: "confirmed" }
					: { confirmed: false, reason: "not_yet" };
			},
		},
		wake: () => "signaled",
		timezone: () => "America/Los_Angeles",
		log: () => undefined,
		fileReadIntervalMs: 0,
		reactionReadIntervalMs: 0,
	});
	const bridgeTick = async () => {
		ticker.tick();
		await ticker.settle();
	};

	const outcomes = [];
	outcomes.push(await poll()); // 88%: ask (or not)
	await bridgeTick(); // post the card
	const proposalRead = files.readProposal();
	const proposal = proposalRead.status === "ok" ? proposalRead.value : null;
	const cardText =
		proposal === null
			? null
			: renderResetCardText(proposal, {
					founderId: FOUNDER,
					timezone: "America/Los_Angeles",
				});
	if (options.founder === "approve") founder.approve = true;
	if (options.founder === "reject") founder.reject = true;
	now += options.founder === "silent" ? 125 * 60_000 : 5 * 60_000;
	await bridgeTick(); // decide
	accounts.personal.five = 92; // reach the switch line
	now += 5 * 60_000;
	outcomes.push(await poll());
	await bridgeTick(); // render the outcome
	const finalProposal = files.readProposal();
	const consent = files.readConsent();
	const audit = files.readAudit();
	const posts = anthropic.requests.filter((r) => r.method === "POST");
	const finalStore = store();
	await anthropic.close();
	rmSync(root, { recursive: true, force: true });
	return {
		name,
		outcomes,
		proposalTarget: proposal?.target.name ?? null,
		proposalRecoveryAt: proposal?.target.recoveryAt ?? null,
		cardText,
		cardsPosted: discord.posted.length,
		allowedUserIds: discord.posted[0]?.allowedUserIds ?? null,
		finalStatus:
			finalProposal.status === "ok" ? finalProposal.value.status : null,
		consentState: consent.status === "ok" ? consent.value.state : null,
		cardOutcomeLines: discord.edits,
		redeemPosts: posts.map((r) => ({
			path: r.path,
			account: r.account,
			userAgent: r.userAgent,
			body: r.body,
		})),
		getsWithoutCliUa: anthropic.requests.filter(
			(r) =>
				r.path?.includes("cedar_ember=1") &&
				r.userAgent !== "claude-cli/2.1.283 (external, cli)",
		).length,
		store: {
			generation: finalStore.generation,
			activeAccount: finalStore.activeAccount,
			lastSwitch: finalStore.lastSwitch ?? null,
			businessCooldown:
				finalStore.accounts.find((a) => a.name === "business")
					?.switchCooldownUntil ?? null,
		},
		reviveEpochGeneration: state.reviveEpoch?.generation ?? null,
		switchCalls: switches.length,
		audit: audit.status === "ok" ? audit.value : audit,
		alerts: alerts.map((alert) => alert.title),
	};
}

const results = [
	await runScenario("approve", { founder: "approve" }),
	await runScenario("reject", { founder: "reject" }),
	await runScenario("silent", { founder: "silent" }),
	await runScenario("direct-target", {
		founder: "approve",
		directTarget: true,
	}),
];

const failures = [];
const check = (scenario, condition, message) => {
	if (!condition) failures.push(`${scenario}: ${message}`);
};
const [approve, reject, silent, direct] = results;
check(
	"approve",
	approve.proposalTarget === "business",
	"target is the latest natural recovery",
);
check("approve", approve.cardsPosted === 1, "exactly one card");
check(
	"approve",
	JSON.stringify(approve.allowedUserIds) === JSON.stringify([FOUNDER]),
	"only the founder is pingable",
);
check(
	"approve",
	!approve.cardText?.includes("server free text"),
	"no server free text on the card",
);
check("approve", approve.redeemPosts.length === 1, "exactly one redeem POST");
check(
	"approve",
	approve.redeemPosts[0]?.body?.program === "cedar_ember" &&
		approve.redeemPosts[0]?.body?.grant_id === GRANT_ID,
	"redeem body",
);
check(
	"approve",
	approve.getsWithoutCliUa === 0,
	"every card read carries the CLI UA",
);
check("approve", approve.finalStatus === "switched", "switched");
check(
	"approve",
	approve.store.activeAccount === "business" &&
		approve.store.generation === 8 &&
		approve.store.lastSwitch?.triggerKind === "quota",
	"store switched as a quota switch",
);
check(
	"approve",
	approve.store.businessCooldown === null,
	"target cooldown lifted",
);
check("approve", approve.reviveEpochGeneration === 8, "settlement ran");
check(
	"approve",
	Array.isArray(approve.audit) &&
		approve.audit.map((r) => r.kind).join(",") === "intent,terminal",
	"audit intent + terminal",
);
check(
	"reject",
	reject.redeemPosts.length === 0 && reject.finalStatus === "rejected",
	"rejected: no POST",
);
check(
	"silent",
	silent.redeemPosts.length === 0 && silent.finalStatus === "expired",
	"timeout: no POST",
);
check(
	"direct-target",
	direct.proposalTarget === null &&
		direct.cardsPosted === 0 &&
		direct.redeemPosts.length === 0,
	"a direct target means no ask",
);

const summary = { ok: failures.length === 0, failures, results };
if (evidenceDir !== undefined) {
	mkdirSync(evidenceDir, { recursive: true });
	writeFileSync(
		join(evidenceDir, "fly-2896-harness.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(failures.length === 0 ? 0 : 1);
