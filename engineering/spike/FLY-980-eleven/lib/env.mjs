// FLY-980 — load ~/.flywheel/.env into process.env (existing vars win).
// Secrets stay in the env file: never in argv, never logged (FLY-510 纪律).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadFlywheelEnv() {
	const file = join(homedir(), ".flywheel", ".env");
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return; // no env file — callers validate the specific keys they need
	}
	for (const line of raw.split("\n")) {
		const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!m) continue;
		const [, name, valueRaw] = m;
		if (process.env[name] !== undefined) continue;
		let value = valueRaw.trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		process.env[name] = value;
	}
}
