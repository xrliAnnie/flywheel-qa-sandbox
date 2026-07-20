/**
 * FLY-1356: split-participation reader — a FRESH config read at every
 * dispatch resolution (only consulted when the Bridge-global flag is
 * `split`), so a Lead adding `skill_framework.split: false` pulls the
 * project out immediately, no restart.
 *
 * Contract (Blueprint catches throws and pins the project to A + warn):
 *   - ENOENT / absent `skill_framework` key / bare `skill_framework:`
 *     (parses as null) → participate (default true)
 *   - `skill_framework` present but NOT a plain mapping → THROW — malformed
 *     config must fail closed, never be read as the permissive default.
 *     WHITELIST semantics (Codex R2 structural ruling after R1's blacklist
 *     was bypassed twice): only a plain record (prototype Object.prototype
 *     or null) is accepted. YAML tags like !!set (Set) and !!binary
 *     (Uint8Array) parse as non-Array objects whose .split is undefined —
 *     any typeof/Array blacklist reads them as the permissive default.
 *   - `skill_framework.split` present but non-boolean → THROW
 *
 * Extracted from run-infra.ts so the yaml semantics are directly
 * unit-testable against real config files (Codex R1 acceptance: the `[]`
 * case must be exercised with a real parse, not a mocked reader).
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export function makeSkillFrameworkParticipationReader(
	configPath: string,
): (projectName: string | undefined) => boolean {
	return (_projectName) => {
		let content: string;
		try {
			content = readFileSync(configPath, "utf-8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
			throw err;
		}
		const parsed = parseYaml(content) as { skill_framework?: unknown } | null;
		const skillFramework = parsed?.skill_framework;
		if (skillFramework === undefined || skillFramework === null) return true;
		// WHITELIST (Codex R2): accept ONLY a plain record. A blacklist can
		// never enumerate every non-mapping the yaml parser may produce.
		const proto =
			typeof skillFramework === "object"
				? Object.getPrototypeOf(skillFramework)
				: undefined;
		if (proto !== Object.prototype && proto !== null) {
			throw new Error(
				`skill_framework must be a mapping, got ${Object.prototype.toString.call(skillFramework)}`,
			);
		}
		const split = (skillFramework as { split?: unknown }).split;
		if (split === undefined || split === null) return true;
		if (typeof split !== "boolean") {
			throw new Error(
				`skill_framework.split must be a boolean, got ${JSON.stringify(split)}`,
			);
		}
		return split;
	};
}
