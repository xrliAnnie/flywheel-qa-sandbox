import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import { NON_FLAG_ALLOWLIST, RETIRED_FLAGS } from "../feature-flags/truth.js";

// FLY-709 F5: two-way drift guard. Keep the registry and the code in sync so a
// NEW `FLYWHEEL_*` boolean gate added to production code but not registered fails
// CI, and every registered env flag really is read where the registry claims.
//
// First version (Codex-endorsed): a SCOPED scan of production runtime `src`
// dirs (excludes tests/dist/node_modules). The forward direction (no silent new
// gate) uses a `process.env.FLYWHEEL_*` regex; plumbing / value / context vars
// are excluded via an allowlist WITH A REASON. The reverse direction (registered
// → read) checks the flag's declared readSite FILE actually contains the env var
// (robust to read form: process.env.X, injected `env.X`, destructured). A full
// AST scanner is a follow-up.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

const SCAN_DIRS = [
	"packages/teamlead/src",
	"packages/config/src",
	"packages/flywheel-comm/src",
	"packages/edge-worker/src",
];

/**
 * `FLYWHEEL_*` env vars that are NOT on/off feature gates — runtime context,
 * plumbing, ids, paths, tuning knobs, secrets, value config. Each MUST carry a
 * reason. If you add a real feature gate, register it instead of allowlisting.
 */
function walk(dir: string, out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) {
			if (e === "__tests__" || e === "node_modules" || e === "dist") continue;
			walk(p, out);
		} else if (
			e.endsWith(".ts") &&
			!e.endsWith(".test.ts") &&
			!e.endsWith(".d.ts")
		) {
			out.push(p);
		}
	}
}

// Direct `process.env.X` reads (broad — plumbing/value vars are allowlisted).
// PLUS injected `env.X` reads (function-parameter reads like
// `env.FLYWHEEL_STUCK_DETECT !== "0"`, which the process.env scan missed — Codex
// R1 HIGH), but ONLY anchored to a BOOLEAN-GATE comparison (=== / !== "0"|"1"|
// "true"|"false"). Matching every `env.X` catches dozens of injected config
// VALUES (channel ids, thresholds, paths) that are not gates — the boolean
// anchor isolates real on/off gates and keeps the guard low-noise.
const BOOL_CMP = String.raw`\s*(?:===|!==)\s*["'](?:0|1|true|false)["']`;
const ENV_PATTERNS = [
	/process\.env\.(FLYWHEEL_[A-Z0-9_]+)/g,
	/process\.env\[\s*["'](FLYWHEEL_[A-Z0-9_]+)["']\s*\]/g,
	new RegExp(String.raw`\benv\.(FLYWHEEL_[A-Z0-9_]+)` + BOOL_CMP, "g"),
	new RegExp(
		String.raw`\benv\[\s*["'](FLYWHEEL_[A-Z0-9_]+)["']\s*\]` + BOOL_CMP,
		"g",
	),
];

function scanFlywheelEnvNames(): Set<string> {
	const files: string[] = [];
	for (const d of SCAN_DIRS) walk(join(REPO_ROOT, d), files);
	const names = new Set<string>();
	for (const f of files) {
		const src = readFileSync(f, "utf-8");
		for (const re of ENV_PATTERNS) {
			re.lastIndex = 0;
			let m: RegExpExecArray | null = re.exec(src);
			while (m !== null) {
				names.add(m[1] as string);
				m = re.exec(src);
			}
		}
	}
	return names;
}

describe("feature-flag drift guard", () => {
	const registeredEnvVars = new Set(
		FEATURE_FLAGS.filter((f) => f.envVar).map((f) => f.envVar as string),
	);

	it("scanner finds FLYWHEEL_* env reads in production src", () => {
		const found = scanFlywheelEnvNames();
		expect(found.size).toBeGreaterThan(5);
		// a known gate read via direct process.env access
		expect(found.has("FLYWHEEL_HEARTBEAT_READOPT")).toBe(true);
	});

	it("every registered env flag is read where its readSite file claims", () => {
		const missing: string[] = [];
		for (const flag of FEATURE_FLAGS) {
			if (!flag.envVar) continue;
			const found = flag.readSites.some((s) => {
				try {
					return readFileSync(join(REPO_ROOT, s.file), "utf-8").includes(
						flag.envVar as string,
					);
				} catch {
					return false;
				}
			});
			if (!found) missing.push(`${flag.name} (${flag.envVar})`);
		}
		expect(
			missing,
			`registered but not found in readSite file: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("no silent new gate: every scanned FLYWHEEL_* is registered or allowlisted", () => {
		const found = scanFlywheelEnvNames();
		const unregistered = [...found].filter(
			(v) => !registeredEnvVars.has(v) && !(v in NON_FLAG_ALLOWLIST),
		);
		expect(
			unregistered,
			`new FLYWHEEL_* env not registered or allowlisted (register it, or add to NON_FLAG_ALLOWLIST with a reason): ${unregistered.join(", ")}`,
		).toEqual([]);
	});

	it("no retired tombstone is still read as a production boolean gate", () => {
		const found = scanFlywheelEnvNames();
		const revived = RETIRED_FLAGS.map((flag) => flag.envVar).filter((envVar) =>
			found.has(envVar),
		);
		expect(
			revived,
			`retired FLYWHEEL_* tombstone still has a production gate read: ${revived.join(", ")}`,
		).toEqual([]);
	});
});
