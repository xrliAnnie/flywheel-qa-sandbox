import { CommDB } from "../db.js";

export interface RespondArgs {
	questionId: string;
	fromAgent: string;
	answer: string;
	dbPath: string;
}

export function respond(args: RespondArgs): void {
	const db = new CommDB(args.dbPath, false);
	try {
		db.insertResponse(args.questionId, args.fromAgent, args.answer);
	} finally {
		db.close();
	}
}
