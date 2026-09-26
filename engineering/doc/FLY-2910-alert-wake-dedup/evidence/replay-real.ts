/**
 * FLY-2910 production-policy replay. Only opens the source DBs read-only; all
 * counterfactual writes go to fresh in-memory StateStores. No message text is
 * emitted. Run from the repository root with pnpm exec tsx and an authoritative
 * --dispatcher-id, optionally --comm-db/--teamlead-db for managed snapshots.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChatDeliveryEnvelope } from "../../../../packages/flywheel-comm/src/discord-chat-ingest.js";
import type { MailboxRow } from "../../../../packages/flywheel-comm/src/mailbox-queue.js";
import {
	StateStore,
	type AlertThreadRow,
	type AlertWakeLetter,
} from "../../../../packages/teamlead/src/StateStore.js";
import {
	AlertWakeDedup,
	decideAlertWake,
	parseAlertWake,
	type ParsedAlertWake,
} from "../../../../packages/teamlead/src/bridge/alert-wake-dedup.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const require = createRequire(resolve(repo, "packages/teamlead/package.json"));
const Database =
	require("better-sqlite3") as typeof import("better-sqlite3").default;
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
	const key = process.argv[index];
	const value = process.argv[index + 1];
	if (!key?.startsWith("--") || !value)
		throw new Error("Expected --option value");
	args.set(key, value);
}
const dispatcherId = args.get("--dispatcher-id");
assert(
	dispatcherId && /^\d{16,22}$/.test(dispatcherId),
	"--dispatcher-id must be the trusted configured dispatcher identity",
);
const start = new Date(
	args.get("--start") ?? "2026-09-25T07:00:00Z",
).toISOString();
const end = new Date(args.get("--end") ?? "2026-09-26T07:00:00Z").toISOString();
const observedThrough = new Date(
	args.get("--observed-through") ?? end,
).toISOString();
assert(start < observedThrough && observedThrough <= end, "Invalid observed window");
const designEnd = "2026-09-26T04:00:00.000Z";
const project = "flywheel";
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const increment = (record: Record<string, number>, key: string, amount = 1) => {
	record[key] = (record[key] ?? 0) + amount;
};

function envelope(row: MailboxRow) {
	try {
		return parseChatDeliveryEnvelope(row.content);
	} catch {
		return null;
	}
}
function candidate(row: MailboxRow): boolean {
	return (
		(row.source_kind === "infra_alert" &&
			row.content.startsWith("[infra_alert] ")) ||
		(row.type === "discord_chat" && envelope(row)?.authorId === dispatcherId)
	);
}
function correlation(row: MailboxRow, alert: ParsedAlertWake): string {
	if (alert.carrier === "infra_alert") {
		const tail = Object.fromEntries(
			(row.content.split("\n").at(-1) ?? "").split(" ").map((part) => {
				const pos = part.indexOf("=");
				return [part.slice(0, pos), part.slice(pos + 1)];
			}),
		);
		return JSON.stringify([
			tail.project,
			tail.affected ?? tail.owner,
			alert.kind,
			tail.session ?? null,
		]);
	}
	const header = String(envelope(row)?.text ?? "").split("\n")[0] ?? "";
	const affected = /\(([^\s/]+) \/ [\w.-]+\)$/.exec(header)?.[1] ?? "";
	return JSON.stringify(["B", affected, alert.kind, alert.title]);
}

function loadSources() {
	const capturedAt = new Date().toISOString();
	const comm = new Database(
		args.get("--comm-db") ??
			resolve(homedir(), ".flywheel/comm/flywheel/comm.db"),
		{ readonly: true, fileMustExist: true },
	);
	const teamlead = new Database(
		args.get("--teamlead-db") ?? resolve(homedir(), ".flywheel/teamlead.db"),
		{ readonly: true, fileMustExist: true },
	);
	const rows = new Map<string, MailboxRow>();
	const letters = new Map<string, AlertWakeLetter>();
	const threads = new Map<string, AlertThreadRow>();
	const counts: Record<string, number> = {};
	let hasLetterTable = false;
	try {
		comm.pragma("query_only = ON");
		teamlead.pragma("query_only = ON");
		comm.exec("BEGIN");
		teamlead.exec("BEGIN");
		for (const table of ["mailbox_archive", "mailbox"] as const) {
			// Both table identifiers are fixed source-code constants. Every data value is bound.
			const result = comm
				.prepare(
					`SELECT * FROM ${table} WHERE recipient_kind = ? AND created_at >= ? AND created_at < ? ORDER BY created_at, seq LIMIT ?`,
				)
				.all("lead", start, observedThrough, 20_001) as MailboxRow[];
			assert(
				result.length <= 20_000,
				"Replay row limit exceeded; narrow the requested window",
			);
			counts[table] = result.length;
			for (const row of result)
				rows.set(row.delivery_id, {
					...row,
					delivery_disposition: row.delivery_disposition ?? "model",
				});
		}
		hasLetterTable = Boolean(
			teamlead
				.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?")
				.get("table", "alert_wake_letter"),
		);
		for (const row of rows.values()) {
			const alert = parseAlertWake(row, row.to_agent, dispatcherId!);
			if (!alert) continue;
			if (alert.carrier === "infra_alert" && hasLetterTable) {
				const letter = teamlead
					.prepare(
						"SELECT delivery_id AS deliveryId, correlation_key AS correlationKey, canonical_event_id AS canonicalEventId, recorded_at AS recordedAt, evidence_recorded_at AS evidenceRecordedAt FROM alert_wake_letter WHERE delivery_id = ?",
					)
					.get(row.delivery_id) as AlertWakeLetter | undefined;
				if (letter) letters.set(row.delivery_id, letter);
			} else if (alert.messageId) {
				const thread = teamlead
					.prepare(
						"SELECT * FROM alert_threads WHERE root_message_id = ? OR thread_id = ?",
					)
					.get(alert.messageId, alert.messageId) as AlertThreadRow | undefined;
				if (thread) threads.set(alert.messageId, thread);
			}
		}
		comm.exec("COMMIT");
		teamlead.exec("COMMIT");
	} finally {
		comm.close();
		teamlead.close();
	}
	return {
		rows: [...rows.values()].sort(
			(a, b) => a.created_at.localeCompare(b.created_at) || a.seq - b.seq,
		),
		letters,
		threads,
		capturedAt,
		counts,
		hasLetterTable,
	};
}

type Source = ReturnType<typeof loadSources>;
type Mode = "verified" | "hypothetical_same_correlation";
async function replay(source: Source, mode: Mode, through: string) {
	const store = await StateStore.create(":memory:");
	let clock = Date.parse(start);
	const policy = new AlertWakeDedup({
		store,
		dispatcherUserId: () => dispatcherId!,
		isEnabled: () => true,
		now: () => new Date(clock),
	});
	const rows = source.rows.filter((row) => row.created_at < through);
	const groups = new Map<string, MailboxRow[]>();
	const decisions: Array<Record<string, unknown>> = [];
	const proofPairs: Array<Record<string, unknown>> = [];
	const reasons: Record<string, number> = {};
	const perLead: Record<
		string,
		{
			beforeWakeBatches: number;
			afterWakeBatches: number;
			alertLetters: number;
			wake: number;
			suppress: number;
			digest: number;
		}
	> = {};
	const wakeByDelivery = new Set<string>();
	const quietByDelivery = new Set<string>();
	const deliveredProof = new Map<
		string,
		{
			fingerprint: string;
			generation: string;
			deliveredAt: string;
			leadId: string;
		}
	>();
	const keyOf = (row: MailboxRow) =>
		`${row.to_agent}:${row.batch_id ?? `unbatched:${row.delivery_id}`}`;
	let unbatchedAlerts = 0;
	let mixedBatches = 0;
	try {
		for (const row of rows) {
			if (row.delivery_disposition !== "model" || row.carrier !== "inbox")
				continue;
			const key = keyOf(row);
			const group = groups.get(key) ?? [];
			group.push(row);
			groups.set(key, group);
		}
		const events: Array<{
			at: number;
			kind: "decision" | "receipt";
			key: string;
			rows: MailboxRow[];
		}> = [];
		for (const [key, group] of groups) {
			if (!group.some(candidate)) continue;
			const lead = group[0]!.to_agent;
			perLead[lead] ??= {
				beforeWakeBatches: 0,
				afterWakeBatches: 0,
				alertLetters: 0,
				wake: 0,
				suppress: 0,
				digest: 0,
			};
			if (group.some((row) => !candidate(row))) mixedBatches++;
			if (group[0]!.batch_id) perLead[lead].beforeWakeBatches++;
			else unbatchedAlerts += group.filter(candidate).length;
			const decisionAt = Math.min(
				...group.map((row) => Date.parse(row.created_at)),
			);
			// Real receipt time gates evidence; ACKED is the plan's delivered proxy.
			const receiptAt = Math.max(
				decisionAt,
				...group
					.filter((row) => row.state === "ACKED")
					.map((row) =>
						Date.parse(row.delivered_at ?? row.acked_at ?? row.created_at),
					),
			);
			events.push({ at: decisionAt, kind: "decision", key, rows: group });
			events.push({ at: receiptAt, kind: "receipt", key, rows: group });
		}
		events.sort(
			(a, b) =>
				a.at - b.at ||
				(a.kind === b.kind
					? a.key.localeCompare(b.key)
					: a.kind === "decision"
						? -1
						: 1),
		);
		for (const event of events) {
			clock = event.at;
			for (const row of event.rows) {
				if (!candidate(row)) continue;
				const alert = parseAlertWake(row, row.to_agent, dispatcherId!);
				let generation: string | null = null;
				if (alert) {
					if (mode === "hypothetical_same_correlation")
						generation = `hypothetical:${hash(correlation(row, alert))}`;
					else
						generation =
							alert.carrier === "infra_alert"
								? (source.letters.get(row.delivery_id)?.canonicalEventId ??
									null)
								: (source.threads.get(alert.messageId!)?.event_id ?? null);
					if (generation && alert.carrier === "infra_alert")
						store.recordAlertWakeLetter({
							deliveryId: row.delivery_id,
							correlationKey:
								mode === "verified"
									? source.letters.get(row.delivery_id)!.correlationKey!
									: correlation(row, alert),
							canonicalEventId: generation,
							recordedAt: row.created_at,
						});
					if (generation && alert.carrier === "discord_chat")
						store.openAlertThread({
							correlationKey: `replay-root:${alert.messageId}`,
							eventId: generation,
							threadId: alert.messageId!,
							rootMessageId: alert.messageId!,
							channelId: "replay",
							leadId: row.to_agent,
							projectName: project,
							eventType: alert.kind,
						});
				}
				if (event.kind === "receipt") {
					if (row.state === "ACKED" && wakeByDelivery.has(row.delivery_id)) {
						policy.recordDelivered(row, row.to_agent, project);
						if (
							alert?.fingerprint &&
							generation &&
							store.getAlertWakeDedupRecord(row.to_agent, alert.fingerprint)
								?.deliveredDeliveryId === row.delivery_id
						)
							deliveredProof.set(row.delivery_id, {
								fingerprint: alert.fingerprint,
								generation,
								deliveredAt: new Date(clock).toISOString(),
								leadId: row.to_agent,
							});
					}
					continue;
				}
				const prior = alert?.fingerprint
					? store.getAlertWakeDedupRecord(row.to_agent, alert.fingerprint)
					: undefined;
				const decision = !alert
					? { action: "wake", reason: "unrecognized" }
					: row.retry_count > 0 || row.lease_retry_count > 0
						? { action: "wake", reason: "frozen_retry" }
						: decideAlertWake({
								alert,
								record: prior,
								ticketGeneration: generation,
								now: clock,
							});
				const result =
					row.retry_count > 0
						? null
						: policy.revalidate(row, row.to_agent, project);
				const quiet = result !== null && !result.deliver;
				assert.equal(
					quiet,
					decision.action !== "wake",
					"Production revalidation disagreed with pure decision",
				);
				if (quiet) quietByDelivery.add(row.delivery_id);
				else wakeByDelivery.add(row.delivery_id);
				increment(reasons, `${decision.action}:${decision.reason}`);
				const lead = perLead[row.to_agent]!;
				lead.alertLetters++;
				if (decision.action === "suppress") lead.suppress++;
				else if (decision.action === "digest") lead.digest++;
				else lead.wake++;
				decisions.push({
					deliveryId: row.delivery_id,
					batchId: row.batch_id,
					leadId: row.to_agent,
					carrier: alert?.carrier ?? row.source_kind,
					kind: alert?.kind ?? "unrecognized",
					fingerprint: alert?.fingerprint ?? null,
					action: decision.action,
					reason: decision.reason,
					at: new Date(clock).toISOString(),
					generationHash: generation ? hash(generation) : null,
				});
				if (decision.action === "suppress") {
					assert(
						prior?.deliveredDeliveryId && alert?.fingerprint && generation,
					);
					const proof = deliveredProof.get(prior.deliveredDeliveryId);
					assert(
						proof &&
							proof.fingerprint === alert.fingerprint &&
							proof.generation === generation &&
							proof.leadId === row.to_agent,
					);
					assert(
						Date.parse(proof.deliveredAt) <= clock,
						"Suppression used a future receipt",
					);
					proofPairs.push({
						leadId: row.to_agent,
						kind: alert.kind,
						fingerprint: alert.fingerprint,
						suppressedDeliveryId: row.delivery_id,
						deliveredEquivalentDeliveryId: prior.deliveredDeliveryId,
						suppressedAt: new Date(clock).toISOString(),
						deliveredAt: proof.deliveredAt,
						windowStartedAt: prior.windowStartedAt,
						generationHash: hash(generation),
						generationVerified: mode === "verified",
					});
				}
			}
		}
		for (const group of groups.values()) {
			if (!group.some(candidate) || !group[0]!.batch_id) continue;
			if (group.some((row) => !quietByDelivery.has(row.delivery_id)))
				perLead[group[0]!.to_agent]!.afterWakeBatches++;
		}
		return {
			mode,
			windowUtc: [start, through],
			beforeWakeBatches: Object.values(perLead).reduce(
				(sum, lead) => sum + lead.beforeWakeBatches,
				0,
			),
			afterWakeBatches: Object.values(perLead).reduce(
				(sum, lead) => sum + lead.afterWakeBatches,
				0,
			),
			perLead,
			reasons,
			mixedBatches,
			unbatchedAlerts,
			proofPairs,
			decisions,
		};
	} finally {
		store.close();
	}
}

async function main() {
	const source = loadSources();
	const verified = await replay(source, "verified", observedThrough);
	const hypothetical = await replay(
		source,
		"hypothetical_same_correlation",
		observedThrough,
	);
	const comparatorEnd = observedThrough < designEnd ? observedThrough : designEnd;
	const comparison = {
		verified: await replay(source, "verified", comparatorEnd),
		hypothetical: await replay(
			source,
			"hypothetical_same_correlation",
			comparatorEnd,
		),
	};
	const originalRows = new Map(
		source.rows.map((row) => [row.delivery_id, row]),
	);
	const futureReceiptEquivalents = comparison.hypothetical.decisions.flatMap(
		(current, index, all) => {
			if (current.reason !== "no_delivered_equivalent" || !current.fingerprint)
				return [];
			const prior = all.slice(0, index).find((previous) => {
				const original = originalRows.get(String(previous.deliveryId));
				return (
					previous.action === "wake" &&
					previous.leadId === current.leadId &&
					previous.fingerprint === current.fingerprint &&
					previous.generationHash === current.generationHash &&
					original?.state === "ACKED" &&
					original.delivered_at &&
					Date.parse(original.delivered_at) > Date.parse(String(current.at))
				);
			});
			return prior
				? [
						{
							kind: current.kind,
							deliveryId: current.deliveryId,
							createdAt: current.at,
							earlierEquivalentDeliveryId: prior.deliveryId,
							earlierEquivalentDeliveredAt: originalRows.get(
								String(prior.deliveryId),
							)!.delivered_at,
							reason:
								"Earlier equivalent was still awaiting its adapter receipt at this decision",
						},
					]
				: [];
		},
	);
	const result = {
		model: "FLY-2910-production-alert-wake-dedup-v1",
		capturedAt: source.capturedAt,
		requestedWindowUtc: [start, end],
		observedThroughUtc: observedThrough,
		requestedWindowTimezone: "America/Los_Angeles",
		coverageComplete:
			observedThrough === end && Date.parse(source.capturedAt) >= Date.parse(end),
		latestObservedCreatedAt: source.rows.at(-1)?.created_at ?? null,
		sourceRows: source.counts,
		sourceDigest: hash(
			source.rows.map((row) => [
				row.delivery_id,
				row.content,
				row.created_at,
				row.batch_id,
				row.state,
				row.delivered_at,
				row.retry_count,
				row.lease_retry_count,
			]),
		),
		productionCodeSha256: Object.fromEntries(
			[
				"packages/teamlead/src/StateStore.ts",
				"packages/teamlead/src/bridge/alert-wake-dedup.ts",
			].map((path) => [
				path,
				createHash("sha256")
					.update(readFileSync(resolve(repo, path)))
					.digest("hex"),
			]),
		),
		dispatcherIdentity: {
			userId: dispatcherId,
			provenance:
				args.get("--dispatcher-source") ??
				"explicit trusted dispatcher ID provided by operator",
		},
		generationEvidence: {
			alertWakeLetterTableExists: source.hasLetterTable,
			exactDeliveryMappings: source.letters.size,
			exactRootOrThreadMappings: source.threads.size,
		},
		limitations: [
			"Requested end is fixed at PT midnight; observedThroughUtc bounds this partial implementation replay. Full-day replay belongs to QA; coverageComplete=false is not full-day evidence.",
			"Only read-only source queries were used, each source connection held a read transaction and was closed. Cross-database snapshots are not atomic.",
			"Historical batch creation time is unavailable: the earliest member created_at is the decision-time proxy; adapter evidence is delayed until the latest real delivered_at/ACKED timestamp in that batch.",
			"ACKED waking rows count as delivered per plan; retry_count>0 and lease_retry_count>0 rows bypass revalidation. Frozen batches with both counts zero cannot be reconstructed from historical rows. Current row state and retry counters can evolve after the observed created_at window.",
			"All model inbox members are included when determining whether an alert-containing batch disappears; a mixed batch with any surviving member remains a wake.",
			"Verified uses only exact immutable letter mappings and live root/thread lookups. Latest-only thread mappings cannot recover older generations; misses wake safely.",
			"Hypothetical assumes unchanged canonical generation for equal historical correlation throughout a fixed window; resolve/recur is not verified and these savings are an upper-bound estimate.",
			"State begins empty at the requested start. No production messages, ledger rows, or notification state are mutated. No raw message contents are emitted.",
		],
		verified,
		hypothetical,
		designFreezeComparison: {
			expected: { before: 152, verifiedAfter: 134, hypotheticalAfter: 102 },
			actual: comparison,
			reconciliation: {
				basis:
					"The design Python model wrote delivered evidence immediately at each alert's created_at. The production replay waits for the real adapter receipt and decides all members before their batch receipt.",
				futureReceiptEquivalents,
				actualHypotheticalMinusDesign:
					comparison.hypothetical.afterWakeBatches - 102,
				remainingUnrecognizedLetters: comparison.hypothetical.decisions.filter(
					(item) => item.reason === "unrecognized",
				).length,
			},
		},
	};
	const output = args.get("--output") ?? resolve(here, "replay-real.json");
	writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
	console.log(
		JSON.stringify({
			capturedAt: result.capturedAt,
			coverageComplete: result.coverageComplete,
			verified: [verified.beforeWakeBatches, verified.afterWakeBatches],
			hypothetical: [
				hypothetical.beforeWakeBatches,
				hypothetical.afterWakeBatches,
			],
			designFreeze: {
				verified: [
					comparison.verified.beforeWakeBatches,
					comparison.verified.afterWakeBatches,
				],
				hypothetical: [
					comparison.hypothetical.beforeWakeBatches,
					comparison.hypothetical.afterWakeBatches,
				],
			},
			proofPairs: hypothetical.proofPairs.length,
		}),
	);
}
main().catch((error) => {
	console.error(error instanceof Error ? error.message : "Replay failed");
	process.exitCode = 1;
});
