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

/**
 * Environment for probe CLIs: the caller's own Flywheel identity must never
 * reach the child, or the user-level SessionEnd hook would report the probe
 * session to the caller's Bridge as a completed runner session.
 */
// Minimal allowlist: locale/terminal/path basics plus the Claude config dir.
// Everything else (runner identity, cloud/ssh/git credentials) stays out.
const PROBE_ENV_ALLOWLIST = new Set([
	"HOME",
	"PATH",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"TMPDIR",
	"TZ",
	"CLAUDE_CONFIG_DIR",
]);
export function probeEnv(env) {
	const clean = Object.fromEntries(
		Object.entries(env).filter(([key]) => PROBE_ENV_ALLOWLIST.has(key)),
	);
	return {
		...clean,
		FLYWHEEL_MARKER_DIR: "/nonexistent/fly2913-probe-markers",
	};
}

/** Argv for the one controlled first turn (a fixed tiny prompt, no tools). */
export function buildFirstTurnArgv({
	model,
	effort,
	sessionId,
	settings,
	noChrome,
}) {
	return [
		"-p",
		FIRST_TURN_PROMPT,
		"--session-id",
		sessionId,
		"--model",
		model,
		"--effort",
		effort,
		"--output-format",
		"json",
		"--settings",
		JSON.stringify(settings),
		"--permission-mode",
		"bypassPermissions",
		"--no-session-persistence",
		...(noChrome ? ["--no-chrome"] : []),
	];
}
export const FIRST_TURN_PROMPT = "Reply with exactly: OK";

/** Only the usage numbers of a `-p --output-format json` result; never text. */
export function parseFirstTurnUsage(stdout) {
	try {
		const usage = JSON.parse(stdout)?.usage;
		const n = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
		const input = n(usage?.input_tokens);
		const cacheCreation = n(usage?.cache_creation_input_tokens);
		const cacheRead = n(usage?.cache_read_input_tokens);
		if (input === null || cacheCreation === null || cacheRead === null)
			return { status: "failed", failure: "missing_usage" };
		return {
			status: "complete",
			promptTokens: input + cacheCreation + cacheRead,
			usage: { input, cacheCreation, cacheRead },
		};
	} catch {
		return { status: "failed", failure: "malformed_result" };
	}
}

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
		// Probe sessions never land in the account's transcript history.
		"--no-session-persistence",
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
const tokensBy = (rows, key) =>
	new Map((rows ?? []).map((row) => [row[key], row.tokens]));

/**
 * Item-level verdict for one legacy/role-v1 pair. Skills are not removed:
 * a targeted skill must stay listed with a smaller (description-hidden) cost;
 * excluded rules must disappear. Anything else must be unchanged.
 */
