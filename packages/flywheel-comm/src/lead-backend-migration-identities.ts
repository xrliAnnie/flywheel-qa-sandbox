import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveCodexLeadCapabilities } from "flywheel-config";
import {
	applyMigrationFields,
	type BackendMigrationPlan,
	rollbackMigrationFields,
} from "./lead-backend-migration.js";
import { parseMigrationIntent } from "./lead-backend-migration-io.js";
import { compileLeadIdentityRows } from "./lead-identity.js";
import { readSummaryGranularity } from "./summary-config.js";

/** Derive both identities through the existing compiler, including the selected
 * summary assignment. The intent cannot supply alternate bot/channel authority.
 */
export function resolveMigrationIdentities(
	home: string,
	registry: unknown,
	input: BackendMigrationPlan,
) {
	const plan = parseMigrationIntent(input);
	const sourceRegistry = rollbackMigrationFields(registry, plan);
	const targetRegistry = applyMigrationFields(sourceRegistry, plan);
	const options = {
		homeDir: home,
		summarySelection: readSummaryGranularity({ homeDir: home }),
	};
	const select = (raw: unknown) => {
		const rows = compileLeadIdentityRows(raw, options).filter(
			(row) =>
				row.identity.projectName === plan.projectName &&
				row.identity.leadId === plan.leadId,
		);
		if (rows.length !== 1 || !rows[0])
			throw Error("migration canonical identity missing");
		return rows[0];
	};
	const source = select(sourceRegistry),
		target = select(targetRegistry);
	if (
		source.identity.backend !== "claude-code" ||
		target.identity.backend !== "codex-app-server" ||
		!resolveCodexLeadCapabilities(target.lead).runnerActionsEnabled ||
		source.identity.summaryAssignmentDigest !==
			target.identity.summaryAssignmentDigest ||
		source.identity.botUserId !== target.identity.botUserId ||
		source.identity.botTokenEnv !== target.identity.botTokenEnv ||
		source.identity.discordStateDir !== target.identity.discordStateDir
	)
		throw Error("migration canonical identity conflict");
	const botUserId = target.identity.botUserId,
		botTokenEnv = target.identity.botTokenEnv,
		root = target.project.projectRoot;
	if (
		!botUserId ||
		!botTokenEnv ||
		typeof root !== "string" ||
		!isAbsolute(root)
	)
		throw Error("migration canonical routing missing");
	// Matches generic flywheel-lead.sh selector/sanitize_codex_child_env: chat and
	// optional registry roundtable only. Ambient core/cross-department ids are cleared.
	const channels = [
		target.lead.chatChannel,
		...(target.lead.roundtableChannel !== undefined
			? [target.lead.roundtableChannel]
			: []),
	];
	if (channels.some((id) => typeof id !== "string" || !/^\d{17,20}$/.test(id)))
		throw Error("migration canonical channel invalid");
	return {
		source: source.identity,
		target: target.identity,
		projectRoot: realpathSync(root),
		botUserId,
		botTokenEnv,
		channelIds: [...new Set(channels as string[])],
	};
}
