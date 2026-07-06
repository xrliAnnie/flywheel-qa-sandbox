/**
 * FLY-123 WS-A + WS-C: per-runner CODEX_HOME provisioning + credential
 * lockdown. Unit-covers the home module against a temp source ~/.codex and a
 * temp homes root (no real ~/.codex touched).
 */
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	codexHomeDir,
	codexHomesRoot,
	discoverAccountPool,
	provisionCodexHome,
	removeCodexHome,
	renderCodexHomeConfig,
	scrubCodexHomeCredential,
	scrubOrphanedCodexHomes,
	sourceCodexDir,
	stripSecretEnv,
} from "../src/codex-home.js";

const GLOBAL_CONFIG = `sandbox_mode = "workspace-write"
approval_policy = "never"
model = "gpt-5-codex"

[projects."/Users/x/Dev/flywheel"]
trust_level = "trusted"
`;
const TOKEN = "gho_AbC123_def-456";

let tmp: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "fly123-home-"));
	const src = join(tmp, "dotcodex");
	mkdirSync(join(src, "profiles", "personal"), { recursive: true });
	mkdirSync(join(src, "profiles", "business"), { recursive: true });
	writeFileSync(
		join(src, "auth.json"),
		'{"OPENAI_API_KEY":null,"tokens":{"x":1}}',
	);
	writeFileSync(join(src, "config.toml"), GLOBAL_CONFIG);
	env = {
		FLYWHEEL_CODEX_HOMES_ROOT: join(tmp, "homes"),
		FLYWHEEL_CODEX_SOURCE_HOME: src,
	};
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("path resolution (WS-E seam)", () => {
	it("codexHomesRoot honors FLYWHEEL_CODEX_HOMES_ROOT", () => {
		expect(codexHomesRoot(env)).toBe(join(tmp, "homes"));
	});

	it("codexHomeDir nests the execution id under the root", () => {
		expect(codexHomeDir("exec-42", env)).toBe(join(tmp, "homes", "exec-42"));
	});

	it("defaults to ~/.flywheel/codex-homes when unset", () => {
		expect(codexHomesRoot({})).toMatch(/\.flywheel\/codex-homes$/);
	});

	it("sourceCodexDir honors FLYWHEEL_CODEX_SOURCE_HOME", () => {
		expect(sourceCodexDir(env)).toBe(join(tmp, "dotcodex"));
	});
});

describe("discoverAccountPool (dynamic, AC6)", () => {
	it("lists profile dirs sorted, no hardcoded count", () => {
		expect(discoverAccountPool(env)).toEqual(["business", "personal"]);
	});

	it("follows the pool when a profile is added (no code change)", () => {
		mkdirSync(join(tmp, "dotcodex", "profiles", "school"));
		expect(discoverAccountPool(env)).toEqual([
			"business",
			"personal",
			"school",
		]);
	});

	it("returns [] when the pool dir is absent", () => {
		expect(
			discoverAccountPool({ FLYWHEEL_CODEX_PROFILES_DIR: join(tmp, "nope") }),
		).toEqual([]);
	});
});

describe("renderCodexHomeConfig (WS-C delivery)", () => {
	it("preserves base config and appends the GH_TOKEN block", () => {
		const out = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN);
		expect(out).toContain('model = "gpt-5-codex"');
		expect(out).toContain("[shell_environment_policy.set]");
		expect(out).toContain(`GH_TOKEN = "${TOKEN}"`);
	});

	it("is idempotent — re-render does not stack duplicate blocks", () => {
		const once = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN);
		const twice = renderCodexHomeConfig(once, TOKEN);
		expect(twice).toBe(once);
		expect(twice.match(/shell_environment_policy/g)?.length).toBe(1);
	});

	it("emits no credential block when no token is given", () => {
		const out = renderCodexHomeConfig(GLOBAL_CONFIG);
		expect(out).not.toContain("shell_environment_policy");
		expect(out).toContain('model = "gpt-5-codex"');
	});

	it("strips a prior block when re-rendered without a token (scrub semantics)", () => {
		const withTok = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN);
		const scrubbed = renderCodexHomeConfig(withTok);
		expect(scrubbed).not.toContain("GH_TOKEN");
		expect(scrubbed).not.toContain("shell_environment_policy");
		expect(scrubbed).toContain('model = "gpt-5-codex"');
	});

	it("fails loudly if base declares the shell_environment_policy namespace — table, dotted-key, inline, or spaced (R1 #5)", () => {
		const variants = [
			`${GLOBAL_CONFIG}\n[shell_environment_policy]\ninherit = "core"\n`,
			`${GLOBAL_CONFIG}\n[shell_environment_policy.set]\nFOO = "bar"\n`,
			`${GLOBAL_CONFIG}\nshell_environment_policy.set.FOO = "bar"\n`,
			`${GLOBAL_CONFIG}\nshell_environment_policy = { set = { FOO = "bar" } }\n`,
			`${GLOBAL_CONFIG}\n[ shell_environment_policy ]\ninherit = "core"\n`,
		];
		for (const base of variants) {
			expect(() => renderCodexHomeConfig(base, TOKEN)).toThrow(
				/shell_environment_policy namespace/,
			);
		}
		// A comment mentioning it must NOT trip the guard.
		expect(() =>
			renderCodexHomeConfig(
				`${GLOBAL_CONFIG}\n# shell_environment_policy is managed by flywheel\n`,
				TOKEN,
			),
		).not.toThrow();
	});
});

