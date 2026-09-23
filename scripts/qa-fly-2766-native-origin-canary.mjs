#!/usr/bin/env node
// Read-only verification of one committed, version-keyed native skill origin.
import { realpathSync } from "node:fs";
import { sep } from "node:path";

try {
	const codexVersion = process.env.FLYWHEEL_NATIVE_SKILL_BASELINE_VERSION;
	if (process.argv.length !== 2 || !codexVersion) throw new Error();
	const { resolvePinnedNativeSkillBaseline } = await import(
		"../packages/teamlead/dist/lead-capabilities/native-skill-baseline.js"
	);
	const { verifyNativeSkillOrigin } = await import(
		"../packages/teamlead/dist/lead-capabilities/native-home.js"
	);
	const baseline = resolvePinnedNativeSkillBaseline(codexVersion);
	if (!baseline.origin) throw new Error();
	const origin = realpathSync(baseline.origin.root);
	if (
		!origin.endsWith(
			`${sep}native-skill-baselines${sep}${codexVersion}${sep}skills${sep}.system`,
		)
	)
		throw new Error();
	const sources = verifyNativeSkillOrigin({
		root: origin,
		baseline,
		codexVersion,
		secrets: [],
	});
	process.stdout.write(
		`${JSON.stringify({
			status: "passed",
			codexVersion,
			selectedOrigin: origin,
			sources: sources.map(({ name, sha256 }) => ({ name, sha256 })),
			modelStarted: false,
			productionMutated: false,
		})}\n`,
	);
} catch {
	process.stdout.write(
		`${JSON.stringify({
			status: "failed",
			errorCode: "native_skill_baseline_unverified",
		})}\n`,
	);
	process.exitCode = 1;
}
