import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import {
	type FlagStoreRuntime,
	storeNodeDwellEnabled,
	storeNodeDwellThresholdHours,
} from "./bridge/flag-store-runtime.js";
import { StateStore } from "./StateStore.js";

export type NodeDwellVerdict =
	| "normal"
	| "cleared"
	| "fixed"
	| "waiting_founder";

export interface NodeDwellReceiptTarget {
	runId: string;
	nodeId: string;
	attempt: number;
}

export interface WriteNodeDwellReviewBatchInput {
	dbPath: string;
	commDbPath: string;
	projectName: string;
	callerLeadId: string;
	environmentLeadId: string | undefined;
	verdict: NodeDwellVerdict;
	note?: string;
	items: readonly NodeDwellReceiptTarget[];
	/** Test seam only; production and the CLI always use the five-second bound. */
	busyTimeoutMs?: number;
}

export class ReceiptRejectedError extends Error {
	constructor(readonly token: string) {
		super(`RECEIPT_REJECTED ${token}`);
		this.name = "ReceiptRejectedError";
	}
}

export class ReceiptBusyError extends Error {
	constructor() {
		super("RECEIPT_BUSY");
		this.name = "ReceiptBusyError";
	}
}

function rejectReceipt(token: string): never {
	throw new ReceiptRejectedError(token);
}

function isBusyError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		String((error as { code?: unknown }).code).startsWith("SQLITE_BUSY")
	);
}

function resolveReceiptOwner(
	comm: Database.Database,
	input: {
		executionId: string | null;
		issueId: string;
		projectName: string;
	},
): string {
	if (input.executionId) {
		const exact = comm
			.prepare(
				`SELECT project_name, issue_id, lead_id
				   FROM sessions WHERE execution_id = ?`,
			)
			.get(input.executionId) as
			| {
					project_name: string;
					issue_id: string | null;
					lead_id: string | null;
			  }
			| undefined;
		if (exact) {
			if (
				exact.project_name !== input.projectName ||
				exact.issue_id !== input.issueId ||
				!exact.lead_id?.trim()
			) {
				rejectReceipt("owner_exact_mismatch");
			}
			return exact.lead_id.trim();
		}
	}

	const current = comm
		.prepare(
			`SELECT DISTINCT nullif(trim(lead_id),'') AS lead_id
			   FROM sessions
			  WHERE project_name = ? AND issue_id = ?
			    AND status IN ('running','blocked')`,
		)
		.all(input.projectName, input.issueId) as Array<{ lead_id: string | null }>;
	if (current.length === 1 && current[0]?.lead_id) return current[0].lead_id;
	if (current.length > 0) rejectReceipt("owner_current_ambiguous");

	if (input.executionId) {
		const lineage = comm
			.prepare(
				`SELECT project_name, issue_id, lead_id
				   FROM session_receipt_lineage
				  WHERE execution_id = ?
				    AND NOT EXISTS (
				      SELECT 1 FROM sessions
				       WHERE project_name = ? AND issue_id = ?
				    )`,
			)
			.get(input.executionId, input.projectName, input.issueId) as
			| {
					project_name: string;
					issue_id: string | null;
					lead_id: string | null;
			  }
			| undefined;
		if (lineage) {
			if (
				lineage.project_name !== input.projectName ||
				lineage.issue_id !== input.issueId ||
				!lineage.lead_id?.trim()
			) {
				rejectReceipt("owner_lineage_mismatch");
			}
			return lineage.lead_id.trim();
		}
	}

	const issueLineage = comm
		.prepare(
			`SELECT count(*) AS row_count,
			        count(nullif(trim(lead_id),'')) AS owner_count,
			        count(DISTINCT nullif(trim(lead_id),'')) AS distinct_owner_count,
			        min(nullif(trim(lead_id),'')) AS lead_id
			   FROM session_receipt_lineage
			  WHERE project_name = ? AND issue_id = ?
			    AND NOT EXISTS (
			      SELECT 1 FROM sessions
			       WHERE project_name = ? AND issue_id = ?
			    )`,
		)
		.get(
			input.projectName,
			input.issueId,
			input.projectName,
			input.issueId,
		) as {
		row_count: number;
		owner_count: number;
		distinct_owner_count: number;
		lead_id: string | null;
	};
	if (issueLineage.row_count > 0) {
		if (
			issueLineage.owner_count !== issueLineage.row_count ||
			issueLineage.distinct_owner_count !== 1 ||
			!issueLineage.lead_id
		) {
			rejectReceipt("owner_issue_lineage_ambiguous");
		}
		return issueLineage.lead_id;
	}

	const latest = comm
		.prepare(
			`SELECT DISTINCT nullif(trim(lead_id),'') AS lead_id
			   FROM sessions
			  WHERE project_name = ? AND issue_id = ?
			    AND started_at = (
			      SELECT max(started_at) FROM sessions
			       WHERE project_name = ? AND issue_id = ?
			    )`,
		)
		.all(
			input.projectName,
			input.issueId,
			input.projectName,
			input.issueId,
		) as Array<{ lead_id: string | null }>;
	if (latest.length === 1 && latest[0]?.lead_id) return latest[0].lead_id;
	rejectReceipt(latest.length > 0 ? "owner_latest_ambiguous" : "owner_missing");
}

