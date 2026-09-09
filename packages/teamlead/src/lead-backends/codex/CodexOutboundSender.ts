/**
 * FLY-224 Phase 4b(2/3) — CodexOutboundSender: the real `OutboundSender`
 * (plan §6.4, Phase 0A §4) that delivers a Codex Lead's replies through the
 * canonical Bridge endpoint (`POST /api/lead-outbound/send`).
 *
 * Correctness model (Codex Phase-4b(2/3) review R1+R2 — stated HONESTLY, no
 * over-claim of exactly-once):
 *   - The reply is NEVER LOST: a DURABLE OUTBOX (better-sqlite3, one row per
 *     reply) — `enqueue` is idempotent on `idempotencyKey`, and a crash between
 *     enqueue and deliver is recoverable because `deliver(outboxId)` reads the
 *     persisted row.
 *   - `deliver` is locally idempotent (a row already `sent` is a no-op) and
 *     DURABLY RETRYABLE: a non-2xx / transport error leaves the row `pending` and
 *     throws. It is NOT a self-driving retry loop — the LeadInputRouter marks the
 *     entry `ambiguous` (human/recovery decides), so the reply is "retryable", not
 *     "auto-resent".
 *   - DEDUP is best-effort-strong, NOT unconditional exactly-once: every request
 *     carries a stable `idempotencyKey` so the Bridge can dedup, plus a
 *     deterministic `nonce` (Discord `enforce_nonce`, in-window). A repeat within
 *     either guard is deduped. TRUE exactly-once across an arbitrary-delay BRIDGE
 *     crash — Bridge sent to Discord but crashed BEFORE persisting the result, and
 *     the client retries after the nonce window — is NOT guaranteed by this client
 *     and is fundamentally NOT achievable without permanent downstream idempotency.
 *
 * Paired server piece (runtime/Bridge sub-chunk, NOT here) — REQUIRED to close the
 * crash gap above: the `/api/lead-outbound/send` route must (a) apiToken-guard,
 * (b) resolve the per-Lead Discord token server-side, (c) persist an
 * idempotencyKey→result record ATOMICALLY enough with the Discord send (or via
 * permanent downstream idempotency), and (d) when it cannot PROVE whether the
 * prior send succeeded, surface `ambiguous` rather than blind-resend.
 *
 * The HTTP transport is injected so this is UNIT-TESTED ONLY (Phase-4b guardrail)
 * — never a real Bridge.
 */

import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { OutboundSender } from "./LeadInputRouter.js";
import type { ProbeResult } from "./outbound-preflight.js";

/** Injectable HTTP transport (default: global fetch). Tests pass a fake. */
export type HttpPost = (req: {
	url: string;
	headers: Record<string, string>;
	body: string;
	signal?: AbortSignal;
}) => Promise<{ status: number; body: string }>;

const defaultPost: HttpPost = async (req) => {
	const res = await fetch(req.url, {
		method: "POST",
		headers: req.headers,
		body: req.body,
		signal: req.signal,
	});
	return { status: res.status, body: await res.text() };
};

interface OutboxRow {
	outbox_id: string;
	idempotency_key: string;
	lead_id: string;
	text: string;
	nonce: string;
	channel_id: string;
	status: string;
	message_id: string | null;
	created_at: number;
	updated_at: number;
}

export interface CodexOutboundSenderOptions {
	bridgeUrl: string;
	apiToken: string;
	/** The Lead's project — scopes (projectName, leadId) server-side so a reused
	 * agentId across projects can't impersonate (FLY-224 review). */
	projectName: string;
	/** Stable Lead identity used by the authorization-only startup probe. */
	leadId: string;
	/** Discord channel the Lead replies in (the Lead's chat channel). */
	channelId: string;
	/** SQLite path for the durable outbox, or ":memory:" for tests. */
	dbPath: string;
	post?: HttpPost;
	now?: () => number;
	probeTimeoutMs?: number;
	/** Confirmed sends with identical content may allocate a new business event
	 * after this window. Pending/ambiguous sends never rotate automatically. */
	proactiveEventIdTtlMs?: number;
}