describe("provisionCodexHome (WS-A)", () => {
	it("creates the home, seeds auth.json (0600) and config.toml (0600) with the token", () => {
		const home = provisionCodexHome({
			executionId: "exec-1",
			ghToken: TOKEN,
			env,
		});
		expect(home).toBe(join(tmp, "homes", "exec-1"));

		const authMode = statSync(join(home, "auth.json")).mode & 0o777;
		expect(authMode).toBe(0o600);
		const cfgMode = statSync(join(home, "config.toml")).mode & 0o777;
		expect(cfgMode).toBe(0o600);

		const cfg = readFileSync(join(home, "config.toml"), "utf-8");
		expect(cfg).toContain(`GH_TOKEN = "${TOKEN}"`);
		expect(cfg).toContain('model = "gpt-5-codex"');
		// auth seeded verbatim from source
		expect(readFileSync(join(home, "auth.json"), "utf-8")).toContain(
			'"tokens"',
		);
	});

	it("is idempotent — re-provisioning overwrites in place", () => {
		provisionCodexHome({ executionId: "exec-2", ghToken: TOKEN, env });
		provisionCodexHome({ executionId: "exec-2", ghToken: TOKEN, env });
		const cfg = readFileSync(
			join(tmp, "homes", "exec-2", "config.toml"),
			"utf-8",
		);
		expect(cfg.match(/shell_environment_policy/g)?.length).toBe(1);
	});

	it("provisions without a token (no credential block)", () => {
		const home = provisionCodexHome({ executionId: "exec-3", env });
		const cfg = readFileSync(join(home, "config.toml"), "utf-8");
		expect(cfg).not.toContain("GH_TOKEN");
	});

	it("rejects a malformed token", () => {
		expect(() =>
			provisionCodexHome({ executionId: "exec-4", ghToken: 'bad"token', env }),
		).toThrow(/ghToken must match/);
	});
});

describe("retirement (P5 credential-residue invariant)", () => {
	it("scrubCodexHomeCredential removes the live token but keeps the home", () => {
		const home = provisionCodexHome({
			executionId: "exec-5",
			ghToken: TOKEN,
			env,
		});
		scrubCodexHomeCredential("exec-5", env);
		const cfg = readFileSync(join(home, "config.toml"), "utf-8");
		expect(cfg).not.toContain("GH_TOKEN");
		expect(cfg).not.toContain("shell_environment_policy");
		expect(cfg).toContain('model = "gpt-5-codex"'); // base config retained
	});

	it("scrub is a no-op when the home is absent", () => {
		expect(() => scrubCodexHomeCredential("never-existed", env)).not.toThrow();
	});

	it("removeCodexHome deletes the whole home", () => {
		const home = provisionCodexHome({
			executionId: "exec-6",
			ghToken: TOKEN,
			env,
		});
		removeCodexHome("exec-6", env);
		expect(() => statSync(home)).toThrow();
	});
});

describe("R1 hardening (Codex code review round 1)", () => {
	it("MED #2: re-provision repairs a pre-existing wider-mode config.toml back to 0600", () => {
		const home = provisionCodexHome({ executionId: "x1", ghToken: TOKEN, env });
		// Simulate a config that pre-existed world-readable (e.g. crash-recovery).
		chmodSync(join(home, "config.toml"), 0o644);
		chmodSync(home, 0o755);
		provisionCodexHome({ executionId: "x1", ghToken: TOKEN, env });
		expect(statSync(join(home, "config.toml")).mode & 0o777).toBe(0o600);
		expect(statSync(home).mode & 0o777).toBe(0o700);
	});

	it("MED #3: scrubOrphanedCodexHomes strips the token from non-live homes, keeps live ones", () => {
		provisionCodexHome({ executionId: "live-1", ghToken: TOKEN, env });
		provisionCodexHome({ executionId: "dead-1", ghToken: TOKEN, env });
		provisionCodexHome({ executionId: "dead-2", ghToken: TOKEN, env });

		const scrubbed = scrubOrphanedCodexHomes(new Set(["live-1"]), env);
		expect(scrubbed).toBe(2);

		const read = (id: string) =>
			readFileSync(join(codexHomeDir(id, env), "config.toml"), "utf-8");
		expect(read("live-1")).toContain("GH_TOKEN"); // live runner keeps its token
		expect(read("dead-1")).not.toContain("GH_TOKEN");
		expect(read("dead-2")).not.toContain("GH_TOKEN");
		// re-running is a no-op (already-clean homes aren't recounted)
		expect(scrubOrphanedCodexHomes(new Set(["live-1"]), env)).toBe(0);
	});

	it("MED #3: scrubOrphanedCodexHomes is a no-op when the homes root is absent", () => {
		expect(
			scrubOrphanedCodexHomes(new Set(), {
				FLYWHEEL_CODEX_HOMES_ROOT: join(tmp, "no-such-root"),
			}),
		).toBe(0);
	});

	it("HIGH #1: stripSecretEnv removes all GitHub-token env names, keeps the rest", () => {
		const out = stripSecretEnv({
			GH_TOKEN: "ghp_x",
			GITHUB_TOKEN: "ghp_y",
			GH_ENTERPRISE_TOKEN: "z",
			PATH: "/usr/bin",
			CODEX_HOME: "/home",
		});
		expect(out.GH_TOKEN).toBeUndefined();
		expect(out.GITHUB_TOKEN).toBeUndefined();
		expect(out.GH_ENTERPRISE_TOKEN).toBeUndefined();
		expect(out.PATH).toBe("/usr/bin");
		expect(out.CODEX_HOME).toBe("/home");
	});
});
