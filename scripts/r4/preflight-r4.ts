#!/usr/bin/env npx tsx

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CommDB } from "../../packages/flywheel-comm/src/db.js";

const shards = [
	"flywheel",
	"geoforge3d",
	"growth",
	"joycon-typeless",
	"personal-assistant",
	"sub",
	"tidal-echo",
] as const;

const root =
	process.env.FLYWHEEL_COMM_ROOT ?? join(homedir(), ".flywheel", "comm");
let failed = false;

for (const shard of shards) {
	const dbPath = join(root, shard, "comm.db");
	try {
		// flywheel survives Phase M-reset, so a missing canonical DB there is data
		// loss and must fail closed. The six reset shards are intentionally absent
		// and become virgin mailbox DBs here. Verification never archives/purges.
		const createIfMissing = shard !== "flywheel";
		const db = new CommDB(dbPath, createIfMissing, false);
		db.close();
		for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
			if (!existsSync(path)) continue;
			const mode = statSync(path).mode & 0o777;
			if ((mode & 0o200) === 0) {
				throw new Error(
					`canonical file is not owner-writable: ${path} mode=${mode.toString(8).padStart(4, "0")}`,
				);
			}
		}
		console.log(`PREFLIGHT OK   ${shard}`);
	} catch (error) {
		failed = true;
		console.error(
			`PREFLIGHT FAIL ${shard}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

process.exitCode = failed ? 1 : 0;
