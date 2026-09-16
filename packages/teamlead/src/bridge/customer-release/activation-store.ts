import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import type { CustomerReleaseIdentity } from "./activation.js";
import { isDiscordId } from "./notice.js";

export interface ReleaseActivationState {
	epoch: number;
	enabled: boolean;
	identity: CustomerReleaseIdentity;
	enableReceiptId: string | null;
	evidenceBundleDigest: string | null;
}
export interface ReleaseEnableNotice {
	noticeId: string;
	epoch: number;
	identityDigest: string;
	evidenceBundleDigest: string;
	applicationId: string;
	channelId: string;
	messageId: string;
	expiresAt: number;
}
export interface ReleaseControlNotice extends ReleaseEnableNotice {
	action: "enable" | "disable";
	policyRevision: string;
	botUserId: string;
	messageDigest: string;
}
export interface ReleaseEnableAction {
	interactionId: string;
	noticeId: string;
	actorId: string;
	applicationId: string;
	channelId: string;
	messageId: string;
}
function requireValid(value: unknown): asserts value {
	if (!value) throw new Error("customer release activation evidence invalid");
}
function clock(now: number): void {
	requireValid(Number.isSafeInteger(now) && now >= 0);
}
function exact(value: unknown, keys: string[]): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}
const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
const id = (value: string) => /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);

/** Only trusted runtime/Gateway adapters call this store; no runner/HTTP writer.
 * Both tables use the existing StateStore transaction and survive every cycle. */
export class CustomerReleaseActivationStore {
	constructor(
		private readonly db: Database.Database,
		private readonly cycles: {
			invalidateRuntime(reason: string, now: number): void;
		},
	) {}
	migrate(): void {
		this.db.exec(`CREATE TABLE IF NOT EXISTS customer_release_activation (
      project_id TEXT PRIMARY KEY CHECK(project_id='flywheel'), epoch INTEGER NOT NULL CHECK(epoch>=1),
      identity_json TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      enable_receipt_id TEXT, evidence_bundle_digest TEXT
    );
    CREATE TABLE IF NOT EXISTS customer_release_activation_events (
      event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL CHECK(project_id='flywheel'),
      epoch INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, happened_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS customer_release_activation_event_immutable BEFORE UPDATE ON customer_release_activation_events
    BEGIN SELECT RAISE(ABORT,'immutable activation event'); END;
    CREATE TRIGGER IF NOT EXISTS customer_release_activation_event_no_delete BEFORE DELETE ON customer_release_activation_events
    BEGIN SELECT RAISE(ABORT,'immutable activation event'); END;`);
	}
	get(): ReleaseActivationState | null {
		const row = this.db
			.prepare(
				"SELECT epoch,identity_json AS identity,enabled,enable_receipt_id AS enableReceiptId,evidence_bundle_digest AS evidenceBundleDigest FROM customer_release_activation WHERE project_id=?",
			)
			.get("flywheel") as
			| (Omit<ReleaseActivationState, "identity" | "enabled"> & {
					identity: string;
					enabled: number;
			  })
			| undefined;
		return row
			? {
					...row,
					identity: JSON.parse(row.identity),
					enabled: row.enabled === 1,
				}
			: null;
	}
	private event(
		eventId: string,
		epoch: number,
		kind: string,
		payload: unknown,
		now: number,
	): void {
		this.db
			.prepare(
				"INSERT INTO customer_release_activation_events VALUES (?,?,?,?,?,?)",
			)
			.run(eventId, "flywheel", epoch, kind, JSON.stringify(payload), now);
	}
	/** A missed calendar slot survives credential/owner epochs and has no invented artifact. */
	missedSlot(weekStart: string): {
		projectId: "flywheel";
		weekStart: string;
		reason: "no_candidate" | "unknown";
	} | null {
		requireValid(/^\d{4}-\d{2}-\d{2}$/.test(weekStart));
		const row = this.db
			.prepare(
				"SELECT payload_json AS payload FROM customer_release_activation_events WHERE event_id=? AND project_id='flywheel' AND kind='cycle_slot_missed'",
			)
			.get(`slot:flywheel:${weekStart}`) as { payload: string } | undefined;
		return row ? JSON.parse(row.payload) : null;
	}
	recordMissedSlot(
		weekStart: string,
		reason: "no_candidate" | "unknown",
		now: number,
	): void {
		clock(now);
		requireValid(reason === "no_candidate" || reason === "unknown");
		this.db
			.transaction(() => {
				if (this.missedSlot(weekStart)) return;
				const state = this.get();
				requireValid(state);
				this.event(
					`slot:flywheel:${weekStart}`,
					state.epoch,
					"cycle_slot_missed",
					{ projectId: "flywheel", weekStart, reason },
					now,
				);
			})
			.immediate();
	}

