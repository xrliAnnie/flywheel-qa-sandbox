import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
export interface ReleaseAccountingEvent {
	eventId: string;
	projectId: "flywheel";
	cycleId: string | null;
	kind: string;
	when: number;
	origin: "automatic" | "manual_intake" | "activation";
	facts: Record<string, unknown>;
}
export interface ReleaseAccountingTransport {
	/** Must search the complete bounded target scope; throw if incomplete. */
	find(marker: string): Promise<{ id: string }[]>;
	create(
		marker: string,
		event: ReleaseAccountingEvent,
		digest: string,
	): Promise<string>;
	read(id: string): Promise<{ marker: string; digest: string }>;
	/** Verify destination and writer ownership again before replacing this known record. */
	update?(
		id: string,
		marker: string,
		event: ReleaseAccountingEvent,
		digest: string,
	): Promise<void>;
}
type Target = "linear" | "github";
interface Row {
	eventId: string;
	target: Target;
	externalId: string | null;
	digest: string;
	content: string;
	state: "pending" | "delivered";
	createStarted: number;
	attempt: number;
	retryAt: number;
}
const selection =
	"event_id AS eventId,target,external_id AS externalId,content_digest AS digest,content_json AS content,state,create_started AS createStarted,attempt,retry_at AS retryAt";
function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function valid(value: unknown): asserts value {
	if (!value) throw new Error("release accounting invalid");
}
/** Projection state is separate from publication state. No method here can
 * publish, mint a permit, change a cycle or write ship/PR approval accounting. */
