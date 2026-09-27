import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readlinkSync,
	realpathSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * FLY-2885: engine B authenticates with the fleet's ChatGPT subscription.
 * `file` is the only store that reads the linked auth.json (`ephemeral` does
 * not); `chatgpt` refuses any API-key login.
 */
export const VOICE_CODEX_HOME_CONFIG =
	'forced_login_method = "chatgpt"\n' +
	'cli_auth_credentials_store = "file"\n' +
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
	"browser_use = false\n" +
	"computer_use = false\n" +
	"multi_agent = false\n" +
	"hooks = false\n" +
	"skip_host_skill_discovery = true\n";

/**
 * The shared credential is linked, never copied: a copy forks the refresh
 * token and the fleet's original then fails with refresh_token_reused
 * (FLY-2404). Returns the real path every home must link to.
 */
export function pinVoiceCodexAuthSource(source: string): string {
	try {
		if (!isAbsolute(source)) throw new Error("relative");
		const metadata = lstatSync(source);
		const uid = process.getuid?.();
		if (
			!metadata.isFile() ||
			metadata.isSymbolicLink() ||
			(metadata.mode & 0o777) !== 0o600 ||
			(uid !== undefined && metadata.uid !== uid)
		)
			throw new Error("file");
		const pinned = realpathSync(source);
		const resolved = lstatSync(pinned);
		if (resolved.ino !== metadata.ino || resolved.dev !== metadata.dev)
			throw new Error("moved");
		return pinned;
	} catch {
		throw new Error("voice_codex_auth_source_invalid");
	}
}

/** Read-only admission. The host preparation step owns creation and rollback. */
export function assertVoiceCodexHome(home: string, authSource: string): void {
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
		// The only credential form allowed here is a link to the pinned source.
		const auth = join(home, "auth.json");
		if (!lstatSync(auth).isSymbolicLink() || readlinkSync(auth) !== authSource)
			throw new Error("auth");
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
