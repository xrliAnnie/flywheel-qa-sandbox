import {
	chmodSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertVoiceCodexHome,
	assertVoiceScribeHome,
	VOICE_CODEX_HOME_CONFIG,
	VOICE_SCRIBE_HOME_CONFIG,
} from "../codex-home.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function home() {
	const path = mkdtempSync(join(tmpdir(), "voice-codex-home-"));
	roots.push(path);
	chmodSync(path, 0o700);
	writeFileSync(join(path, "config.toml"), VOICE_CODEX_HOME_CONFIG, {
		mode: 0o600,
	});
	return path;
}

function scribeHome() {
	const sourceRoot = mkdtempSync(join(tmpdir(), "voice-scribe-auth-"));
	const path = mkdtempSync(join(tmpdir(), "voice-scribe-home-"));
	roots.push(sourceRoot, path);
	chmodSync(sourceRoot, 0o700);
	chmodSync(path, 0o700);
	const auth = join(sourceRoot, "auth.json");
	writeFileSync(auth, "{}", { mode: 0o600 });
	writeFileSync(join(path, "config.toml"), VOICE_SCRIBE_HOME_CONFIG, {
		mode: 0o600,
	});
	symlinkSync(auth, join(path, "auth.json"));
	return { path, auth, sourceRoot };
}
describe("voice Codex home", () => {
	it("accepts only a private ordinary home and fixed API ephemeral config", () => {
		expect(() => assertVoiceCodexHome(home())).not.toThrow();
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
		"subscription",
		"file-store",
		"provider",
		"mcp",
		"auth-file",
	])("refuses %s without repairing it", (failure) => {
		let path = home();
		const config = join(path, "config.toml");
		if (failure === "missing") rmSync(config);
		if (failure === "config-symlink") {
			rmSync(config);
			const target = join(path, "source.toml");
			writeFileSync(target, VOICE_CODEX_HOME_CONFIG, { mode: 0o600 });
			symlinkSync(target, config);
		}
		if (failure === "home-symlink") {
			const parent = home();
			const link = join(parent, "alias");
			symlinkSync(path, link);
			path = link;
		}
		if (failure === "public-config") chmodSync(config, 0o644);
		if (failure === "public-home") chmodSync(path, 0o755);
		if (failure === "subscription")
			writeFileSync(
				config,
				VOICE_CODEX_HOME_CONFIG.replace('"api"', '"chatgpt"'),
			);
		if (failure === "file-store")
			writeFileSync(
				config,
				VOICE_CODEX_HOME_CONFIG.replace('"ephemeral"', '"file"'),
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
		if (failure === "auth-file")
			writeFileSync(join(path, "auth.json"), "do not read or remove", {
				mode: 0o600,
			});
		expect(() => assertVoiceCodexHome(path)).toThrow(
			"voice_codex_home_invalid",
		);
	});
});

describe("voice scribe Codex home", () => {
	it("accepts only the fixed no-tool subscription config and host auth symlink", () => {
		const fixture = scribeHome();
		expect(() =>
			assertVoiceScribeHome(fixture.path, fixture.auth),
		).not.toThrow();
		expect(VOICE_SCRIBE_HOME_CONFIG).not.toContain("forced_login_method");
		expect(VOICE_SCRIBE_HOME_CONFIG).not.toContain("realtime_conversation");
		for (const feature of [
			"shell_tool",
			"unified_exec",
			"view_image",
			"image_generation",
			"code_mode_host",
			"standalone_web_search",
			"memories",
			"apps",
			"plugins",
			"browser_use",
			"computer_use",
			"multi_agent",
			"hooks",
		]) {
			expect(VOICE_SCRIBE_HOME_CONFIG).toContain(`${feature} = false`);
		}
	});

	it.each([
		"missing-auth",
		"copied-auth",
		"wrong-auth",
		"public-auth-source",
		"api-login",
		"mcp",
		"tool-enabled",
	])("refuses scribe %s without repairing it", (failure) => {
		const fixture = scribeHome();
		const authLink = join(fixture.path, "auth.json");
		const config = join(fixture.path, "config.toml");
		if (failure === "missing-auth") rmSync(authLink);
		if (failure === "copied-auth") {
			rmSync(authLink);
			writeFileSync(authLink, "{}", { mode: 0o600 });
		}
		if (failure === "wrong-auth") {
			const other = join(fixture.sourceRoot, "other-auth.json");
			writeFileSync(other, "{}", { mode: 0o600 });
			rmSync(authLink);
			symlinkSync(other, authLink);
		}
		if (failure === "public-auth-source") chmodSync(fixture.auth, 0o644);
		if (failure === "api-login")
			writeFileSync(
				config,
				`forced_login_method = "api"\n${VOICE_SCRIBE_HOME_CONFIG}`,
			);
		if (failure === "mcp")
			writeFileSync(
				config,
				`${VOICE_SCRIBE_HOME_CONFIG}\n[mcp_servers.example]\ncommand="unsafe"\n`,
			);
		if (failure === "tool-enabled")
			writeFileSync(
				config,
				VOICE_SCRIBE_HOME_CONFIG.replace(
					"unified_exec = false",
					"unified_exec = true",
				),
			);
		expect(() => assertVoiceScribeHome(fixture.path, fixture.auth)).toThrow(
			"voice_scribe_home_invalid",
		);
	});
});
