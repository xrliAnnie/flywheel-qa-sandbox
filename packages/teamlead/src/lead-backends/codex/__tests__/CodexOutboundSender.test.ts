import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CodexOutboundSender,
	deterministicNonce,
	type HttpPost,
} from "../CodexOutboundSender.js";

interface Posted {
	url: string;
	headers: Record<string, string>;
	body: string;
}

function fakePost(status = 200): { post: HttpPost; calls: Posted[] } {
	const calls: Posted[] = [];
	const post: HttpPost = async (req) => {
		calls.push(req);
		return {
			status,
			body: JSON.stringify({ status: "sent", messageId: "message-1" }),
		};
	};
	return { post, calls };
}

/** Returns the given statuses in sequence (last repeats) — for retry tests. */
function seqPost(statuses: number[]): { post: HttpPost; calls: Posted[] } {
	const calls: Posted[] = [];
	let i = 0;
	const post: HttpPost = async (req) => {
		calls.push(req);
		const status = statuses[Math.min(i, statuses.length - 1)];
		i += 1;
		return {
			status,
			body: JSON.stringify({ status: "sent", messageId: "message-1" }),
		};
	};
	return { post, calls };
}

function make(
	opts: {
		post?: HttpPost;
		dbPath?: string;
		now?: () => number;
		proactiveEventIdTtlMs?: number;
	} = {},
) {
	return new CodexOutboundSender({
		bridgeUrl: "http://bridge.local/",
		apiToken: "secret-token",
		projectName: "proj-1",
		leadId: "lead-1",
		channelId: "chan-1",
		dbPath: opts.dbPath ?? ":memory:",
		post: opts.post,
		now: opts.now ?? (() => 1000),
		proactiveEventIdTtlMs: opts.proactiveEventIdTtlMs,
	});
}

describe("CodexOutboundSender — boundary validation", () => {
	it("requires bridgeUrl, apiToken, projectName, leadId, channelId", () => {
		const base = {
			bridgeUrl: "u",
			apiToken: "t",
			projectName: "p",
			leadId: "l",
			channelId: "c",
			dbPath: ":memory:",
		};
		expect(() => new CodexOutboundSender({ ...base, bridgeUrl: "" })).toThrow(
			/bridgeUrl/,
		);
		expect(() => new CodexOutboundSender({ ...base, apiToken: "" })).toThrow(
			/apiToken/,
		);
		expect(() => new CodexOutboundSender({ ...base, projectName: "" })).toThrow(
			/projectName/,
		);
		expect(() => new CodexOutboundSender({ ...base, leadId: "" })).toThrow(
			/leadId/,
		);
		expect(() => new CodexOutboundSender({ ...base, channelId: "" })).toThrow(
			/channelId/,
		);
	});
});

