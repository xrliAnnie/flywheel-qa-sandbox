import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertVoiceCodexHome,
	pinVoiceCodexAuthSource,
	VOICE_CODEX_HOME_CONFIG,
} from "../codex-home.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function scratch(): string {
	const path = mkdtempSync(join(tmpdir(), "voice-codex-auth-"));
	roots.push(path);
	return realpathSync(path);
}
function authSource(): string {
	const path = join(scratch(), "auth.json");
	writeFileSync(path, '{"tokens":"fixture"}', { mode: 0o600 });
	return path;
}
function home(source = authSource()) {
	const path = mkdtempSync(join(tmpdir(), "voice-codex-home-"));
	roots.push(path);
	chmodSync(path, 0o700);
	writeFileSync(join(path, "config.toml"), VOICE_CODEX_HOME_CONFIG, {
		mode: 0o600,
	});
	symlinkSync(source, join(path, "auth.json"));
	return { path, source };
}
describe("voice Codex home", () => {
	it("accepts only a private home, the fixed subscription config and a symlink to the pinned credential", () => {
		const { path, source } = home();
		expect(() => assertVoiceCodexHome(path, source)).not.toThrow();
		expect(VOICE_CODEX_HOME_CONFIG).toContain(
			'forced_login_method = "chatgpt"',
		);
		expect(VOICE_CODEX_HOME_CONFIG).toContain(
			'cli_auth_credentials_store = "file"',
		);
		for (const feature of [
			"unified_exec",
			"view_image",
			"image_generation",
			"code_mode_host",
			"standalone_web_search",
		]) {
			expect(VOICE_CODEX_HOME_CONFIG).toContain(`${feature} = false`);
		}
		expect(VOICE_CODEX_HOME_CONFIG).toContain('web_search = "disabled"');
	});
	it.each([
		"missing",
		"config-symlink",
		"home-symlink",
		"public-config",
		"public-home",
		"api-login",
		"ephemeral-store",
		"provider",
		"mcp",
		"auth-missing",
		"auth-copy",
		"auth-elsewhere",
	])("refuses %s without repairing it", (failure) => {
		const created = home();
		let path = created.path;
		const config = join(path, "config.toml");
		const auth = join(path, "auth.json");
		if (failure === "missing") rmSync(config);
		if (failure === "config-symlink") {
			rmSync(config);
			const target = join(path, "source.toml");
			writeFileSync(target, VOICE_CODEX_HOME_CONFIG, { mode: 0o600 });
			symlinkSync(target, config);
		}
		if (failure === "home-symlink") {
			const parent = home().path;
			const link = join(parent, "alias");
			symlinkSync(path, link);
			path = link;
		}
		if (failure === "public-config") chmodSync(config, 0o644);
		if (failure === "public-home") chmodSync(path, 0o755);
		if (failure === "api-login")
			writeFileSync(
				config,
				VOICE_CODEX_HOME_CONFIG.replace('"chatgpt"', '"api"'),
			);
		if (failure === "ephemeral-store")
			writeFileSync(
				config,
				VOICE_CODEX_HOME_CONFIG.replace('"file"', '"ephemeral"'),
			);
		if (failure === "provider")
			writeFileSync(
				config,
				`${VOICE_CODEX_HOME_CONFIG}\nmodel_provider="other"\n`,
			);
		if (failure === "mcp")
			writeFileSync(
				config,
				`${VOICE_CODEX_HOME_CONFIG}\n[mcp_servers.example]\ncommand="unsafe"\n`,
			);
		if (failure === "auth-missing") rmSync(auth);
		if (failure === "auth-copy") {
			// A copy forks the refresh token (FLY-2404); only a link is allowed.
			rmSync(auth);
			writeFileSync(auth, readFileSync(created.source), { mode: 0o600 });
		}
		if (failure === "auth-elsewhere") {
			rmSync(auth);
			symlinkSync(authSource(), auth);
		}
		expect(() => assertVoiceCodexHome(path, created.source)).toThrow(
			"voice_codex_home_invalid",
		);
	});
	it("removing the home deletes only the link, never the credential", () => {
		const { path, source } = home();
		const before = readFileSync(source);
		rmSync(path, { recursive: true, force: true });
		expect(readFileSync(source)).toEqual(before);
	});
});

describe("voice Codex credential source pin", () => {
	it("pins the real path of a private regular file", () => {
		const source = authSource();
		expect(pinVoiceCodexAuthSource(source)).toBe(source);
		const dir = scratch();
		mkdirSync(join(dir, "real"), { mode: 0o700 });
		const nested = join(dir, "real", "auth.json");
		writeFileSync(nested, "{}", { mode: 0o600 });
		symlinkSync(join(dir, "real"), join(dir, "alias"));
		expect(pinVoiceCodexAuthSource(join(dir, "alias", "auth.json"))).toBe(
			nested,
		);
	});
	it.each(["relative", "missing", "symlink", "public", "directory"])(
		"refuses a %s credential source",
		(failure) => {
			let source = authSource();
			if (failure === "relative") source = "auth.json";
			if (failure === "missing") rmSync(source);
			if (failure === "symlink") {
				const link = join(scratch(), "auth.json");
				symlinkSync(source, link);
				source = link;
			}
			if (failure === "public") chmodSync(source, 0o644);
			if (failure === "directory") source = scratch();
			expect(() => pinVoiceCodexAuthSource(source)).toThrow(
				"voice_codex_auth_source_invalid",
			);
		},
	);
});