	synchronize(
		identity: CustomerReleaseIdentity,
		now: number,
	): ReleaseActivationState {
		clock(now);
		requireValid(
			exact(identity, [
				"projectId",
				"policyRevision",
				"founderId",
				"endpoint",
				"audience",
				"botTokenSha256",
				"decisionTokenSha256",
				"identityDigest",
			]),
		);
		requireValid(
			identity.projectId === "flywheel" &&
				isDiscordId(identity.founderId) &&
				[
					identity.identityDigest,
					identity.policyRevision,
					identity.botTokenSha256,
					identity.decisionTokenSha256,
				].every(digest),
		);
		return this.db
			.transaction(() => {
				const previous = this.get();
				if (previous && isDeepStrictEqual(previous.identity, identity))
					return previous;
				const epoch = (previous?.epoch ?? 0) + 1;
				requireValid(Number.isSafeInteger(epoch));
				this.db
					.prepare(`INSERT INTO customer_release_activation VALUES ('flywheel',?,?,0,NULL,NULL)
        ON CONFLICT(project_id) DO UPDATE SET epoch=excluded.epoch,identity_json=excluded.identity_json,enabled=0,enable_receipt_id=NULL,evidence_bundle_digest=NULL`)
					.run(epoch, JSON.stringify(identity));
				this.event(randomUUID(), epoch, "identity_changed", identity, now);
				this.cycles.invalidateRuntime("activation_identity_changed", now);
				return this.get()!;
			})
			.immediate();
	}
	/** Called only after the dedicated Discord adapter verifies delivery/access. */
	recordDeliveredEnableNotice(notice: ReleaseEnableNotice, now: number): void {
		clock(now);
		requireValid(
			exact(notice, [
				"noticeId",
				"epoch",
				"identityDigest",
				"evidenceBundleDigest",
				"applicationId",
				"channelId",
				"messageId",
				"expiresAt",
			]),
		);
		requireValid(
			id(notice.noticeId) &&
				digest(notice.identityDigest) &&
				digest(notice.evidenceBundleDigest) &&
				[notice.applicationId, notice.channelId, notice.messageId].every(
					isDiscordId,
				) &&
				Number.isSafeInteger(notice.expiresAt) &&
				notice.expiresAt > now,
		);
		this.db
			.transaction(() => {
				const state = this.get();
				requireValid(
					state &&
						state.epoch === notice.epoch &&
						state.identity.identityDigest === notice.identityDigest,
				);
				const old = this.db
					.prepare(
						"SELECT payload_json AS payload FROM customer_release_activation_events WHERE event_id=? AND kind='enable_notice'",
					)
					.get(`notice:${notice.noticeId}`) as { payload: string } | undefined;
				if (old) {
					requireValid(isDeepStrictEqual(JSON.parse(old.payload), notice));
					return;
				}
				this.event(
					`notice:${notice.noticeId}`,
					state.epoch,
					"enable_notice",
					notice,
					now,
				);
			})
			.immediate();
	}
	/** One append-only intent permits one POST. Replays are observe-only. */
	startControlDelivery(
		intent: Omit<ReleaseControlNotice, "messageId">,
		now: number,
	): boolean {
		clock(now);
		requireValid(
			exact(intent, [
				"action",
				"noticeId",
				"epoch",
				"identityDigest",
				"evidenceBundleDigest",
				"applicationId",
				"channelId",
				"expiresAt",
				"policyRevision",
				"botUserId",
				"messageDigest",
			]),
		);
		requireValid(/^[a-f0-9]{32}$/.test(intent.noticeId));
		return this.db
			.transaction(() => {
				const state = this.get();
				requireValid(
					state &&
						state.epoch === intent.epoch &&
						state.identity.identityDigest === intent.identityDigest &&
						state.identity.policyRevision === intent.policyRevision,
				);
				const previous = this.db
					.prepare(
						"SELECT payload_json AS payload FROM customer_release_activation_events WHERE event_id=? AND kind='control_sending'",
					)
					.get(`control-send:${intent.noticeId}`) as
					| { payload: string }
					| undefined;
				if (previous) {
					requireValid(isDeepStrictEqual(JSON.parse(previous.payload), intent));
					return false;
				}
				this.event(
					`control-send:${intent.noticeId}`,
					intent.epoch,
					"control_sending",
					intent,
					now,
				);
				return true;
			})
			.immediate();
	}

