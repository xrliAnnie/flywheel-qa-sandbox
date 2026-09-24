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
	VOICE_CODEX_HOME_CONFIG,
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
