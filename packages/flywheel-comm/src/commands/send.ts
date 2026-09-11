import { randomUUID } from "node:crypto";
import { CommDB } from "../db.js";
import {
	authorizeLeadWrite,
	type LeadWriteAuthorizationDeps,
} from "../lead-lease.js";
import {
	createStateStoreSnapshotReader,
	resolveRunnerRecipient,
	type StateStoreSnapshotReader,
} from "../recipient-resolve.js";

export interface SendArgs {
	fromAgent: string;
	toAgent: string;
	content: string;
	dbPath: string;
	env?: NodeJS.ProcessEnv;
	authorizationDeps?: LeadWriteAuthorizationDeps;
	stateStore?: StateStoreSnapshotReader;
}

/** Persist one Lead → Runner instruction; the Bridge Runner lane owns delivery. */
export async function send(args: SendArgs): Promise<string> {
	return (await sendDetailed(args)).id;
}

export async function sendDetailed(
	args: SendArgs,
): Promise<{ id: string; resolvedTo: string; resolvedFromPrefix: boolean }> {
	const authorization = authorizeLeadWrite(
		{ claimedLeadId: args.fromAgent, env: args.env },
		args.authorizationDeps,
	);
	const db = new CommDB(args.dbPath);
	try {
		const recipient = resolveRunnerRecipient(
			{
				commDb: db,
				stateStore: args.stateStore ?? createStateStoreSnapshotReader(args.env),
			},
			args.toAgent,
		);
		const resolvedTo =
			recipient.kind === "lead" ? recipient.toAgent : recipient.executionId;
		if (recipient.kind === "runner" && recipient.livenessWarning)
			console.error(`liveness_unverified: ${recipient.livenessWarning}`);
		const id = randomUUID();
		db.insertInstructionWithId(
			id,
			args.fromAgent,
			resolvedTo,
			args.content,
			authorization.provenance,
		);
		db.clearDeclaredState(resolvedTo);
		return {
			id,
			resolvedTo,
			resolvedFromPrefix:
				recipient.kind === "runner" && recipient.resolvedFromPrefix,
		};
	} finally {
		db.close();
	}
}
