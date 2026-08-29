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

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { OutboundSender } from "./LeadInputRouter.js";

/** Injectable HTTP transport (default: global fetch). Tests pass a fake. */
export type HttpPost = (req: {
	url: string;
	headers: Record<string, string>;
	body: string;
}) => Promise<{ status: number; body: string }>;

const defaultPost: HttpPost = async (req) => {
	const res = await fetch(req.url, {
		method: "POST",
		headers: req.headers,
		body: req.body,
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
	created_at: number;
	updated_at: number;
}

export interface CodexOutboundSenderOptions {
	bridgeUrl: string;
	apiToken: string;
	/** The Lead's project — scopes (projectName, leadId) server-side so a reused
	 * agentId across projects can't impersonate (FLY-224 review). */
	projectName: string;
	/** Discord channel the Lead replies in (the Lead's chat channel). */
	channelId: string;
	/** SQLite path for the durable outbox, or ":memory:" for tests. */
	dbPath: string;
	post?: HttpPost;
	now?: () => number;
}

export class CodexOutboundSender implements OutboundSender {
	private readonly db: Database.Database;
	private readonly bridgeUrl: string;
	private readonly apiToken: string;
	private readonly projectName: string;
	private readonly channelId: string;
	private readonly post: HttpPost;
	private readonly now: () => number;

	constructor(opts: CodexOutboundSenderOptions) {
		// Validate at the boundary — these are required for any real delivery.
		if (!opts.bridgeUrl)
			throw new Error("CodexOutboundSender: bridgeUrl required");
		if (!opts.apiToken)
			throw new Error("CodexOutboundSender: apiToken required");
		if (!opts.projectName)
			throw new Error("CodexOutboundSender: projectName required");
		if (!opts.channelId)
			throw new Error("CodexOutboundSender: channelId required");
		this.bridgeUrl = opts.bridgeUrl.replace(/\/+$/, "");
		this.apiToken = opts.apiToken;
		this.projectName = opts.projectName;
		this.channelId = opts.channelId;
		this.post = opts.post ?? defaultPost;
		this.now = opts.now ?? (() => Date.now());
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
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);
	}

	close(): void {
		this.db.close();
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
		return outboxId;
	}

	/**
	 * Deliver a previously-enqueued reply via the canonical Bridge endpoint.
	 * Idempotent: a row already `sent` is a no-op. A non-2xx / transport error
	 * leaves the row `pending` and throws (router → ambiguous; retry on recovery).
	 */
	async deliver(outboxId: string): Promise<void> {
		const row = this.db
			.prepare("SELECT * FROM outbox WHERE outbox_id = ?")
			.get(outboxId) as OutboxRow | undefined;
		if (!row)
			throw new Error(`CodexOutboundSender.deliver: no outbox ${outboxId}`);
		if (row.status === "sent") return; // already delivered — idempotent

		const res = await this.post({
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
		if (res.status < 200 || res.status >= 300) {
			// Leave pending so recovery can retry; surface for ambiguous handling.
			throw new Error(`lead-outbound/send failed: HTTP ${res.status}`);
		}
		this.db
			.prepare(
				"UPDATE outbox SET status = 'sent', updated_at = @ts WHERE outbox_id = @outboxId AND status = 'pending'",
			)
			.run({ ts: this.now(), outboxId });
	}
}

/** Deterministic Discord nonce from the idempotency key (stable across runs). */
export function deterministicNonce(idempotencyKey: string): string {
	return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
}
