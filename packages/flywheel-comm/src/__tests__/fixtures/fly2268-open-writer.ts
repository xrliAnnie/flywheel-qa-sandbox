import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { CommDB } from "../../db.js";

const [dbPath, executionId, readyPath, startPath] = process.argv.slice(2);
if (!dbPath || !executionId || !readyPath || !startPath) {
	throw new Error("dbPath, executionId, readyPath, and startPath are required");
}

writeFileSync(readyPath, executionId, "utf8");
while (!existsSync(startPath)) await delay(5);

const db = new CommDB(dbPath);
try {
	db.insertInstruction("lead", executionId, `concurrent-${executionId}`);
} finally {
	db.close();
}
