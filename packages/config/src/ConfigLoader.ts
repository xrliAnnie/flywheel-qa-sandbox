import * as path from "node:path";
import { parse } from "yaml";
import { MIN_GATE_TIMEOUT_MS } from "./constants.js";
import { RETIRED_CONFIG_PATHS } from "./feature-flags/truth.js";
import { getModelConfigSnapshot } from "./model-config.js";
import type { CheckpointConfig, FlywheelConfig, RoleEffort } from "./types.js";
import {
	EXECUTOR_BACKENDS,
	ROLE_EFFORT_LEVELS,
	XIAOHONGSHU_CADENCES,
	XIAOHONGSHU_MAX_FETCH_CEILING,
	XIAOHONGSHU_REVIEW_CHANNELS,
} from "./types.js";

/** Function signature for reading a file — injected for testability */
export type ReadFileFn = (path: string) => Promise<string>;

function retiredProjectFlag(key: string): never {
	throw new Error(
		`${key} was retired (FLY-2103): per-project flags live in the flag store — delete this key; see flywheel-comm feature-flags`,
	);
}

/**
 * Loads and validates .flywheel/config.yaml.
 *
 * Accepts a readFile function for dependency injection (testable without fs).
 * Validates required fields and cross-references (runner availability).
 */
export class ConfigLoader {
	constructor(private readFile: ReadFileFn) {}

	async load(path: string): Promise<FlywheelConfig> {
		const content = await this.readFile(path);
		const raw = parse(content);
		this.validate(raw);
		return raw as FlywheelConfig;
	}

