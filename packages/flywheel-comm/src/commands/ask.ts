import { CommDB } from "../db.js";

export interface AskArgs {
	lead: string;
	execId?: string;
	question: string;
	dbPath: string;
}

/**
 * Non-blocking question.
 *
 * FLY-161: Bridge's GatePoller picks this up within ≤1 poll tick (~3s default)
 * and emits a `runner_question` event to the Lead. The Lead notifies Annie
 * but the Runner does NOT wait for a response — the Runner should keep working
 * on other parts of the task. Use `gate` (with a checkpoint) instead when the
 * Runner needs to block until the Lead responds.
 */
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
