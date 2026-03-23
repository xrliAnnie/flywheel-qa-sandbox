import { CommDB } from "../db.js";

export interface AskArgs {
	lead: string;
	execId?: string;
	question: string;
	dbPath: string;
}

export function ask(args: AskArgs): string {
	const db = new CommDB(args.dbPath);
	try {
		const fromAgent = args.execId ?? "runner";
		const questionId = db.insertQuestion(fromAgent, args.lead, args.question);
		return questionId;
	} finally {
		db.close();
	}
}