export async function writeNodeDwellReviewBatch(
	input: WriteNodeDwellReviewBatchInput,
): Promise<{
	issueId: string;
	written: number;
	cycles: Array<{ nodeId: string; cycleNo: number }>;
}> {
	if (
		!input.environmentLeadId ||
		input.callerLeadId !== input.environmentLeadId
	) {
		rejectReceipt("lead_identity_mismatch");
	}
	if (!input.projectName.trim() || !input.callerLeadId.trim()) {
		rejectReceipt("identity_missing");
	}
	if (
		!["normal", "cleared", "fixed", "waiting_founder"].includes(input.verdict)
	) {
		rejectReceipt("verdict_invalid");
	}
	if (input.items.length === 0) rejectReceipt("batch_empty");
	const targetKeys = input.items.map(
		(item) => `${item.runId}\0${item.nodeId}\0${item.attempt}`,
	);
	if (new Set(targetKeys).size !== targetKeys.length) {
		rejectReceipt("target_duplicate");
	}
	for (const item of input.items) {
		if (
			!item.runId ||
			!item.nodeId ||
			!Number.isSafeInteger(item.attempt) ||
			item.attempt <= 0
		) {
			rejectReceipt("target_invalid");
		}
	}

	let state: Database.Database | undefined;
	let comm: Database.Database | undefined;
	try {
		state = new Database(input.dbPath, { fileMustExist: true });
		comm = new Database(input.commDbPath, {
			readonly: true,
			fileMustExist: true,
		});
		state.pragma(`busy_timeout = ${input.busyTimeoutMs ?? 5000}`);
		comm.pragma(`busy_timeout = ${input.busyTimeoutMs ?? 5000}`);
		state.pragma("foreign_keys = ON");

		const write = state.transaction(() => {
			let issueId: string | undefined;
			const cycles: Array<{ nodeId: string; cycleNo: number }> = [];
			for (const item of input.items) {
				const target = state!
					.prepare(
						`SELECT wr.issue_id, wr.project_name, wr.status AS run_status,
						        n.state, n.execution_id, n.ended_at
						   FROM workflow_run wr
						   JOIN workflow_run_node n ON n.run_id = wr.run_id
						  WHERE wr.run_id = ? AND n.node_id = ? AND n.attempt = ?`,
					)
					.get(item.runId, item.nodeId, item.attempt) as
					| {
							issue_id: string;
							project_name: string;
							run_status: string;
							state: string;
							execution_id: string | null;
							ended_at: string | null;
					  }
					| undefined;
				if (
					!target ||
					target.project_name !== input.projectName ||
					target.run_status !== "active" ||
					target.ended_at !== null ||
					!["running", "review", "admitted"].includes(target.state)
				) {
					rejectReceipt("target_not_active");
				}
				if (issueId !== undefined && issueId !== target.issue_id) {
					rejectReceipt("batch_cross_issue");
				}
				issueId = target.issue_id;
				const owner = resolveReceiptOwner(comm!, {
					executionId: target.execution_id,
					issueId: target.issue_id,
					projectName: input.projectName,
				});
				if (owner !== input.callerLeadId) rejectReceipt("owner_mismatch");
				const prior = state!
					.prepare(
						`SELECT coalesce(max(cycle_no), 0) AS cycle_no
						   FROM node_dwell_review
						  WHERE run_id = ? AND node_id = ? AND attempt = ?`,
					)
					.get(item.runId, item.nodeId, item.attempt) as { cycle_no: number };
				const cycleNo = prior.cycle_no + 1;
				state!
					.prepare(
						`INSERT INTO node_dwell_review (
						   run_id,node_id,attempt,cycle_no,verdict,
						   examined_at,examined_by,note
						 ) VALUES (?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,?)`,
					)
					.run(
						item.runId,
						item.nodeId,
						item.attempt,
						cycleNo,
						input.verdict,
						input.callerLeadId,
						input.note?.trim() || null,
					);
				cycles.push({ nodeId: item.nodeId, cycleNo });
			}
			return { issueId: issueId!, written: cycles.length, cycles };
		});
		return write.immediate();
	} catch (error) {
		if (error instanceof ReceiptRejectedError) throw error;
		if (isBusyError(error)) throw new ReceiptBusyError();
		throw new ReceiptRejectedError("database_error");
	} finally {
		comm?.close();
		state?.close();
	}
}

