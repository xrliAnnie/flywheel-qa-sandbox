import { existsSync } from "node:fs";
import { CommDB } from "../db.js";
import type { CheckResult } from "../types.js";

export interface CheckArgs {
  questionId: string;
  dbPath: string;
}

export function check(args: CheckArgs): CheckResult {
  // DB not existing is expected (ask hasn't been called yet) — return pending.
  // Other errors (permissions, corrupt DB) should propagate.
  if (!existsSync(args.dbPath)) {
    return { status: "pending" };
  }
  const db = new CommDB(args.dbPath, false);
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
