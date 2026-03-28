#!/usr/bin/env tsx
import { CommDB } from "../packages/flywheel-comm/src/db.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROJECT = "e2e-stale-demo";
const dir = join(homedir(), ".flywheel", "comm", PROJECT);
mkdirSync(dir, { recursive: true });

const db = new CommDB(join(dir, "comm.db"));
db.registerSession(
	"exec-demo-stale",
	"GEO-E2E-STALE:@0",
	PROJECT,
	"GEO-E2E-270",
	"product-lead",
);
db.updateSessionStatus("exec-demo-stale", "completed");
db.close();

console.log("CommDB 写入完成 ✅");
console.log("  execution_id: exec-demo-stale");
console.log("  tmux_window:  GEO-E2E-STALE:@0");
console.log("  status:       completed");
