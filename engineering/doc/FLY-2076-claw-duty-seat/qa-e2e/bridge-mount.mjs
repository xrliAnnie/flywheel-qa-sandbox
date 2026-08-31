// QA·FLY-2076 — does the REAL Bridge app actually mount /duty, and is the
// capability really separate from the shared API bearer?
// Boots the real built createBridgeApp (not a hand-mounted router).

import { join } from "node:path";

const repoRoot =
	process.env.QA_REPO_ROOT ?? "/Users/xiaorongli/Dev/flywheel-FLY-2076";
const tl = (p) => import(join(repoRoot, "packages/teamlead/dist", p));

const { createBridgeApp } = await tl("bridge/plugin.js");
const { StateStore } = await tl("StateStore.js");

const results = { pass: [], fail: [] };
const ok = (n, c, d = "") =>
	(c ? results.pass : results.fail).push(`${n}${d ? ` — ${d}` : ""}`);

const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/qa2076",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				chatChannel: "c",
				match: { labels: ["eng"] },
				botUserId: "100000000000000003",
			},
		],
	},
];

const baseConfig = (over) => ({
	host: "127.0.0.1",
	port: 0,
	dbPath: ":memory:",
	notificationChannel: "c",
	defaultLeadAgentId: "flywheel-eng-lead",
	stuckThresholdMinutes: 15,
	stuckCheckIntervalMs: 300000,
	orphanThresholdMinutes: 60,
	founderConsent: { decisionMode: "off" },
	...over,
});

async function boot(config, opts) {
	const store = await StateStore.create(":memory:");
	store.openAlertThread({
		correlationKey: "flywheel|lead-a|rate_limit|",
		eventId: "evt-mount-1",
		threadId: "t1",
		rootMessageId: "r1",
		channelId: "alerts",
		leadId: "lead-a",
		projectName: "flywheel",
		eventType: "rate_limit",
		ticketStatus: "NEW",
		ownerRef: "infra_bot:claude",
	});
	// createBridgeApp keeps `opts` as its 15th positional parameter.
	const app = createBridgeApp(
		store,
		projects,
		config,
		undefined, // broadcaster
		undefined, // transitionOpts
		undefined, // retryDispatcher
		undefined, // cipherWriter
		undefined, // eventFilter
		undefined, // _unusedForumTagUpdater
		undefined, // registry
		undefined, // _unusedForumPostCreator
		undefined, // memoryService
		undefined, // captureSessionFn
		undefined, // startDispatcher
		undefined, // standupService
		undefined, // standupProjectName
		opts,
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise((r) => server.once("listening", r));
	const port = server.address().port;
	return { store, server, base: `http://127.0.0.1:${port}` };
}

const get = async (base, path, token) => {
	const res = await fetch(`${base}${path}`, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});
	let body = {};
	try {
		body = await res.json();
	} catch {}
	return { status: res.status, body };
};

// ── 1. duty token configured + shared api token configured ──
{
	const dispatcher = { current: null };
	const { server, base } = await boot(
		baseConfig({ apiToken: "shared-api", alertDutyToken: "duty-only" }),
		{
			alertDuty: { dispatcherBotUserId: dispatcher, alertHub: { current: undefined } },
		},
	);

	const withDuty = await get(base, "/duty/alert-tickets/outstanding", "duty-only");
	ok(
		"real Bridge mounts /duty and the duty bearer gets 200",
		withDuty.status === 200 && Array.isArray(withDuty.body.tickets),
		`status=${withDuty.status}`,
	);

	const withApi = await get(base, "/duty/alert-tickets/outstanding", "shared-api");
	ok(
		"the SHARED api bearer cannot reach /duty (403)",
		withApi.status === 403,
		`status=${withApi.status}`,
	);

	const noAuth = await get(base, "/duty/alert-tickets/outstanding");
	ok("/duty without a bearer is 403", noAuth.status === 403, `status=${noAuth.status}`);

	const dutyOnApi = await get(base, "/api/sessions", "duty-only");
	ok(
		"the duty bearer is NOT valid on /api (no privilege widening)",
		dutyOnApi.status === 401 || dutyOnApi.status === 403,
		`status=${dutyOnApi.status}`,
	);

	// seat probe: null before the Bridge resolves the dispatcher, then the id
	const seatBefore = await get(base, "/api/alert-duty/seat", "shared-api");
	dispatcher.current = "1524831623164596265";
	const seatAfter = await get(base, "/api/alert-duty/seat", "shared-api");
	ok(
		"the seat probe is late-bound: null before resolution, the id after",
		seatBefore.status === 200 &&
			seatBefore.body.dispatcherBotUserId === null &&
			seatAfter.body.dispatcherBotUserId === "1524831623164596265",
		`before=${JSON.stringify(seatBefore.body)} after=${JSON.stringify(seatAfter.body)}`,
	);

	// resolve with no Hub wired → 503, not a silent success
	const res = await fetch(`${base}/duty/alert-tickets/transition`, {
		method: "POST",
		headers: {
			Authorization: "Bearer duty-only",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ action: "resolve", eventId: "evt-mount-1" }),
	});
	ok("resolve without a wired Hub fails loud (503)", res.status === 503, `status=${res.status}`);

	server.close();
}

// ── 2. duty token NOT configured → the surface is closed, not open ──
{
	const { server, base } = await boot(baseConfig({ apiToken: "shared-api" }), {});
	const r = await get(base, "/duty/alert-tickets/outstanding", "anything");
	ok(
		"an unconfigured duty capability fails CLOSED (503, never open)",
		r.status === 503 && r.body.error === "alert_duty_unconfigured",
		`status=${r.status} ${JSON.stringify(r.body)}`,
	);
	server.close();
}

// ── 3. token collision refuses to start (config layer) ──
{
	const { loadConfig } = await tl("config.js");
	const snapshot = { ...process.env };
	process.env.TEAMLEAD_DEFAULT_LEAD_AGENT = "flywheel-eng-lead";
	process.env.DISCORD_OWNER_USER_ID = "100000000000000009";
	process.env.FLYWHEEL_PROJECTS = JSON.stringify(projects);
	process.env.TEAMLEAD_API_TOKEN = "same-token-value";
	process.env.FLYWHEEL_ALERT_DUTY_TOKEN = "same-token-value";
	let threw = "";
	try {
		loadConfig();
	} catch (e) {
		threw = e.message;
	}
	ok(
		"a duty token equal to the shared API token refuses to start",
		threw.includes("FLYWHEEL_ALERT_DUTY_TOKEN must differ from TEAMLEAD_API_TOKEN"),
		threw || "(no throw)",
	);
	// control: distinct values start fine
	process.env.FLYWHEEL_ALERT_DUTY_TOKEN = "a-different-value";
	let ctrl = "ok";
	try {
		loadConfig();
	} catch (e) {
		ctrl = e.message;
	}
	ok("control: distinct tokens load cleanly", ctrl === "ok", ctrl);
	for (const k of Object.keys(process.env))
		if (!(k in snapshot)) delete process.env[k];
	Object.assign(process.env, snapshot);
}

console.log("\n── QA FLY-2076 real Bridge mount / capability separation ──");
for (const p of results.pass) console.log(`  ✓ ${p}`);
for (const f of results.fail) console.log(`  ✗ ${f}`);
console.log(`\nPASS ${results.pass.length}  FAIL ${results.fail.length}`);
process.exit(results.fail.length === 0 ? 0 : 1);