export class CustomerReleaseAccounting {
	constructor(private readonly db: Database.Database) {}
	migrate(): void {
		this.db.exec(`CREATE TABLE IF NOT EXISTS customer_release_projections(
   event_id TEXT NOT NULL,target TEXT NOT NULL CHECK(target IN ('linear','github')),
   external_id TEXT,content_digest TEXT NOT NULL,content_json TEXT NOT NULL,
   state TEXT NOT NULL CHECK(state IN ('pending','delivered')),
   create_started INTEGER NOT NULL DEFAULT 0 CHECK(create_started IN (0,1)),
   attempt INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,
   PRIMARY KEY(event_id,target)
  );
  CREATE TRIGGER IF NOT EXISTS customer_release_projection_snapshot_immutable BEFORE UPDATE ON customer_release_projections
  WHEN NEW.event_id!=OLD.event_id OR NEW.target!=OLD.target OR NEW.content_digest!=OLD.content_digest OR NEW.content_json!=OLD.content_json
   OR NEW.create_started<OLD.create_started OR (OLD.external_id IS NOT NULL AND NEW.external_id IS NOT OLD.external_id)
  BEGIN SELECT RAISE(ABORT,'immutable release projection'); END;`);
	}
	enqueue(event: ReleaseAccountingEvent): void {
		valid(
			event &&
				Object.keys(event).length === 7 &&
				[
					"eventId",
					"projectId",
					"cycleId",
					"kind",
					"when",
					"origin",
					"facts",
				].every((key) => Object.hasOwn(event, key)),
		);
		const content = JSON.stringify(event);
		valid(
			content.length <= 262144 &&
				/^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/.test(event.eventId) &&
				event.projectId === "flywheel" &&
				Number.isSafeInteger(event.when) &&
				event.when >= 0 &&
				["automatic", "manual_intake", "activation"].includes(event.origin),
		);
		const digest = createHash("sha256").update(content).digest("hex");
		this.db
			.transaction(() => {
				for (const target of ["linear", "github"] as const) {
					const previous = this.status(event.eventId, target);
					if (previous) {
						valid(previous.content === content && previous.digest === digest);
						continue;
					}
					this.db
						.prepare(
							"INSERT INTO customer_release_projections(event_id,target,content_digest,content_json,state) VALUES (?,?,?,?,'pending')",
						)
						.run(event.eventId, target, digest, content);
				}
			})
			.immediate();
	}
	/** Capture existing Bridge facts only. This never invents a delivery receipt.
	 * Snapshot fields describe capture time, not the source event's historical state. */
	capture(now: number): void {
		valid(Number.isSafeInteger(now) && now >= 0);
		this.db
			.transaction(() => {
				const events = this.db
					.prepare(`SELECT e.event_id AS eventId,e.cycle_id AS cycleId,e.kind,e.who,e.happened_at AS happenedAt,e.reason,
			 c.release_id AS releaseId,c.frozen_beta_json AS beta,c.binding_json AS binding,c.state,c.revision,
			 c.window_opened_at AS windowOpenedAt,c.deadline_at AS deadlineAt,c.cancel_reason AS cancelReason,
			 c.policy_revision AS policyRevision,c.activation_epoch AS activationEpoch,
			 EXISTS(SELECT 1 FROM customer_release_events m WHERE m.cycle_id=e.cycle_id AND m.kind='manual_intake') AS manualIntake
			 FROM customer_release_events e JOIN customer_release_cycles c ON c.cycle_id=e.cycle_id
			 WHERE c.project_id='flywheel' AND NOT EXISTS(SELECT 1 FROM customer_release_projections p WHERE p.event_id='cycle:'||e.event_id)
			 ORDER BY e.seq LIMIT 100`)
					.all() as {
					eventId: string;
					cycleId: string;
					kind: string;
					who: string;
					happenedAt: number;
					reason: string | null;
					releaseId: string;
					beta: string;
					binding: string | null;
					state: string;
					revision: number;
					windowOpenedAt: number | null;
					deadlineAt: number | null;
					cancelReason: string | null;
					policyRevision: string;
					activationEpoch: number;
					manualIntake: number;
				}[];
				for (const e of events) {
					const decisions = this.db
						.prepare(`SELECT decision_id AS decisionId,attempt_id AS attemptId,claimed_at AS claimedAt,
				 json_extract(permit_json,'$.trigger') AS trigger,json_extract(permit_json,'$.actor') AS actor,
				 json_extract(permit_json,'$.verdictId') AS verdictId,json_extract(permit_json,'$.readiness') AS readinessJson,
                 json_extract(permit_json,'$.fullBinding') AS fullBindingJson,json_extract(permit_json,'$.baseEtag') AS baseEtag
				 FROM customer_release_decisions WHERE cycle_id=? ORDER BY claimed_at,decision_id`)
						.all(e.cycleId) as {
						[key: string]: unknown;
						fullBindingJson: string | null;
						readinessJson: string | null;
					}[];
					const actions = this.db
						.prepare(`SELECT interaction_id AS interactionId,action,actor_id AS actorId,
				 binding_digest AS bindingDigest,received_at AS receivedAt FROM customer_release_actions WHERE cycle_id=? ORDER BY received_at,interaction_id`)
						.all(e.cycleId);
					const notices = this.db
						.prepare(`SELECT notice_id AS noticeId,binding_digest AS bindingDigest,send_state AS sendState,
				 message_id AS messageId,delivered_at AS deliveredAt FROM customer_release_notices WHERE cycle_id=?`)
						.all(e.cycleId);
					const results = this.db
						.prepare(`SELECT attempt_id AS attemptId,kind,cycle_state AS cycleState,observed_at AS observedAt,
				 result_json AS resultJson FROM customer_release_attempt_results WHERE cycle_id=? ORDER BY observed_at,attempt_id`)
						.all(e.cycleId) as {
						attemptId: string;
						kind: string;
						cycleState: string;
						observedAt: number;
						resultJson: string;
					}[];
					this.enqueue({
						eventId: `cycle:${e.eventId}`,
						projectId: "flywheel",
						cycleId: e.cycleId,
						kind: e.kind,
						when: e.happenedAt,
						origin: e.manualIntake ? "manual_intake" : "automatic",
						facts: {
							who: e.who,
							capturedAt: now,
							releaseId: e.releaseId,
							frozenBeta: JSON.parse(e.beta),
							binding: e.binding ? JSON.parse(e.binding) : null,
							policyRevision: e.policyRevision,
							activationEpoch: e.activationEpoch,
							reason: e.reason && /^[a-z_]+$/.test(e.reason) ? e.reason : null,
							reasonDigest: e.reason ? hash(e.reason) : null,
							snapshot: {
								state: e.state,
								revision: e.revision,
								windowOpenedAt: e.windowOpenedAt,
								deadlineAt: e.deadlineAt,
								cancelReason: e.cancelReason,
							},
							decisions: decisions.map(
								({ fullBindingJson, readinessJson, ...decision }) => ({
									...decision,
									fullBinding: fullBindingJson
										? JSON.parse(fullBindingJson)
										: null,
									readiness: readinessJson ? JSON.parse(readinessJson) : null,
								}),
							),
							actions,
							notices,
							results: results.map(({ resultJson, ...result }) => {
								const proof = JSON.parse(resultJson) as {
									manifest?: unknown;
									manifestEtag?: string;
								};
								return {
									...result,
									proofDigest: hash(resultJson),
									manifestEtag:
										typeof proof.manifestEtag === "string"
											? proof.manifestEtag
											: null,
									manifestDigest:
										proof.manifest === undefined
											? null
											: hash(JSON.stringify(proof.manifest)),
								};
							}),
						},
					});
				}
				const activation = this.db
					.prepare(`SELECT event_id AS eventId,kind,epoch,payload_json AS payload,happened_at AS happenedAt
			 FROM customer_release_activation_events e WHERE project_id='flywheel' AND NOT EXISTS(
			 SELECT 1 FROM customer_release_projections p WHERE p.event_id='activation:'||e.event_id)
			 ORDER BY happened_at,event_id LIMIT 100`)
					.all() as {
					eventId: string;
					kind: string;
					epoch: number;
					payload: string;
					happenedAt: number;
				}[];
				for (const e of activation) {
					const payload = JSON.parse(e.payload);
					this.enqueue({
						eventId: `activation:${e.eventId}`,
						projectId: "flywheel",
						cycleId: null,
						kind: e.kind,
						when: e.happenedAt,
						origin: "activation",
						facts: {
							capturedAt: now,
							epoch: e.epoch,
							who:
								["enabled", "disabled"].includes(e.kind) &&
								typeof payload.actorId === "string"
									? payload.actorId
									: "system",
							actionId: ["enabled", "disabled"].includes(e.kind)
								? e.eventId
								: null,
							payloadDigest: hash(e.payload),
							...(e.kind === "cycle_slot_missed"
								? { weekStart: payload.weekStart, reason: payload.reason }
								: {}),
						},
					});
				}
			})
			.immediate();
	}
	/** Bind the fixed remote records once for an activation, before any I/O.
	 * Uses the existing immutable activation journal; no credentials belong here. */
	bindActivationTarget(
		epoch: number,
		binding: {
			activationId: string;
			repository: string;
			repositoryId: number;
			linearIssueId: string;
			linearTeamId: string;
			linearProjectId: string;
			githubIssueNumber: number;
			linearWriterId: string;
			githubWriterId: number;
		},
		now: number,
	): void {
		valid(
			Number.isSafeInteger(epoch) &&
				epoch > 0 &&
				Number.isSafeInteger(now) &&
				now >= 0,
		);
		valid(binding.activationId === `flywheel:epoch:${epoch}`);
		const content = JSON.stringify(binding),
			eventId = `accounting-target:${epoch}`;
		this.db
			.transaction(() => {
				const previous = this.db
					.prepare(
						"SELECT payload_json AS payload FROM customer_release_activation_events WHERE event_id=?",
					)
					.get(eventId) as { payload: string } | undefined;
				if (previous) {
					valid(previous.payload === content);
					return;
				}
				this.db
					.prepare(
						"INSERT INTO customer_release_activation_events(event_id,project_id,epoch,kind,payload_json,happened_at) VALUES (?,'flywheel',?,'accounting_target_bound',?,?)",
					)
					.run(eventId, epoch, content, now);
			})
			.immediate();
	}
	status(eventId: string, target: Target): Row | null {
		return (
			(this.db
				.prepare(
					`SELECT ${selection} FROM customer_release_projections WHERE event_id=? AND target=?`,
				)
				.get(eventId, target) as Row | undefined) ?? null
		);
	}
	pending(now: number): (Row & { event: ReleaseAccountingEvent })[] {
		valid(Number.isSafeInteger(now) && now >= 0);
		return (
			this.db
				.prepare(
					`SELECT ${selection} FROM customer_release_projections WHERE state='pending' AND retry_at<=? ORDER BY retry_at,event_id,target LIMIT 100`,
				)
				.all(now) as Row[]
		).map((row) => ({ ...row, event: JSON.parse(row.content) }));
	}
	async project(
		target: Target,
		transportOrResolve:
			| ReleaseAccountingTransport
			| ((event: ReleaseAccountingEvent) => ReleaseAccountingTransport),
		now: number,
	): Promise<void> {
		valid(target === "linear" || target === "github");
		for (const row of this.pending(now)
			.filter((row) => row.target === target)
			.slice(0, 10)) {
			const marker = `release-event:${row.eventId}`;
			try {
				const transport =
					typeof transportOrResolve === "function"
						? transportOrResolve(row.event)
						: transportOrResolve;
				let externalId = row.externalId;
				if (!externalId) {
					const matches = await transport.find(marker);
					valid(Array.isArray(matches) && matches.length <= 1);
					externalId = matches[0]?.id ?? null;
					if (!externalId) {
						const started =
							this.db
								.prepare(
									"UPDATE customer_release_projections SET create_started=1 WHERE event_id=? AND target=? AND state='pending' AND create_started=0",
								)
								.run(row.eventId, target).changes === 1;
						if (!started)
							throw new Error("release accounting create unresolved");
						externalId = await transport.create(marker, row.event, row.digest);
					}
					valid(
						typeof externalId === "string" &&
							externalId.length > 0 &&
							externalId.length <= 2048,
					);
					this.db
						.prepare(
							"UPDATE customer_release_projections SET external_id=? WHERE event_id=? AND target=? AND external_id IS NULL",
						)
						.run(externalId, row.eventId, target);
				}
				// A concurrent recovery can bind the row while our lookup is in flight.
				externalId = this.status(row.eventId, target)?.externalId ?? null;
				valid(externalId);
				let proof = await transport.read(externalId);
				if (
					proof.marker === marker &&
					proof.digest !== row.digest &&
					transport.update
				) {
					await transport.update(externalId, marker, row.event, row.digest);
					proof = await transport.read(externalId);
				}
				valid(proof.marker === marker && proof.digest === row.digest);
				this.db
					.prepare(
						"UPDATE customer_release_projections SET state='delivered',attempt=attempt+1 WHERE event_id=? AND target=? AND external_id=?",
					)
					.run(row.eventId, target, externalId);
			} catch {
				this.db
					.prepare(
						"UPDATE customer_release_projections SET attempt=attempt+1,retry_at=? WHERE event_id=? AND target=? AND state='pending'",
					)
					.run(now + 30000, row.eventId, target);
			}
		}
	}
}
