import { createHash } from "node:crypto";
import { parseChatDeliveryEnvelope } from "flywheel-comm/discord-chat-ingest";
import type { MailboxRow } from "flywheel-comm/mailbox-queue";
import type { StateStore } from "../StateStore.js";
import { AUTOMATED_MESSAGE_PREFIX } from "./automated-message.js";
import { storeLeadAlertWakeDedupEnabled } from "./flag-store-runtime.js";
import type { LeadInboxLoopOptions } from "./lead-inbox-loop.js";

export interface ParsedAlertWake {
	carrier: "infra_alert" | "discord_chat";
	kind: string;
	title: string;
	severity: "info" | "warning" | "severe";
	categoryKey: string;
	categoryTitle: string;
	fingerprint: string | null;
	messageId?: string;
}
export const ALERT_WAKE_WINDOW_MS = 6 * 60 * 60 * 1000;
const ISO_TIME =
	/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g;
const TRUNCATED = /仅列前\s*\d+|[.…]+\s*共\s*\d+\s*个|\(\+\d+ more\)/;
const INFO_WAKE_KINDS = new Set(["flag_scan_handoff"]);
const SEVERITY_RANK = { info: 0, warning: 1, severe: 2 } as const;
function hash(parts: string[]): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function categoryTitle(title: string): string {
	return title
		.replace(ISO_TIME, "<time>")
		.replace(/\b[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\b/gi, "<uuid>")
		.replace(/\b[\da-f]{16,}\b/gi, "<hex>")
		.replace(/\b[A-Z][A-Z0-9]*-\d+\b/g, "<issue>")
		.replace(/\d+/g, "<n>");
}

/** Recognize only the two established carriers. Unknown shapes keep normal delivery. */
export function parseAlertWake(
	row: MailboxRow,
	leadId: string,
	dispatcherId: string | null,
): ParsedAlertWake | null {
	if (row.recipient_kind !== "lead" || row.to_agent !== leadId) return null;
	let carrier: ParsedAlertWake["carrier"];
	let kind: string;
	let title: string;
	let severity: ParsedAlertWake["severity"];
	let body: string[];
	let context = "";
	let messageId: string | undefined;
	if (
		row.source_kind === "infra_alert" &&
		row.content.startsWith("[infra_alert] ")
	) {
		const lines = row.content.split("\n");
		const tail = lines.at(-1) ?? "";
		const event = /(?:^| )event=([\w.-]+)(?: |$)/.exec(tail)?.[1];
		const level = /(?:^| )severity=(info|warning|severe)(?: |$)/.exec(
			tail,
		)?.[1];
		if (!event || !level || lines.length < 2) return null;
		carrier = "infra_alert";
		kind = event;
		severity = level as ParsedAlertWake["severity"];
		title = lines[0]!.slice("[infra_alert] ".length);
		body = lines.slice(1, -1);
		// The metadata line may carry the only object identity. Retain every
		// field except the kind/severity already represented by the policy.
		context = tail
			.split(" ")
			.filter((part) => !/^(event|severity)=/.test(part))
			.join(" ");
	} else if (row.type === "discord_chat" && dispatcherId) {
		let envelope: ReturnType<typeof parseChatDeliveryEnvelope>;
		try {
			envelope = parseChatDeliveryEnvelope(row.content);
		} catch {
			return null;
		}
		if (
			!envelope ||
			envelope.authorId !== dispatcherId ||
			envelope.leadId !== leadId ||
			typeof envelope.text !== "string" ||
			typeof envelope.messageId !== "string"
		)
			return null;
		const lines = envelope.text.split("\n");
		const firstLine = lines[0] ?? "";
		const header =
			/^(?:<@!?\d+> )?(🚨|⚠️|ℹ️) \*\*(.+)\*\* \(([^\s/]+) \/ ([\w.-]+)\)$/.exec(
				firstLine.startsWith(AUTOMATED_MESSAGE_PREFIX)
					? firstLine.slice(AUTOMATED_MESSAGE_PREFIX.length)
					: firstLine,
			);
		if (!header) return null;
		carrier = "discord_chat";
		title = header[2]!;
		kind = header[4]!;
		severity =
			header[1] === "🚨" ? "severe" : header[1] === "⚠️" ? "warning" : "info";
		context = header[3]!;
		body = lines.slice(1).filter((line) => !line.startsWith("🎫 "));
		messageId = envelope.messageId;
	} else return null;
	if (!title) return null;
	const signature =
		carrier === "infra_alert" && kind === "zombie_session_backlog"
			? /^zombie-backlog:([a-f0-9]{16}):\d+$/.exec(row.source_ref ?? "")?.[1]
			: undefined;
	let fingerprint: string | null = null;
	if (signature) fingerprint = hash([kind, title, context, signature]);
	else if (!TRUNCATED.test(body.join("\n"))) {
		const canonical = body.map((line) => {
			let value = line.replace(ISO_TIME, "<time>");
			if (kind === "cmux_watcher_stalled")
				value = value.replace(
					/\b(heartbeat_age_ms|event_age_ms)=[\d.]+/g,
					"$1=<age>",
				);
			return value;
		});
		fingerprint = hash([kind, title, context, ...canonical]);
	}
	const normalized = categoryTitle(title);
	return {
		carrier,
		kind,
		title,
		severity,
		categoryKey: JSON.stringify([kind, normalized]),
		categoryTitle: normalized,
		fingerprint,
		...(messageId ? { messageId } : {}),
	};
}

export function decideAlertWake(input: {
	alert: ParsedAlertWake;
	record?: {
		windowStartedAt: string;
		maxSeverity: number;
		ticketGeneration: string | null;
	};
	ticketGeneration: string | null;
	now: number;
}): { action: "wake" | "suppress" | "digest"; reason: string } {
	const { alert, record, ticketGeneration, now } = input;
	if (alert.severity === "info" && !INFO_WAKE_KINDS.has(alert.kind))
		return { action: "digest", reason: "alert_info_digest" };
	if (!alert.fingerprint || !ticketGeneration)
		return { action: "wake", reason: "unprovable" };
	if (!record) return { action: "wake", reason: "no_delivered_equivalent" };
	if (now - Date.parse(record.windowStartedAt) > ALERT_WAKE_WINDOW_MS)
		return { action: "wake", reason: "window_expired" };
	if (SEVERITY_RANK[alert.severity] > record.maxSeverity)
		return { action: "wake", reason: "severity_up" };
	if (ticketGeneration !== record.ticketGeneration)
		return { action: "wake", reason: "new_ticket_generation" };
	return { action: "suppress", reason: "alert_equivalent_delivered" };
}

type WakeVerdict = Awaited<
	ReturnType<NonNullable<LeadInboxLoopOptions["revalidateModel"]>>
>;
interface AlertWakeDedupOptions {
	store: StateStore;
	dispatcherUserId: () => string | null;
	isEnabled?: (projectName: string) => boolean;
	now?: () => Date;
}

/** Only a successful adapter receipt can establish evidence used for suppression. */
export class AlertWakeDedup {
	unrecognized = 0;
	private readonly batches = new Map<
		string,
		{ id: string; wakes: Map<string, string>; digestAttached: boolean }
	>();
	constructor(private readonly opts: AlertWakeDedupOptions) {}

	private parse(row: MailboxRow, leadId: string): ParsedAlertWake | null {
		return parseAlertWake(row, leadId, this.opts.dispatcherUserId());
	}
	private generation(row: MailboxRow, alert: ParsedAlertWake): string | null {
		return alert.carrier === "infra_alert"
			? (this.opts.store.getAlertWakeLetter(row.delivery_id)
					?.canonicalEventId ?? null)
			: (this.opts.store.getAlertThreadByRootMessageId(alert.messageId!)
					?.event_id ?? null);
	}

	revalidate(
		row: MailboxRow,
		leadId: string,
		projectName: string,
	): WakeVerdict | null {
		// ACK-lease expiry creates a new batch without increasing retry_count.
		// Preserve its delivery/ACK obligation and already-materialized content.
		if (row.lease_retry_count > 0) return null;
		let enabled = false;
		try {
			enabled = this.opts.isEnabled
				? this.opts.isEnabled(projectName)
				: storeLeadAlertWakeDedupEnabled(
						{ store: this.opts.store },
						projectName,
					);
		} catch {
			/* No evidence reads or writes when flag authority is unavailable. */
		}
		if (!enabled) return null;
		const alert = this.parse(row, leadId);
		if (!alert) {
			this.unrecognized += 1;
			return null;
		}
		const now = (this.opts.now?.() ?? new Date()).getTime();
		const nowIso = new Date(now).toISOString();
		const infoOnly =
			alert.severity === "info" && !INFO_WAKE_KINDS.has(alert.kind);
		const ticketGeneration = infoOnly ? null : this.generation(row, alert);
		const record =
			!infoOnly && alert.fingerprint
				? this.opts.store.getAlertWakeDedupRecord(leadId, alert.fingerprint)
				: undefined;
		const decision = decideAlertWake({ alert, record, ticketGeneration, now });
		const identity = {
			leadId,
			projectName,
			eventType: alert.kind,
			categoryKey: alert.categoryKey,
			categoryTitle: alert.categoryTitle,
		};
		if (decision.action === "digest" || decision.action === "suppress") {
			const fingerprint =
				decision.action === "digest"
					? `info:${hash([alert.categoryKey])}`
					: alert.fingerprint!;
			if (decision.action === "digest")
				this.opts.store.bumpAlertWakeInfo({ ...identity, fingerprint, nowIso });
			else if (
				!this.opts.store.bumpAlertWakeSuppressed({
					leadId,
					fingerprint,
					nowIso,
				})
			)
				throw new Error("alert wake evidence disappeared before accounting");
			return {
				deliver: false,
				disposition: "audit_only",
				settle: "acked",
				auditDecision: {
					policyVersion: "alert-wake-dedup-v1",
					reason: decision.reason,
					decidedAt: nowIso,
					proofRef:
						decision.action === "digest"
							? `alert-dedup:${leadId}:info:${hash([alert.categoryKey])}`
							: `alert-dedup:${leadId}:${fingerprint.slice(0, 16)}:${record!.deliveredDeliveryId}`,
				},
			};
		}
		const batchId = row.batch_id ?? row.delivery_id;
		let batch = this.batches.get(leadId);
		if (!batch || batch.id !== batchId) {
			batch = { id: batchId, wakes: new Map(), digestAttached: false };
			this.batches.set(leadId, batch);
		}
		const counts = this.opts.store.sumAlertWakeCategory(
			leadId,
			alert.categoryKey,
			new Date(now - ALERT_WAKE_WINDOW_MS).toISOString(),
		);
		const pending = [...batch.wakes.entries()].filter(
			([id, category]) =>
				id !== row.delivery_id && category === alert.categoryKey,
		).length;
		const occurrences = counts.occurrences + pending + 1;
		batch.wakes.set(row.delivery_id, alert.categoryKey);
		let deliveryContent = row.delivery_content ?? row.content;
		if (occurrences >= 2) {
			const reasons: Record<string, string> = {
				no_delivered_equivalent:
					"内容与已送达的不同（对象、处理要求或数量变了）",
				window_expired: "超过 6 小时",
				severity_up: "级别升高",
				new_ticket_generation: "工单重开",
				unprovable: "无法证明与已送达的相同",
			};
			deliveryContent += `\n\n[告警合并] 同类告警 6 小时内第 ${occurrences} 次，其中 ${counts.suppressed} 次与已送达的告警完全相同、已合并未叫醒你；这次叫醒原因：${reasons[decision.reason]}。`;
		}
		if (!batch.digestAttached) {
			batch.digestAttached = true;
			const digest = this.opts.store.takeAlertWakeDigest(leadId, 10);
			if (digest.total > 0) {
				const lines = digest.entries.map(
					(entry) =>
						`- ×${entry.digestPending} ${entry.eventType} · ${entry.categoryTitle}（${entry.infoOnly ? "info" : "重复"}）`,
				);
				if (digest.remainingCategories > 0)
					lines.push(
						`…（其余 ${digest.remainingCategories} 类见 GET /duty/alert-board 的 wakeDedup）`,
					);
				deliveryContent = `[告警摘要] 上次告警叫醒以来，有 ${digest.total} 条告警没有叫醒你（重复 = 与已送达告警完全相同；info = 通知）：\n${lines.join("\n")}\n\n${deliveryContent}`;
			}
		}
		return { deliver: true, deliveryContent };
	}

	recordDelivered(row: MailboxRow, leadId: string, projectName: string): void {
		try {
			const alert = this.parse(row, leadId);
			if (!alert?.fingerprint) return;
			const ticketGeneration = this.generation(row, alert);
			if (!ticketGeneration) return;
			this.opts.store.recordAlertWakeDelivered({
				leadId,
				fingerprint: alert.fingerprint,
				projectName,
				eventType: alert.kind,
				categoryKey: alert.categoryKey,
				categoryTitle: alert.categoryTitle,
				deliveryId: row.delivery_id,
				severityRank: SEVERITY_RANK[alert.severity],
				ticketGeneration,
				nowIso: (this.opts.now?.() ?? new Date()).toISOString(),
				sourceKind: alert.carrier,
			});
		} catch (error) {
			console.warn(
				`[alert-wake-dedup] delivered evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