	controlDeliveryAt(noticeId: string): number | null {
		const row = this.db
			.prepare(
				"SELECT happened_at AS at FROM customer_release_activation_events WHERE event_id=? AND kind='control_sending'",
			)
			.get(`control-send:${noticeId}`) as { at: number } | undefined;
		return row?.at ?? null;
	}

	controlNotice(noticeId: string): ReleaseControlNotice | null {
		requireValid(id(noticeId));
		const row = this.db
			.prepare(
				"SELECT payload_json AS payload FROM customer_release_activation_events WHERE event_id=? AND kind='control_notice'",
			)
			.get(`control:${noticeId}`) as { payload: string } | undefined;
		return row ? JSON.parse(row.payload) : null;
	}
	/** Only after independent Discord readback and founder/bot access verification. */
	recordDeliveredControl(notice: ReleaseControlNotice, now: number): void {
		clock(now);
		requireValid(
			exact(notice, [
				"action",
				"noticeId",
				"epoch",
				"identityDigest",
				"evidenceBundleDigest",
				"applicationId",
				"channelId",
				"messageId",
				"expiresAt",
				"policyRevision",
				"botUserId",
				"messageDigest",
			]),
		);
		requireValid(
			(notice.action === "enable" || notice.action === "disable") &&
				/^[a-f0-9]{32}$/.test(notice.noticeId) &&
				[
					notice.identityDigest,
					notice.evidenceBundleDigest,
					notice.policyRevision,
					notice.messageDigest,
				].every(digest) &&
				[
					notice.applicationId,
					notice.channelId,
					notice.messageId,
					notice.botUserId,
				].every(isDiscordId) &&
				Number.isSafeInteger(notice.expiresAt) &&
				notice.expiresAt > now,
		);
		this.db
			.transaction(() => {
				const state = this.get();
				requireValid(
					state &&
						state.epoch === notice.epoch &&
						state.identity.identityDigest === notice.identityDigest &&
						state.identity.policyRevision === notice.policyRevision,
				);
				const old = this.controlNotice(notice.noticeId);
				if (old) {
					requireValid(isDeepStrictEqual(old, notice));
					return;
				}
				if (notice.action === "enable")
					this.recordDeliveredEnableNotice(
						{
							noticeId: notice.noticeId,
							epoch: notice.epoch,
							identityDigest: notice.identityDigest,
							evidenceBundleDigest: notice.evidenceBundleDigest,
							applicationId: notice.applicationId,
							channelId: notice.channelId,
							messageId: notice.messageId,
							expiresAt: notice.expiresAt,
						},
						now,
					);
				this.event(
					`control:${notice.noticeId}`,
					notice.epoch,
					"control_notice",
					notice,
					now,
				);
			})
			.immediate();
	}