describe("CodexOutboundSender — authorization probe (FLY-2442)", () => {
	it.each([
		[200, '{"status":"authorized"}', { state: "authorized" }],
		[
			200,
			'{"status":"sent"}',
			{ state: "incompatible", status: 200, reason: "unexpected_response" },
		],
		[
			400,
			'{"reason":"text_required"}',
			{ state: "incompatible", status: 400, reason: "text_required" },
		],
		[
			401,
			'{"reason":"unauthorized"}',
			{ state: "incompatible", status: 401, reason: "unauthorized" },
		],
		[
			403,
			'{"reason":"lead_channel_unauthorized"}',
			{
				state: "unauthorized",
				status: 403,
				reason: "lead_channel_unauthorized",
			},
		],
		[
			404,
			'{"reason":"not_found"}',
			{ state: "incompatible", status: 404, reason: "not_found" },
		],
		[
			429,
			'{"reason":"rate_limited"}',
			{ state: "unavailable", status: 429, reason: "rate_limited" },
		],
		[
			503,
			'{"reason":"unavailable"}',
			{ state: "unavailable", status: 503, reason: "unavailable" },
		],
	] as const)("maps HTTP %s with body %s", async (status, body, expected) => {
		const calls: Posted[] = [];
		const sender = make({
			post: async (req) => {
				calls.push(req);
				return { status, body };
			},
		});

		await expect(sender.probeAuthorization("roundtable")).resolves.toEqual(
			expected,
		);
		expect(JSON.parse(calls[0]!.body)).toEqual({
			projectName: "proj-1",
			leadId: "lead-1",
			channelId: "roundtable",
			probe: true,
		});
		const row = (
			sender as unknown as {
				db: { prepare(sql: string): { get(): { count: number } } };
			}
		).db
			.prepare("SELECT count(*) AS count FROM outbox")
			.get();
		expect(row.count).toBe(0);
	});

	it("maps malformed bodies and transport failures without throwing", async () => {
		const malformed = make({
			post: async () => ({ status: 200, body: "not-json" }),
		});
		await expect(malformed.probeAuthorization("chan")).resolves.toEqual({
			state: "incompatible",
			status: 200,
			reason: "unexpected_response",
		});

		const failed = make({
			post: async () => Promise.reject(new Error("ECONNRESET")),
		});
		await expect(failed.probeAuthorization("chan")).resolves.toMatchObject({
			state: "unavailable",
			reason: "ECONNRESET",
		});
	});

	it("aborts a probe that exceeds its deadline", async () => {
		const post = vi.fn<HttpPost>(
			(req) =>
				new Promise((_, reject) => {
					if (!req.signal) return reject(new Error("missing abort signal"));
					req.signal.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		const sender = new CodexOutboundSender({
			bridgeUrl: "http://bridge.local",
			apiToken: "token",
			projectName: "proj-1",
			leadId: "lead-1",
			channelId: "chan-1",
			dbPath: ":memory:",
			post,
			probeTimeoutMs: 10,
		});

		await expect(sender.probeAuthorization("chan-1")).resolves.toMatchObject({
			state: "unavailable",
		});
		expect(post).toHaveBeenCalledTimes(1);
	});
});

describe("CodexOutboundSender — enqueue", () => {
	it("allocates one durable event id for the same proactive target and text across reopen", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2445-event-id-"));
		const dbPath = join(dir, "actions.db");
		const first = make({ dbPath });
		const eventId = first.allocateEventId("chat", "same report");
		expect(eventId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		first.close();

		const restarted = make({ dbPath });
		expect(restarted.allocateEventId("chat", "same report")).toBe(eventId);
		expect(restarted.allocateEventId("chat", "different report")).not.toBe(
			eventId,
		);
		restarted.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("rotates a confirmed-sent content allocation after the bounded dedup window", async () => {
		let now = 1_000;
		const { post, calls } = fakePost(200);
		const sender = make({
			post,
			now: () => now,
			proactiveEventIdTtlMs: 60_000,
		});
		const firstEventId = sender.allocateEventId("chat", "done");
		const firstOutboxId = await sender.enqueue({
			leadId: "lead-1",
			text: "done",
			idempotencyKey: `lead-action:proj-1:lead-1:${firstEventId}`,
		});
		await sender.deliver(firstOutboxId);

		now += 10 * 24 * 60 * 60 * 1_000;
		const secondEventId = sender.allocateEventId("chat", "done");
		expect(secondEventId).not.toBe(firstEventId);
		const secondOutboxId = await sender.enqueue({
			leadId: "lead-1",
			text: "done",
			idempotencyKey: `lead-action:proj-1:lead-1:${secondEventId}`,
		});
		await sender.deliver(secondOutboxId);
		expect(calls).toHaveLength(2);
	});

	it("never rotates an ambiguous content allocation after the dedup window", async () => {
		let now = 1_000;
		const calls: Posted[] = [];
		const sender = make({
			now: () => now,
			proactiveEventIdTtlMs: 60_000,
			post: async (req) => {
				calls.push(req);
				return {
					status: 409,
					body: JSON.stringify({
						status: "ambiguous",
						reason: "prior_attempt_unproven",
					}),
				};
			},
		});
		const eventId = sender.allocateEventId("chat", "maybe delivered");
		const outboxId = await sender.enqueue({
			leadId: "lead-1",
			text: "maybe delivered",
			idempotencyKey: `lead-action:proj-1:lead-1:${eventId}`,
		});
		await expect(sender.deliver(outboxId)).rejects.toThrow(/ambiguous/i);

		now += 10 * 24 * 60 * 60 * 1_000;
		expect(sender.allocateEventId("chat", "maybe delivered")).toBe(eventId);
		await expect(sender.deliver(outboxId)).rejects.toThrow(/ambiguous/i);
		expect(calls).toHaveLength(1);
	});

	it("returns outboxId = idempotencyKey and dedupes", async () => {
		const sender = make();
		const id1 = await sender.enqueue({
			leadId: "l",
			text: "hi",
			idempotencyKey: "e1:out",
		});
		expect(id1).toBe("e1:out");
		// Exact duplicate key and payload → same durable row.
		const id2 = await sender.enqueue({
			leadId: "l",
			text: "hi",
			idempotencyKey: "e1:out",
		});
		expect(id2).toBe("e1:out");
	});

	it("rejects reuse of one idempotency key with different content", async () => {
		const sender = make();
		await sender.enqueue({
			leadId: "l",
			text: "original",
			idempotencyKey: "event-1",
		});
		await expect(
			sender.enqueue({
				leadId: "l",
				text: "changed",
				idempotencyKey: "event-1",
			}),
		).rejects.toThrow(/idempotency.*conflict/i);
	});

	it("uses a deterministic nonce (stable across keys/instances)", () => {
		expect(deterministicNonce("e1:out")).toBe(deterministicNonce("e1:out"));
		expect(deterministicNonce("e1:out")).not.toBe(deterministicNonce("e2:out"));
		expect(deterministicNonce("e1:out")).toMatch(/^[0-9a-f]{32}$/);
	});
});

describe("CodexOutboundSender — deliver", () => {
	it("POSTs the canonical payload (url, auth header, nonce) and marks sent", async () => {
		const { post, calls } = fakePost(200);
		const sender = make({ post });
		const id = await sender.enqueue({
			leadId: "lead-a",
			text: "reply!",
			idempotencyKey: "e1:out",
		});
		await sender.deliver(id);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("http://bridge.local/api/lead-outbound/send");
		expect(calls[0].headers.authorization).toBe("Bearer secret-token");
		const body = JSON.parse(calls[0].body);
		expect(body).toEqual({
			projectName: "proj-1",
			leadId: "lead-a",
			channelId: "chan-1",
			text: "reply!",
			// idempotencyKey is the durable dedup key the Bridge persists.
			idempotencyKey: "e1:out",
			nonce: deterministicNonce("e1:out"),
		});
	});

	it("FLY-267: enqueue with channelId routes that reply to THAT channel (else default)", async () => {
		const { post, calls } = fakePost(200);
		const sender = make({ post });
		const routed = await sender.enqueue({
			leadId: "lead-a",
			text: "in roundtable",
			idempotencyKey: "r1:out",
			channelId: "round-table",
		});
		await sender.deliver(routed);
		expect(JSON.parse(calls[0].body).channelId).toBe("round-table");
		const def = await sender.enqueue({
			leadId: "lead-a",
			text: "in chat",
			idempotencyKey: "r2:out",
		});
		await sender.deliver(def);
		expect(JSON.parse(calls[1].body).channelId).toBe("chan-1"); // fallback
	});

	it("is idempotent — a second deliver does not POST again", async () => {
		const { post, calls } = fakePost(200);
		const sender = make({ post });
		const id = await sender.enqueue({
			leadId: "l",
			text: "x",
			idempotencyKey: "e1:out",
		});
		await sender.deliver(id);
		await sender.deliver(id);
		expect(calls).toHaveLength(1);
	});

	it("persists the Bridge message id and returns it after a process restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2445-actions-outbox-"));
		const dbPath = join(dir, "actions.db");
		const { post, calls } = fakePost(200);
		const first = make({ post, dbPath });
		const id = await first.enqueue({
			leadId: "lead-a",
			text: "report",
			idempotencyKey: "summary:7:report",
		});
		await expect(first.deliverWithResult(id)).resolves.toEqual({
			messageId: "message-1",
			deduped: false,
		});
		first.close();
		const restarted = make({ post, dbPath });
		await restarted.enqueue({
			leadId: "lead-a",
			text: "report",
			idempotencyKey: "summary:7:report",
		});
		await expect(restarted.deliverWithResult(id)).resolves.toEqual({
			messageId: "message-1",
			deduped: true,
		});
		expect(calls).toHaveLength(1);
		restarted.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("marks a Bridge ambiguity and never blindly re-posts it", async () => {
		const calls: Posted[] = [];
		const sender = make({
			post: async (req) => {
				calls.push(req);
				return {
					status: 409,
					body: JSON.stringify({
						status: "ambiguous",
						reason: "prior_attempt_unproven",
					}),
				};
			},
		});
		const id = await sender.enqueue({
			leadId: "lead-a",
			text: "report",
			idempotencyKey: "summary:8:report",
		});
		await expect(sender.deliverWithResult(id)).rejects.toThrow(/ambiguous/i);
		await expect(sender.deliverWithResult(id)).rejects.toThrow(/ambiguous/i);
		expect(calls).toHaveLength(1);
	});

	it("throws on a non-2xx response and leaves the row pending", async () => {
		const { post } = fakePost(503);
		const sender = make({ post });
		const id = await sender.enqueue({
			leadId: "l",
			text: "x",
			idempotencyKey: "e1:out",
		});
		await expect(sender.deliver(id)).rejects.toThrow(/HTTP 503/);
		const row = (
			sender as unknown as {
				db: {
					prepare: (s: string) => { get: (k: string) => { status: string } };
				};
			}
		).db
			.prepare("SELECT status FROM outbox WHERE outbox_id = ?")
			.get(id);
		expect(row.status).toBe("pending");
	});

	it("retries a pending row after a transient failure — same idempotencyKey/nonce both times (Bridge dedups)", async () => {
		// At-least-once client: first POST fails (503), a later deliver re-POSTs
		// the SAME idempotencyKey + nonce so the Bridge's durable dedup makes it
		// exactly-once. Proves cross-attempt key stability (CR MED-3).
		const { post, calls } = seqPost([503, 200]);
		const sender = make({ post });
		const id = await sender.enqueue({
			leadId: "l",
			text: "x",
			idempotencyKey: "e1:out",
		});
		await expect(sender.deliver(id)).rejects.toThrow(/HTTP 503/); // attempt 1
		await sender.deliver(id); // attempt 2 succeeds
		expect(calls).toHaveLength(2);
		const b0 = JSON.parse(calls[0].body);
		const b1 = JSON.parse(calls[1].body);
		expect(b0.idempotencyKey).toBe("e1:out");
		expect(b1.idempotencyKey).toBe("e1:out"); // SAME key → Bridge dedups
		expect(b1.nonce).toBe(b0.nonce); // SAME nonce
		// Now marked sent → a third deliver is a no-op.
		await sender.deliver(id);
		expect(calls).toHaveLength(2);
	});

	it("throws for an unknown outboxId", async () => {
		const sender = make();
		await expect(sender.deliver("nope")).rejects.toThrow(/no outbox/);
	});
});

describe("CodexOutboundSender — durable across reopen", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly224-outbox-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("a reply enqueued before a crash can be delivered after reopen", async () => {
		const path = join(dir, "outbox.db");
		const s1 = make({ dbPath: path });
		await s1.enqueue({
			leadId: "l",
			text: "survives",
			idempotencyKey: "e1:out",
		});
		s1.close(); // simulate crash/restart

		const { post, calls } = fakePost(200);
		const s2 = make({ dbPath: path, post });
		await s2.deliver("e1:out"); // row was persisted → deliver works
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0].body).text).toBe("survives");
		expect(JSON.parse(calls[0].body).nonce).toBe(deterministicNonce("e1:out"));
		s2.close();
	});
});
