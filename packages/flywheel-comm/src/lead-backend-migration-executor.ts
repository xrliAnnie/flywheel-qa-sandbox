/** Fixed FLY-2459 window sequence. No verifier or business dispatch runs inside it. */
export const MIGRATION_STEPS = [
	"preflight",
	"stop",
	"configure",
	"stage_manifest",
	"stage_plist",
	"seed",
	"activate",
] as const;
export type MigrationStep = (typeof MIGRATION_STEPS)[number];
/** Only the pre-activation generic preflight may select the Lead-authorized recovery path. */
export class MigrationActivationPreflightError extends Error {
	constructor() {
		super("migration activation preflight failed");
	}
}
export interface MigrationExecutionReceipt {
	version: 1;
	intentSha: string;
	revision: number;
	status:
		| "executing"
		| "held"
		| "deployed_unverified"
		| "failed"
		| "verified"
		| "committed";
	verification?: { evidenceSha: string; proofSha: string };
	pending: MigrationStep | null;
	completed: Partial<Record<MigrationStep, string>>;
	failure: "step_failed" | null;
	sourceCarrier?: { pid: number; start: string };
	recovery?: {
		reason: "activation_preflight_failed";
		state: "pending" | "restored";
		proofSha: string | null;
	};
}
export interface MigrationObservation {
	state: "pre" | "post" | "conflict";
	proofSha: string;
}
export interface MigrationExecutorDeps {
	/** Capture the actual old carrier while the source identity is still active. */
	captureSourceCarrier(): Promise<{ pid: number; start: string }>;
	/** Must verify the existing owner-qualified restart/admission authority, never the intent alone. */
	verifyWindow(): Promise<void>;
	load(): MigrationExecutionReceipt | null;
	/** Durable CAS against previousRevision, with fsync before return. */
	save(
		receipt: MigrationExecutionReceipt,
		previousRevision: number | null,
	): void | Promise<void>;
	/** Read actual artifacts/process/cursor evidence; never infer it from the receipt phase. */
	observe(step: MigrationStep): Promise<MigrationObservation>;
	/** One bounded attempt, restricted to this target; stage actions must recognize partial postimages. */
	apply(step: MigrationStep): Promise<void>;
	/** Conditional CAS restoration and old-owner recovery; re-observe real state on every replay. */
	restoreSource?(): Promise<string>;
}
const HASH = /^[a-f0-9]{64}$/;
export async function executeBackendMigration(
	intentSha: string,
	deps: MigrationExecutorDeps,
): Promise<MigrationExecutionReceipt> {
	if (!HASH.test(intentSha)) throw new Error("invalid migration intent hash");
	await deps.verifyWindow();
	let current = deps.load();
	if (
		current &&
		(current.version !== 1 ||
			current.intentSha !== intentSha ||
			!Number.isSafeInteger(current.revision) ||
			current.revision < 0)
	)
		throw new Error("migration receipt intent conflict");
	if (current?.verification)
		throw new Error(
			"migration already finalized; reconcile outside restart window",
		);
	let receipt: MigrationExecutionReceipt = current
		? structuredClone(current)
		: {
				version: 1,
				intentSha,
				revision: 0,
				status: "executing",
				pending: null,
				completed: {},
				failure: null,
			};
	const persist = async (patch: Partial<MigrationExecutionReceipt>) => {
		const next = {
			...receipt,
			...patch,
			revision: current ? current.revision + 1 : 0,
		};
		await deps.save(next, current?.revision ?? null);
		current = structuredClone(next);
		receipt = next;
	};
	const restore = async () => {
		await deps.verifyWindow();
		if (!deps.restoreSource)
			throw new Error("migration source restoration unavailable");
		const proofSha = await deps.restoreSource();
		if (!HASH.test(proofSha))
			throw new Error("migration source restoration unproven");
		await persist({
			status: "failed",
			pending: null,
			failure: "step_failed",
			recovery: {
				reason: "activation_preflight_failed",
				state: "restored",
				proofSha,
			},
		});
		return receipt;
	};
	try {
		// Once recovery is selected, a resumed execution must never re-enter forward migration.
		if (receipt.recovery) return await restore();
		for (const step of MIGRATION_STEPS) {
			await deps.verifyWindow();
			if (step === "stop" && !receipt.sourceCarrier) {
				if (receipt.completed.stop || receipt.pending === "stop")
					throw new Error(
						"migration interrupted stop has no source carrier evidence",
					);
				const sourceCarrier = await deps.captureSourceCarrier();
				if (
					!Number.isSafeInteger(sourceCarrier.pid) ||
					sourceCarrier.pid <= 0 ||
					typeof sourceCarrier.start !== "string" ||
					!sourceCarrier.start.trim() ||
					sourceCarrier.start.length > 128
				)
					throw new Error("migration source carrier unproven");
				await persist({ sourceCarrier });
			}
			const observed = await deps.observe(step);
			if (!HASH.test(observed.proofSha))
				throw new Error("invalid migration observation proof");
			if (
				observed.state === "conflict" ||
				(receipt.completed[step] && observed.state !== "post")
			)
				throw new Error(`migration ${step} conflict`);
			if (observed.state === "post") {
				if (
					receipt.completed[step] !== observed.proofSha ||
					receipt.pending === step
				) {
					await persist({
						status: "executing",
						pending: null,
						completed: { ...receipt.completed, [step]: observed.proofSha },
						failure: null,
					});
				}
				continue;
			}
			await persist({ status: "executing", pending: step, failure: null });
			await deps.verifyWindow();
			try {
				await deps.apply(step);
			} catch (error) {
				if (
					step !== "activate" ||
					!(error instanceof MigrationActivationPreflightError)
				)
					throw error;
				await persist({
					status: "held",
					failure: "step_failed",
					recovery: {
						reason: "activation_preflight_failed",
						state: "pending",
						proofSha: null,
					},
				});
				return await restore();
			}
			const after = await deps.observe(step);
			if (after.state !== "post" || !HASH.test(after.proofSha))
				throw new Error(`migration ${step} postimage unproven`);
			await persist({
				pending: null,
				completed: { ...receipt.completed, [step]: after.proofSha },
			});
		}
		if (receipt.status !== "deployed_unverified")
			await persist({
				status: "deployed_unverified",
				pending: null,
				failure: null,
			});
		return receipt;
	} catch (error) {
		// Only the explicitly classified preflight failure above selects restoration.
		// Never persist exception text: it may contain credentials.
		await persist({ status: "held", failure: "step_failed" });
		throw error;
	}
}
