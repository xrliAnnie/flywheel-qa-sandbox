import fs from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	measureRunnerMemoryIndex,
	type RunnerMemoryIndexStats,
	type RunnerMemorySnapshot,
} from "flywheel-config";
import type { AdapterExecutionContext } from "flywheel-core";
import { SAFE_IDENTIFIER_RE } from "flywheel-core";

export type { RunnerMemoryIndexStats } from "flywheel-config";
export {
	measureIndexPrefix,
	RUNNER_MEMORY_DEFAULT_BUDGET,
	RUNNER_MEMORY_HARD_LIMIT,
	RUNNER_MEMORY_SCAN_CEILING_BYTES,
} from "flywheel-config";

export const RUNNER_MEMORY_ID_MAX_LENGTH = 128;

export type RunnerMemoryBackend = "claude-tmux" | "codex-tmux";
export type RunnerMemoryIdentity = { project: string; role: string };
export type RunnerMemorySkipReason =
	| "no_project"
	| "no_role"
	| "invalid_project"
	| "invalid_role"
	| "unsupported_backend";
export type RunnerMemoryPolicyProbe = {
	conflicts: string[];
	unreadable: string[];
};
export type RunnerMemoryMount =
	| {
			status: "mounted";
			backend: RunnerMemoryBackend;
			project: string;
			role: string;
			dir: string;
			index: RunnerMemoryIndexStats;
			snapshot: RunnerMemorySnapshot;
			policy?: RunnerMemoryPolicyProbe;
	  }
	| {
			status: "skipped";
			reason: RunnerMemorySkipReason;
			backend: string;
			project?: string;
			role?: string;
			policy?: RunnerMemoryPolicyProbe;
	  }
	| {
			status: "failed";
			backend: RunnerMemoryBackend;
			project?: string;
			role?: string;
			dir?: string;
			reason: string;
			policy?: RunnerMemoryPolicyProbe;
	  };

export const DEFAULT_MANAGED_SETTINGS = {
	managedFile: "/Library/Application Support/ClaudeCode/managed-settings.json",
	managedDropinDir:
		"/Library/Application Support/ClaudeCode/managed-settings.d",
} as const;

const RUNNER_MEMORY_SETTINGS_SCAN_CEILING_BYTES = 1_048_576;

/** Resolve the existing project and role identifiers without inventing aliases. */
export function resolveRunnerMemoryIdentity(input: {
	backend: string;
	projectName?: string;
	nodeId?: string;
	agentName?: string;
}):
	| {
			ok: true;
			backend: RunnerMemoryBackend;
			identity: RunnerMemoryIdentity;
	  }
	| {
			ok: false;
			reason: RunnerMemorySkipReason;
			project?: string;
			role?: string;
	  } {
	if (input.backend !== "claude-tmux" && input.backend !== "codex-tmux") {
		return { ok: false, reason: "unsupported_backend" };
	}
	const role = input.nodeId ?? input.agentName;
	if (input.projectName === undefined) {
		return { ok: false, reason: "no_project", role };
	}
	if (role === undefined) {
		return {
			ok: false,
			reason: "no_role",
			project: input.projectName,
		};
	}
	if (
		!SAFE_IDENTIFIER_RE.test(input.projectName) ||
		input.projectName.length > RUNNER_MEMORY_ID_MAX_LENGTH
	) {
		return {
			ok: false,
			reason: "invalid_project",
			project: input.projectName,
			role,
		};
	}
	if (
		!SAFE_IDENTIFIER_RE.test(role) ||
		role.length > RUNNER_MEMORY_ID_MAX_LENGTH
	) {
		return {
			ok: false,
			reason: "invalid_role",
			project: input.projectName,
			role,
		};
	}
	return {
		ok: true,
		backend: input.backend,
		identity: { project: input.projectName, role },
	};
}

/** Resolve the machine-stable memory root; an invalid override never falls back. */
export function resolveRunnerMemoryRoot(env: NodeJS.ProcessEnv):
	| { ok: true; root: string }
	| {
			ok: false;
			reason: "invalid_root_override" | "no_home" | "invalid_home";
	  } {
	if (env.FLYWHEEL_RUNNER_MEMORY_ROOT !== undefined) {
		const root = env.FLYWHEEL_RUNNER_MEMORY_ROOT;
		return root.length > 0 && isAbsolute(root)
			? { ok: true, root }
			: { ok: false, reason: "invalid_root_override" };
	}
	const home = env.HOME?.trim();
	if (!home) return { ok: false, reason: "no_home" };
	if (!isAbsolute(home)) return { ok: false, reason: "invalid_home" };
	return { ok: true, root: join(home, ".flywheel", "runner-memory") };
}

