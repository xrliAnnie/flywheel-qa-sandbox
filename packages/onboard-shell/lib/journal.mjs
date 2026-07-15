// FLY-1062 PR2 · resume journal — records the installed version (a
// NON-SENSITIVE key). The license key NEVER touches this file. A re-run reads
// it back so a fresh shell knows what is already in place.
import fs from "node:fs";
import path from "node:path";

function journalPath(cfg) {
	return path.join(cfg.stateDir, "onboard-journal.json");
}

export function readJournal(cfg) {
	try {
		return JSON.parse(fs.readFileSync(journalPath(cfg), "utf8"));
	} catch {
		return {};
	}
}

// recordVersion <cfg> <ver> — merge {installedVersion} without ever writing a
// key. Atomic (tmp+rename), 0644 (non-secret).
export function recordVersion(cfg, ver, now = Date.now()) {
	fs.mkdirSync(cfg.stateDir, { recursive: true });
	const j = readJournal(cfg);
	j.installedVersion = ver;
	j.updatedAt = now;
	const p = journalPath(cfg);
	const tmp = `${p}.tmp.${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(j, null, 2)}\n`);
	fs.renameSync(tmp, p);
}
