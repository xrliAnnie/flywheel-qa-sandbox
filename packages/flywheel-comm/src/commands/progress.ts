import { CommDB } from "../db.js";
import {
	PIPELINE_STAGES,
	PROGRESS_STATUSES,
	type PipelineStage,
	type ProgressPayload,
	type ProgressStatus,
} from "../types.js";

export interface ProgressArgs {
	execId: string;
	stage: string;
	status: string;
	dbPath: string;
	artifact?: string;
}

export function progress(args: ProgressArgs): string | null {
	if (!PIPELINE_STAGES.includes(args.stage as PipelineStage)) {
		throw new Error(
			`Invalid stage: ${args.stage}. Valid stages: ${PIPELINE_STAGES.join(", ")}`,
		);
	}
	if (!PROGRESS_STATUSES.includes(args.status as ProgressStatus)) {
		throw new Error(
			`Invalid status: ${args.status}. Valid statuses: ${PROGRESS_STATUSES.join(", ")}`,
		);
	}

	let db: CommDB;
	try {
		db = new CommDB(args.dbPath, false);
	} catch {
		// DB doesn't exist or can't be opened — silently skip (best-effort reporting)
		return null;
	}

	try {
		const session = db.getSession(args.execId);
		if (!session || !session.lead_id) {
			return null;
		}

		const payload: ProgressPayload = {
			stage: args.stage as PipelineStage,
			status: args.status as ProgressStatus,
			executionId: args.execId,
			issueId: session.issue_id ?? undefined,
			artifact: args.artifact,
			timestamp: new Date().toISOString(),
		};

		return db.insertProgress(
			args.execId,
			session.lead_id,
			JSON.stringify(payload),
		);
	} finally {
		db.close();
	}
}