export function verifyPair({ legacy, roleV1, compiled, requiredSkills }) {
	const beforeSkills = tokensBy(legacy.skills, "name");
	const afterSkills = tokensBy(roleV1.skills, "name");
	const hidden = new Set(compiled.stamp.hiddenSkillDescriptions);
	const targetedSkills = [...hidden].filter((n) => beforeSkills.has(n));
	const fullStill = targetedSkills.filter(
		(n) => afterSkills.has(n) && afterSkills.get(n) >= beforeSkills.get(n),
	);
	// Memory files are keyed by type and name: several CLAUDE.md files coexist.
	const memory = (rows) =>
		new Set((rows ?? []).map((row) => `${row.type}:${row.file}`));
	const beforeRules = memory(legacy.memoryFiles);
	const afterRules = memory(roleV1.memoryFiles);
	// Excluded rules are user-level files under the Claude config dir.
	const excluded = new Set(
		compiled.stamp.excludedRules.map((rule) => `User:${rule}`),
	);
	const targetedRules = [...excluded].filter((n) => beforeRules.has(n));
	const rulesStill = targetedRules.filter((n) => afterRules.has(n));
	const beforeAgents = names(legacy.agents, "name");
	const afterAgents = names(roleV1.agents, "name");
	const result = {
		controls: {
			skills: {
				targetedPresentInLegacy: targetedSkills.length,
				reduced: targetedSkills.length - fullStill.length,
				stillPresent: fullStill,
				effective: targetedSkills.length > 0 && fullStill.length === 0,
			},
			rules: {
				targetedPresentInLegacy: targetedRules.length,
				removed: targetedRules.length - rulesStill.length,
				stillPresent: rulesStill,
				effective: targetedRules.length > 0 && rulesStill.length === 0,
			},
		},
		unintendedLoss: {
			// name-only must keep every skill listed and invocable.
			skills: [...beforeSkills.keys()].filter((n) => !afterSkills.has(n)),
			unintendedHidden: [...beforeSkills]
				.filter(
					([n, t]) =>
						!hidden.has(n) && afterSkills.has(n) && afterSkills.get(n) < t,
				)
				.map(([n]) => n),
			agents: [...beforeAgents].filter((n) => !afterAgents.has(n)),
			rules: [...beforeRules].filter(
				(n) => !afterRules.has(n) && !excluded.has(n),
			),
		},
		requiredMissing: requiredSkills.filter(
			(n) =>
				beforeSkills.has(n) &&
				(!afterSkills.has(n) || afterSkills.get(n) < beforeSkills.get(n)),
		),
	};
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

const mcpState = (sample) =>
	JSON.stringify(
		(sample.mcpServers ?? []).map((server) => [server.name, server.status]),
	);
/** Same-condition pair: both first turns measured, both diagnostics measured,
 * and the same MCP servers in the same state (an account-level MCP outage
 * affects both sides identically). */
const comparable = (pair) =>
	["legacy", "roleV1"].every(
		(side) =>
			pair[side].context &&
			(pair[side].status === "complete" ||
				pair[side].failure === "mcp_not_connected") &&
			Number.isFinite(pair.turns?.[side]?.promptTokens),
	) && mcpState(pair.legacy) === mcpState(pair.roleV1);

const stats = (values) =>
	values.length && values.every((v) => Number.isFinite(v))
		? {
				p50: median(values),
				min: Math.min(...values),
				max: Math.max(...values),
			}
		: null;

export function summarizeRole(pairs) {
	const complete = pairs.filter(comparable);
	const degraded = [
		...new Set(
			complete.flatMap((p) =>
				(p.legacy.mcpServers ?? [])
					.filter((server) => server.status !== "connected")
					.map((server) => `${server.name}:${server.status}`),
			),
		),
	];
	// Primary: the real first request's prompt tokens (input + cache create +
	// cache read). Auxiliary: the CLI's own diagnostic estimate.
	const turn = (p, side) => p.turns[side].promptTokens;
	const diag = (p, side) => p[side].context?.knownFixedCategoryTokens ?? null;
	const before = stats(complete.map((p) => turn(p, "legacy")));
	const after = stats(complete.map((p) => turn(p, "roleV1")));
	const diagBefore = stats(complete.map((p) => diag(p, "legacy")));
	const diagAfter = stats(complete.map((p) => diag(p, "roleV1")));
	// A control whose targets survive in any pair saved nothing: report it so a
	// capability-safe pass is never mistaken for a proven saving.
	const ineffective = { skills: [], rules: [] };
	for (const pair of complete)
		for (const kind of Object.keys(ineffective))
			for (const item of pair.verdict?.controls?.[kind]?.stillPresent ?? [])
				if (!ineffective[kind].includes(item)) ineffective[kind].push(item);
	return {
		samples: pairs.length,
		completePairs: complete.length,
		measurementMethod: "first-turn-api-usage",
		before,
		after,
		deltaP50: before && after ? before.p50 - after.p50 : null,
		diagnosticEstimate: {
			before: diagBefore,
			after: diagAfter,
			deltaP50: diagBefore && diagAfter ? diagBefore.p50 - diagAfter.p50 : null,
		},
		allPairsPass:
			complete.length === pairs.length &&
			complete.every((p) => p.verdict?.pass === true),
		ineffective,
		mcpDegraded: degraded,
		allControlsEffective:
			complete.length === pairs.length &&
			complete.every((p) => p.verdict?.controls) &&
			Object.values(ineffective).every((list) => list.length === 0),
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
	firstTurn,
	config,
	pinnedAgents,
	claudeConfigDir,
	env = process.env,
}) {
	const out = { roles: {} };
	const childEnv = probeEnv(env);
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
			claudeConfigDir,
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
					env: childEnv,
					inventoryNames: true,
					timeoutMs: 120000,
					controlTimeoutMs: 60000,
					// SessionEnd hooks can outlast 1s on a loaded host.
					closeWaitMs: 5000,
				});
			const legacy = await launch(base);
			const roleV1 = await launch(slim);
			const turn = (settings) =>
				firstTurn({
					binary,
					cwd,
					model,
					effort,
					settings,
					noChrome,
					env: childEnv,
				});
			const turns = { legacy: await turn(base), roleV1: await turn(slim) };
			pairs.push({
				legacy,
				roleV1,
				turns,
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
			hiddenSkillDescriptions: compiled.stamp.hiddenSkillDescriptions,
			excludedRules: compiled.stamp.excludedRules,
			summary: summarizeRole(pairs),
			pairs,
		};
	}
	return out;
}
