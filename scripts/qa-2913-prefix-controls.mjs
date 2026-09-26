#!/usr/bin/env node
/** FLY-2913: run paired legacy/role-v1 context probes in one 529 slot cwd.
 * Usage: node scripts/qa-2913-prefix-controls.mjs <slot-cwd> <out.json>
 *   --model <canonical-model> --effort <low|medium|high|xhigh|max>
 *   [--rounds 3] [--binary <absolute claude path>] [--roles a,b]
 * Requires a built packages/config dist. Never edits shared configuration.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeClaudeContext } from "./lib/qa-2913-context-probe.mjs";
import {
	CONTROL_ROLES,
	runPrefixControls,
} from "./lib/qa-2913-prefix-controls.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED = { design: "eng_design", implement: "implement", qa: "qa" };

export function readPinnedAgents(root = repoRoot) {
	return Object.fromEntries(
		Object.entries(PINNED).map(([role, file]) => {
			const content = readFileSync(
				join(root, ".flywheel/agents/nodes", `${file}.md`),
				"utf8",
			);
			return [
				role,
				{
					content,
					digest: createHash("sha256").update(content).digest("hex"),
				},
			];
		}),
	);
}

function parseArgs(argv) {
	const [cwd, out, ...rest] = argv;
	const opts = { rounds: 3, binary: join(homedir(), ".local/bin/claude") };
	for (let i = 0; i < rest.length; i += 2) {
		const [flag, value] = [rest[i], rest[i + 1]];
		if (value === undefined) throw new Error(`missing value for ${flag}`);
		if (flag === "--model") opts.model = value;
		else if (flag === "--effort") opts.effort = value;
		else if (flag === "--rounds") opts.rounds = Number(value);
		else if (flag === "--binary") opts.binary = value;
		else if (flag === "--roles") opts.roles = value.split(",");
		else throw new Error(`unknown flag ${flag}`);
	}
	if (!cwd || !out || !opts.model || !opts.effort)
		throw new Error("usage: <slot-cwd> <out.json> --model <m> --effort <e>");
	if (!Number.isInteger(opts.rounds) || opts.rounds < 1 || opts.rounds > 10)
		throw new Error("--rounds must be 1..10");
	if (!isAbsolute(opts.binary)) throw new Error("--binary must be absolute");
	for (const role of opts.roles ?? [])
		if (!CONTROL_ROLES.includes(role)) throw new Error(`unknown role ${role}`);
	return { cwd, out, ...opts };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const config = await import(
		pathToFileURL(join(repoRoot, "packages/config/dist/index.js")).href
	);
	const result = await runPrefixControls({
		binary: args.binary,
		cwd: args.cwd,
		model: args.model,
		effort: args.effort,
		rounds: args.rounds,
		roles: args.roles ?? CONTROL_ROLES,
		probe: probeClaudeContext,
		config,
		pinnedAgents: readPinnedAgents(),
		claudeConfigDir:
			process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
	});
	writeFileSync(
		args.out,
		`${JSON.stringify({ capturedAt: new Date().toISOString(), model: args.model, effort: args.effort, rounds: args.rounds, ...result }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	for (const [role, data] of Object.entries(result.roles))
		console.log(
			`${role}: pairs=${data.summary.completePairs}/${data.summary.samples} before=${data.summary.before?.p50 ?? "n/a"} after=${data.summary.after?.p50 ?? "n/a"} delta=${data.summary.deltaP50 ?? "n/a"} capabilityPass=${data.summary.allPairsPass} controlsEffective=${data.summary.allControlsEffective} ineffective=${JSON.stringify(data.summary.ineffective)}`,
		);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		console.error(`qa-2913-prefix-controls: ${error.message}`);
		process.exit(1);
	});
}