	private validate(config: unknown): asserts config is FlywheelConfig {
		// A project file is one validation decision: every collection row must
		// see the same hot model-policy generation.
		const modelSnapshot = getModelConfigSnapshot();
		if (!config || typeof config !== "object") {
			throw new Error("Config must be a YAML object");
		}

		const c = config as Record<string, unknown>;
		for (const retired of RETIRED_CONFIG_PATHS) {
			if (Object.hasOwn(c, retired.path)) {
				throw new Error(
					`${retired.path} is retired by ${retired.retiredBy}; remove the entire top-level block`,
				);
			}
		}

		// Required top-level fields
		if (!c.project || typeof c.project !== "string") {
			throw new Error("Missing required field: project");
		}

		// linear.team_id
		const linear = c.linear as Record<string, unknown> | undefined;
		if (!linear || !linear.team_id) {
			throw new Error("Missing required field: linear.team_id");
		}

		// runners
		const runners = c.runners as Record<string, unknown> | undefined;
		if (!runners || !runners.default) {
			throw new Error("Missing required field: runners.default");
		}
		const available = runners.available as Record<string, unknown> | undefined;
		if (!available || typeof available !== "object") {
			throw new Error("Missing required field: runners.available");
		}

		// runners.default must be in available
		const defaultRunner = runners.default as string;
		if (!(defaultRunner in available)) {
			throw new Error(`Runner "${defaultRunner}" not in available runners`);
		}

		// teams
		const teams = c.teams as unknown[] | undefined;
		if (!Array.isArray(teams) || teams.length === 0) {
			throw new Error(
				"Missing required field: teams (must be non-empty array)",
			);
		}

		// Validate orchestrator runner references
		for (const team of teams) {
			const t = team as Record<string, unknown>;
			const orchestrators = t.orchestrators as unknown[] | undefined;
			if (Array.isArray(orchestrators)) {
				for (const orch of orchestrators) {
					const o = orch as Record<string, unknown>;
					const runnerRef = o.runner as string;
					if (runnerRef && !(runnerRef in available)) {
						throw new Error(`Runner "${runnerRef}" not in available runners`);
					}
				}
			}
		}

		// decision_layer
		const dl = c.decision_layer as Record<string, unknown> | undefined;
		if (!dl) {
			throw new Error("Missing required field: decision_layer");
		}
		const validLevels = new Set([
			"manual_only",
			"observer",
			"advisor",
			"autonomous",
		]);
		if (!dl.autonomy_level || !validLevels.has(dl.autonomy_level as string)) {
			throw new Error(
				`Invalid decision_layer.autonomy_level: "${dl.autonomy_level}". Must be one of: ${[...validLevels].join(", ")}`,
			);
		}
		if (!dl.escalation_channel || typeof dl.escalation_channel !== "string") {
			throw new Error(
				"Missing required field: decision_layer.escalation_channel",
			);
		}

		// FLY-1687: optional per-project patrol tuning (not an enable/disable flag).
		const patrol = c.patrol as Record<string, unknown> | undefined;
		if (Object.hasOwn(c, "patrol")) {
			if (
				patrol == null ||
				typeof patrol !== "object" ||
				Array.isArray(patrol)
			) {
				throw new Error("patrol must be a YAML mapping (object)");
			}
			if (
				Object.hasOwn(patrol, "interval_minutes") &&
				(typeof patrol.interval_minutes !== "number" ||
					!Number.isFinite(patrol.interval_minutes) ||
					patrol.interval_minutes <= 0)
			) {
				throw new Error(
					"patrol.interval_minutes must be a positive finite number",
				);
			}
		}

		// skills.proofshot (optional — GEO-151)
		const skills = c.skills as Record<string, unknown> | undefined;
		if (skills != null) {
			if (typeof skills !== "object" || Array.isArray(skills)) {
				throw new Error("skills must be a YAML mapping (object)");
			}
			const ps = skills.proofshot as Record<string, unknown> | undefined;
			if (ps != null) {
				if (typeof ps !== "object" || Array.isArray(ps)) {
					throw new Error(
						"skills.proofshot must be a YAML mapping (object), not an array or scalar",
					);
				}
				if (Object.hasOwn(ps, "enabled")) {
					retiredProjectFlag("skills.proofshot.enabled");
				}
				if (ps.dev_command != null && typeof ps.dev_command !== "string") {
					throw new Error("skills.proofshot.dev_command must be a string");
				}
				if (
					ps.port != null &&
					(typeof ps.port !== "number" ||
						!Number.isInteger(ps.port) ||
						ps.port <= 0)
				) {
					throw new Error("skills.proofshot.port must be a positive integer");
				}
				if (
					ps.capture_stages != null &&
					(!Array.isArray(ps.capture_stages) ||
						!ps.capture_stages.every((s) => typeof s === "string"))
				) {
					throw new Error(
						"skills.proofshot.capture_stages must be an array of strings",
					);
				}
				if (
					ps.vision_default != null &&
					typeof ps.vision_default !== "boolean"
				) {
					throw new Error("skills.proofshot.vision_default must be a boolean");
				}
				if (
					ps.vision_token_budget != null &&
					(typeof ps.vision_token_budget !== "number" ||
						ps.vision_token_budget <= 0)
				) {
					throw new Error(
						"skills.proofshot.vision_token_budget must be a positive number",
					);
				}
				if (
					ps.model_viewer_url != null &&
					typeof ps.model_viewer_url !== "string"
				) {
					throw new Error("skills.proofshot.model_viewer_url must be a string");
				}
				if (
					ps.model_capture_angles != null &&
					(!Array.isArray(ps.model_capture_angles) ||
						!ps.model_capture_angles.every((a) => typeof a === "string"))
				) {
					throw new Error(
						"skills.proofshot.model_capture_angles must be an array of strings",
					);
				}
				if (
					ps.artifact_path_allowlist != null &&
					(!Array.isArray(ps.artifact_path_allowlist) ||
						!ps.artifact_path_allowlist.every((p) => typeof p === "string"))
				) {
					throw new Error(
						"skills.proofshot.artifact_path_allowlist must be an array of strings (regex patterns)",
					);
				}
			}
		}

		// checkpoints (optional — FLY-47)
		const checkpoints = c.checkpoints as Record<string, unknown> | undefined;
		if (
			checkpoints != null &&
			(typeof checkpoints !== "object" || Array.isArray(checkpoints))
		) {
			throw new Error(
				"checkpoints must be a YAML mapping (object), not an array or scalar",
			);
		}
		if (checkpoints && typeof checkpoints === "object") {
			const validBehaviors = new Set(["fail-open", "fail-close"]);
			for (const [name, cpRaw] of Object.entries(checkpoints)) {
				if (!cpRaw || typeof cpRaw !== "object" || Array.isArray(cpRaw)) {
					throw new Error(`checkpoints.${name} must be an object`);
				}
				const cp = cpRaw as Record<string, unknown>;
				if (
					cp.timeout_behavior != null &&
					!validBehaviors.has(cp.timeout_behavior as string)
				) {
					throw new Error(
						`checkpoints.${name}.timeout_behavior must be "fail-open" or "fail-close", got "${cp.timeout_behavior}"`,
					);
				}
				if (cp.timeout_ms != null) {
					if (typeof cp.timeout_ms !== "number" || cp.timeout_ms <= 0) {
						throw new Error(
							`checkpoints.${name}.timeout_ms must be a positive number`,
						);
					}
					// FLY-159: warn + raise below-floor values (don't throw — preserve
					// boot continuity for projects deployed before the floor existed).
					if (cp.timeout_ms < MIN_GATE_TIMEOUT_MS) {
						console.warn(
							`[ConfigLoader] checkpoints.${name}.timeout_ms=${cp.timeout_ms}ms is below floor (${MIN_GATE_TIMEOUT_MS}ms = 4h), raising to floor. ` +
								`Set this explicitly in .flywheel/config.yaml to silence this warning.`,
						);
						(cp as CheckpointConfig).timeout_ms = MIN_GATE_TIMEOUT_MS;
					}
				}
				if (
					cp.cleanup_ttl_hours != null &&
					(typeof cp.cleanup_ttl_hours !== "number" ||
						cp.cleanup_ttl_hours <= 0)
				) {
					throw new Error(
						`checkpoints.${name}.cleanup_ttl_hours must be a positive number`,
					);
				}
				if (cp.stage != null && typeof cp.stage !== "string") {
					throw new Error(`checkpoints.${name}.stage must be a string`);
				}
				if (Object.hasOwn(cp, "enabled")) {
					retiredProjectFlag(`checkpoints.${name}.enabled`);
				}
			}
		}

		// roles (optional — FLY-123): per-role executor backend bindings.
		// Strict validation per Codex design review R1 #7 — a misspelled role
		// key or backend must fail at load time, not silently no-op until
		// adapter lookup.
		const roles = c.roles as Record<string, unknown> | undefined;
		if (roles != null && (typeof roles !== "object" || Array.isArray(roles))) {
			throw new Error(
				"roles must be a YAML mapping (object), not an array or scalar",
			);
		}
		if (roles && typeof roles === "object") {
			const validRoles = new Set(["lead", "runner", "reviewer", "triager"]);
			// FLY-493 (Codex R1 #6): derive from EXECUTOR_BACKENDS so this list
			// and the type can never drift (was a hardcoded parallel set).
			const validBackends = new Set<string>(EXECUTOR_BACKENDS);
			for (const [roleName, roleRaw] of Object.entries(roles)) {
				if (!validRoles.has(roleName)) {
					throw new Error(
						`roles.${roleName} is not a recognized role. Valid roles: ${[...validRoles].join(", ")}`,
					);
				}
				if (!roleRaw || typeof roleRaw !== "object" || Array.isArray(roleRaw)) {
					throw new Error(`roles.${roleName} must be an object`);
				}
				const role = roleRaw as Record<string, unknown>;
				if (typeof role.backend !== "string" || role.backend.length === 0) {
					throw new Error(`roles.${roleName}.backend is required`);
				}
				if (!validBackends.has(role.backend)) {
					throw new Error(
						`roles.${roleName}.backend "${role.backend}" is not supported. Valid backends: ${[...validBackends].join(", ")}`,
					);
				}
				if (
					role.model != null &&
					(typeof role.model !== "string" || role.model.trim().length === 0)
				) {
					throw new Error(
						`roles.${roleName}.model must be a non-empty string when set`,
					);
				}
				// FLY-241: normalize a set model to its trimmed form. The check
				// above already rejects null / non-string / whitespace-only, so
				// here role.model is a non-empty string. A quoted padded value
				// ("  claude-fable-5  ") otherwise passes validation and reaches
				// the CLI as `--model "  claude-fable-5  "`, which Claude/Codex
				// reject → the Runner never starts. Trim on load so downstream
				// (resolveRoleAdapter → runnerModel → `--model`) gets the bare id.
				if (typeof role.model === "string") {
					role.model = role.model.trim();
				}
				// FLY-671: optional per-role effort (closed CLI enum). Absent stays
				// absent (byte-compat). A misspelled level must fail at load, not
				// silently reach the runner CLI and crash it at spawn.
				if (role.effort != null) {
					if (
						typeof role.effort !== "string" ||
						!ROLE_EFFORT_LEVELS.includes(role.effort as RoleEffort)
					) {
						throw new Error(
							`roles.${roleName}.effort must be one of ${ROLE_EFFORT_LEVELS.join(", ")} when set, got ${JSON.stringify(role.effort)}`,
						);
					}
				}
			}
		}

		// doc_flow (optional — FLY-205)
		const docFlow = c.doc_flow as Record<string, unknown> | undefined;
		if (docFlow != null) {
			if (typeof docFlow !== "object" || Array.isArray(docFlow)) {
				throw new Error(
					"doc_flow must be a YAML mapping (object), not an array or scalar",
				);
			}
			if (Object.hasOwn(docFlow, "enabled")) {
				retiredProjectFlag("doc_flow.enabled");
			}
			if (docFlow.default_department == null) {
				throw new Error(
					"doc_flow.default_department is required when doc_flow is present",
				);
			}
			if (
				typeof docFlow.default_department !== "string" ||
				!/^[a-z0-9-]+$/.test(docFlow.default_department)
			) {
				throw new Error(
					`doc_flow.default_department must be a non-empty lowercase directory name matching ^[a-z0-9-]+$ (no slashes, dots, spaces or uppercase), got "${docFlow.default_department}"`,
				);
			}
		}

		if (Object.hasOwn(c, "skill_framework")) {
			retiredProjectFlag("skill_framework.split");
		}

		if (Object.hasOwn(c, "pipeline")) {
			const pipeline = c.pipeline as Record<string, unknown> | undefined;
			retiredProjectFlag(
				pipeline && Object.hasOwn(pipeline, "work_kind")
					? "pipeline.work_kind"
					: "pipeline.dag",
			);
		}

		if (Object.hasOwn(c, "ponytail")) {
			retiredProjectFlag("ponytail.enabled");
		}

		// xiaohongshu_learning (optional — FLY-222)
		// Static SHAPE validation only. The routing-tuple cross-check (Lead
		// exists + canSpawnRunners, department_label routes uniquely to lead_id,
		// Linear team/project/label resolve) is a RUNTIME check the scheduler
		// performs against projects.json + Linear — on failure it skips that
		// collection with a bounded alert, NOT a config-load throw. Like
		// doc_flow, authoring fields are validated whenever PRESENT so malformed
		// metadata fails loudly instead of later.
		const xhs = c.xiaohongshu_learning as Record<string, unknown> | undefined;
		if (xhs != null) {
			if (typeof xhs !== "object" || Array.isArray(xhs)) {
				throw new Error(
					"xiaohongshu_learning must be a YAML mapping (object), not an array or scalar",
				);
			}
			if (Object.hasOwn(xhs, "enabled")) {
				retiredProjectFlag("xiaohongshu_learning.enabled");
			}
			if (xhs.video_opt_in != null && typeof xhs.video_opt_in !== "boolean") {
				throw new Error("xiaohongshu_learning.video_opt_in must be a boolean");
			}
			if (xhs.collections != null) {
				if (!Array.isArray(xhs.collections)) {
					throw new Error("xiaohongshu_learning.collections must be an array");
				}
				const seenIds = new Set<string>();
				xhs.collections.forEach((entry: unknown, i: number) => {
					const where = `xiaohongshu_learning.collections[${i}]`;
					if (
						entry == null ||
						typeof entry !== "object" ||
						Array.isArray(entry)
					) {
						throw new Error(`${where} must be a mapping (object)`);
					}
					const col = entry as Record<string, unknown>;
					for (const field of [
						"collection_id",
						"label",
						"lead_id",
						"department_label",
						"target_linear_project",
					] as const) {
						const v = col[field];
						if (typeof v !== "string" || v.trim() === "") {
							throw new Error(`${where}.${field} must be a non-empty string`);
						}
					}
					// collection_id is a state-file path segment (project__cid.json), so
					// it must match the SAME charset the state layer's safeSegment
					// enforces. Catch a bad id at the config boundary, not later as a
					// readState throw that would wedge the whole scheduler tick.
					const cid = col.collection_id as string;
					if (!/^[A-Za-z0-9._-]+$/.test(cid)) {
						throw new Error(
							`${where}.collection_id "${cid}" must match ^[A-Za-z0-9._-]+$ (it is used as a state-file path segment)`,
						);
					}
					// Duplicate collection_id within one project = ambiguous state
					// keying (state file is per project__collection_id) → reject.
					if (seenIds.has(cid)) {
						throw new Error(
							`${where}.collection_id "${cid}" is duplicated; each collection_id must be unique within a project`,
						);
					}
					seenIds.add(cid);
					if (
						col.cadence != null &&
						!XIAOHONGSHU_CADENCES.includes(col.cadence as never)
					) {
						throw new Error(
							`${where}.cadence must be one of ${XIAOHONGSHU_CADENCES.join(", ")}, got "${col.cadence}"`,
						);
					}
					// FLY-709: optional per-collection runner model — must be a
					// recognized FLY-728 dispatch tier (id or alias). A typo here would
					// otherwise silently spawn the wrong model every day.
					if (
						col.model != null &&
						(typeof col.model !== "string" ||
							modelSnapshot.normalizeDispatchModel(col.model) === null)
					) {
						throw new Error(
							`${where}.model must be a recognized model tier id or alias (normalizeDispatchModel), got "${col.model}"`,
						);
					}
					if (col.max_fetch != null) {
						if (
							typeof col.max_fetch !== "number" ||
							!Number.isInteger(col.max_fetch) ||
							col.max_fetch < 1 ||
							col.max_fetch > XIAOHONGSHU_MAX_FETCH_CEILING
						) {
							throw new Error(
								`${where}.max_fetch must be an integer between 1 and ${XIAOHONGSHU_MAX_FETCH_CEILING}, got "${col.max_fetch}"`,
							);
						}
					}
					// FLY-286: review_channel (enum), first_run_cap (0..ceiling),
					// first_run_analyze_limit (1..ceiling). auto_create is retired.
					if (
						col.review_channel != null &&
						!XIAOHONGSHU_REVIEW_CHANNELS.includes(col.review_channel as never)
					) {
						throw new Error(
							`${where}.review_channel must be one of ${XIAOHONGSHU_REVIEW_CHANNELS.join(", ")}, got "${col.review_channel}"`,
						);
					}
					if (col.first_run_cap != null) {
						if (
							typeof col.first_run_cap !== "number" ||
							!Number.isInteger(col.first_run_cap) ||
							col.first_run_cap < 0 ||
							col.first_run_cap > XIAOHONGSHU_MAX_FETCH_CEILING
						) {
							throw new Error(
								`${where}.first_run_cap must be an integer between 0 and ${XIAOHONGSHU_MAX_FETCH_CEILING}, got "${col.first_run_cap}"`,
							);
						}
					}
					if (col.first_run_analyze_limit != null) {
						if (
							typeof col.first_run_analyze_limit !== "number" ||
							!Number.isInteger(col.first_run_analyze_limit) ||
							col.first_run_analyze_limit < 1 ||
							col.first_run_analyze_limit > XIAOHONGSHU_MAX_FETCH_CEILING
						) {
							throw new Error(
								`${where}.first_run_analyze_limit must be an integer between 1 and ${XIAOHONGSHU_MAX_FETCH_CEILING}, got "${col.first_run_analyze_limit}"`,
							);
						}
					}
					if (Object.hasOwn(col, "auto_create")) {
						retiredProjectFlag(`${where}.auto_create`);
					}
				});
			}
		}

		// agents (optional — v0.6)
		const agents = c.agents as Record<string, unknown> | undefined;
		if (
			agents != null &&
			(typeof agents !== "object" || Array.isArray(agents))
		) {
			throw new Error(
				"agents must be a YAML mapping (object), not an array or scalar",
			);
		}
		if (agents && typeof agents === "object") {
			// FLY-137 v1.27.2: "generic" is reserved (shipped fallback in AgentDispatcher).
			if ("generic" in agents) {
				throw new Error(
					'agents.generic: "generic" is reserved by Flywheel for the shipped-generic fallback. Pick a different agent name.',
				);
			}
			for (const [name, agentRaw] of Object.entries(agents)) {
				const agent = agentRaw as Record<string, unknown>;
				if (!agent.agent_file || typeof agent.agent_file !== "string") {
					throw new Error(
						`agents.${name}: missing required field "agent_file"`,
					);
				}
				const agentFile = agent.agent_file as string;
				this.validateAgentPath(agentFile, `agents.${name}.agent_file`);
				if (agent.domain_file != null) {
					if (typeof agent.domain_file !== "string") {
						throw new Error(`agents.${name}.domain_file must be a string`);
					}
					this.validateAgentPath(
						agent.domain_file as string,
						`agents.${name}.domain_file`,
					);
				}
				// FLY-137 v1.27.2: optional `department` field with bidirectional consistency check.
				const explicitDept = agent.department;
				if (explicitDept != null && typeof explicitDept !== "string") {
					throw new Error(`agents.${name}.department must be a string`);
				}
				const pathDept = this.parseAgentDept(
					agentFile,
					`agents.${name}.agent_file`,
				);
				if (typeof explicitDept === "string") {
					if (pathDept === null) {
						throw new Error(
							`agents.${name}: agent_file "${agentFile}" is at top-level (no dept dir) but department: "${explicitDept}" is declared. Top-level agents must omit the department field.`,
						);
					}
					if (pathDept !== explicitDept) {
						throw new Error(
							`agents.${name}.department="${explicitDept}" mismatches agent_file path "${agentFile}" (expected department="${pathDept}").`,
						);
					}
				}
				// FLY-901: optional `departments` set — explicit multi-dept registration
				// for AgentDispatcher step-2a (dual-register). Omitted => path-derived
				// single dept (byte-compat).
				if (agent.departments != null) {
					const departments = agent.departments;
					// V1: non-empty string array
					if (
						!Array.isArray(departments) ||
						departments.length === 0 ||
						!departments.every((d) => typeof d === "string")
					) {
						throw new Error(
							`agents.${name}.departments must be a non-empty array of strings`,
						);
					}
					const depts = departments as string[];
					// V2: path-safe tokens (each dept becomes a directory-segment semantic).
					for (const d of depts) {
						if (!/^[a-z0-9-]+$/.test(d)) {
							throw new Error(
								`agents.${name}.departments entries must be lowercase directory-safe tokens matching ^[a-z0-9-]+$, got "${d}"`,
							);
						}
					}
					// V3: no duplicate entries.
					if (new Set(depts).size !== depts.length) {
						throw new Error(
							`agents.${name}.departments contains duplicate entries: [${depts.join(", ")}]`,
						);
					}
					// V4: only dept-owned agents may declare departments (mirrors the
					// singular `department` rule for top-level catch-all agents).
					if (pathDept === null) {
						throw new Error(
							`agents.${name}: agent_file "${agentFile}" is at top-level (no dept dir) but departments is declared. Top-level agents must omit the departments field.`,
						);
					}
					// V5: the file's physical home dept must be a member of the set.
					if (!depts.includes(pathDept)) {
						throw new Error(
							`agents.${name}.departments must include the path-derived home department "${pathDept}" (agent_file "${agentFile}").`,
						);
					}
				}
				// match validation
				if (!agent.match || typeof agent.match !== "object") {
					throw new Error(`agents.${name}: missing required field "match"`);
				}
				const match = agent.match as Record<string, unknown>;
				if (!Array.isArray(match.labels)) {
					throw new Error(`agents.${name}.match.labels must be an array`);
				}
				if (!(match.labels as unknown[]).every((l) => typeof l === "string")) {
					throw new Error(
						`agents.${name}.match.labels must contain only strings`,
					);
				}
				// FLY-137 v1.27.1: `match.keywords` is now optional (Haiku step dropped).
				// Validate ONLY if the field is present.
				if (match.keywords != null) {
					if (!Array.isArray(match.keywords)) {
						throw new Error(
							`agents.${name}.match.keywords must be an array (if present)`,
						);
					}
					if (
						!(match.keywords as unknown[]).every((k) => typeof k === "string")
					) {
						throw new Error(
							`agents.${name}.match.keywords must contain only strings`,
						);
					}
				}
			}
		}

		// default_agent validation (outside agents block)
		const defaultAgent = c.default_agent as string | undefined;
		if (defaultAgent) {
			if (!agents || typeof agents !== "object") {
				throw new Error(
					`default_agent "${defaultAgent}" requires an agents section`,
				);
			}
			if (!(defaultAgent in agents)) {
				throw new Error(`default_agent "${defaultAgent}" not found in agents`);
			}
		}

		// FLY-1335: an empty match.labels array NEVER wins label matching
		// (AgentDispatcher.labelsMatch returns false on an empty array — empty is
		// NOT a wildcard). Such an agent is selected only by an explicit agentName
		// override, or — when its name is declared as `default_agent` — via the
		// Step-3a unmatched-label fallback. This warning fires for empty-labels
		// agents that are NOT the default_agent: they are name-only, and if the
		// author meant "catch-all", that intent silently doesn't work. Warn, don't
		// throw — boot continuity for existing configs (FLY-159 precedent);
		// name-only agents stay legitimate.
		if (agents && typeof agents === "object") {
			for (const [name, agentRaw] of Object.entries(agents)) {
				const match = (agentRaw as Record<string, unknown>).match as {
					labels: string[];
				};
				if (match.labels.length === 0 && name !== defaultAgent) {
					console.warn(
						`[ConfigLoader] agents.${name}.match.labels is empty — an empty array is NOT a wildcard; ` +
							`label dispatch will never select this agent (it is name-only). ` +
							`For a "no label matched" catch-all, declare default_agent: ${name} (FLY-1335).`,
					);
				}
			}
		}
	}

