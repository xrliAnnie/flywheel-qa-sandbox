import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { deriveRunnerStartKey } from "flywheel-comm/runner-start";
export interface MigrationRunEvidence {
	issueId: string;
	runId: string;
	nodeId: string;
	executionId: string;
	activationId: string;
	eventUid: string;
}
/** Reads existing authority only. The source timestamp comes from exact bot REST
 * readback, never from the caller's evidence JSON. Department scope uses the
 * existing canonical resolver supplied by the host entry.
 */
export function verifyMigrationRunEvidence(input: {
	path: string;
	evidence: MigrationRunEvidence;
	source: { channelId: string; messageId: string; at: string };
	belongsToLead(session: {
		project_name: string;
		issue_labels: string | null;
	}): boolean;
}): string {
	const sourceTime = Date.parse(input.source.at);
	if (!Number.isFinite(sourceTime) || !isAbsolute(input.path))
		throw Error("invalid migration source evidence");
	const stat = lstatSync(input.path);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw Error("invalid migration evidence database");
	const { evidence: e, source } = input;
	const key = deriveRunnerStartKey({
		projectName: "flywheel",
		leadId: "flywheel-product-lead",
		issueId: e.issueId,
		idempotencyKey: `discord:${source.channelId}:${source.messageId}`,
	}).key;
	const db = new Database(input.path, { readonly: true, fileMustExist: true });
	try {
		const rows = db
			.prepare(`SELECT r.created_at AS reserved_at, w.created_at AS run_at,
   n.started_at AS node_at, b.bound_at, t.granted_at,
   s.project_name, s.issue_labels, ev.payload, ev.at AS delivered_at
   FROM workflow_start_reservation r
   JOIN workflow_run w ON w.run_id=r.run_id AND w.project_name='flywheel'
   JOIN workflow_run_node n ON n.run_id=r.run_id AND n.node_id=r.node_id AND n.attempt=r.attempt AND n.execution_id=r.execution_id
   JOIN workflow_execution_binding b ON b.run_id=r.run_id AND b.node_id=r.node_id AND b.attempt=r.attempt AND b.execution_id=r.execution_id
   JOIN workflow_activation_turn t ON t.activation_id=b.activation_id AND t.execution_id=r.execution_id AND t.issue_id=w.issue_id
   JOIN sessions s ON s.execution_id=r.execution_id AND s.issue_id=w.issue_id AND s.project_name=w.project_name
   JOIN workflow_run_event ev ON ev.run_id=r.run_id AND ev.node_id=r.node_id AND ev.execution_id=r.execution_id AND ev.kind='issue_delivery'
   WHERE r.idempotency_key=? AND r.run_id=? AND r.node_id=? AND r.execution_id=?
    AND b.activation_id=? AND ev.event_uid=? AND (s.issue_identifier=? OR s.issue_id=?)`)
			.all(
				key,
				e.runId,
				e.nodeId,
				e.executionId,
				e.activationId,
				e.eventUid,
				e.issueId,
				e.issueId,
			) as Array<{
			reserved_at: string;
			run_at: string;
			node_at: string;
			bound_at: string;
			granted_at: string;
			delivered_at: string;
			project_name: string;
			issue_labels: string | null;
			payload: string;
		}>;
		if (rows.length !== 1)
			throw Error("migration run evidence chain missing or ambiguous");
		const row = rows[0]!;
		if (!input.belongsToLead(row))
			throw Error("migration runner scope mismatch");
		for (const at of [
			row.reserved_at,
			row.run_at,
			row.node_at,
			row.bound_at,
			row.granted_at,
			row.delivered_at,
		]) {
			// SQLite datetime('now') is UTC but omits a zone. Never use host local time.
			const ms = Date.parse(
				/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(at)
					? at.replace(" ", "T") + "Z"
					: at,
			);
			if (!Number.isFinite(ms) || ms <= sourceTime)
				throw Error("migration dispatch predates source");
		}
		const payload = JSON.parse(row.payload);
		if (
			payload?.sourceKind !== "authoritative" ||
			payload.activationId !== e.activationId ||
			typeof payload.body !== "string" ||
			typeof payload.bodyDigest !== "string" ||
			createHash("sha256").update(payload.body).digest("hex") !==
				payload.bodyDigest
		)
			throw Error("migration issue delivery body unproven");
		return createHash("sha256")
			.update(
				JSON.stringify({
					key,
					e,
					source,
					bodyDigest: payload.bodyDigest,
					at: row.delivered_at,
				}),
			)
			.digest("hex");
	} finally {
		db.close();
	}
}

/** Exact readback only; never sends a Discord message or follows a redirect. */
export async function verifyMigrationSource(input: {
	channelId: string;
	messageId: string;
	founderId: string;
	botUserId: string;
	botToken: string;
	request?: typeof fetch;
}): Promise<{ channelId: string; messageId: string; at: string }> {
	const snowflake = /^[1-9][0-9]{16,19}$/;
	if (
		![input.channelId, input.messageId, input.founderId, input.botUserId].every(
			(id) => snowflake.test(id),
		) ||
		!input.botToken
	)
		throw Error("migration source identity invalid");
	const response = await (input.request ?? fetch)(
		`https://discord.com/api/v10/channels/${input.channelId}/messages/${input.messageId}`,
		{
			method: "GET",
			headers: { Authorization: `Bot ${input.botToken}` },
			redirect: "error",
			signal: AbortSignal.timeout(5000),
		},
	);
	if (!response.ok || !response.body)
		throw Error("migration source unavailable");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 131072) throw Error("migration source response too large");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	const m = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (
		m?.id !== input.messageId ||
		m.channel_id !== input.channelId ||
		m.author?.id !== input.founderId ||
		m.author?.bot === true ||
		!Array.isArray(m.mentions) ||
		!m.mentions.some(
			(v: unknown) =>
				v !== null &&
				typeof v === "object" &&
				"id" in v &&
				v.id === input.botUserId,
		) ||
		typeof m.timestamp !== "string" ||
		!Number.isFinite(Date.parse(m.timestamp))
	)
		throw Error("migration source mention unproven");
	return {
		channelId: input.channelId,
		messageId: input.messageId,
		at: m.timestamp,
	};
}
