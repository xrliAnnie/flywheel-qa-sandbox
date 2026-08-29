#!/usr/bin/env node
/**
 * FLY-182 Track B §4.6 — one-time cleanup of the legacy alert-queue backlog.
 *
 * Production accumulated ~1669 `~/.flywheel/alert-queue/*.json` files, 100%
 * `queueReason:"no-channel"` — PERMANENT failures that the old drainQueue
 * retried forever at sent=0. This moves permanent-reason files to the
 * dead-letter dir (kept for audit), after backing up the WHOLE queue dir to a
 * tarball. Transient files (e.g. discord-5xx) are left for normal drain.
 *
 * Report-only by default; pass --apply to actually move. Run ONCE at ship time
 * (per plan §5: stop Bridge/drain → run this → enable alertFallbackToCore →
 * restart) so the legacy backlog can never flood core after the config flip.
 *
 * Usage:
 *   node scripts/alert-queue-drain-permanent.mjs            # report-only
 *   node scripts/alert-queue-drain-permanent.mjs --apply    # back up + move
 */

import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PERMANENT_QUEUE_REASONS = new Set([
	"no-channel",
	"no-token",
	"unknown-lead",
]);

const apply = process.argv.includes("--apply");
const queueDir =
	process.env.FLYWHEEL_ALERT_QUEUE_DIR ??
	join(homedir(), ".flywheel", "alert-queue");
const deadLetterDir =
	process.env.FLYWHEEL_ALERT_DEADLETTER_DIR ??
	join(homedir(), ".flywheel", "alert-deadletter");

function classify(file) {
	try {
		const parsed = JSON.parse(readFileSync(join(queueDir, file), "utf-8"));
		if (parsed.queueReason && PERMANENT_QUEUE_REASONS.has(parsed.queueReason)) {
			return { permanent: true, reason: parsed.queueReason };
		}
		return { permanent: false, reason: parsed.queueReason ?? "unknown" };
	} catch {
		// Malformed → permanent (can never be delivered).
		return { permanent: true, reason: "malformed" };
	}
}

async function main() {
	let files;
	try {
		files = readdirSync(queueDir).filter((f) => f.endsWith(".json"));
	} catch (err) {
		console.log(`No alert-queue at ${queueDir} (${err?.message ?? err}).`);
		return;
	}

	const byReason = new Map();
	const permanentFiles = [];
	for (const f of files) {
		const c = classify(f);
		byReason.set(c.reason, (byReason.get(c.reason) ?? 0) + 1);
		if (c.permanent) permanentFiles.push({ file: f, reason: c.reason });
	}

	console.log(
		`=== alert-queue-drain-permanent (${apply ? "APPLY" : "DRY-RUN"}) ===`,
	);
	console.log(`queueDir: ${queueDir}`);
	console.log(`total files: ${files.length}`);
	for (const [reason, n] of [...byReason.entries()].sort(
		(a, b) => b[1] - a[1],
	)) {
		console.log(`  ${reason}: ${n}`);
	}
	console.log(`permanent (to dead-letter): ${permanentFiles.length}`);
	console.log(
		`transient (left for drain): ${files.length - permanentFiles.length}`,
	);

	if (!apply) {
		console.log(
			"\nDRY-RUN — nothing moved. Re-run with --apply to back up + move.",
		);
		return;
	}
	if (permanentFiles.length === 0) {
		console.log("\nNothing permanent to move.");
		return;
	}

	// Back up the WHOLE queue dir first.
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const backupDir = join(homedir(), ".flywheel", "backups");
	mkdirSync(backupDir, { recursive: true });
	const tarball = join(backupDir, `alert-queue-${ts}.tar.gz`);
	console.log(`\nBacking up ${queueDir} → ${tarball} ...`);
	// Derive the tar root from the ACTUAL queueDir (honors an overridden
	// FLYWHEEL_ALERT_QUEUE_DIR) so we never move files we didn't back up.
	await execFileAsync("tar", [
		"czf",
		tarball,
		"-C",
		dirname(queueDir),
		"--",
		basename(queueDir),
	]);

	mkdirSync(deadLetterDir, { recursive: true });
	let moved = 0;
	for (const { file, reason } of permanentFiles) {
		try {
			renameSync(
				join(queueDir, file),
				join(deadLetterDir, `permanent-${reason}-${file}`),
			);
			moved++;
		} catch (err) {
			console.warn(`  failed to move ${file}: ${err?.message ?? err}`);
		}
	}
	console.log(
		`\nDONE: moved ${moved} permanent file(s) to ${deadLetterDir} (backup at ${tarball}).`,
	);
}

main().catch((err) => {
	console.error(`alert-queue-drain-permanent failed: ${err?.stack ?? err}`);
	process.exit(1);
});