function maintenanceFailureToken(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	if (
		detail.includes("node dwell threshold must be positive decimal hours") ||
		detail.includes("managed node dwell threshold is not positive finite hours")
	) {
		return "NODE_DWELL_UNAVAILABLE threshold_invalid";
	}
	if (/no such (?:table|column):/i.test(detail)) {
		return "NODE_DWELL_UNAVAILABLE maintenance_schema_mismatch";
	}
	const token = detail.match(/maintenance_[a-z_]+/)?.[0] ?? "unexpected_error";
	return `NODE_DWELL_UNAVAILABLE ${token}`;
}

export interface OpenApproveGate {
	questionId: string;
	fromAgent: string;
}

export function readOpenApproveGates(commDbPath: string): OpenApproveGate[] {
	let comm: CommDB | undefined;
	try {
		comm = CommDB.openReadonly(commDbPath);
		return comm.getOpenGatesByCheckpoint("approve_to_ship").map((gate) => {
			if (!gate.id || !gate.from_agent) {
				throw new Error("question_domain_invalid");
			}
			return { questionId: gate.id, fromAgent: gate.from_agent };
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const token = detail.includes("question_domain_invalid")
			? "question_domain_invalid"
			: "question_domain_unavailable";
		throw new Error(`NODE_DWELL_UNAVAILABLE ${token}`);
	} finally {
		comm?.close();
	}
}

/**
 * Read the live project-scoped threshold without creating or migrating the
 * production database. The patrol invokes this on every tick so project and
 * wildcard changes take effect without a Bridge restart.
 */
export async function readNodeDwellThresholdHours(
	dbPath: string,
	projectName: string,
): Promise<number> {
	let store: StateStore | undefined;
	try {
		store = await StateStore.openForMaintenance(dbPath, { readonly: true });
		const runtime: FlagStoreRuntime = { mode: "ready", store };
		return storeNodeDwellThresholdHours(runtime, projectName);
	} catch (error) {
		throw new Error(maintenanceFailureToken(error));
	} finally {
		store?.close();
	}
}

export async function readNodeDwellEnabled(
	dbPath: string,
	projectName: string,
): Promise<boolean> {
	let store: StateStore | undefined;
	try {
		store = await StateStore.openForMaintenance(dbPath, { readonly: true });
		const runtime: FlagStoreRuntime = { mode: "ready", store };
		return storeNodeDwellEnabled(runtime, projectName);
	} catch (error) {
		throw new Error(maintenanceFailureToken(error));
	} finally {
		store?.close();
	}
}

export interface NodeDwellControlIo {
	stdout(line: string): void;
	stderr(line: string): void;
}

export interface NodeDwellControlContext {
	environmentLeadId: string | undefined;
	readStdin(): string;
}

function option(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0 || index + 1 >= args.length) return undefined;
	return args[index + 1];
}

export async function runNodeDwellControl(
	args: readonly string[],
	io: NodeDwellControlIo = {
		stdout: (line) => process.stdout.write(`${line}\n`),
		stderr: (line) => process.stderr.write(`${line}\n`),
	},
	context: NodeDwellControlContext = {
		environmentLeadId: process.env.FLYWHEEL_LEAD_ID,
		readStdin: () => readFileSync(0, "utf8"),
	},
): Promise<number> {
	const [command] = args;
	if (
		command !== "enabled" &&
		command !== "threshold" &&
		command !== "receipt-batch" &&
		command !== "open-approve-gates"
	) {
		io.stderr(
			"usage: flywheel-node-dwell-control enabled|threshold --db <teamlead.db> --project <name> | open-approve-gates --comm-db <comm.db> | receipt-batch --db <teamlead.db> --comm-db <comm.db> --project <name> --lead <id> --verdict <value> [--note <text>]",
		);
		return 64;
	}
	if (command === "open-approve-gates") {
		const commDbPath = option(args, "--comm-db");
		if (!commDbPath) {
			io.stderr("NODE_DWELL_UNAVAILABLE invalid_arguments");
			return 64;
		}
		try {
			const gates = readOpenApproveGates(commDbPath);
			for (const gate of gates) {
				io.stdout(
					`NODE_DWELL_OPEN_APPROVE_GATE id_hex=${Buffer.from(gate.questionId, "utf8").toString("hex")} from_hex=${Buffer.from(gate.fromAgent, "utf8").toString("hex")}`,
				);
			}
			io.stdout(`NODE_DWELL_OPEN_APPROVE_GATES count=${gates.length}`);
			return 0;
		} catch (error) {
			io.stderr(error instanceof Error ? error.message : String(error));
			return 70;
		}
	}
	const dbPath = option(args, "--db");
	const projectName = option(args, "--project");
	if (!dbPath || !projectName?.trim()) {
		io.stderr("NODE_DWELL_UNAVAILABLE invalid_arguments");
		return 64;
	}
	if (command === "receipt-batch") {
		const commDbPath = option(args, "--comm-db");
		const callerLeadId = option(args, "--lead");
		const verdict = option(args, "--verdict");
		if (
			!commDbPath ||
			!callerLeadId?.trim() ||
			!verdict ||
			!["normal", "cleared", "fixed", "waiting_founder"].includes(verdict)
		) {
			io.stderr("RECEIPT_REJECTED invalid_arguments");
			return 64;
		}
		let body: unknown;
		try {
			body = JSON.parse(context.readStdin());
		} catch {
			io.stderr("RECEIPT_REJECTED invalid_json");
			return 65;
		}
		const items =
			body &&
			typeof body === "object" &&
			Array.isArray(Reflect.get(body, "items"))
				? (Reflect.get(body, "items") as unknown[])
				: undefined;
		if (
			!items ||
			!items.every(
				(item): item is NodeDwellReceiptTarget =>
					item !== null &&
					typeof item === "object" &&
					typeof Reflect.get(item, "runId") === "string" &&
					typeof Reflect.get(item, "nodeId") === "string" &&
					typeof Reflect.get(item, "attempt") === "number",
			)
		) {
			io.stderr("RECEIPT_REJECTED invalid_batch");
			return 65;
		}
		try {
			const result = await writeNodeDwellReviewBatch({
				dbPath,
				commDbPath,
				projectName: projectName.trim(),
				callerLeadId: callerLeadId.trim(),
				environmentLeadId: context.environmentLeadId,
				verdict: verdict as NodeDwellVerdict,
				note: option(args, "--note"),
				items,
			});
			io.stdout(
				`RECEIPT_BATCH_OK issue=${result.issueId} written=${result.written} cycles=${result.cycles
					.map(({ nodeId, cycleNo }) => `${nodeId}:${cycleNo}`)
					.join(",")}`,
			);
			return 0;
		} catch (error) {
			io.stderr(error instanceof Error ? error.message : String(error));
			return error instanceof ReceiptBusyError ? 75 : 65;
		}
	}
	if (command === "enabled") {
		try {
			const enabled = await readNodeDwellEnabled(dbPath, projectName.trim());
			io.stdout(
				`NODE_DWELL_ENABLED project=${projectName.trim()} enabled=${enabled ? "yes" : "no"}`,
			);
			return 0;
		} catch (error) {
			io.stderr(error instanceof Error ? error.message : String(error));
			return 70;
		}
	}
	try {
		const hours = await readNodeDwellThresholdHours(dbPath, projectName.trim());
		io.stdout(
			`NODE_DWELL_THRESHOLD project=${projectName.trim()} hours=${hours}`,
		);
		return 0;
	} catch (error) {
		io.stderr(error instanceof Error ? error.message : String(error));
		return 70;
	}
}
