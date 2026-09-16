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
const KEY_WHERE =
	"project_name=@projectName AND lead_id=@leadId AND operation_id=@operationId AND request_id=@requestId";
interface ReceiptRow {
	project_name: string;
	lead_id: string;
	operation_id: string;
	request_id: string;
	input_digest: string;
	activation_id: string;
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
}
/** Owns no connection. Journal.close() closes this store too. Callers are trusted broker code, never model input. */
export class OperationReceiptStore {
	constructor(private readonly db: Database.Database) {}
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
							`INSERT INTO lead_operation_receipts (project_name,lead_id,operation_id,request_id,input_digest,activation_id,state,started_at,updated_at) VALUES (@projectName,@leadId,@operationId,@requestId,@inputDigest,@activationId,'prepared',@now,@now) ON CONFLICT(project_name,lead_id,operation_id,request_id) DO NOTHING`,
						)
						.run(input).changes === 1;
				const receipt = this.get({
					projectName: input.projectName,
					leadId: input.leadId,
					operationId: input.operationId,
					requestId: input.requestId,
				})!;
				if (receipt.inputDigest !== input.inputDigest)
					throw new Error("input_digest_conflict");
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
	transaction<T>(work: () => T): T {
		return this.db.transaction(work)();
	}
}
