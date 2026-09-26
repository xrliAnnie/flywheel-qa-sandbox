import type Database from "better-sqlite3";
import { z } from "zod";

const coordinate = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[a-zA-Z0-9_.:-]+$/);
const keySchema = z
	.object({
		projectName: coordinate,
		leadId: coordinate,
		operationId: coordinate,
		requestId: z.string().uuid(),
	})
	.strict();
const prepareSchema = keySchema.extend({
	inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
	activationId: coordinate,
	targetKey: z.string().min(1).max(512).optional(),
	/** Voice repeat-gate fingerprint only; resident receipts leave it null. */
	dedupeDigest: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	now: z.number().int().nonnegative(),
});
const stateSchema = z.enum([
	"prepared",
	"dispatched",
	"succeeded",
	"rejected",
	"unknown",
]);
export type OperationReceiptKey = z.infer<typeof keySchema>;
export type OperationReceiptState = z.infer<typeof stateSchema>;
export interface OperationReceipt extends OperationReceiptKey {
	inputDigest: string;
	activationId: string;
	targetKey: string | null;
	state: OperationReceiptState;
	providerRef: string | null;
	startedAt: number;
	updatedAt: number;
	errorCode: string | null;
}
const transitionSchema = prepareSchema.extend({
	from: stateSchema,
	to: stateSchema,
	providerRef: coordinate.optional(),
	errorCode: z
		.string()
		.regex(/^[a-z][a-z0-9_]{0,95}$/)
		.optional(),
});
const scopeSchema = z
	.object({
		projectName: coordinate,
		leadId: coordinate,
		activationId: coordinate,
		now: z.number().int().nonnegative(),
	})
	.strict();
const deliverySchema = z
	.object({
		projectName: coordinate,
		leadId: coordinate,
		activationId: coordinate,
		entryId: coordinate,
	})
	.strict();
const KEY_WHERE =
	"project_name=@projectName AND lead_id=@leadId AND operation_id=@operationId AND request_id=@requestId";
