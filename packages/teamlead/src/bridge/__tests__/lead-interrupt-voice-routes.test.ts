import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import express from "express";
import { CommDB } from "flywheel-comm/db";
import { ingestDiscordChat } from "flywheel-comm/discord-chat-ingest";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { decodeSenderRef } from "flywheel-comm/sender-ref";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	LEAD_INTERRUPT_BODY_MAX_CODE_POINTS,
	renderLeadInterruptLetter,
} from "../lead-interrupt-contract.js";
import {
	createCommDbFounderQuoteVerifier,
	createLeadInterruptVoiceHandlers,
	createProjectLeadTargetResolver,
	type LeadInterruptMailbox,
} from "../lead-interrupt-routes.js";
import { voiceSessionAuthMiddleware } from "../voice-session-auth.js";
import { createVoiceSessionRouter } from "../voice-session-routes.js";

const MASTER = "master-token";
const INGEST = "ingest-token";
const NOW = "2026-09-25T20:00:00.000Z";
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const FOUNDER = "100000000000000009";
const FOUNDER_MESSAGE = "300000000000000001";
const VOICE_LEAD = "voice-lead";
const TARGET = "flywheel-eng-lead";
const ID_1 = "li_00000000-0000-4000-8000-000000000001";

let server: Server | undefined;
let store: StateStore;
let root: string;
let voiceDb: string;
let targetDb: string;

function rawDb(s: StateStore): Database.Database {
	return (s as unknown as { db: { raw: Database.Database } }).db.raw;
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "fly2883-voice-"));
	store = await StateStore.create(join(root, "teamlead.db"));
	voiceDb = join(root, "voice-comm.db");
	targetDb = join(root, "target-comm.db");
	new CommDB(voiceDb).close();
	new CommDB(targetDb).close();
});

afterEach(
	() =>
		new Promise<void>((resolve) => {
			const finish = () => {
				store.close();
				rmSync(root, { recursive: true, force: true });
				resolve();
			};
			if (!server) return finish();
			server.close(finish);
			server = undefined;
		}),
);

function claimSession(): string {
	store.reserveVoiceSession({
		sessionId: SESSION_ID,
		mode: "meeting",
		projectName: "voice-project",
		leadId: VOICE_LEAD,
		guildId: "100000000000000001",
		voiceChannelId: "100000000000000002",
		voiceBotUserId: "100000000000000005",
		meetingId: "20000000-0000-4000-8000-000000000001",
		evidenceDir: "/evidence/a",
		requestedBy: "master",
		credentialTier: "master",
		createdAt: NOW,
	});
	store.updateVoiceProvisioning({
		sessionId: SESSION_ID,
		expectedStep: "reserved",
		nextStep: "done",
		nextState: "desired",
		updatedAt: NOW,
	});
	const claimed = store.claimVoiceSession({
		sessionId: SESSION_ID,
		daemonBootId: "boot-a",
		now: NOW,
		leaseTtlMs: 60 * 60_000,
	});
	if (!claimed) throw new Error("claim failed");
	return claimed.leaseToken;
}

function ingestFounderQuote(
	overrides: {
		messageId?: string;
		origin?: "voice" | "discord";
		voiceSessionId?: string;
		authorId?: string;
	} = {},
): void {
	ingestDiscordChat({
		dbPath: voiceDb,
		leadId: VOICE_LEAD,
		chatId: "100000000000000003",
		originChannelId: "100000000000000003",
		messageId: overrides.messageId ?? FOUNDER_MESSAGE,
		authorId: overrides.authorId ?? FOUNDER,
		authorName: "founder",
		ts: NOW,
		msgKind: "guild",
		attachments: [],
		text: "问问 eng lead 现在在干嘛",
		...((overrides.origin ?? "voice") === "voice"
			? {
					origin: "voice" as const,
					voiceSessionId: overrides.voiceSessionId ?? SESSION_ID,
				}
			: {}),
		founderId: FOUNDER,
	});
}

