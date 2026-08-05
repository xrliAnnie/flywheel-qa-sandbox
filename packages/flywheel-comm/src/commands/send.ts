import { randomUUID } from "node:crypto";
import { CommDB } from "../db.js";
import {
	authorizeLeadWrite,
	type LeadWriteAuthorizationDeps,
} from "../lead-lease.js";

export interface SendArgs {
	fromAgent: string;
	toAgent: string;
	content: string;
	dbPath: string;
	env?: NodeJS.ProcessEnv;
	authorizationDeps?: LeadWriteAuthorizationDeps;
}

/** Persist one Lead → Runner instruction; the Bridge Runner lane owns delivery. */
export async function send(args: SendArgs): Promise<string> {
	const authorization = authorizeLeadWrite(
		{ claimedLeadId: args.fromAgent, env: args.env },
		args.authorizationDeps,
	);
	const db = new CommDB(args.dbPath);
	try {
		const id = randomUUID();
		db.insertInstructionWithId(
			id,
			args.fromAgent,
			args.toAgent,
			args.content,
			authorization.provenance,
		);
		db.clearDeclaredState(args.toAgent);
		return id;
	} finally {
		db.close();
	}
}