	/** Actor is already authenticated by the dedicated Gateway; re-check canonical ownership and exact card here. */
	enable(action: ReleaseEnableAction, now: number): ReleaseActivationState {
		clock(now);
		requireValid(
			exact(action, [
				"interactionId",
				"noticeId",
				"actorId",
				"applicationId",
				"channelId",
				"messageId",
			]),
		);
		requireValid(
			[
				action.interactionId,
				action.actorId,
				action.applicationId,
				action.channelId,
				action.messageId,
			].every(isDiscordId) && id(action.noticeId),
		);
		return this.db
			.transaction(() => {
				const state = this.get();
				const row = this.db
					.prepare(
						"SELECT payload_json AS payload FROM customer_release_activation_events WHERE event_id=? AND kind='enable_notice'",
					)
					.get(`notice:${action.noticeId}`) as { payload: string } | undefined;
				requireValid(state && row);
				const notice = JSON.parse(row.payload) as ReleaseEnableNotice;
				requireValid(
					state.epoch === notice.epoch &&
						state.identity.identityDigest === notice.identityDigest &&
						state.identity.founderId === action.actorId &&
						notice.applicationId === action.applicationId &&
						notice.channelId === action.channelId &&
						notice.messageId === action.messageId,
				);
				const old = this.db
					.prepare(
						"SELECT payload_json AS payload FROM customer_release_activation_events WHERE event_id=? AND kind='enabled'",
					)
					.get(action.interactionId) as { payload: string } | undefined;
				if (old) {
					requireValid(
						isDeepStrictEqual(JSON.parse(old.payload), action) &&
							state.enabled &&
							state.enableReceiptId === action.interactionId,
					);
					return state;
				}
				requireValid(now < notice.expiresAt && !state.enabled);
				// A delivered enable card is single-use across disable/re-enable cycles.
				requireValid(
					!this.db
						.prepare(
							"SELECT 1 FROM customer_release_activation_events WHERE project_id='flywheel' AND kind='enabled' AND json_extract(payload_json,'$.noticeId')=? LIMIT 1",
						)
						.get(action.noticeId),
				);
				this.event(action.interactionId, state.epoch, "enabled", action, now);
				this.db
					.prepare(
						"UPDATE customer_release_activation SET enabled=1,enable_receipt_id=?,evidence_bundle_digest=? WHERE project_id=? AND epoch=?",
					)
					.run(
						action.interactionId,
						notice.evidenceBundleDigest,
						"flywheel",
						state.epoch,
					);
				return this.get()!;
			})
			.immediate();
	}
	/** Runtime identity/evidence loss is not a founder click and cannot mint a new grant. */
	revoke(reason: string, now: number): void {
		clock(now);
		requireValid(/^[a-z][a-z0-9_]{0,127}$/.test(reason));
		this.db
			.transaction(() => {
				const state = this.get();
				if (!state?.enabled) {
					this.cycles.invalidateRuntime(reason, now);
					return;
				}
				this.event(
					randomUUID(),
					state.epoch,
					"runtime_disabled",
					{ reason },
					now,
				);
				this.db
					.prepare(
						"UPDATE customer_release_activation SET enabled=0,enable_receipt_id=NULL,evidence_bundle_digest=NULL WHERE project_id='flywheel'",
					)
					.run();
				this.cycles.invalidateRuntime(reason, now);
			})
			.immediate();
	}

	disable(
		interactionId: string,
		actorId: string,
		epoch: number,
		now: number,
	): ReleaseActivationState {
		clock(now);
		requireValid(isDiscordId(interactionId) && isDiscordId(actorId));
		return this.db
			.transaction(() => {
				const state = this.get();
				requireValid(
					state &&
						state.epoch === epoch &&
						state.identity.founderId === actorId,
				);
				const payload = { actorId, epoch };
				const old = this.db
					.prepare(
						"SELECT payload_json AS payload FROM customer_release_activation_events WHERE event_id=? AND kind='disabled'",
					)
					.get(interactionId) as { payload: string } | undefined;
				if (old) {
					requireValid(isDeepStrictEqual(JSON.parse(old.payload), payload));
					return state;
				}
				this.event(interactionId, epoch, "disabled", payload, now);
				this.db
					.prepare(
						"UPDATE customer_release_activation SET enabled=0,enable_receipt_id=NULL,evidence_bundle_digest=NULL WHERE project_id='flywheel'",
					)
					.run();
				this.cycles.invalidateRuntime("founder_disabled", now);
				return this.get()!;
			})
			.immediate();
	}
}
