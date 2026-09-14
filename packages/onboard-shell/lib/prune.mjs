import fs from "node:fs";
import path from "node:path";
import { isSafeVersion, versionPrefix } from "./config.mjs";
import { currentPkgRoot, verifyPkgRoot } from "./install.mjs";
import { previousGood, readLedger } from "./ledger.mjs";

export function pruneVersions(cfg) {
	const stored = readLedger(cfg);
	if (
		stored.state !== "valid" ||
		stored.ledger.applying !== null ||
		!["updated", "settled"].includes(stored.ledger.lastRun?.outcome)
	)
		return;
	const current = currentPkgRoot(cfg);
	if (!current) return;
	let ver;
	let previous;
	try {
		ver = fs
			.readFileSync(path.join(current, ".flywheel-prebuilt"), "utf8")
			.trim();
		verifyPkgRoot(current, ver);
		if (stored.ledger.lastRun.latest !== ver) return;
		previous = previousGood(cfg, stored.ledger, ver);
	} catch {
		return;
	}
	for (const name of fs.readdirSync(cfg.versionsDir)) {
		if (name === ver || name === previous?.ver || !isSafeVersion(name))
			continue;
		const prefix = versionPrefix(cfg, name);
		// Preserve an aliased current prefix even if its name differs from the sentinel.
		const real = fs.realpathSync(prefix);
		if (current === real || current.startsWith(`${real}${path.sep}`)) continue;
		fs.rmSync(prefix, { recursive: true, force: true });
	}
}
