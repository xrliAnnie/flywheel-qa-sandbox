import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
	delimiter,
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
} from "node:path";

const invalid = () => new Error("credential_source_invalid");
/** Resolve source metadata only. Existing credentials are never opened. An absent
 * file remains protected through its nearest existing ancestor's real path. */
function resolveSource(path: string): string {
	let ancestor = path;
	for (;;) {
		try {
			lstatSync(ancestor);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw invalid();
			const parent = dirname(ancestor);
			if (parent === ancestor) throw invalid();
			ancestor = parent;
		}
	}
	return join(realpathSync(ancestor), relative(ancestor, path));
}
export function pinLeadCredentialPaths(sources: readonly string[]) {
	if (!sources.length || sources.length > 256) throw invalid();
	const original = [...new Set(sources)].sort();
	for (const path of original)
		if (
			!isAbsolute(path) ||
			path === "/" ||
			normalize(path) !== path ||
			path.length > 4096 ||
			/[*?[\]{}]/.test(path) ||
			[...path].some(
				(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
			)
		)
			throw invalid();
	const resolve = () =>
		[
			...new Set(original.flatMap((path) => [path, resolveSource(path)])),
		].sort();
	let paths: string[];
	try {
		paths = resolve();
	} catch {
		throw invalid();
	}
	return Object.freeze({
		paths: Object.freeze(paths),
		assertCurrent() {
			try {
				if (JSON.stringify(resolve()) !== JSON.stringify(paths))
					throw invalid();
			} catch {
				throw new Error("credential_source_changed");
			}
		},
	});
}

/** Fixed aliases from lead-body.sh, codex-global-health/cutover/sweep and
 * flywheel-claude-profile. Metadata only; not a new credential registry. */
export function leadCredentialAliases(
	env: NodeJS.ProcessEnv,
	activeCodexHome?: string,
): readonly string[] {
	// Only the v2 parent supplies this current, trusted home. Other callers keep
	// historical homes entirely denied. Root-default-deny still protects every
	// ungranted child; only verified skills/executable paths receive read grants.
	const activeAliases = activeCodexHome
		? new Set(pinLeadCredentialPaths([activeCodexHome]).paths)
		: new Set<string>();
	const privateCodexNames = [
		"auth.json",
		"config.toml",
		"profiles",
		"accounts",
		"sessions",
		"archived_sessions",
		"history.jsonl",
		"log",
		"logs",
		"state_5.sqlite",
		"state_5.sqlite-wal",
		"state_5.sqlite-shm",
	];
	const home = env.HOME || homedir();
	const state = env.FLYWHEEL_STATE_DIR || join(home, ".flywheel");
	const source = env.FLYWHEEL_CODEX_SOURCE_HOME || join(home, ".codex");
	const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
	const paths = [
		join(home, ".flywheel/.env"),
		join(home, ".flywheel/codex-homes"),
		join(home, ".flywheel/codex-credential-backups"),
		join(home, ".flywheel/claude-profiles"),
		join(home, ".flywheel/state"),
		join(home, ".flywheel/comm"),
		join(home, ".claude.json"),
		join(home, ".claude"),
		join(state, ".env"),
		env.FLYWHEEL_WRAPPER_ENV_FILE,
		join(source, "auth.json"),
		join(source, "profiles"),
		join(home, ".codex/auth.json"),
		join(home, ".codex/profiles"),
		env.FLYWHEEL_CODEX_HOMES_ROOT || join(home, ".flywheel/codex-homes"),
		env.FLYWHEEL_CODEX_SWEEP_BACKUP_ROOT ||
			join(home, ".flywheel/codex-credential-backups"),
		env.FLYWHEEL_CODEX_SWEEP_RAYA_HOME ||
			join(home, ".flywheel/raya/codex-home"),
		...(env.FLYWHEEL_CODEX_SWEEP_LEAD_HOMES || "")
			.split(delimiter)
			.filter(Boolean),
		env.CODEX_HOME && join(env.CODEX_HOME, "auth.json"),
		env.FLYWHEEL_CLAUDE_PROFILES_DIR || join(home, ".flywheel/claude-profiles"),
		env.FLYWHEEL_CLAUDE_JSON || join(home, ".claude.json"),
		env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
		env.FLYWHEEL_CLAUDE_KEYCHAIN,
		env.GH_CONFIG_DIR || join(xdg, "gh"),
		join(home, ".config/gh"),
		join(home, ".ssh"),
		join(home, ".netrc"),
		join(home, ".git-credentials"),
		join(xdg, "git/credentials"),
		join(home, ".config/git/credentials"),
		join(home, "Library/Keychains"),
		"/Library/Keychains",
		join(home, "Library/LaunchAgents"),
		join(state, "state"),
		join(state, "comm"),
	];
	for (const active of activeAliases)
		for (const name of privateCodexNames) paths.push(join(active, name));
	// The sweep includes historical suffixed Codex homes; inspect names only.
	if (!isAbsolute(home) || normalize(home) !== home || home === "/")
		throw invalid();
	try {
		for (const entry of readdirSync(home, { withFileTypes: true })) {
			if (
				entry.name.startsWith(".codex-") &&
				(entry.isDirectory() || entry.isSymbolicLink())
			) {
				const candidate = join(home, entry.name);
				const candidateAliases = pinLeadCredentialPaths([candidate]).paths;
				if (candidateAliases.some((path) => activeAliases.has(path))) {
					for (const alias of candidateAliases)
						for (const name of privateCodexNames) paths.push(join(alias, name));
				} else paths.push(candidate);
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw invalid();
	}
	const aliases = [
		...new Set(paths.filter((value): value is string => Boolean(value))),
	];
	// Reuse the exact path grammar without reading any credential bytes.
	return pinLeadCredentialPaths(aliases).paths;
}
