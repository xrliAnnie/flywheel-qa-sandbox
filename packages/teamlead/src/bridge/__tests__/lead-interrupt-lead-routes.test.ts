import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { CommDB } from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { LEAD_INTERRUPT_REPLY_MAX_CODE_POINTS } from "../lead-interrupt-contract.js";
import {
	createLeadInterruptLeadRouter,
	type LeadInterruptMailbox,
	leadInterruptEnqueueInput,
} from "../lead-interrupt-routes.js";

const NOW = "2026-09-25T20:00:00.000Z";
const TARGET = "flywheel-eng-lead";
const ID_1 = "li_00000000-0000-4000-8000-000000000001";
const ID_2 = "li_00000000-0000-4000-8000-000000000002";

let server: Server | undefined;
let store: StateStore;
let root: string;
let queue: MailboxQueue;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "fly2883-lead-"));
	store = await StateStore.create(join(root, "teamlead.db"));
	const dbPath = join(root, "comm.db");
	new CommDB(dbPath).close();
	queue = new MailboxQueue(dbPath);
});

afterEach(
	() =>
		new Promise<void>((resolve) => {
			const finish = () => {
				queue.close();
				store.close();
				rmSync(root, { recursive: true, force: true });
				resolve();
			};
			if (!server) return finish();
			server.close(finish);
			server = undefined;
		}),
);

function seed(
	interruptId: string,
	options: {
		targetLeadId?: string;
		state?: "requested" | "queued";
		enqueue?: boolean;
	} = {},
) {
	store.leadInterrupts.createRequested({
		interruptId,
		initiatorKind: "voice_session",
		initiatorRef: "10000000-0000-4000-8000-000000000001",
		idempotencyKey: `idem-${interruptId}`,
		requestDigest: "a".repeat(64),
		founderMessageId: "300000000000000001",
		targetProject: "flywheel",
		targetLeadId: options.targetLeadId ?? TARGET,
		targetBackend: "claude-code",
		body: "你现在在做什么?",
		bodyDigest: "b".repeat(64),
		now: NOW,
	});
	const row = store.leadInterrupts.get(interruptId)!;
	if (options.enqueue ?? true) queue.enqueue(leadInterruptEnqueueInput(row));
	if ((options.state ?? "queued") === "queued") {
		store.leadInterrupts.transition({
			interruptId,
			from: ["requested"],
			to: "queued",
			event: "enqueued",
			now: NOW,
		});
	}
}