/** Encode a safe identifier injectively on case-insensitive filesystems. */
export function encodeMemoryPathComponent(name: string): string {
	const lower = name.toLowerCase();
	if (name === lower && !name.includes("--")) return name;
	let uppercaseMask = 0n;
	for (let index = 0; index < name.length; index += 1) {
		if (name[index] !== lower[index]) {
			uppercaseMask |= 1n << BigInt(index);
		}
	}
	return `${lower}--${uppercaseMask.toString(16)}`;
}

/** Reverse a component produced by {@link encodeMemoryPathComponent}. */
export function decodeMemoryPathComponent(encoded: string): string {
	const separator = encoded.lastIndexOf("--");
	if (separator === -1) return encoded;
	const base = encoded.slice(0, separator);
	const maskHex = encoded.slice(separator + 2);
	const uppercaseMask = BigInt(`0x${maskHex}`);
	return Array.from(base, (character, index) =>
		(uppercaseMask & (1n << BigInt(index))) !== 0n
			? character.toUpperCase()
			: character,
	).join("");
}

type SettingsSource = {
	path: string;
	managed: boolean;
	forcedUnreadable?: boolean;
};

function readSettingsObject(filePath: string): Record<string, unknown> {
	const fd = fs.openSync(filePath, "r");
	try {
		const size = fs.fstatSync(fd).size;
		if (size > RUNNER_MEMORY_SETTINGS_SCAN_CEILING_BYTES) {
			throw new Error("settings file exceeds scan ceiling");
		}
		const buffer = Buffer.alloc(size);
		let filled = 0;
		while (filled < buffer.length) {
			const count = fs.readSync(
				fd,
				buffer,
				filled,
				buffer.length - filled,
				filled,
			);
			if (count === 0) break;
			filled += count;
		}
		if (filled !== size) throw new Error("settings file short read");
		const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		) {
			throw new Error("settings file is not a JSON object");
		}
		return parsed as Record<string, unknown>;
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Probe the documented file-backed Claude settings sources. Any auto-memory
 * key is a conflict; this intentionally does not implement precedence rules.
 */
export function probeAutoMemoryPolicy(input: {
	home?: string;
	cwd: string;
	projectRoot: string;
	managedSettings?: { managedFile: string; managedDropinDir: string };
}): RunnerMemoryPolicyProbe {
	const managed = input.managedSettings ?? DEFAULT_MANAGED_SETTINGS;
	const sources: SettingsSource[] = [
		{ path: managed.managedFile, managed: true },
	];
	if (fs.existsSync(managed.managedDropinDir)) {
		try {
			for (const name of fs
				.readdirSync(managed.managedDropinDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				sources.push({
					path: join(managed.managedDropinDir, name),
					managed: true,
				});
			}
		} catch {
			sources.push({
				path: managed.managedDropinDir,
				managed: true,
				forcedUnreadable: true,
			});
		}
	}
	const home = input.home?.trim();
	if (home) {
		sources.push({
			path: join(home, ".claude", "settings.json"),
			managed: false,
		});
	}
	sources.push(
		{ path: join(input.cwd, ".claude", "settings.json"), managed: false },
		{
			path: join(input.cwd, ".claude", "settings.local.json"),
			managed: false,
		},
		{
			path: join(input.projectRoot, ".claude", "settings.json"),
			managed: false,
		},
		{
			path: join(input.projectRoot, ".claude", "settings.local.json"),
			managed: false,
		},
	);

	const result: RunnerMemoryPolicyProbe = { conflicts: [], unreadable: [] };
	for (const source of sources) {
		if (source.forcedUnreadable) {
			result.conflicts.push(`${source.path}:unreadable`);
			continue;
		}
		if (!fs.existsSync(source.path)) continue;
		try {
			const settings = readSettingsObject(source.path);
			for (const key of Object.keys(settings)) {
				if (key.startsWith("autoMemory")) {
					result.conflicts.push(`${source.path}:${key}`);
				}
			}
			const env = settings.env;
			if (
				env !== null &&
				typeof env === "object" &&
				!Array.isArray(env) &&
				Object.hasOwn(env, "CLAUDE_CODE_DISABLE_AUTO_MEMORY")
			) {
				result.conflicts.push(
					`${source.path}:env.CLAUDE_CODE_DISABLE_AUTO_MEMORY`,
				);
			}
		} catch {
			if (source.managed) {
				result.conflicts.push(`${source.path}:unreadable`);
			} else {
				result.unreadable.push(source.path);
			}
		}
	}
	return result;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

function formatFsFailure(error: unknown): string {
	return `fs:${error instanceof Error ? error.message : String(error)}`;
}

function initializeMemoryIndex(
	indexPath: string,
	project: string,
	role: string,
): boolean {
	try {
		const stat = fs.lstatSync(indexPath);
		if (!stat.isFile()) throw new Error(`${indexPath} is not a regular file`);
		return false;
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	const initial = [
		`# ${project}/${role} runner memory index`,
		"",
		"<!-- one pointer line per topic file; keep under 160 lines / 20,000 bytes -->",
		"",
	].join("\n");
	try {
		fs.writeFileSync(indexPath, initial, { flag: "wx", mode: 0o600 });
		return true;
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		const stat = fs.lstatSync(indexPath);
		if (!stat.isFile()) throw new Error(`${indexPath} is not a regular file`);
		return false;
	}
}

/** Prepare the persistent role-memory directory before a runner is spawned. */
export function prepareRunnerMemoryMount(input: {
	env: NodeJS.ProcessEnv;
	backend: string;
	projectName?: string;
	nodeId?: string;
	agentName?: string;
	cwd: string;
	projectRoot: string;
	managedSettings?: { managedFile: string; managedDropinDir: string };
}): RunnerMemoryMount {
	if (input.backend !== "claude-tmux" && input.backend !== "codex-tmux") {
		return {
			status: "skipped",
			reason: "unsupported_backend",
			backend: input.backend,
		};
	}
	const backend = input.backend;
	const policy =
		backend === "claude-tmux"
			? probeAutoMemoryPolicy({
					home: input.env.HOME,
					cwd: input.cwd,
					projectRoot: input.projectRoot,
					managedSettings: input.managedSettings,
				})
			: undefined;
	const role = input.nodeId ?? input.agentName;
	if (policy && policy.conflicts.length > 0) {
		return {
			status: "failed",
			backend,
			project: input.projectName,
			role,
			reason: `policy_conflict:${JSON.stringify(policy.conflicts)}`,
			policy,
		};
	}
	const resolvedIdentity = resolveRunnerMemoryIdentity(input);
	if (!resolvedIdentity.ok) {
		return {
			status: "skipped",
			reason: resolvedIdentity.reason,
			backend,
			project: resolvedIdentity.project,
			role: resolvedIdentity.role,
			...(policy && { policy }),
		};
	}
	const { project, role: resolvedRole } = resolvedIdentity.identity;
	const resolvedRoot = resolveRunnerMemoryRoot(input.env);
	if (!resolvedRoot.ok) {
		return {
			status: "failed",
			backend,
			project,
			role: resolvedRole,
			reason: resolvedRoot.reason,
			...(policy && { policy }),
		};
	}
	const dir = join(
		resolvedRoot.root,
		encodeMemoryPathComponent(project),
		encodeMemoryPathComponent(resolvedRole),
	);
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const indexPath = join(dir, "MEMORY.md");
		const firstRun = initializeMemoryIndex(indexPath, project, resolvedRole);
		const measured = measureRunnerMemoryIndex(dir);
		const index = { ...measured.stats, firstRun };
		return {
			status: "mounted",
			backend,
			project,
			role: resolvedRole,
			dir,
			index,
			snapshot: measured.snapshot,
			...(policy && { policy }),
		};
	} catch (error) {
		return {
			status: "failed",
			backend,
			project,
			role: resolvedRole,
			dir,
			reason: formatFsFailure(error),
			...(policy && { policy }),
		};
	}
}

function displayLines(index: RunnerMemoryIndexStats): string {
	return index.linesExact ? String(index.lines) : `>= ${index.lines}`;
}

function legacyMemoryLine(
	backend: RunnerMemoryBackend,
	dir: string | undefined,
): string | undefined {
	if (!dir) return undefined;
	return backend === "claude-tmux"
		? `- Project-wide shared memory (all roles + founder sessions; what runners used before FLY-2147): ${dir} — read on demand for project facts; do not write there.`
		: `- Project-wide shared memory (all roles + founder sessions): ${dir} — read on demand for project facts; do not write there.`;
}

/** Render the bounded, backend-honest memory section inserted into the prompt. */
export function buildRunnerMemoryPromptSection(
	mount: RunnerMemoryMount,
	opts: { legacyProjectMemoryDir?: string },
): string {
	if (mount.status === "skipped" && mount.reason === "unsupported_backend") {
		return "";
	}
	const backend = mount.backend as RunnerMemoryBackend;
	const lines = ["## Runner Memory"];
	if (mount.status !== "mounted") {
		const identity = `${mount.project ?? "-"}/${mount.role ?? "-"}`;
		if (backend === "claude-tmux") {
			if (
				mount.status === "failed" &&
				mount.reason.startsWith("policy_conflict:")
			) {
				lines.push(
					`- Role memory NOT mounted (${identity}): ${mount.reason}. A Claude Code settings source outside Flywheel's control sets auto-memory policy, so the effective memory state of this session is UNKNOWN (Flywheel passed autoMemoryEnabled:false as a best effort and does not resolve settings precedence). Report this line to your Lead in your first status report.`,
				);
			} else {
				lines.push(
					`- Role memory NOT mounted (${identity}): ${mount.reason}. Claude Code auto memory is DISABLED for this session (fail-closed, FLY-2147): Claude Code will not load or automatically write an auto-memory index this session. Report this line to your Lead in your first status report.`,
				);
			}
		} else {
			lines.push(
				`- Role memory NOT mounted (${identity}): ${mount.reason}. No role memory directory this session. Report this line to your Lead in your first status report.`,
			);
		}
		const legacy = legacyMemoryLine(backend, opts.legacyProjectMemoryDir);
		if (legacy) lines.push(legacy);
		return `${lines.join("\n")}\n`;
	}

	if (mount.backend === "codex-tmux") {
		lines.push(
			`- Role memory directory (${mount.project}/${mount.role}): ${mount.dir} (also in env FLYWHEEL_RUNNER_MEMORY_DIR). It is shared with the Claude runners of the same project/role. Native loading for Codex is deferred (FLY-1984 C1): nothing from it is loaded automatically — read ${mount.dir}/MEMORY.md yourself when you need this role's past lessons, and write new lessons there in the same shape (one fact per topic file, one pointer line in MEMORY.md).`,
			`- Closeout contract (FLY-2148): BEFORE you run your completion command (\`complete\` / \`qa-result\`), write what this role learned in this execution into ${mount.dir} — at most ~5 durable, reusable judgments, one topic file each plus one pointer line in MEMORY.md; if you learned nothing durable, write nothing and say so in your final report. Keep MEMORY.md under 160 lines / 20,000 bytes: Codex has no native index guard, so the completion command measures it for you and prints a \`runner-memory closeout\` receipt (written / unchanged / over_budget) — an over_budget receipt means consolidate before you finish. Never store tokens, keys or secrets.`,
		);
		const legacy = legacyMemoryLine(mount.backend, opts.legacyProjectMemoryDir);
		if (legacy) lines.push(legacy);
		return `${lines.join("\n")}\n`;
	}

	lines.push(
		`- Role memory directory (${mount.project}/${mount.role}): ${mount.dir}\n  This is the persistent memory directory Claude Code loads for you this session. It is shared by every \`${mount.role}\` runner of project \`${mount.project}\` across issues, worktrees and executions; it survives worktree deletion.`,
	);
	if (mount.index.firstRun) {
		lines.push(
			"- Index MEMORY.md: first run — the index is empty; write what this role learns here.",
		);
	} else if (mount.index.overHard) {
		lines.push(
			`- ⚠ Index MEMORY.md OVER BUDGET: ${displayLines(mount.index)} lines / ${mount.index.bytes} bytes (budget 160 lines / 20,000 bytes). Claude Code loads only the first 200 lines / 25,000 bytes: entries from about line ${mount.index.firstDroppedLine ?? "unknown"} onward were NOT loaded this session. FIRST TASK before any other work: bring MEMORY.md back under budget — consolidate related topic files and replace or drop superseded index pointers; keep every fact (move detail into topic files), never lose information. Then continue.`,
		);
	} else if (mount.index.overBudget) {
		lines.push(
			`- ⚠ Index MEMORY.md OVER BUDGET: ${displayLines(mount.index)} lines / ${mount.index.bytes} bytes (budget 160 lines / 20,000 bytes; Claude Code stops loading at 200 lines / 25,000 bytes). Nothing was dropped yet. Before you finish this execution, bring MEMORY.md back under budget the same way (consolidate topic files, replace or drop superseded index pointers, keep every fact).`,
		);
	} else {
		lines.push(
			`- Index MEMORY.md: ${displayLines(mount.index)} lines / ${mount.index.bytes} bytes — within budget (160 lines / 20,000 bytes; Claude Code stops loading at 200 lines / 25,000 bytes).`,
		);
	}
	lines.push(
		"- Write rule (closeout contract, FLY-2148): one fact per topic file with frontmatter (name/description/type), one pointer line in MEMORY.md. BEFORE you run your completion command (`complete` / `qa-result`), write what this role learned in this execution — at most ~5 durable, reusable judgments; if you learned nothing durable, write nothing and say so in your final report. The completion command measures MEMORY.md, prints a `runner-memory closeout` receipt line (written / unchanged / over_budget) and records it for your Lead. Never store tokens, keys or secrets.",
	);
	const legacy = legacyMemoryLine(mount.backend, opts.legacyProjectMemoryDir);
	if (legacy) lines.push(legacy);
	return `${lines.join("\n")}\n`;
}

function settingsUnreadableSuffix(mount: RunnerMemoryMount): string {
	return mount.policy && mount.policy.unreadable.length > 0
		? ` settings_unreadable=${JSON.stringify(mount.policy.unreadable)}`
		: "";
}

/** Produce the single structured visibility line emitted for every outcome. */
export function formatRunnerMemoryLogLine(mount: RunnerMemoryMount): {
	level: "info" | "warn";
	line: string;
} {
	const suffix = settingsUnreadableSuffix(mount);
	if (mount.status === "mounted") {
		const indexLines = `${mount.index.linesExact ? "" : ">="}${mount.index.lines}L`;
		if (mount.index.overBudget) {
			return {
				level: "warn",
				line: `[Blueprint] runner-memory OVER BUDGET backend=${mount.backend} project=${mount.project} role=${mount.role} dir=${mount.dir} index=${indexLines}/${mount.index.bytes}B budget=160L/20000B hard=200L/25000B first_dropped_line=${mount.index.firstDroppedLine ?? "none"}${suffix}`,
			};
		}
		return {
			level: "info",
			line: `[Blueprint] runner-memory mounted backend=${mount.backend} project=${mount.project} role=${mount.role} dir=${mount.dir} index=${indexLines}/${mount.index.bytes}B budget=160L/20000B hard=200L/25000B first_run=${mount.index.firstRun} over_budget=false${suffix}`,
		};
	}
	if (mount.status === "skipped") {
		return {
			level: "info",
			line: `[Blueprint] runner-memory skipped reason=${mount.reason} backend=${mount.backend} project=${mount.project ?? "-"} role=${mount.role ?? "-"}${suffix}`,
		};
	}
	return {
		level: "warn",
		line: `[Blueprint] runner-memory failed backend=${mount.backend} project=${mount.project ?? "-"} role=${mount.role ?? "-"} dir=${mount.dir ?? "-"} reason=${mount.reason} (no role memory this session)${suffix}`,
	};
}

/** Map preparation outcomes onto the adapter's explicit three-state contract. */
export function toRunnerMemoryDisposition(
	mount: RunnerMemoryMount,
): AdapterExecutionContext["runnerMemory"] {
	if (mount.status === "mounted") {
		return { status: "mounted", dir: mount.dir, snapshot: mount.snapshot };
	}
	if (mount.status === "skipped" && mount.reason === "unsupported_backend") {
		return undefined;
	}
	return { status: "disabled", reason: mount.reason };
}

/**
 * Resolve Claude Code's observed project-memory slug only as a read-only
 * pointer. The slash-to-dash rule is intentionally used only when the path
 * exists because it is an observed, not documented, Claude implementation.
 */
export function resolveLegacyProjectMemoryDir(input: {
	repoRoot: string;
	home: string;
	exists: (path: string) => boolean;
}): string | undefined {
	if (!input.home) return undefined;
	const slug = input.repoRoot.replaceAll("/", "-");
	const candidate = join(input.home, ".claude", "projects", slug, "memory");
	return input.exists(candidate) ? candidate : undefined;
}
