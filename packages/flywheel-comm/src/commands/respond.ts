import { CommDB } from "../db.js";

export interface RespondArgs {
  questionId: string;
  answer: string;
  dbPath: string;
}

export function respond(args: RespondArgs): void {
  const db = new CommDB(args.dbPath);
  try {
    db.insertResponse(args.questionId, "lead", args.answer);
  } finally {
    db.close();
  }
}
