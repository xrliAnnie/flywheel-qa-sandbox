import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
		return { status, body: "ok" };
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
		return { status, body: "ok" };
	};
	return { post, calls };
}

function make(opts: { post?: HttpPost; dbPath?: string } = {}) {
	return new CodexOutboundSender({
		bridgeUrl: "http://bridge.local/",
		apiToken: "secret-token",
		projectName: "proj-1",
		channelId: "chan-1",
		dbPath: opts.dbPath ?? ":memory:",
		post: opts.post,
		now: () => 1000,
	});
}

describe("CodexOutboundSender — boundary validation", () => {
	it("requires bridgeUrl, apiToken, projectName, channelId", () => {
		const base = {
			bridgeUrl: "u",
			apiToken: "t",
			projectName: "p",
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
		expect(() => new CodexOutboundSender({ ...base, channelId: "" })).toThrow(
			/channelId/,
		);
	});
});

describe("CodexOutboundSender — enqueue", () => {
	it("returns outboxId = idempotencyKey and dedupes", async () => {
		const sender = make();
		const id1 = await sender.enqueue({
			leadId: "l",
			text: "hi",
			idempotencyKey: "e1:out",
		});
		expect(id1).toBe("e1:out");
		// Duplicate key with different text → same row (original text preserved).
		const id2 = await sender.enqueue({
			leadId: "l",
			text: "changed",
			idempotencyKey: "e1:out",
		});
		expect(id2).toBe("e1:out");
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
