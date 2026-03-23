import { CommDB } from "../db.js";

export interface SendArgs {
	fromAgent: string;
	toAgent: string;
	content: string;
	dbPath: string;
}

export function send(args: SendArgs): string {
	const db = new CommDB(args.dbPath);
	try {
		return db.insertInstruction(args.fromAgent, args.toAgent, args.content);
	} finally {
		db.close();
	}
}