interface StartOptions {
	mailboxForProject?: (project: string) => LeadInterruptMailbox | undefined;
	resolveTarget?: (
		project: string,
		leadId: string,
	) => { backend: "claude-code" | "codex-app-server" } | undefined;
	ids?: string[];
	now?: () => string;
}

async function start(options: StartOptions = {}) {
	const queues = new Map<string, MailboxQueue>();
	const nudgeLead = vi.fn();
	const ids = [...(options.ids ?? [ID_1])];
	const defaultMailbox = (project: string) => {
		if (project !== "flywheel") return undefined;
		let queue = queues.get(project);
		if (!queue) {
			queue = new MailboxQueue(targetDb);
			queues.set(project, queue);
		}
		return queue;
	};
	const handlers = createLeadInterruptVoiceHandlers({
		store,
		now: options.now ?? (() => NOW),
		newInterruptId: () => {
			const next = ids.shift();
			if (!next) throw new Error("test ran out of interrupt ids");
			return next;
		},
		resolveTarget:
			options.resolveTarget ??
			((project, leadId) =>
				project === "flywheel" && leadId === TARGET
					? { backend: "claude-code" }
					: undefined),
		verifyFounderQuote: createCommDbFounderQuoteVerifier({
			commDbPathForProject: (project) =>
				project === "voice-project" ? voiceDb : join(root, "missing.db"),
			founderUserId: FOUNDER,
		}),
		mailboxForProject: options.mailboxForProject ?? defaultMailbox,
		nudgeLead,
	});
	const app = express();
	app.use(express.json());
	app.use(
		"/api/voice/sessions",
		voiceSessionAuthMiddleware(MASTER, INGEST),
		createVoiceSessionRouter({
			store,
			leaseTtlMs: 15_000,
			leaseRenewMs: 4_000,
			now: options.now ?? (() => NOW),
			resolveStart: () => {
				throw new Error("not used");
			},
			provisionSession: () => {},
			projectSession: () => ({}),
			leadInterrupts: handlers,
		}),
	);
	server = createServer(app);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const cleanup = () => {
		for (const queue of queues.values()) queue.close();
	};
	server.on("close", cleanup);
	return {
		base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice/sessions`,
		nudgeLead,
	};
}

async function call(
	base: string,
	path: string,
	options: {
		method?: string;
		token?: string;
		lease?: string;
		body?: unknown;
	} = {},
) {
	const response = await fetch(`${base}${path}`, {
		method: options.method ?? "GET",
		headers: {
			...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
			...(options.lease ? { "X-Voice-Lease": options.lease } : {}),
			...(options.body === undefined
				? {}
				: { "Content-Type": "application/json" }),
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	return { status: response.status, body: await response.json() };
}

function request(overrides: Record<string, unknown> = {}) {
	return {
		targetProject: "flywheel",
		targetLeadId: TARGET,
		founderMessageId: FOUNDER_MESSAGE,
		body: "你现在在做什么?",
		idempotencyKey: "idem-key-0001",
		...overrides,
	};
}

function interruptRows(): Array<Record<string, unknown>> {
	const db = CommDB.openReadonly(targetDb);
	try {
		return (db as unknown as { db: Database.Database }).db
			.prepare("SELECT * FROM mailbox WHERE type = 'lead_interrupt'")
			.all() as Array<Record<string, unknown>>;
	} finally {
		db.close();
	}
}

describe("FLY-2883 voice lead-interrupt routes", () => {
	it("audits first, then enqueues one urgent letter and returns 202", async () => {
		const lease = claimSession();
		ingestFounderQuote();
		const { base, nudgeLead } = await start();
		const result = await call(base, `/${SESSION_ID}/lead-interrupts`, {
			method: "POST",
			token: MASTER,
			lease,
			body: request(),
		});
		expect(result).toEqual({
			status: 202,
			body: { interruptId: ID_1, state: "queued" },
		});
		const rows = interruptRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: `lead-interrupt:${ID_1}`,
			delivery_id: `lead-interrupt:${ID_1}`,
			from_agent: `lead-interrupt:${ID_1}`,
			to_agent: TARGET,
			recipient_kind: "lead",
			source_kind: "lead_interrupt",
			source_ref: ID_1,
			msg_class: "model",
			priority: 0,
			state: "QUEUED",
			content: renderLeadInterruptLetter({
				interruptId: ID_1,
				voiceSessionId: SESSION_ID,
				founderMessageId: FOUNDER_MESSAGE,
				body: "你现在在做什么?",
			}),
		});
		expect(() => decodeSenderRef(rows[0]!.sender_ref as string)).not.toThrow();
		expect(
			store.leadInterrupts.listAudit(ID_1).map((row) => row.event),
		).toEqual(["requested", "enqueued"]);
		expect(store.leadInterrupts.get(ID_1)).toMatchObject({
			state: "queued",
			initiatorKind: "voice_session",
			initiatorRef: SESSION_ID,
			founderMessageId: FOUNDER_MESSAGE,
			targetBackend: "claude-code",
		});
		expect(nudgeLead).toHaveBeenCalledWith("flywheel", TARGET);
	});

	it("does not send anything when the audit cannot be written (fail-closed)", async () => {
		const lease = claimSession();
		ingestFounderQuote();
		rawDb(
			store,
		).exec(`CREATE TRIGGER fail_lead_interrupt_audit BEFORE INSERT ON lead_interrupt_audit
			BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
		const { base, nudgeLead } = await start();
		const result = await call(base, `/${SESSION_ID}/lead-interrupts`, {
			method: "POST",
			token: MASTER,
			lease,
			body: request(),
		});
		expect(result).toEqual({
			status: 503,
			body: { error: "audit_unavailable" },
		});
		expect(interruptRows()).toHaveLength(0);
		expect(store.leadInterrupts.get(ID_1)).toBeUndefined();
		expect(nudgeLead).not.toHaveBeenCalled();
	});

	it("requires the daemon tier and a live lease", async () => {
		const lease = claimSession();
		ingestFounderQuote();
		const { base } = await start();
		expect(
			(
				await call(base, `/${SESSION_ID}/lead-interrupts`, {
					method: "POST",
					token: INGEST,
					lease,
					body: request(),
				})
			).status,
		).toBe(403);
		expect(
			await call(base, `/${SESSION_ID}/lead-interrupts`, {
				method: "POST",
				token: MASTER,
				lease: "wrong-lease",
				body: request(),
			}),
		).toEqual({ status: 409, body: { error: "voice_lease_conflict" } });
		expect(interruptRows()).toHaveLength(0);
	});

	it("refuses a target that is not a registered Lead and audits the refusal", async () => {
		const lease = claimSession();
		ingestFounderQuote();
		const { base } = await start();
		const result = await call(base, `/${SESSION_ID}/lead-interrupts`, {
			method: "POST",
			token: MASTER,
			lease,
			body: request({ targetLeadId: "runner-exec-1" }),
		});
		expect(result).toEqual({ status: 422, body: { error: "target_not_lead" } });
		expect(interruptRows()).toHaveLength(0);
		const refused = rawDb(store)
			.prepare("SELECT event, detail, target_lead_id FROM lead_interrupt_audit")
			.all();
		expect(refused).toEqual([
			{
				event: "refused",
				detail: "target_not_lead",
				target_lead_id: "runner-exec-1",
			},
		]);
	});

	it.each([
		["absent", {}, "300000000000000099"],
		["typed in Discord, not voice", { origin: "discord" as const }, undefined],
		[
			"from another voice session",
			{ voiceSessionId: "10000000-0000-4000-8000-000000000002" },
			undefined,
		],
		[
			"not authored by the founder",
			{ authorId: "100000000000000077" },
			undefined,
		],
	])("refuses a founder quote that is %s", async (_label, quote, askFor) => {
		const lease = claimSession();
		ingestFounderQuote(quote);
		const { base } = await start();
		const result = await call(base, `/${SESSION_ID}/lead-interrupts`, {
			method: "POST",
			token: MASTER,
			lease,
			body: request(askFor ? { founderMessageId: askFor } : {}),
		});
		expect(result).toEqual({
			status: 422,
			body: { error: "founder_quote_unverified" },
		});
		expect(interruptRows()).toHaveLength(0);
	});

	it("accepts a founder quote that has already been archived", async () => {
		const lease = claimSession();
		ingestFounderQuote();
		const queue = new MailboxQueue(voiceDb);
		try {
			expect(queue.ack(`chat:${VOICE_LEAD}:${FOUNDER_MESSAGE}`, NOW)).toBe(
				true,
			);
			expect(
				queue.archiveFamily({
					id: `chat:${VOICE_LEAD}:${FOUNDER_MESSAGE}`,
					now: "2026-09-25T20:00:01.000Z",
					retentionMs: 0,
				}),
			).toBe("archived");
		} finally {
			queue.close();
		}
		const { base } = await start();
		expect(
			(
				await call(base, `/${SESSION_ID}/lead-interrupts`, {
					method: "POST",
					token: MASTER,
					lease,
					body: request(),
				})
			).status,
		).toBe(202);
	});

	it.each([
		["an empty body", { body: "  " }],
		[
			"an over-long body",
			{ body: "问".repeat(LEAD_INTERRUPT_BODY_MAX_CODE_POINTS + 1) },
		],
		["a malformed founder message id", { founderMessageId: "abc" }],
		["a malformed idempotency key", { idempotencyKey: "short" }],
		["an unknown field", { extra: true }],
	])("rejects %s with 400", async (_label, overrides) => {
		const lease = claimSession();
		ingestFounderQuote();
		const { base } = await start();
		const result = await call(base, `/${SESSION_ID}/lead-interrupts`, {
			method: "POST",
			token: MASTER,
			lease,
			body: request(overrides),
		});
		expect(result).toEqual({
			status: 400,
			body: { error: "invalid_lead_interrupt_request" },
		});
		expect(interruptRows()).toHaveLength(0);
	});

	it("replays the same idempotency key without a second letter, and refuses a changed body", async () => {
		const lease = claimSession();
		ingestFounderQuote();
		const { base } = await start({ ids: [ID_1] });
		const first = await call(base, `/${SESSION_ID}/lead-interrupts`, {
			method: "POST",
			token: MASTER,
			lease,
			body: request(),
		});
		const second = await call(base, `/${SESSION_ID}/lead-interrupts`, {
			method: "POST",
			token: MASTER,
			lease,
			body: request(),
		});
		expect(second).toEqual(first);
		expect(interruptRows()).toHaveLength(1);
		expect(
			store.leadInterrupts
				.listAudit(ID_1)
				.filter((row) => row.event === "requested"),
		).toHaveLength(1);
		expect(
			await call(base, `/${SESSION_ID}/lead-interrupts`, {
				method: "POST",
				token: MASTER,
				lease,
				body: request({ body: "换一句" }),
			}),
		).toEqual({ status: 409, body: { error: "idempotency_conflict" } });
	});

	it("rate-limits an open interrupt to the same Lead and bursts per session", async () => {
		const lease = claimSession();
		ingestFounderQuote();
		const ids = [
			ID_1,
			"li_00000000-0000-4000-8000-000000000002",
			"li_00000000-0000-4000-8000-000000000003",
			"li_00000000-0000-4000-8000-000000000004",
			"li_00000000-0000-4000-8000-000000000005",
		];
		const { base } = await start({
			ids,
			resolveTarget: (project) =>
				project === "flywheel" ? { backend: "claude-code" } : undefined,
		});
		expect(
			(
				await call(base, `/${SESSION_ID}/lead-interrupts`, {
					method: "POST",
					token: MASTER,
					lease,
					body: request(),
				})
			).status,
		).toBe(202);
		expect(
			await call(base, `/${SESSION_ID}/lead-interrupts`, {
				method: "POST",
				token: MASTER,
				lease,
				body: request({ idempotencyKey: "idem-key-0002" }),
			}),
		).toEqual({ status: 409, body: { error: "interrupt_already_open" } });
		for (const [index, lead] of ["lead-b", "lead-c"].entries()) {
			expect(
				(
					await call(base, `/${SESSION_ID}/lead-interrupts`, {
						method: "POST",
						token: MASTER,
						lease,
						body: request({
							targetLeadId: lead,
							idempotencyKey: `idem-key-10${index}`,
						}),
					})
				).status,
			).toBe(202);
		}
		expect(
			await call(base, `/${SESSION_ID}/lead-interrupts`, {
				method: "POST",
				token: MASTER,
				lease,
				body: request({
					targetLeadId: "lead-d",
					idempotencyKey: "idem-key-0200",
				}),
			}),
		).toEqual({ status: 429, body: { error: "interrupt_rate_limited" } });
	});

	it("marks the interrupt failed and returns 502 when enqueue itself throws", async () => {
		const lease = claimSession();
		ingestFounderQuote();
		const { base } = await start({
			mailboxForProject: () => ({
				enqueue: () => {
					throw new Error("disk full");
				},
				inspectDeliveryState: () => ({ kind: "absent_identity" }),
				ack: () => false,
			}),
		});
		expect(
			await call(base, `/${SESSION_ID}/lead-interrupts`, {
				method: "POST",
				token: MASTER,
				lease,
				body: request(),
			}),
		).toEqual({ status: 502, body: { error: "mailbox_unavailable" } });
		expect(store.leadInterrupts.get(ID_1)?.state).toBe("failed");
		expect(
			store.leadInterrupts
				.listAudit(ID_1)
				.map((row) => [row.event, row.detail]),
		).toEqual([
			["requested", null],
			["enqueue_failed", "mailbox_threw"],
		]);
	});

	it("keeps the row requested when segment 3 fails, and the same key completes it (R1#5)", async () => {
		const lease = claimSession();
		ingestFounderQuote();
		const { base } = await start();
		rawDb(
			store,
		).exec(`CREATE TRIGGER fail_lead_interrupt_update BEFORE UPDATE ON lead_interrupts
			BEGIN SELECT RAISE(ABORT, 'state down'); END`);
		expect(
			await call(base, `/${SESSION_ID}/lead-interrupts`, {
				method: "POST",
				token: MASTER,
				lease,
				body: request(),
			}),
		).toEqual({ status: 503, body: { error: "state_commit_failed" } });
		expect(store.leadInterrupts.get(ID_1)?.state).toBe("requested");
		expect(interruptRows()).toHaveLength(1);
		rawDb(store).exec("DROP TRIGGER fail_lead_interrupt_update");
		expect(
			await call(base, `/${SESSION_ID}/lead-interrupts`, {
				method: "POST",
				token: MASTER,
				lease,
				body: request(),
			}),
		).toEqual({ status: 202, body: { interruptId: ID_1, state: "queued" } });
		expect(interruptRows()).toHaveLength(1);
	});

	it.each([
		["ACKED", "delivered", "mailbox_only"],
		["DEAD", "failed", null],
	] as const)(
		"reconciles a replayed requested row whose archived letter is %s (R2#2)",
		async (terminal, expectedState, expectedDisposition) => {
			const lease = claimSession();
			ingestFounderQuote();
			store.leadInterrupts.createRequested({
				interruptId: ID_1,
				initiatorKind: "voice_session",
				initiatorRef: SESSION_ID,
				idempotencyKey: "idem-key-0001",
				requestDigest: (
					await import("../lead-interrupt-contract.js")
				).leadInterruptRequestDigest({
					targetProject: "flywheel",
					targetLeadId: TARGET,
					founderMessageId: FOUNDER_MESSAGE,
					body: "你现在在做什么?",
				}),
				founderMessageId: FOUNDER_MESSAGE,
				targetProject: "flywheel",
				targetLeadId: TARGET,
				targetBackend: "claude-code",
				body: "你现在在做什么?",
				bodyDigest: "b".repeat(64),
				now: NOW,
			});
			const { base } = await start({
				mailboxForProject: () => ({
					enqueue: () => ({ outcome: "archived" }),
					inspectDeliveryState: () => ({
						kind: "archived_terminal",
						state: terminal,
						settledAt: NOW,
						deadReason: null,
						lastError: null,
						createdAt: NOW,
						deliveredAt: null,
						notifiedAt: null,
					}),
					ack: () => true,
				}),
			});
			const result = await call(base, `/${SESSION_ID}/lead-interrupts`, {
				method: "POST",
				token: MASTER,
				lease,
				body: request(),
			});
			expect(result.body).toMatchObject({
				interruptId: ID_1,
				state: expectedState,
			});
			expect(store.leadInterrupts.get(ID_1)).toMatchObject({
				state: expectedState,
				disposition: expectedDisposition,
			});
		},
	);

	it("returns the reply by interrupt id, only to the initiating session", async () => {
		const lease = claimSession();
		ingestFounderQuote();
		const { base } = await start();
		await call(base, `/${SESSION_ID}/lead-interrupts`, {
			method: "POST",
			token: MASTER,
			lease,
			body: request(),
		});
		expect(
			await call(base, `/${SESSION_ID}/lead-interrupts/${ID_1}`, {
				token: MASTER,
				lease,
			}),
		).toEqual({
			status: 200,
			body: {
				interruptId: ID_1,
				state: "queued",
				targetProject: "flywheel",
				targetLeadId: TARGET,
				disposition: null,
				dispositionReason: null,
				reply: null,
				createdAt: NOW,
			},
		});
		store.leadInterrupts.recordReply({
			interruptId: ID_1,
			text: "在改投递循环",
			replyDigest: "c".repeat(64),
			now: "2026-09-25T20:01:00.000Z",
		});
		expect(
			(
				await call(base, `/${SESSION_ID}/lead-interrupts/${ID_1}`, {
					token: MASTER,
					lease,
				})
			).body,
		).toMatchObject({
			state: "replied",
			reply: { text: "在改投递循环", repliedAt: "2026-09-25T20:01:00.000Z" },
		});
		store.leadInterrupts.createRequested({
			interruptId: "li_00000000-0000-4000-8000-000000000009",
			initiatorKind: "voice_session",
			initiatorRef: "10000000-0000-4000-8000-000000000002",
			idempotencyKey: "idem-other",
			requestDigest: "a".repeat(64),
			founderMessageId: FOUNDER_MESSAGE,
			targetProject: "flywheel",
			targetLeadId: TARGET,
			targetBackend: "claude-code",
			body: "x",
			bodyDigest: "b".repeat(64),
			now: NOW,
		});
		expect(
			await call(
				base,
				`/${SESSION_ID}/lead-interrupts/li_00000000-0000-4000-8000-000000000009`,
				{ token: MASTER, lease },
			),
		).toEqual({ status: 404, body: { error: "lead_interrupt_not_found" } });
	});
});

describe("FLY-2883 lead interrupt target resolver", () => {
	const projects = [
		{
			projectName: "flywheel",
			projectRoot: "/tmp/flywheel",
			leads: [
				{ agentId: "claude-lead", chatChannel: "1", match: { labels: [] } },
				{
					agentId: "codex-lead",
					chatChannel: "2",
					match: { labels: [] },
					backend: "codex-app-server" as const,
				},
			],
		},
	] as unknown as Parameters<typeof createProjectLeadTargetResolver>[0];

	it("resolves registered Leads with their effective backend", () => {
		const resolve = createProjectLeadTargetResolver(projects, {});
		expect(resolve("flywheel", "claude-lead")).toEqual({
			backend: "claude-code",
		});
		expect(resolve("flywheel", "codex-lead")).toEqual({
			backend: "codex-app-server",
		});
	});

	it("never resolves a runner execution id, an unknown Lead, or another project", () => {
		const resolve = createProjectLeadTargetResolver(projects, {});
		expect(resolve("flywheel", "f47244ad-a700-4807-b836-4287cfb2c4bd")).toBe(
			undefined,
		);
		expect(resolve("flywheel", "nobody")).toBeUndefined();
		expect(resolve("other", "claude-lead")).toBeUndefined();
	});
});