	private validateAgentPath(relativePath: string, fieldName: string): void {
		if (relativePath.startsWith("/") || /^[a-zA-Z]:/.test(relativePath)) {
			throw new Error(
				`${fieldName}: agent path must be relative, got "${relativePath}"`,
			);
		}
		// Resolve against a dummy root to catch embedded .. segments
		// e.g., "foo/../../etc/passwd" resolves outside the root
		const dummyRoot = "/flywheel-validate";
		const resolved = path.resolve(dummyRoot, relativePath);
		if (!resolved.startsWith(`${dummyRoot}/`)) {
			throw new Error(
				`${fieldName}: agent path must not escape repo, got "${relativePath}"`,
			);
		}
	}

	/**
	 * FLY-137 v1.27.2: extract dept from `.flywheel/agents/<dept>/<file>.md` paths.
	 * Returns:
	 *   - `null` for `.flywheel/agents/<file>.md` (top-level catch-all, depth 0)
	 *   - `<dept>` (string) for `.flywheel/agents/<dept>/<file>.md` (dept-owned, depth 1)
	 * Throws on:
	 *   - paths not starting with `.flywheel/agents/` (legacy `.claude/agents/...` is hard-errored
	 *     — operators run `flywheel migrate-agents-path` to fix)
	 *   - depth ≥ 2 (nested subdirs not supported in v1.27.2)
	 */
	private parseAgentDept(agentFile: string, fieldName: string): string | null {
		const prefix = ".flywheel/agents/";
		if (!agentFile.startsWith(prefix)) {
			throw new Error(
				`${fieldName}: agent_file must live under ".flywheel/agents/", got "${agentFile}". ` +
					`If this is a legacy ".claude/agents/" reference, run \`flywheel migrate-agents-path\` to update.`,
			);
		}
		const rest = agentFile.slice(prefix.length);
		if (rest.length === 0) {
			throw new Error(
				`${fieldName}: agent_file cannot be the agents/ directory itself`,
			);
		}
		const segments = rest.split("/");
		if (segments.length === 1) return null;
		if (segments.length === 2) {
			if (segments[0]!.length === 0) {
				throw new Error(`${fieldName}: empty dept segment in "${agentFile}"`);
			}
			return segments[0]!;
		}
		throw new Error(
			`${fieldName}: nested subdirs not supported (depth ${segments.length - 1}); v1.27.2 allows only flat .flywheel/agents/<dept>/<file>.md`,
		);
	}
}