export class CodexOutboundSender implements OutboundSender {
	private readonly db: Database.Database;
	private readonly bridgeUrl: string;
	private readonly apiToken: string;
	private readonly projectName: string;
	private readonly leadId: string;
	private readonly channelId: string;
	private readonly post: HttpPost;
	private readonly now: () => number;
	private readonly probeTimeoutMs: number;
	private readonly proactiveEventIdTtlMs: number;

	constructor(opts: CodexOutboundSenderOptions) {
		// Validate at the boundary — these are required for any real delivery.
		if (!opts.bridgeUrl)
			throw new Error("CodexOutboundSender: bridgeUrl required");
		if (!opts.apiToken)
			throw new Error("CodexOutboundSender: apiToken required");
		if (!opts.projectName)
			throw new Error("CodexOutboundSender: projectName required");
		if (!opts.leadId) throw new Error("CodexOutboundSender: leadId required");
		if (!opts.channelId)
			throw new Error("CodexOutboundSender: channelId required");
		this.bridgeUrl = opts.bridgeUrl.replace(/\/+$/, "");
		this.apiToken = opts.apiToken;
		this.projectName = opts.projectName;
		this.leadId = opts.leadId;
		this.channelId = opts.channelId;
		this.post = opts.post ?? defaultPost;
		this.now = opts.now ?? (() => Date.now());
		this.probeTimeoutMs = opts.probeTimeoutMs ?? 5_000;
		this.proactiveEventIdTtlMs = opts.proactiveEventIdTtlMs ?? 60_000;
		if (
			!Number.isSafeInteger(this.proactiveEventIdTtlMs) ||
			this.proactiveEventIdTtlMs <= 0
		) {
			throw new Error(
				"CodexOutboundSender: proactiveEventIdTtlMs must be a positive integer",
			);
		}
		this.db = new Database(opts.dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS outbox (
				outbox_id TEXT PRIMARY KEY,
				idempotency_key TEXT UNIQUE NOT NULL,
				lead_id TEXT NOT NULL,
				text TEXT NOT NULL,
				nonce TEXT NOT NULL,
				 channel_id TEXT NOT NULL,
				 status TEXT NOT NULL,
				 message_id TEXT,
				 created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS proactive_event_id (
				request_digest TEXT PRIMARY KEY,
				event_id TEXT UNIQUE NOT NULL,
				created_at INTEGER NOT NULL
			);
		`);
		const columns = this.db
			.prepare("PRAGMA table_info(outbox)")
			.all() as Array<{ name: string }>;
		if (!columns.some((column) => column.name === "message_id")) {
			this.db.exec("ALTER TABLE outbox ADD COLUMN message_id TEXT");
		}
	}

	close(): void {
		this.db.close();
	}

	/**
	 * Allocate the trusted event id used by model calls that omit an explicit
	 * business key. The mapping is persisted before enqueue/delivery, so a
	 * same-payload retry (including after process restart or an ambiguous send)
	 * reuses the exact Bridge idempotency key instead of minting a blind retry.
	 * A confirmed send rotates after the bounded in-process dedup window so later
	 * legitimate repeated text is deliverable; pending/ambiguous rows never rotate.
	 * Only the payload digest is retained here; the outbox owns the message body.
	 */
	allocateEventId(target: string, text: string): string {
		const requestDigest = createHash("sha256")
			.update(this.projectName)
			.update("\0")
			.update(this.leadId)
			.update("\0")
			.update(target)
			.update("\0")
			.update(text)
			.digest("hex");
		return this.db.transaction(() => {
			const now = this.now();
			const row = this.db
				.prepare(
					"SELECT event_id, created_at FROM proactive_event_id WHERE request_digest = ?",
				)
				.get(requestDigest) as
				| { event_id: string; created_at: number }
				| undefined;
			if (row) {
				const idempotencyKey = `lead-action:${this.projectName}:${this.leadId}:${row.event_id}`;
				const outbox = this.db
					.prepare("SELECT status FROM outbox WHERE idempotency_key = ?")
					.get(idempotencyKey) as { status: string } | undefined;
				if (
					outbox?.status !== "sent" ||
					now - row.created_at < this.proactiveEventIdTtlMs
				) {
					return row.event_id;
				}
			}

			const eventId = randomUUID();
			this.db
				.prepare(
					`INSERT INTO proactive_event_id (request_digest, event_id, created_at)
					 VALUES (?, ?, ?)
					 ON CONFLICT(request_digest) DO UPDATE SET
					   event_id = excluded.event_id,
					   created_at = excluded.created_at`,
				)
				.run(requestDigest, eventId, now);
			return eventId;
		})();
	}

	async probeAuthorization(channelId: string): Promise<ProbeResult> {
		let res: { status: number; body: string };
		try {
			res = await this.post({
				url: `${this.bridgeUrl}/api/lead-outbound/send`,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${this.apiToken}`,
				},
				body: JSON.stringify({
					projectName: this.projectName,
					leadId: this.leadId,
					channelId,
					probe: true,
				}),
				signal: AbortSignal.timeout(this.probeTimeoutMs),
			});
		} catch (error) {
			return {
				state: "unavailable",
				reason: error instanceof Error ? error.message : "transport_error",
			};
		}
		let body: { status?: unknown; reason?: unknown } = {};
		try {
			body = JSON.parse(res.body) as typeof body;
		} catch {}
		const reason =
			typeof body.reason === "string" ? body.reason : "unexpected_response";
		if (res.status === 200 && body.status === "authorized") {
			return { state: "authorized" };
		}
		if (res.status === 403)
			return { state: "unauthorized", status: 403, reason };
		if (res.status === 408 || res.status === 429 || res.status >= 500) {
			return { state: "unavailable", status: res.status, reason };
		}
		return { state: "incompatible", status: res.status, reason };
	}

	/**
	 * Durably enqueue a reply (idempotent on idempotencyKey). Returns the
	 * outboxId. The outboxId IS the idempotencyKey (the router passes a unique
	 * `${entryId}:out`), so re-enqueue after a crash yields the same row + nonce.
	 */
	async enqueue(args: {
		leadId: string;
		text: string;
		idempotencyKey: string;
		channelId?: string;
	}): Promise<string> {
		if (!args.idempotencyKey)
			throw new Error("CodexOutboundSender.enqueue: idempotencyKey required");
		const outboxId = args.idempotencyKey;
		const nonce = deterministicNonce(args.idempotencyKey);
		const ts = this.now();
		// FLY-267: per-message channel override (cross-dept reply), else the default
		// chat channel (byte-compat). Persisted per row so deliver() + recovery target it.
		const channelId = args.channelId ?? this.channelId;
		this.db
			.prepare(
				`INSERT INTO outbox
				 (outbox_id, idempotency_key, lead_id, text, nonce, channel_id, status, created_at, updated_at)
				 VALUES (@outboxId, @idempotencyKey, @leadId, @text, @nonce, @channelId, 'pending', @ts, @ts)
				 ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.run({
				outboxId,
				idempotencyKey: args.idempotencyKey,
				leadId: args.leadId,
				text: args.text,
				nonce,
				channelId,
				ts,
			});
		const row = this.db
			.prepare("SELECT * FROM outbox WHERE idempotency_key = ?")
			.get(args.idempotencyKey) as OutboxRow;
		if (
			row.lead_id !== args.leadId ||
			row.text !== args.text ||
			row.channel_id !== channelId
		) {
			throw new Error(
				`CodexOutboundSender.enqueue: idempotency key conflict for ${args.idempotencyKey}`,
			);
		}
		return outboxId;
	}

	/**
	 * Deliver a previously-enqueued reply via the canonical Bridge endpoint.
	 * Idempotent: a row already `sent` is a no-op. A non-2xx / transport error
	 * leaves the row `pending` and throws (router → ambiguous; retry on recovery).
	 */
	async deliverWithResult(outboxId: string): Promise<{
		messageId?: string;
		deduped: boolean;
	}> {
		const row = this.db
			.prepare("SELECT * FROM outbox WHERE outbox_id = ?")
			.get(outboxId) as OutboxRow | undefined;
		if (!row)
			throw new Error(`CodexOutboundSender.deliver: no outbox ${outboxId}`);
		if (row.status === "sent") {
			return {
				...(row.message_id ? { messageId: row.message_id } : {}),
				deduped: true,
			};
		}
		if (row.status === "ambiguous") {
			throw new Error(
				`CodexOutboundSender.deliver: outbox ${outboxId} is ambiguous; refusing blind retry`,
			);
		}

		let res: Awaited<ReturnType<HttpPost>>;
		try {
			res = await this.post({
				url: `${this.bridgeUrl}/api/lead-outbound/send`,
				headers: {
					"content-type": "application/json",
					// apiToken authorizes the reserved endpoint; never logged.
					authorization: `Bearer ${this.apiToken}`,
				},
				body: JSON.stringify({
					projectName: this.projectName,
					leadId: row.lead_id,
					channelId: row.channel_id,
					text: row.text,
					// Stable dedup key the Bridge persists (idempotencyKey→result) so a
					// repeat returns the prior result instead of re-sending. Closing the
					// Bridge-crash gap (sent-but-not-persisted) is the Bridge route's job
					// (reconcile→ambiguous when unprovable); see the module docstring.
					idempotencyKey: row.idempotency_key,
					// In-window guard only (Discord enforce_nonce); not the cross-crash one.
					nonce: row.nonce,
				}),
			});
		} catch (error) {
			this.db
				.prepare(
					"UPDATE outbox SET status = 'ambiguous', updated_at = @ts WHERE outbox_id = @outboxId AND status = 'pending'",
				)
				.run({ ts: this.now(), outboxId });
			throw new Error(
				`lead-outbound/send transport ambiguous: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		let response: { status?: unknown; messageId?: unknown; reason?: unknown } =
			{};
		try {
			response = JSON.parse(res.body) as typeof response;
		} catch {}
		if (res.status === 409 && response.status === "ambiguous") {
			this.db
				.prepare(
					"UPDATE outbox SET status = 'ambiguous', updated_at = @ts WHERE outbox_id = @outboxId AND status = 'pending'",
				)
				.run({ ts: this.now(), outboxId });
			throw new Error(
				`lead-outbound/send ambiguous: ${typeof response.reason === "string" ? response.reason : "unproven"}`,
			);
		}
		if (res.status < 200 || res.status >= 300) {
			// Leave pending so recovery can retry; surface for ambiguous handling.
			throw new Error(`lead-outbound/send failed: HTTP ${res.status}`);
		}
		if (
			(response.status !== "sent" && response.status !== "deduped") ||
			typeof response.messageId !== "string" ||
			response.messageId.length === 0
		) {
			this.db
				.prepare(
					"UPDATE outbox SET status = 'ambiguous', updated_at = @ts WHERE outbox_id = @outboxId AND status = 'pending'",
				)
				.run({ ts: this.now(), outboxId });
			throw new Error(
				"lead-outbound/send returned an incompatible success body; delivery is ambiguous",
			);
		}
		this.db
			.prepare(
				"UPDATE outbox SET status = 'sent', message_id = @messageId, updated_at = @ts WHERE outbox_id = @outboxId AND status = 'pending'",
			)
			.run({ ts: this.now(), outboxId, messageId: response.messageId });
		return {
			messageId: response.messageId,
			deduped: response.status === "deduped",
		};
	}

	async deliver(outboxId: string): Promise<void> {
		await this.deliverWithResult(outboxId);
	}
}

/** Deterministic Discord nonce from the idempotency key (stable across runs). */
export function deterministicNonce(idempotencyKey: string): string {
	return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
}
