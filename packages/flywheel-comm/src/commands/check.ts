import { CommDB } from "../db.js";
import type { CheckResult } from "../types.js";

export interface CheckArgs {
  questionId: string;
  dbPath: string;
}

export function check(args: CheckArgs): CheckResult {
  let db: CommDB;
  try {
    db = new CommDB(args.dbPath, false);
  } catch {
    // DB doesn't exist yet — no response possible
    return { status: "pending" };
  }
  try {
    const response = db.getResponse(args.questionId);
    if (response) {
      return {
        status: "answered",
        content: response.content,
        from_agent: response.from_agent,
        created_at: response.created_at,
      };
    }
    return { status: "pending" };
  } finally {
    db.close();
  }
}
