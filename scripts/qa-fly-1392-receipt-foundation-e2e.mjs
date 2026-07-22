// QA · FLY-1392 — isolated 529-Room receipt-foundation E2E.
//
// This harness uses a REAL, already-existing founder-authored message from the
// isolated 529 room (never impersonates Annie), then drives production source
// under the FLY-1392 copy-Claude-Code-model (Bridge is transport only):
//
//   Discord GET → founder hub root recorded DELIVERED + raw forwarded to Lead
//     (Bridge does NOT auto-process/answer/wake)
//     → Lead route action writes the handled receipt + runner response + wake
//     → real Claude mailbox codec + runner CLI started receipt
//     → unanswered Lead row r1/r2 → durable Lead notification
//     → real Discord escalation POST → Discord GET read-back.
//
// StateStore, comm.db, and the runner mailbox are all fresh temp paths. The only
// external write is one QA escalation message in the isolated room. By default
// it mentions the test bot, not Annie; independent QA may explicitly set
// FLY1392_ALLOW_FOUNDER_MENTION=1 to exercise the real founder mention.
//
// Usage:
//   TEST_BOT_TOKEN_1=... DISCORD_OWNER_USER_ID=... \
//     node --import tsx scripts/qa-fly-1392-receipt-foundation-e2e.mjs

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const imp = (path) => import(pathToFileURL(join(repoRoot, path)).href);
const { CommDB } = await imp("packages/flywheel-comm/src/db.ts");
const { inbox } = await imp("packages/flywheel-comm/src/commands/inbox.ts");
const { founderMessageRootId } = await imp(
	"packages/flywheel-comm/src/founder-reply-routing.ts",
);
const { LeadInboxQueue } = await imp(
	"packages/flywheel-comm/src/lead-inbox-queue.ts",
);
const { wakeRunnerMailbox } = await imp("packages/flywheel-comm/src/wake.ts");
const { deriveRunnerMailboxIdentity } = await imp(
	"packages/agent-team-transport/src/path-helpers.ts",
);
const { ClaudeCodeAdapter } = await imp(
	"packages/agent-team-transport/src/claude/ClaudeCodeAdapter.ts",
);
const { StateStore } = await imp("packages/teamlead/src/StateStore.ts");
const { InMemoryInboundCursorStore } = await imp(
	"packages/teamlead/src/lead-backends/codex/InboundCursorStore.ts",
);
const { emitFounderReplyDeliveryForThread } = await imp(
	"packages/teamlead/src/bridge/founder-reply-deliverer.ts",
);
const { RunnerReceiptPatrol } = await imp(
	"packages/teamlead/src/bridge/runner-receipt-patrol.ts",
);
const { LeadReceiptPatrol } = await imp(
	"packages/teamlead/src/bridge/lead-receipt-patrol.ts",
);
const { notifyLeadFirst, reconcileDetectionEscalations } = await imp(
	"packages/teamlead/src/bridge/detection-escalation.ts",
);
const { createFounderPager } = await imp(
	"packages/teamlead/src/bridge/detection-escalation-sinks.ts",
);

const CHANNEL = process.env.FLY1392_QA_CHANNEL_ID ?? "1519421055805165842";
const TOKEN = process.env.TEST_BOT_TOKEN_1;
const FOUNDER_ID = process.env.DISCORD_OWNER_USER_ID;
if (!TOKEN || !FOUNDER_ID) {
	console.error(
		"FATAL: TEST_BOT_TOKEN_1 and DISCORD_OWNER_USER_ID are required",
	);
	process.exit(2);
}