async function start(
	options: {
		authorize?: (input: { leadId: string; projectName: string }) => void;
		mailbox?: LeadInterruptMailbox | undefined;
		useDefaultAuthorization?: boolean;
	} = {},
) {
	const authorize = vi.fn(
		options.authorize ??
			((_input: { leadId: string; projectName: string }) => undefined),
	);
	const app = express();
	app.use(express.json());
	app.use(
		"/api/lead-interrupts",
		createLeadInterruptLeadRouter({
			store,
			now: () => NOW,
			mailboxForProject: (project) =>
				project === "flywheel"
					? "mailbox" in options
						? options.mailbox
						: queue
					: undefined,
			...(options.useDefaultAuthorization
				? {
						leadLeaseEnv: {
							FLYWHEEL_PROJECTS_FILE: join(root, "missing-projects.json"),
							HOME: root,
						},
					}
				: { authorizeLeadRequest: authorize }),
		}),
	);
	server = createServer(app);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	return {
		base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lead-interrupts`,
		authorize,
	};
}

async function post(base: string, path: string, body: unknown) {
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.json() };
}

const identity = {
	project: "flywheel",
	leadId: TARGET,
	identityDigest: "d".repeat(64),
};

describe("FLY-2883 Lead-side interrupt routes", () => {
	it("lists only this Lead's queued/delivered interrupts, with the body", async () => {
		seed(ID_1);
		seed(ID_2, { targetLeadId: "other-lead" });
		seed("li_00000000-0000-4000-8000-000000000003", {
			state: "requested",
			enqueue: false,
		});
		const { base, authorize } = await start();
		expect(await post(base, "/pending/query", identity)).toEqual({
			status: 200,
			body: {
				interrupts: [
					{
						interruptId: ID_1,
						founderMessageId: "300000000000000001",
						body: "你现在在做什么?",
						createdAt: NOW,
						relayedBy: "voice_session",
						notFounderTyped: true,
					},
				],
			},
		});
		expect(authorize).toHaveBeenCalledWith(
			expect.objectContaining({ leadId: TARGET, projectName: "flywheel" }),
		);
	});

	it("refuses a caller that fails Lead write authorization", async () => {
		seed(ID_1);
		const { base } = await start({
			authorize: () => {
				throw new Error("lease mismatch");
			},
		});
		expect(await post(base, "/pending/query", identity)).toEqual({
			status: 403,
			body: { error: "lead_write_unauthorized" },
		});
		expect(
			await post(base, `/${ID_1}/reply`, { ...identity, text: "x" }),
		).toEqual({ status: 403, body: { error: "lead_write_unauthorized" } });
		expect(store.leadInterrupts.get(ID_1)?.state).toBe("queued");
	});

	it("fails closed through the real authorizer when the identity cannot resolve", async () => {
		seed(ID_1);
		const { base } = await start({ useDefaultAuthorization: true });
		expect(await post(base, "/pending/query", identity)).toEqual({
			status: 403,
			body: { error: "lead_write_unauthorized" },
		});
	});

	it("records the reply, acks the held letter, and audits it", async () => {
		seed(ID_1);
		const { base } = await start();
		expect(
			await post(base, `/${ID_1}/reply`, {
				...identity,
				text: "  在改投递循环,五分钟后好  ",
			}),
		).toEqual({
			status: 200,
			body: { interruptId: ID_1, state: "replied", replayed: false },
		});
		expect(store.leadInterrupts.get(ID_1)).toMatchObject({
			state: "replied",
			replyText: "在改投递循环,五分钟后好",
			repliedAt: NOW,
		});
		expect(queue.getById(`lead-interrupt:${ID_1}`)?.state).toBe("ACKED");
		expect(store.leadInterrupts.hasAuditEvent(ID_1, "replied")).toBe(true);
	});

	it("replays the same reply idempotently and retries the ack (R1#2)", async () => {
		seed(ID_1);
		const first = await start({ mailbox: undefined });
		expect(
			(await post(first.base, `/${ID_1}/reply`, { ...identity, text: "好" }))
				.status,
		).toBe(200);
		expect(queue.getById(`lead-interrupt:${ID_1}`)?.state).toBe("QUEUED");
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		server = undefined;
		const second = await start();
		expect(
			await post(second.base, `/${ID_1}/reply`, { ...identity, text: "好" }),
		).toEqual({
			status: 200,
			body: { interruptId: ID_1, state: "replied", replayed: true },
		});
		expect(queue.getById(`lead-interrupt:${ID_1}`)?.state).toBe("ACKED");
		expect(
			await post(second.base, `/${ID_1}/reply`, { ...identity, text: "改口" }),
		).toEqual({ status: 409, body: { error: "already_replied" } });
	});

	it("refuses a reply from a Lead that is not the target", async () => {
		seed(ID_1);
		const { base } = await start();
		expect(
			await post(base, `/${ID_1}/reply`, {
				...identity,
				leadId: "other-lead",
				text: "x",
			}),
		).toEqual({ status: 403, body: { error: "not_target_lead" } });
		expect(
			await post(base, `/${ID_1}/reply`, {
				...identity,
				project: "other-project",
				text: "x",
			}),
		).toEqual({ status: 403, body: { error: "not_target_lead" } });
		expect(store.leadInterrupts.get(ID_1)?.state).toBe("queued");
	});

	it("refuses a reply before the letter is in the mailbox, and unknown ids", async () => {
		seed(ID_1, { state: "requested", enqueue: false });
		const { base } = await start();
		expect(
			await post(base, `/${ID_1}/reply`, { ...identity, text: "x" }),
		).toEqual({ status: 409, body: { error: "lead_interrupt_not_replyable" } });
		expect(
			await post(base, `/${ID_2}/reply`, { ...identity, text: "x" }),
		).toEqual({ status: 404, body: { error: "lead_interrupt_not_found" } });
	});

	it.each([
		["empty text", { text: "   " }],
		[
			"over-long text",
			{ text: "好".repeat(LEAD_INTERRUPT_REPLY_MAX_CODE_POINTS + 1) },
		],
		["missing identity digest", { identityDigest: undefined, text: "x" }],
		["an unknown field", { text: "x", extra: 1 }],
	])("rejects %s with 400", async (_label, overrides) => {
		seed(ID_1);
		const { base } = await start();
		expect(
			await post(base, `/${ID_1}/reply`, { ...identity, ...overrides }),
		).toEqual({
			status: 400,
			body: { error: "invalid_lead_interrupt_request" },
		});
	});
});
