#!/usr/bin/env tsx
/**
 * GEO-270: Standalone CLI for cleaning up stale tmux sessions.
 *
 * Scans all CommDB files (~/.flywheel/comm/STAR/comm.db) for completed/timeout
 * sessions that have exceeded the cleanup timeout, then kills their tmux windows
 * if no client is attached.
 *
 * Usage:
 *   npx tsx scripts/cleanup-sessions.ts [--timeout 30] [--dry-run]
 */
import { cleanupStaleSessions } from "../packages/flywheel-comm/src/cleanup.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const timeoutIdx = args.indexOf("--timeout");
const timeoutMinutes =
	timeoutIdx >= 0 ? parseInt(args[timeoutIdx + 1], 10) : 30;

if (isNaN(timeoutMinutes) || timeoutMinutes < 1) {
	console.error("Error: --timeout must be a positive integer");
	process.exit(1);
}

console.log(
	`Cleaning stale sessions (timeout: ${timeoutMinutes}min${dryRun ? ", dry-run" : ""})...\n`,
);

const result = cleanupStaleSessions({
	timeoutMinutes,
	dryRun,
	log: console.log,
});

console.log(`\nResult: ${result.cleaned} cleaned, ${result.skipped} skipped`);
if (result.warnings.length > 0) {
	console.log(`Warnings: ${result.warnings.join(", ")}`);
}
if (result.errors.length > 0) {
	console.error(`Errors (${result.errors.length}):`);
	for (const e of result.errors) console.error(`  - ${e}`);
	process.exit(1);
}