const discord = async (path, init = {}) => {
	const response = await fetch(`https://discord.com/api/v10${path}`, {
		...init,
		headers: {
			Authorization: `Bot ${TOKEN}`,
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
	});
	if (!response.ok) {
		throw new Error(
			`Discord ${init.method ?? "GET"} ${path} → ${response.status}`,
		);
	}
	return response.status === 204 ? null : response.json();
};

const results = [];
const check = (name, pass, detail = "") => {
	results.push({ name, pass: Boolean(pass), detail });
	console.log(
		`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
	);
};

const botUser = await discord("/users/@me");
let founderMessage;
let before;
for (let page = 0; page < 10 && !founderMessage; page += 1) {
	const messages = await discord(
		`/channels/${CHANNEL}/messages?limit=100${before ? `&before=${before}` : ""}`,
	);
	founderMessage = messages.find(
		(message) =>
			message.author?.id === FOUNDER_ID &&
			message.author?.bot !== true &&
			typeof message.content === "string" &&
			message.content.trim().length > 0,
	);
	before = messages.at(-1)?.id;
	if (messages.length < 100) break;
}
const liveFounderMessage = Boolean(founderMessage);
if (!founderMessage) {
	if (process.env.FLY1392_ALLOW_SYNTHETIC_FOUNDER !== "1") {
		console.error(
			"FATAL: no non-bot founder-authored message is visible in the latest 1000 529-Room messages",
		);
		process.exit(2);
	}
	const syntheticAt = Date.now() - 10_000;
	founderMessage = {
		id: String(BigInt(syntheticAt - 1_420_070_400_000) << 22n),
		content: "FLY-1392 synthetic founder ingress fixture",
		author: { id: FOUNDER_ID, bot: false },
	};
	console.log(
		"SKIP  canonical founder-authored Discord ingress (no founder message in 1000-message history; synthetic fixture enabled)",
	);
}

const runTag = `qa1392-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
const dir = mkdtempSync(join(tmpdir(), "fly1392-e2e-"));
const dbPath = join(dir, "comm.db");
const mailboxRoot = join(dir, "claude-config");
const previousBackend = process.env.FLYWHEEL_COMM_BACKEND;
const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
process.env.FLYWHEEL_COMM_BACKEND = "mailbox";
process.env.CLAUDE_CONFIG_DIR = mailboxRoot;

const PROJECT = "flywheel";
const LEAD = "qa1392-lead";
const EXEC = `exec-${runTag}`;
const ISSUE = `issue-${runTag}`;
const ISSUE_IDENTIFIER = `FLY-1392-QA-${runTag}`;
const OWNER_EPOCH = `owner-${runTag}`;
let db;
let queue;
let store;

try {
	db = new CommDB(dbPath);
	queue = new LeadInboxQueue(dbPath);
	store = await StateStore.create(join(dir, "state.db"));
	db.registerSession(EXEC, `${ISSUE_IDENTIFIER}:@0`, PROJECT, ISSUE, LEAD);
	store.upsertSession({
		execution_id: EXEC,
		issue_id: ISSUE,
		issue_identifier: ISSUE_IDENTIFIER,
		project_name: PROJECT,
		status: "running",
	});
	const ownerAt = new Date().toISOString();
	check(
		"protocol owner acquired",
		queue.acquireOrRenewOwner({
			ownerEpoch: OWNER_EPOCH,
			now: ownerAt,
			leaseTtlMs: 60 * 60_000,
		}),
	);

	// ── A. Real founder message → Bridge relays raw to Lead (no auto-process)
	//        → Lead route action writes handled + wake → real mailbox wake ──
	// FLY-1392 copy-Claude-Code-model: Bridge is a transport only. Every founder
	// message (even one matching a pending question) is recorded delivered and
	// forwarded to Lead; ONLY a later Lead route/no-route action may write the
	// handled receipt or reach a runner. The Lead action is simulated by running
	// the route command with the in-room Lead identity (routeFounderReply).
	const questionId = db.insertQuestion(
		EXEC,
		LEAD,
		"QA route this founder reply",
		{
			checkpoint: "brainstorm",
		},
	);
	const cursor = new InMemoryInboundCursorStore();
	cursor.save(CHANNEL, (BigInt(founderMessage.id) - 1n).toString());
	const ingressFetch = liveFounderMessage
		? fetch
		: async (input, init) => {
				if (
					typeof input === "string" &&
					input.includes(`/channels/${CHANNEL}/messages?`)
				) {
					return new Response(JSON.stringify([founderMessage]), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return fetch(input, init);
			};
	// Bridge's founder→Lead handoff. Returns true (durably accepted by Lead) and
	// captures the relayed payload so the harness can assert the ORIGINAL text
	// reached Lead untouched.
	let relayedToLead = null;
	const deliverAmbiguousToLead = async (_eventId, payload) => {
		relayedToLead = payload;
		return true;
	};
	const ingress = await emitFounderReplyDeliveryForThread(
		{
			issueId: ISSUE,
			projectName: PROJECT,
			threadId: CHANNEL,
			botToken: TOKEN,
			ownerUserId: FOUNDER_ID,
			graceMs: 0,
			commDbPath: dbPath,
			leadId: LEAD,
		},
		[
			{
				questionId,
				checkpoint: "brainstorm",
				executionId: EXEC,
				createdAtMs:
					Number(BigInt(founderMessage.id) >> 22n) + 1_420_070_400_000 - 1,
				checkpointGraceMs: 0,
			},
		],
		{
			store,
			cursorStore: cursor,
			fetchImpl: ingressFetch,
			commDbFactory: () => new CommDB(dbPath, false),
			receiptFoundationEnabled: () => true,
			receiptOwnerEpoch: () => OWNER_EPOCH,
			deliverAmbiguousToLead,
		},
	);
	const rootId = founderMessageRootId(LEAD, founderMessage.id);
	const root = queue.getById(rootId);
	const founderText = founderMessage.content.slice(0, 2_000);
	check(
		liveFounderMessage
			? "real Discord founder message advanced"
			: "synthetic founder ingress fixture advanced",
		ingress.result === "advanced",
	);
	check(
		"canonical receipt row enqueued in Lead's ledger (v2: delivered_at set by the loop delivery)",
		Boolean(
			root &&
				root.routing_state === "hub_recorded" &&
				root.carrier === "inbox" &&
				root.priority === 0 &&
				root.processed_at == null &&
				root.disposed_at == null,
		),
	);
	// The core copy-model contract: Bridge does NOT auto-process. No handled
	// receipt, no runner response, no runner wake — until the Lead acts.
	check(
		"Bridge did NOT auto-process (handled receipt absent before Lead acts)",
		root?.processed_at == null && root?.processed_evidence == null,
	);
	check(
		"Bridge did NOT auto-answer the runner (no response before Lead acts)",
		db.getResponse(questionId) === undefined,
	);
	check(
		"Bridge did NOT wake the runner (no wake intent before Lead acts)",
		db.listRunnerPhaseWakes(EXEC).length === 0,
	);
	check(
		"Bridge forwarded the ORIGINAL founder text to Lead untouched",
		relayedToLead?.answer === founderMessage.content &&
			relayedToLead?.msgId === founderMessage.id,
	);

	// The Lead handles it: route the founder reply to the pending question. Only
	// now may the handled receipt, the runner response, and the wake appear.
	const routed = db.routeFounderReply({
		msgId: founderMessage.id,
		leadId: LEAD,
		toQuestionId: questionId,
		now: new Date().toISOString(),
		provenance: { senderGeneration: 7 },
		intentKey: `founder-route:${LEAD}:${founderMessage.id}:${questionId}`,
		envelope: {
			id: `founder-route-wake:${LEAD}:${founderMessage.id}:${questionId}`,
			to: EXEC,
			content: "founder reply answered",
			metadata: { msgId: founderMessage.id, questionId },
		},
		queuedAtMs: Date.now(),
	});
	check("Lead route action routed the founder reply", routed.kind === "routed");
	const processedRoot = queue.getById(rootId);
	check(
		"handled receipt written ONLY by the Lead route action",
		Boolean(processedRoot?.processed_at) &&
			processedRoot?.routing_state === "bound",
	);
	check(
		"Lead route wrote the runner response (from Lead, original founder text)",
		db.getResponse(questionId)?.from_agent === LEAD &&
			db.getResponse(questionId)?.content === founderText,
	);
	const admittedWake = db.listRunnerPhaseWakes(EXEC)[0];
	check("Lead route created the durable runner wake", Boolean(admittedWake));

	const wakePatrol = new RunnerReceiptPatrol({
		projectNames: [PROJECT],
		commDbPathForProject: () => dbPath,
		receiptFoundationEnabled: () => true,
		resolveTargetState: () => "live",
		now: () => Date.now(),
		pushWake: async ({ db: openDb, wake, verified }) => {
			const envelope = JSON.parse(wake.envelope_json);
			return wakeRunnerMailbox({
				db: openDb,
				execId: wake.execution_id,
				fromAgent: LEAD,
				content: envelope.content,
				metadata: envelope.metadata,
				backend: "claude-code",
				verified,
			});
		},
		nudgeWakePointer: async () => ({ nudged: false, error: "not_due" }),
		notifyWakeFailure: async () => false,
	});
	await wakePatrol.pass();
	const { agentName, teamName } = deriveRunnerMailboxIdentity(EXEC, LEAD);
	const mailboxPath = new ClaudeCodeAdapter().getInboxPath(teamName, agentName);
	const mailbox = existsSync(mailboxPath)
		? JSON.parse(readFileSync(mailboxPath, "utf8"))
		: [];
	check(
		"real Claude mailbox received the wake pointer",
		mailbox.some((entry) => entry.text?.includes("founder reply answered")),
		mailboxPath,
	);
	const observedAt = Date.now() + 1;
	inbox({ execId: EXEC, dbPath, now: () => observedAt });
	check(
		"runner CLI recorded the constrained started receipt",
		db.listRunnerPhaseWakes(EXEC)[0]?.state === "started",
	);

	// ── B. No processed receipt → r1/r2 → Lead notify → real Discord page ──
	const ESC_EXEC = `unprocessed-${runTag}`;
	db.registerSession(ESC_EXEC, `${ISSUE_IDENTIFIER}:@1`, PROJECT, ISSUE, LEAD);
	const unansweredQuestion = db.insertQuestion(
		ESC_EXEC,
		LEAD,
		"QA intentionally unanswered",
	);
	const receiptId = `unprocessed-${runTag}`;
	const t0Ms = Date.now();
	const t0 = new Date(t0Ms).toISOString();
	queue.enqueue({
		id: receiptId,
		toLead: LEAD,
		source: `question:${unansweredQuestion}`,
		type: "runner_question",
		msgClass: "model",
		priority: 1,
		content: `QA unanswered ${runTag}`,
		refMessageId: unansweredQuestion,
		createdAt: t0,
	});
	const claimed = queue.claimModelBatch({
		toLead: LEAD,
		ownerEpoch: OWNER_EPOCH,
		batchId: `batch-${runTag}`,
		now: t0,
		claimTtlMs: 60_000,
	});
	// v2: category-agnostic priority windows (uniform 1s for a fast fault-injection
	// loop) + activation episode reconcile so the delivered row is re-anchored and
	// its resend children carry the generation-scoped `@<episode>` id.
	const WINDOWS_MS = [1_000, 1_000, 1_000, 1_000];
	queue.markConsumed(
		claimed.map(({ id }) => id),
		{
			ownerEpoch: OWNER_EPOCH,
			disposition: "delivered",
			now: t0,
			receiptWindowsMs: WINDOWS_MS,
		},
	);
	const activation = db.reconcileReceiptActivation({
		enabled: true,
		now: t0,
		receiptWindowsMs: WINDOWS_MS,
		highWaterMark: "1485740000000000000",
	});
	let patrolNow = t0Ms + 1_000;
	const escalationKind = "receipt_unprocessed:runner_question";
	const leadPatrol = new LeadReceiptPatrol({
		projectNames: [PROJECT],
		commDbPathForProject: () => dbPath,
		receiptFoundationEnabled: () => true,
		ownerEpoch: () => OWNER_EPOCH,
		now: () => patrolNow,
		windowMs: 1_000,
		receiptWindowsMs: WINDOWS_MS,
		resendCap: 2,
		notifyUnprocessed: async ({ payload }) => {
			const outcome = await notifyLeadFirst(
				{
					store,
					runtimeRegistry: {
						getForLead: () => ({
							deliver: async () => ({ delivered: true }),
						}),
					},
					resolveOwner: () => ({
						leadId: LEAD,
						projectName: PROJECT,
						executionId: ESC_EXEC,
						issueId: ISSUE,
					}),
				},
				{
					targetKey: payload.targetKey,
					kind: escalationKind,
					episodeFingerprint: payload.rootId,
					executionId: ESC_EXEC,
					issueId: ISSUE,
					issueIdentifier: ISSUE_IDENTIFIER,
					projectName: PROJECT,
					firstDetectedAtMs: Date.parse(payload.firstDeliveredAt),
					reason: `QA ${payload.resendRound} resends without processed receipt`,
				},
			);
			return outcome === "notified" || outcome === "already_notified";
		},
		notifyAdvisory: async () => true,
	});
	// v2 fault-injection loop: a resend round only advances after the previous
	// resend child is actually DELIVERED to the Lead's inbox (delivered_rounds
	// contract). So each pass we deliver any freshly-materialized child, mirroring
	// the LeadInboxLoop, until the escalation fires at the resend cap.
	const deliverChild = (round) => {
		const childId = `${receiptId}#r${round}@${activation.episodeId}`;
		if (!queue.getById(childId)) return;
		const childRows = queue.claimModelBatch({
			toLead: LEAD,
			ownerEpoch: OWNER_EPOCH,
			batchId: `resend-batch-${round}`,
			now: new Date(patrolNow).toISOString(),
			claimTtlMs: 60_000,
		});
		queue.markConsumed(
			childRows.map(({ id }) => id),
			{
				ownerEpoch: OWNER_EPOCH,
				disposition: "delivered",
				now: new Date(patrolNow).toISOString(),
				receiptWindowsMs: WINDOWS_MS,
			},
		);
	};
	for (let round = 1; round <= 3; round += 1) {
		await leadPatrol.pass();
		deliverChild(round);
		patrolNow += 1_000;
	}
	check(
		"unprocessed root emitted exactly r1+r2 (generation-scoped ids)",
		Boolean(
			queue.getById(`${receiptId}#r1@${activation.episodeId}`) &&
				queue.getById(`${receiptId}#r2@${activation.episodeId}`) &&
				!queue.getById(`${receiptId}#r3@${activation.episodeId}`),
		),
	);
	check(
		"Lead-first escalation is durable",
		store.getDetectionEscalation(
			`${PROJECT}:${LEAD}`,
			escalationKind,
			receiptId,
		)?.status === "LEAD_NOTIFIED",
	);
	check(
		"receipt root records escalation only after Lead notify",
		Boolean(queue.getById(receiptId)?.escalated_at),
	);

	store.upsertChatThread(CHANNEL, CHANNEL, ISSUE, LEAD);
	const undeliverable = [];
	const pageFounder = createFounderPager({
		store,
		resolveTarget: () => ({
			executionId: ESC_EXEC,
			issueId: ISSUE,
			issueIdentifier: ISSUE_IDENTIFIER,
			projectName: PROJECT,
			chatChannel: CHANNEL,
			botToken: TOKEN,
		}),
		discordOwnerUserId:
			process.env.FLY1392_ALLOW_FOUNDER_MENTION === "1"
				? FOUNDER_ID
				: botUser.id,
		discordBotToken: TOKEN,
		onUndeliverable: (_row, reason) => undeliverable.push(reason),
		addMember: async () => "added",
	});
	await reconcileDetectionEscalations({
		store,
		pageFounder,
		fleetSink: async () => {},
		kindFilter: { includeKinds: [escalationKind] },
		graceMs: 1,
		fleetThreshold: 999,
		now: () => Date.now() + 5_000,
	});
	const readback = await discord(`/channels/${CHANNEL}/messages?limit=50`);
	const page = readback.find(
		(message) =>
			message.author?.id === botUser.id &&
			message.content?.includes(ISSUE_IDENTIFIER) &&
			message.content?.includes(`${PROJECT}:${LEAD}`),
	);
	check(
		"real Discord escalation page read back",
		Boolean(page),
		page?.id ?? "",
	);
	check(
		"founder pager had no undeliverable outcome",
		undeliverable.length === 0,
	);
} finally {
	queue?.close();
	db?.close();
	store?.close();
	rmSync(dir, { recursive: true, force: true });
	if (previousBackend === undefined) delete process.env.FLYWHEEL_COMM_BACKEND;
	else process.env.FLYWHEEL_COMM_BACKEND = previousBackend;
	if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
}

const failed = results.filter((result) => !result.pass);
console.log(
	`\n=== FLY-1392 receipt foundation E2E: ${results.length - failed.length}/${results.length} PASS ===`,
);
if (!liveFounderMessage) {
	console.log(
		"BOUNDARY: canonical Annie-authored 529 ingress remains for independent QA; all other machine legs used production components.",
	);
}
if (failed.length > 0) process.exit(1);