interface ReceiptRow {
	project_name: string;
	lead_id: string;
	operation_id: string;
	request_id: string;
	input_digest: string;
	activation_id: string;
	target_key: string | null;
	dedupe_digest?: string | null;
	state: OperationReceiptState;
	provider_ref: string | null;
	started_at: number;
	updated_at: number;
	error_code: string | null;
}
function fromRow(r: ReceiptRow): OperationReceipt {
	return {
		projectName: r.project_name,
		leadId: r.lead_id,
		operationId: r.operation_id,
		requestId: r.request_id,
		inputDigest: r.input_digest,
		activationId: r.activation_id,
		targetKey: r.target_key ?? null,
		state: r.state,
		providerRef: r.provider_ref,
		startedAt: r.started_at,
		updatedAt: r.updated_at,
		errorCode: r.error_code,
	};
}
/** Called by the owning journal or Bridge outbound store's existing migration lifecycle. Additive for rollback compatibility. */
export function migrateOperationReceipts(db: Database.Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS lead_operation_receipts (
 project_name TEXT NOT NULL,lead_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_id TEXT NOT NULL,
 input_digest TEXT NOT NULL,activation_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','succeeded','rejected','unknown')),
 provider_ref TEXT,started_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error_code TEXT,
 PRIMARY KEY(project_name,lead_id,operation_id,request_id));
 CREATE INDEX IF NOT EXISTS lead_operation_receipts_recovery_idx ON lead_operation_receipts(project_name,lead_id,activation_id,state);`);
	const columns = new Set(
		(
			db.prepare("PRAGMA table_info(lead_operation_receipts)").all() as Array<{
				name: string;
			}>
		).map((column) => column.name),
	);
	if (!columns.has("target_key"))
		db.exec("ALTER TABLE lead_operation_receipts ADD COLUMN target_key TEXT");
	if (!columns.has("dedupe_digest"))
		db.exec(
			"ALTER TABLE lead_operation_receipts ADD COLUMN dedupe_digest TEXT",
		);
	db.exec(
		"CREATE INDEX IF NOT EXISTS lead_operation_receipts_target_idx ON lead_operation_receipts(target_key,state)",
	);
	// Voice-only association of receipts with the background turn entries that
	// produced or replayed them. Additive; resident journals never write it.
	db.exec(`CREATE TABLE IF NOT EXISTS lead_operation_receipt_deliveries (
 project_name TEXT NOT NULL,lead_id TEXT NOT NULL,activation_id TEXT NOT NULL,entry_id TEXT NOT NULL,
 operation_id TEXT NOT NULL,request_id TEXT NOT NULL,recorded_at INTEGER NOT NULL,
 PRIMARY KEY(project_name,lead_id,activation_id,entry_id,operation_id,request_id))`);
}
/** Owns no connection. Journal.close() closes this store too. Callers are trusted broker code, never model input. */
export class OperationReceiptStore {
	constructor(private readonly db: Database.Database) {}
	/** Complete, read-only session ledger; the caller supplies trusted activation scope. */
	listByActivation(raw: {
		projectName: string;
		leadId: string;
		activationId: string;
	}): OperationReceipt[] {
		const scope = scopeSchema.omit({ now: true }).parse(raw);
		const rows = this.db
			.prepare(
				"SELECT * FROM lead_operation_receipts WHERE project_name=@projectName AND lead_id=@leadId AND activation_id=@activationId ORDER BY started_at,operation_id,request_id",
			)
			.all(scope) as ReceiptRow[];
		return rows.map(fromRow);
	}
	/** Voice parent only: bind a write receipt to the background turn entry that saw it. */
	associateDelivery(raw: {
		projectName: string;
		leadId: string;
		activationId: string;
		entryId: string;
		operationId: string;
		requestId: string;
		now: number;
	}): void {
		const input = deliverySchema
			.extend({
				operationId: coordinate,
				requestId: z.string().uuid(),
				now: z.number().int().nonnegative(),
			})
			.strict()
			.parse(raw);
		this.db
			.prepare(
				"INSERT INTO lead_operation_receipt_deliveries (project_name,lead_id,activation_id,entry_id,operation_id,request_id,recorded_at) VALUES (@projectName,@leadId,@activationId,@entryId,@operationId,@requestId,@now) ON CONFLICT DO NOTHING",
			)
			.run(input);
	}
	/** Durable per-turn ledger, including replays of receipts created by an earlier turn. */
	listByDelivery(raw: {
		projectName: string;
		leadId: string;
		activationId: string;
		entryId: string;
	}): OperationReceipt[] {
		const input = deliverySchema.parse(raw);
		const rows = this.db
			.prepare(
				"SELECT r.* FROM lead_operation_receipt_deliveries d JOIN lead_operation_receipts r ON r.project_name=d.project_name AND r.lead_id=d.lead_id AND r.operation_id=d.operation_id AND r.request_id=d.request_id WHERE d.project_name=@projectName AND d.lead_id=@leadId AND d.activation_id=@activationId AND d.entry_id=@entryId ORDER BY r.started_at,r.operation_id,r.request_id",
			)
			.all(input) as ReceiptRow[];
		return rows.map(fromRow);
	}
	/** Newest dispatched/succeeded/unknown write with the same repeat fingerprint since `since`. */
	findRecentRepeat(raw: {
		projectName: string;
		leadId: string;
		activationId: string;
		operationId: string;
		targetKey: string;
		dedupeDigest: string;
		since: number;
		excludeRequestId: string;
		/** Skip receipts first associated with this turn entry (same-turn steps). */
		excludeOriginEntryId?: string;
	}): OperationReceipt | undefined {
		const input = z
			.object({
				projectName: coordinate,
				leadId: coordinate,
				activationId: coordinate,
				operationId: coordinate,
				targetKey: z.string().min(1).max(512),
				dedupeDigest: z.string().regex(/^[a-f0-9]{64}$/),
				since: z.number().int(),
				excludeRequestId: z.string().uuid(),
				excludeOriginEntryId: coordinate.optional(),
			})
			.strict()
			.parse(raw);
		// A receipt's origin turn is its first recorded delivery association.
		const origin =
			"(SELECT d.entry_id FROM lead_operation_receipt_deliveries d WHERE d.project_name=r.project_name AND d.lead_id=r.lead_id AND d.activation_id=r.activation_id AND d.operation_id=r.operation_id AND d.request_id=r.request_id ORDER BY d.recorded_at,d.rowid LIMIT 1)";
		const row = this.db
			.prepare(
				`SELECT r.* FROM lead_operation_receipts r WHERE r.project_name=@projectName AND r.lead_id=@leadId AND r.activation_id=@activationId AND r.operation_id=@operationId AND r.target_key=@targetKey AND r.dedupe_digest=@dedupeDigest AND r.state IN ('dispatched','succeeded','unknown') AND r.started_at>=@since AND r.request_id<>@excludeRequestId${input.excludeOriginEntryId === undefined ? "" : ` AND COALESCE(${origin},'')<>@excludeOriginEntryId`} ORDER BY r.started_at DESC,r.request_id DESC LIMIT 1`,
			)
			.get(input) as ReceiptRow | undefined;
		return row ? fromRow(row) : undefined;
	}
	get(key: OperationReceiptKey): OperationReceipt | undefined {
		const parsed = keySchema.parse(key);
		const row = this.db
			.prepare(`SELECT * FROM lead_operation_receipts WHERE ${KEY_WHERE}`)
			.get(parsed) as ReceiptRow | undefined;
		return row ? fromRow(row) : undefined;
	}
	/** Read-only proof that this scoped provider resource was durably acknowledged. */
	hasSucceededProviderPrefix(raw: {
		projectName: string;
		leadId: string;
		operationId: string;
		providerPrefix: string;
	}): boolean {
		const input = z
			.object({
				projectName: coordinate,
				leadId: coordinate,
				operationId: coordinate,
				providerPrefix: coordinate,
			})
			.strict()
			.parse(raw);
		return !!this.db
			.prepare(
				`SELECT 1 FROM lead_operation_receipts WHERE project_name=@projectName AND lead_id=@leadId AND operation_id=@operationId AND state='succeeded' AND substr(provider_ref,1,length(@providerPrefix))=@providerPrefix LIMIT 1`,
			)
			.get(input);
	}

	prepare(raw: z.infer<typeof prepareSchema>): {
		disposition: "prepared" | "replay" | "reconcile-only";
		receipt: OperationReceipt;
	} {
		const input = prepareSchema.parse(raw);
		return this.db
			.transaction(() => {
				const inserted =
					this.db
						.prepare(
							`INSERT INTO lead_operation_receipts (project_name,lead_id,operation_id,request_id,input_digest,activation_id,target_key,dedupe_digest,state,started_at,updated_at) VALUES (@projectName,@leadId,@operationId,@requestId,@inputDigest,@activationId,@targetKey,@dedupeDigest,'prepared',@now,@now) ON CONFLICT(project_name,lead_id,operation_id,request_id) DO NOTHING`,
						)
						.run({
							...input,
							targetKey: input.targetKey ?? null,
							dedupeDigest: input.dedupeDigest ?? null,
						}).changes === 1;
				const receipt = this.get({
					projectName: input.projectName,
					leadId: input.leadId,
					operationId: input.operationId,
					requestId: input.requestId,
				})!;
				if (receipt.inputDigest !== input.inputDigest)
					throw new Error("input_digest_conflict");
				if (receipt.targetKey && receipt.targetKey !== input.targetKey)
					throw new Error("target_key_conflict");
				return {
					disposition: inserted
						? "prepared"
						: receipt.activationId === input.activationId
							? "replay"
							: "reconcile-only",
					receipt,
				} as const;
			})
			.immediate();
	}
	transition(raw: z.infer<typeof transitionSchema>): OperationReceipt {
		const input = transitionSchema.parse(raw);
		const allowed: Record<
			OperationReceiptState,
			readonly OperationReceiptState[]
		> = {
			prepared: ["dispatched", "rejected"],
			dispatched: ["succeeded", "rejected", "unknown"],
			unknown: ["succeeded", "rejected"],
			succeeded: [],
			rejected: [],
		};
		if (!allowed[input.from].includes(input.to))
			throw new Error("invalid_receipt_transition");
		if (input.to === "succeeded" && !input.providerRef)
			throw new Error("provider_ref_required");
		return this.db
			.transaction(() => {
				const changed = this.db
					.prepare(
						`UPDATE lead_operation_receipts SET state=@to,provider_ref=COALESCE(@providerRef,provider_ref),error_code=@errorCode,updated_at=@now WHERE ${KEY_WHERE} AND input_digest=@inputDigest AND activation_id=@activationId AND state=@from AND updated_at<=@now`,
					)
					.run({
						...input,
						providerRef: input.providerRef ?? null,
						errorCode: input.errorCode ?? null,
					}).changes;
				if (changed !== 1) throw new Error("receipt_transition_conflict");
				return this.get({
					projectName: input.projectName,
					leadId: input.leadId,
					operationId: input.operationId,
					requestId: input.requestId,
				})!;
			})
			.immediate();
	}
	/** Parent startup only, after exclusive Lead ownership and before admission. Never resends. */
	recoverInterruptedParent(raw: {
		projectName: string;
		leadId: string;
		now: number;
	}): number {
		const input = scopeSchema.omit({ activationId: true }).parse(raw);
		return this.db
			.prepare(
				`UPDATE lead_operation_receipts SET state='unknown',error_code='dispatch_interrupted',updated_at=@now WHERE project_name=@projectName AND lead_id=@leadId AND state IN ('prepared','dispatched')`,
			)
			.run(input).changes;
	}
	/** Recovery for one explicitly stopped dispatcher. Never resends. */
	recoverDispatched(raw: z.infer<typeof scopeSchema>): number {
		const input = scopeSchema.parse(raw);
		return this.db
			.prepare(
				`UPDATE lead_operation_receipts SET state='unknown',error_code='dispatch_interrupted',updated_at=@now WHERE project_name=@projectName AND lead_id=@leadId AND activation_id=@activationId AND state='dispatched' AND updated_at<=@now`,
			)
			.run(input).changes;
	}
	/** Voice/session startup recovery is activation-scoped and must not touch the resident parent. */
	recoverInterruptedActivation(raw: z.infer<typeof scopeSchema>): number {
		const input = scopeSchema.parse(raw);
		return this.db
			.prepare(
				`UPDATE lead_operation_receipts
				 SET state='unknown',error_code='dispatch_interrupted',updated_at=@now
				 WHERE project_name=@projectName AND lead_id=@leadId
				 AND activation_id=@activationId AND state IN ('prepared','dispatched')
				 AND updated_at<=@now`,
			)
			.run(input).changes;
	}
	transaction<T>(work: () => T): T {
		return this.db.transaction(work)();
	}
}
