import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { join } from "node:path";

export const VOICE_CODEX_HOME_CONFIG =
	'forced_login_method = "api"\n' +
	'cli_auth_credentials_store = "ephemeral"\n' +
	'web_search = "disabled"\n' +
	"[features]\n" +
	"realtime_conversation = true\n" +
	"shell_tool = false\n" +
	"unified_exec = false\n" +
	"view_image = false\n" +
	"image_generation = false\n" +
	"code_mode_host = false\n" +
	"standalone_web_search = false\n" +
	"memories = false\n" +
	"apps = false\n" +
	"plugins = false\n" +
	"remote_plugin = false\n" +
	"browser_use = false\n" +
	"computer_use = false\n" +
	"multi_agent = false\n" +
	"hooks = false\n" +
	"skip_host_skill_discovery = true\n";

export const VOICE_SCRIBE_HOME_CONFIG =
	'web_search = "disabled"\n' +
	"[features]\n" +
	"shell_tool = false\n" +
	"unified_exec = false\n" +
	"view_image = false\n" +
	"image_generation = false\n" +
	"code_mode_host = false\n" +
	"standalone_web_search = false\n" +
	"memories = false\n" +
	"apps = false\n" +
	"plugins = false\n" +
	"remote_plugin = false\n" +
	"browser_use = false\n" +
	"computer_use = false\n" +
	"multi_agent = false\n" +
	"hooks = false\n" +
	"skip_host_skill_discovery = true\n";

/** Read-only admission. The host preparation step owns creation and rollback. */
export function assertVoiceCodexHome(home: string): void {
	let fd: number | undefined;
	try {
		const directory = lstatSync(home);
		const uid = process.getuid?.();
		if (
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			(directory.mode & 0o777) !== 0o700 ||
			(uid !== undefined && directory.uid !== uid)
		)
			throw new Error("directory");
		// An existing subscription/file credential is never reused or removed here.
		try {
			lstatSync(join(home, "auth.json"));
			throw new Error("existing_auth");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		fd = openSync(
			join(home, "config.toml"),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		const config = fstatSync(fd);
		if (
			!config.isFile() ||
			(config.mode & 0o777) !== 0o600 ||
			(uid !== undefined && config.uid !== uid) ||
			config.size > 4096
		)
			throw new Error("file");
		// Exact, auditable config: no profiles, provider/endpoint overrides or MCP.
		if (readFileSync(fd, "utf8") !== VOICE_CODEX_HOME_CONFIG)
			throw new Error("config");
	} catch {
		throw new Error("voice_codex_home_invalid");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Read-only admission for the subscription-backed, no-tool scribe profile. */
export function assertVoiceScribeHome(
	home: string,
	expectedAuthPath: string,
): void {
	let configFd: number | undefined;
	let authFd: number | undefined;
	try {
		const directory = lstatSync(home);
		const uid = process.getuid?.();
		if (
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			(directory.mode & 0o777) !== 0o700 ||
			(uid !== undefined && directory.uid !== uid)
		)
			throw new Error("directory");

		const authLinkPath = join(home, "auth.json");
		if (!lstatSync(authLinkPath).isSymbolicLink()) throw new Error("auth_link");
		authFd = openSync(
			expectedAuthPath,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		const auth = fstatSync(authFd);
		if (
			!auth.isFile() ||
			(auth.mode & 0o777) !== 0o600 ||
			(uid !== undefined && auth.uid !== uid) ||
			realpathSync(authLinkPath) !== realpathSync(expectedAuthPath)
		)
			throw new Error("auth_source");

		configFd = openSync(
			join(home, "config.toml"),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		const config = fstatSync(configFd);
		if (
			!config.isFile() ||
			(config.mode & 0o777) !== 0o600 ||
			(uid !== undefined && config.uid !== uid) ||
			config.size > 4096 ||
			readFileSync(configFd, "utf8") !== VOICE_SCRIBE_HOME_CONFIG
		)
			throw new Error("config");
	} catch {
		throw new Error("voice_scribe_home_invalid");
	} finally {
		if (configFd !== undefined) closeSync(configFd);
		if (authFd !== undefined) closeSync(authFd);
	}
}

/** Admission only: the capability parent is the sole config and auth-link writer. */
export function assertVoiceCapabilityHome(
	home: string,
	expectedAuthPath: string,
): void {
	const descriptors: number[] = [];
	try {
		const uid = process.getuid?.();
		const directory = lstatSync(home);
		if (
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			(directory.mode & 0o777) !== 0o700 ||
			(uid !== undefined && directory.uid !== uid)
		)
			throw new Error("directory");
		const readPrivate = (path: string, maximumBytes: number): string => {
			const fd = openSync(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			descriptors.push(fd);
			const stat = fstatSync(fd);
			if (
				!stat.isFile() ||
				(stat.mode & 0o777) !== 0o600 ||
				(uid !== undefined && stat.uid !== uid) ||
				stat.size > maximumBytes
			)
				throw new Error("file");
			return readFileSync(fd, "utf8");
		};
		const auth = join(home, "auth.json");
		if (
			!lstatSync(auth).isSymbolicLink() ||
			realpathSync(auth) !== realpathSync(expectedAuthPath)
		)
			throw new Error("auth_link");
		readPrivate(expectedAuthPath, 1024 * 1024);
		const config = readPrivate(join(home, "config.toml"), 1024 * 1024);
		const proof = readPrivate(
			join(home, ".flywheel-capability-config.sha256"),
			130,
		).trim();
		if (
			!config.startsWith("# Flywheel managed capability bundle v2\n") ||
			/forced_login_method\s*=\s*["']api["']/u.test(config) ||
			proof !== createHash("sha256").update(config).digest("hex")
		)
			throw new Error("config");
	} catch {
		throw new Error("voice_capability_home_invalid");
	} finally {
		for (const fd of descriptors) closeSync(fd);
	}
}
