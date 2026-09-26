/** FLY-2913: paired legacy / role-v1 fixed-prefix controls for one 529 slot.
 * Each pair launches the same CLI, model, effort, cwd and flags twice through
 * the bounded context probe (no model turn); only the per-launch settings
 * differ. Item names prove whether each removal control actually took effect;
 * nothing here edits shared configuration or starts a room.
 */
import { randomUUID } from "node:crypto";

export const CONTROL_ROLES = [
	"design",
	"implement",
	"qa",
	"review-design",
	"review-code",
];

/** Probe argv mirroring the real launch's settings shape for the role. */
export function buildProbeArgv({
	model,
	effort,
	sessionId,
	settings,
	noChrome,
}) {
	return [
		"--print",
		"--session-id",
		sessionId,
		"--model",
		model,
		"--effort",
		effort,
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--settings",
		JSON.stringify(settings),
		"--permission-mode",
		"bypassPermissions",
		...(noChrome ? ["--no-chrome"] : []),
	];
}

/** Legacy settings as the real consumer composes them (profile then forced deny). */
export function legacySettings({
	role,
	mcpProfile,
	buildNonLeadClaudeSettings,
}) {
	if (role === "review-design" || role === "review-code")
		return buildNonLeadClaudeSettings();
	const enabledPlugins = {};
	for (const plugin of mcpProfile?.disabledPlugins ?? [])
		enabledPlugins[plugin] = false;
	for (const plugin of mcpProfile?.enabledPluginsExtra ?? [])
		enabledPlugins[plugin] = true;
	return buildNonLeadClaudeSettings({ enabledPlugins });
}

const names = (rows, key) => new Set((rows ?? []).map((row) => row[key]));

/** Item-level verdict for one legacy/role-v1 pair. */
export function verifyPair({ legacy, roleV1, compiled, requiredSkills }) {
	const before = {
		skills: names(legacy.skills, "name"),
		agents: names(legacy.agents, "name"),
		rules: names(legacy.memoryFiles, "file"),
	};
	const after = {
		skills: names(roleV1.skills, "name"),
		agents: names(roleV1.agents, "name"),
		rules: names(roleV1.memoryFiles, "file"),
	};
	const removed = {
		skills: new Set(compiled.stamp.removed.skills),
		agents: new Set(compiled.stamp.removed.agents),
		rules: new Set(compiled.stamp.removed.rules),
	};
	const result = { controls: {}, unintendedLoss: {}, requiredMissing: [] };
	for (const kind of ["skills", "agents", "rules"]) {
		const targeted = [...removed[kind]].filter((n) => before[kind].has(n));
		const stillPresent = targeted.filter((n) => after[kind].has(n));
		result.controls[kind] = {
			targetedPresentInLegacy: targeted.length,
			removed: targeted.length - stillPresent.length,
			stillPresent,
			effective: targeted.length > 0 && stillPresent.length === 0,
		};
		result.unintendedLoss[kind] = [...before[kind]].filter(
			(n) => !after[kind].has(n) && !removed[kind].has(n),
		);
	}
	result.requiredMissing = requiredSkills.filter(
		(n) => before.skills.has(n) && !after.skills.has(n),
	);
	result.pass =
		result.requiredMissing.length === 0 &&
		Object.values(result.unintendedLoss).every((list) => list.length === 0);
	return result;
}

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[mid]
		: Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

export function summarizeRole(pairs) {
	const complete = pairs.filter(
		(p) => p.legacy.status === "complete" && p.roleV1.status === "complete",
	);
	const fixed = (sample) => sample.context?.knownFixedCategoryTokens ?? null;
	const before = complete.map((p) => fixed(p.legacy));
	const after = complete.map((p) => fixed(p.roleV1));
	const stats = (values) =>
		values.length && values.every((v) => Number.isFinite(v))
			? {
					p50: median(values),
					min: Math.min(...values),
					max: Math.max(...values),
				}
			: null;
	return {
		samples: pairs.length,
		completePairs: complete.length,
		before: stats(before),
		after: stats(after),
		deltaP50:
			stats(before) && stats(after)
				? stats(before).p50 - stats(after).p50
				: null,
		allPairsPass:
			complete.length === pairs.length &&
			complete.every((p) => p.verdict?.pass === true),
	};
}

/** Runs `rounds` interleaved legacy/role-v1 pairs per role; probe is injectable. */
export async function runPrefixControls({
	binary,
	cwd,
	model,
	effort,
	rounds = 3,
	roles = CONTROL_ROLES,
	probe,
	config,
	pinnedAgents,
	home,
	env = process.env,
}) {
	const out = { roles: {} };
	for (const role of roles) {
		const runner = !role.startsWith("review-");
		const mcpProfile = runner
			? config.resolveRunnerMcpProfile({
					sessionRole: role === "qa" ? "qa" : "main",
					issueLabels: [],
					env,
				})
			: null;
		const workflow = {
			runId: "fly2913-probe",
			snapshotDigest: "0".repeat(64),
			templateId: "tpl_code",
		};
		const phase = runner ? role : "implement";
		const agent = runner ? pinnedAgents[role] : null;
		const compiled = config.compileRunnerPrefixProfile({
			request: {
				selection: {
					mode: "role-v1",
					role,
					taskSetId: "engineering",
					workflow,
				},
				context: { workflow, nodeId: phase, phase, agent },
			},
			home,
			skillArm: "superpowers",
		});
		const base = legacySettings({
			role,
			mcpProfile,
			buildNonLeadClaudeSettings: config.buildNonLeadClaudeSettings,
		});
		const slim = config.buildNonLeadClaudeSettings(compiled.settings, base);
		const noChrome = mcpProfile?.disableChrome === true;
		const requiredSkills = [
			...new Set([
				...config.RUNNER_PREFIX_REQUIRED_SKILLS[role],
				...compiled.stamp.pinnedSkills,
			]),
		];
		const pairs = [];
		for (let i = 0; i < rounds; i++) {
			const launch = (settings) =>
				probe({
					binary,
					args: buildProbeArgv({
						model,
						effort,
						sessionId: randomUUID(),
						settings,
						noChrome,
					}),
					cwd,
					env,
					inventoryNames: true,
					timeoutMs: 120000,
					controlTimeoutMs: 60000,
				});
			const legacy = await launch(base);
			const roleV1 = await launch(slim);
			pairs.push({
				legacy,
				roleV1,
				verdict:
					legacy.inventory && roleV1.inventory
						? verifyPair({
								legacy: legacy.inventory,
								roleV1: roleV1.inventory,
								compiled,
								requiredSkills,
							})
						: null,
			});
		}
		out.roles[role] = {
			profileDigest: compiled.profileDigest,
			removed: compiled.stamp.removed,
			summary: summarizeRole(pairs),
			pairs,
		};
	}
	return out;
}
