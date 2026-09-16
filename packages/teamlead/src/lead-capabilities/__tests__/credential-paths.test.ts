import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { expect, it } from "vitest";
import {
	leadCredentialAliases,
	pinLeadCredentialPaths,
} from "../credential-paths.js";
import { renderLeadPermissionProfile } from "../permission-profile.js";

it("pins aliases and absent descendants without reading credential contents, and detects retargeting", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "credential-paths-")));
	try {
		const one = join(root, "one"),
			two = join(root, "two"),
			alias = join(root, "alias");
		mkdirSync(one);
		mkdirSync(two);
		symlinkSync(one, alias);
		const path = join(alias, "future", "secret");
		const pin = pinLeadCredentialPaths([path, path]);
		expect(pin.paths).toEqual([path, join(one, "future", "secret")].sort());
		expect(() => pin.assertCurrent()).not.toThrow();
		mkdirSync(join(one, "future"));
		writeFileSync(join(one, "future", "secret"), "synthetic", { mode: 0 });
		expect(() => pin.assertCurrent()).not.toThrow();
		unlinkSync(alias);
		symlinkSync(two, alias);
		expect(() => pin.assertCurrent()).toThrow("credential_source_changed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
it("rejects ambiguous, unbounded and dangling credential metadata", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "credential-paths-")));
	try {
		const dangling = join(root, "dangling");
		symlinkSync(join(root, "absent"), dangling);
		for (const paths of [
			[],
			["relative"],
			["/"],
			[`${root}/../secret`],
			[`${root}/*`],
			[dangling],
			Array(257).fill(root),
		])
			expect(() => pinLeadCredentialPaths(paths)).toThrow(
				"credential_source_invalid",
			);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("covers current launcher and account storage aliases without opening credentials", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "credential-aliases-")));
	try {
		const source = join(root, "source"),
			wrapper = join(root, "wrapper.env");
		writeFileSync(wrapper, "synthetic unreadable credential", { mode: 0 });
		const paths = leadCredentialAliases({
			HOME: root,
			FLYWHEEL_WRAPPER_ENV_FILE: wrapper,
			FLYWHEEL_CODEX_SOURCE_HOME: source,
			GH_CONFIG_DIR: join(root, "gh-custom"),
			FLYWHEEL_CLAUDE_PROFILES_DIR: join(root, "claude-pool"),
		});
		expect(paths).toEqual(
			expect.arrayContaining([
				wrapper,
				join(root, ".flywheel/.env"),
				join(source, "auth.json"),
				join(source, "profiles"),
				join(root, ".flywheel/codex-homes"),
				join(root, ".flywheel/codex-credential-backups"),
				join(root, "claude-pool"),
				join(root, ".claude.json"),
				join(root, "gh-custom"),
				join(root, ".ssh"),
				join(root, ".git-credentials"),
				join(root, "Library/Keychains"),
				join(root, "Library/LaunchAgents"),
			]),
		);
		expect(() => pinLeadCredentialPaths(paths)).not.toThrow();
		expect(() =>
			leadCredentialAliases({ HOME: root, GH_CONFIG_DIR: "relative" }),
		).toThrow("credential_source_invalid");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("keeps private current-home files denied while allowing only pinned public paths in a .codex-key home", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "credential-current-")));
	try {
		const active = join(root, ".codex-honey"),
			historical = join(root, ".codex-retired");
		mkdirSync(active);
		mkdirSync(historical);
		const env = { HOME: root, CODEX_HOME: active };
		expect(leadCredentialAliases(env)).toContain(active);
		const denied = leadCredentialAliases(env, active);
		expect(denied).not.toContain(active);
		expect(denied).toEqual(
			expect.arrayContaining([
				historical,
				join(active, "auth.json"),
				join(active, "config.toml"),
				join(active, "profiles"),
				join(active, "sessions"),
			]),
		);
		const publicPaths = [join(active, "skills"), join(active, "bin", "codex")];
		const parsed = parse(
			renderLeadPermissionProfile({
				deploymentRoot: join(root, "deploy"),
				projectRoot: join(root, "project"),
				artifactRoot: join(root, "project", "artifacts"),
				brokerSocket: join(root, "broker.sock"),
				proxyPort: 31999,
				credentialPaths: denied,
				readPaths: publicPaths,
			}),
		) as any;
		const fs = parsed.permissions["flywheel-lead-v2"].filesystem;
		expect(fs[":root"]).toBe("deny");
		expect(fs[active]).toBeUndefined();
		for (const path of publicPaths) expect(fs[path]).toBe("read");
		expect(fs[join(active, "auth.json")]).toBe("deny");
		expect(() =>
			renderLeadPermissionProfile({
				deploymentRoot: join(root, "deploy"),
				projectRoot: join(root, "project"),
				artifactRoot: join(root, "project", "artifacts"),
				brokerSocket: join(root, "broker.sock"),
				proxyPort: 31999,
				credentialPaths: denied,
				readPaths: [join(active, "auth.json")],
			}),
		).toThrow("permission grant overlaps a credential source");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
