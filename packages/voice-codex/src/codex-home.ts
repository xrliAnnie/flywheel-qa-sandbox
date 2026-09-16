import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";

export const VOICE_CODEX_HOME_CONFIG =
	'forced_login_method = "api"\ncli_auth_credentials_store = "ephemeral"\n';

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
