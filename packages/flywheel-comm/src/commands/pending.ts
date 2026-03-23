import { CommDB } from "../db.js";
import type { PendingQuestion } from "../types.js";

export interface PendingArgs {
	lead: string;
	dbPath: string;
}

export function pending(args: PendingArgs): PendingQuestion[] {
	const db = new CommDB(args.dbPath, false);
	try {
		const questions = db.getPendingQuestions(args.lead);
		return questions.map((q) => ({
			id: q.id,
			from_agent: q.from_agent,
			content: q.content,
			created_at: q.created_at,
		}));
	} finally {
		db.close();
	}
}
