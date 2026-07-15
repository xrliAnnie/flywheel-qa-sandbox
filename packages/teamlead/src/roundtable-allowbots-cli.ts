#!/usr/bin/env node
/**
 * FLY-282 — CLI wrapper around `reconcile` (roundtable-allowbots.ts), invoked by
 * `claude-lead.sh` once at Lead startup. Best-effort: ANY failure logs to stderr
 * and still exits 0, so provisioning can never abort a Lead launch.
 *
 * Usage:
 *   roundtable-allowbots-cli.js \
 *     --lead-id <id> --token-env <ENV_NAME> --access-file <path> \
 *     --registry-dir <dir> --channel-ids <csv>
 */

import { reconcile } from "./roundtable-allowbots.js";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && i + 1 < process.argv.length
		? process.argv[i + 1]
		: undefined;
}

async function main(): Promise<void> {
	const leadId = arg("lead-id");
	const tokenEnv = arg("token-env") ?? "DISCORD_BOT_TOKEN";
	const accessFile = arg("access-file");
	const registryDir = arg("registry-dir");
	const channelIds = (arg("channel-ids") ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	if (!leadId || !accessFile || !registryDir || channelIds.length === 0) {
		process.stderr.write(
			"[roundtable-allowbots] missing required args (--lead-id --access-file --registry-dir --channel-ids) — skip\n",
		);
		return;
	}

	const token = process.env[tokenEnv];
	const result = await reconcile({
		leadId,
		token,
		accessFile,
		registryDir,
		channelIds,
		logger: (m) => process.stderr.write(`${m}\n`),
	});

	process.stderr.write(
		`[roundtable-allowbots] ${leadId}: member=${result.member} published=${result.published} ` +
			`peers=${result.peersConsidered} changed=${result.allowBotsChanged}` +
			(result.added.length ? ` added=[${result.added.join(",")}]` : "") +
			"\n",
	);
}

main().catch((err) => {
	// Never fail the Lead launch on a provisioning error.
	process.stderr.write(
		`[roundtable-allowbots] unexpected error (ignored): ${(err as Error).message}\n`,
	);
	process.exit(0);
});
