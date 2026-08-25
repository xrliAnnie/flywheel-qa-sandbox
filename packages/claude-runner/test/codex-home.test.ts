/**
 * FLY-123 WS-A + WS-C: per-runner CODEX_HOME provisioning + credential
 * lockdown. Unit-covers the home module against a temp source ~/.codex and a
 * temp homes root (no real ~/.codex touched).
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertCodexSourceIdentity,
	codexHomeDir,
	codexHomesRoot,
	discoverAccountPool as discoverAccountPoolProduction,
	provisionCodexHome as provisionCodexHomeProduction,
	rawCodexBin,
	removeCodexHome,
	renderCodexHomeConfig,
	scrubCodexHomeCredential,
	scrubOrphanedCodexHomes,
	sourceCodexDir,
	stripInheritedSecretEnv,
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
let registryPath: string;
let ledgerRoot: string;

function jwt(email: string, accountId: string, plan = "pro"): string {
	return [
		Buffer.from('{"alg":"none"}').toString("base64url"),
		Buffer.from(
			JSON.stringify({
				email,
				"https://api.openai.com/auth": {
					chatgpt_account_id: accountId,
					chatgpt_plan_type: plan,
				},
			}),
		).toString("base64url"),
		"signature",
	].join(".");
}

function testAuth(
	email = "personal@example.test",
	accountId = "acct-personal",
) {
	return JSON.stringify({
		tokens: {
			id_token: jwt(email, accountId),
			access_token: "test-access-canary",
			refresh_token: "test-refresh-canary",
		},
	});
}

function provisionCodexHome(
	opts: Parameters<typeof provisionCodexHomeProduction>[0],
): string {
	return provisionCodexHomeProduction({
		...opts,
		registryPath,
		ledgerRoot,
	});
}

function discoverAccountPool(envArg: NodeJS.ProcessEnv = env): string[] {
	return discoverAccountPoolProduction(envArg, registryPath);
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "fly123-home-"));
	const src = join(tmp, "dotcodex");
	mkdirSync(join(src, "profiles", "personal"), { recursive: true });
	mkdirSync(join(src, "profiles", "business"), { recursive: true });
	registryPath = join(tmp, "codex-account-registry.json");
	ledgerRoot = join(tmp, "codex-account-ledger");
	writeFileSync(
		registryPath,
		JSON.stringify({
			version: 1,
			primary: "personal",
			profiles: [
				{
					name: "school",
					email: "school@example.test",
					role: "manual_backup",
				},
				{
					name: "personal",
					email: "personal@example.test",
					role: "primary",
				},
				{
					name: "business",
					email: "business@example.test",
					role: "manual_backup",
				},
			],
		}),
	);
	writeFileSync(join(src, "auth.json"), testAuth());
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
	it("lists only existing canonical profile dirs sorted", () => {
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

	it("excludes zombie and unknown profile directories", () => {
		mkdirSync(join(tmp, "dotcodex", "profiles", "personal1"));
		mkdirSync(join(tmp, "dotcodex", "profiles", "mystery"));
		expect(discoverAccountPool(env)).toEqual(["business", "personal"]);
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

	it("FLY-1604 fails loudly ONLY on unmergeable shell_environment_policy shapes — root dotted key or inline table (rewrite of R1 #5)", () => {
		// Root-level dotted/inline definitions must sit BEFORE any [table]
		// header — appended after one they would be relative keys inside that
		// table (exactly the false-positive class the root-aware merge fixed).
		const variants = [
			`shell_environment_policy.set.FOO = "bar"\n${GLOBAL_CONFIG}`,
			`shell_environment_policy = { set = { FOO = "bar" } }\n${GLOBAL_CONFIG}`,
		];
		for (const base of variants) {
			expect(() => renderCodexHomeConfig(base, TOKEN)).toThrow(
				/shell_environment_policy/,
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

	it("FLY-1395 renders deterministic Codex skill-disable blocks", () => {
		const out = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN, {
			skillDisableNames: [
				"superpowers:test-driven-development",
				"superpowers:brainstorming",
				"superpowers:brainstorming",
			],
		});
		expect(out).toContain(
			'# >>> flywheel-managed skills (FLY-1395) — do not edit >>>\n[[skills.config]]\nname = "superpowers:brainstorming"\nenabled = false\n\n[[skills.config]]\nname = "superpowers:test-driven-development"\nenabled = false\n# <<< flywheel-managed skills (FLY-1395) <<<',
		);
		expect(out).toContain(`GH_TOKEN = "${TOKEN}"`);
	});

	it("FLY-1395 skill rendering is idempotent and does not stack blocks", () => {
		const opts = {
			skillDisableNames: ["superpowers:brainstorming"],
		};
		const once = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN, opts);
		const twice = renderCodexHomeConfig(once, TOKEN, opts);
		expect(twice).toBe(once);
		expect(twice.match(/flywheel-managed skills \(FLY-1395\)/g)).toHaveLength(
			2,
		);
	});

	it("FLY-1395 A arm opts absent remains byte-identical", () => {
		expect(renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN)).toBe(
			`${GLOBAL_CONFIG.trimEnd()}\n\n# >>> flywheel-managed credential (FLY-123) — do not edit >>>\n[shell_environment_policy.set]\nGH_TOKEN = "${TOKEN}"\n# <<< flywheel-managed credential (FLY-123) <<<\n`,
		);
	});

	it("FLY-1604 fails loudly ONLY on unmergeable skills shapes — single table, dotted-inline array, inline table (rewrite of FLY-1395 guard)", () => {
		// Header form may sit anywhere; root dotted/inline forms must sit
		// BEFORE any [table] header to actually be root-level definitions.
		for (const base of [
			`${GLOBAL_CONFIG}\n[skills.config]\nname = "x"\n`,
			`skills.config = [{ name = "x", enabled = true }]\n${GLOBAL_CONFIG}`,
			`skills = { config = [] }\n${GLOBAL_CONFIG}`,
		]) {
			expect(() =>
				renderCodexHomeConfig(base, TOKEN, {
					skillDisableNames: ["superpowers:brainstorming"],
				}),
			).toThrow(/skills|valid TOML/);
		}
		expect(() =>
			renderCodexHomeConfig(
				`${GLOBAL_CONFIG}\n# [skills] is managed per runner\n`,
				TOKEN,
				{ skillDisableNames: ["superpowers:brainstorming"] },
			),
		).not.toThrow();
	});

	it("FLY-1395 rejects unsafe skill names before emitting TOML", () => {
		expect(() =>
			renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN, {
				skillDisableNames: ['superpowers:bad"\nenabled = true'],
			}),
		).toThrow(/invalid Codex skill name/);
	});
});

describe("renderCodexHomeConfig — FLY-1961 workspace trust", () => {
	const trustedProjectPath = '/Users/x/Dev/flywheel-"quoted"\\repo';

	it("adds an escaped trusted project without changing existing projects", () => {
		const out = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN, {
			trustedProjectPath,
		});
		const parsed = parseToml(out) as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		expect(parsed.projects[trustedProjectPath].trust_level).toBe("trusted");
		expect(parsed.projects["/Users/x/Dev/flywheel"].trust_level).toBe(
			"trusted",
		);
		expect(parsed.shell_environment_policy.set.GH_TOKEN).toBe(TOKEN);
		expect(out).toContain("flywheel-managed workspace trust (FLY-1961)");
	});

	it("does not drop trust on the pure-passthrough path and is idempotent", () => {
		const once = renderCodexHomeConfig(GLOBAL_CONFIG, undefined, {
			trustedProjectPath: "/tmp/new-worktree",
		});
		const twice = renderCodexHomeConfig(once, undefined, {
			trustedProjectPath: "/tmp/new-worktree",
		});

		expect(
			(
				parseToml(once) as Record<
					string,
					Record<string, Record<string, unknown>>
				>
			).projects["/tmp/new-worktree"].trust_level,
		).toBe("trusted");
		expect(twice).toBe(once);
		expect(twice.match(/flywheel-managed workspace trust/g)).toHaveLength(2);
	});

	it("does not add a managed block when the exact target is already trusted", () => {
		const out = renderCodexHomeConfig(GLOBAL_CONFIG, undefined, {
			trustedProjectPath: "/Users/x/Dev/flywheel",
		});

		expect(out).toBe(`${GLOBAL_CONFIG.trimEnd()}\n`);
		expect(out).not.toContain("flywheel-managed workspace trust");
	});

	it.each([
		[
			"untrusted target",
			`[projects."/tmp/new-worktree"]\ntrust_level = "untrusted"\n`,
			/trust_level.*trusted/,
		],
		[
			"empty target",
			`[projects."/tmp/new-worktree"]\n`,
			/trust_level.*trusted/,
		],
		["non-table projects", "projects = []\n", /projects.*table/],
		[
			"non-table target",
			`projects."/tmp/new-worktree" = "bad"\n`,
			/project entry.*table/,
		],
	])("fails loudly for %s", (_name, base, message) => {
		expect(() =>
			renderCodexHomeConfig(base, undefined, {
				trustedProjectPath: "/tmp/new-worktree",
			}),
		).toThrow(message);
	});

	it.each(["relative/worktree", "/tmp/bad\0worktree"])(
		"rejects unsafe trustedProjectPath %j",
		(path) => {
			expect(() =>
				renderCodexHomeConfig(GLOBAL_CONFIG, undefined, {
					trustedProjectPath: path,
				}),
			).toThrow(/trustedProjectPath must be.*absolute.*NUL-free/);
		},
	);

	it("coexists with notify, skill disables, and credential injection", () => {
		const notifyProgramPath = join(tmp, "hooks", "runner-stop-notify.sh");
		const out = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN, {
			trustedProjectPath: "/tmp/coexist",
			notifyProgramPath,
			skillDisableNames: ["superpowers:brainstorming"],
		});
		const parsed = parseToml(out) as Record<string, any>;

		expect(parsed.projects["/tmp/coexist"].trust_level).toBe("trusted");
		expect(parsed.notify).toEqual([notifyProgramPath, "--codex"]);
		expect(parsed.shell_environment_policy.set.GH_TOKEN).toBe(TOKEN);
		expect(parsed.skills.config).toContainEqual({
			name: "superpowers:brainstorming",
			enabled: false,
		});
	});
});

describe("renderCodexHomeConfig — FLY-1571 managed notify", () => {
	const notifyProgramPath = '/Users/x/Flywheel Hooks/runner-"stop"\\notify.sh';
	const opts = { notifyProgramPath };

	it("replaces the real single-line root notify and preserves other semantics", () => {
		const base = `notify = ["/Applications/Sky.app/notify", "turn-ended"]\n${GLOBAL_CONFIG}`;
		const out = renderCodexHomeConfig(base, TOKEN, opts);
		const parsed = parseToml(out) as Record<string, unknown>;
		expect(parsed.notify).toEqual([notifyProgramPath, "--codex"]);
		expect(parsed.model).toBe("gpt-5-codex");
		expect(out).not.toContain("Sky.app");
		expect(out).toContain("flywheel-managed notify (FLY-1571)");
	});

	it("inserts notify before the first table when the base has none", () => {
		const out = renderCodexHomeConfig(GLOBAL_CONFIG, undefined, opts);
		expect((parseToml(out) as Record<string, unknown>).notify).toEqual([
			notifyProgramPath,
			"--codex",
		]);
		expect(out.indexOf("notify =")).toBeLessThan(out.indexOf("[projects."));
	});

	it("is idempotent and coexists with the managed GH_TOKEN block", () => {
		const once = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN, opts);
		const twice = renderCodexHomeConfig(once, TOKEN, opts);
		expect(twice).toBe(once);
		expect(twice.match(/flywheel-managed notify/g)).toHaveLength(2);
		expect(twice).toContain(`GH_TOKEN = "${TOKEN}"`);
	});

	it.each([
		[
			"multiline",
			`notify = [\n  "/Applications/Sky.app/notify",\n  "turn-ended",\n]\n${GLOBAL_CONFIG}`,
		],
		["two anchors", `notify = ["one"]\nnotify = ["two"]\n${GLOBAL_CONFIG}`],
		[
			"relative after table",
			`${GLOBAL_CONFIG}\n[other]\nnotify = ["relative"]\n`,
		],
		["quoted key", `"notify" = ["quoted"]\n${GLOBAL_CONFIG}`],
		["dotted key", `notify.program = "dotted"\n${GLOBAL_CONFIG}`],
	])("fails loud for an ambiguous %s shape", (_name, base) => {
		expect(() => renderCodexHomeConfig(base, TOKEN, opts)).toThrow(/notify/i);
	});

	it("sanitizes notify merge errors without quoting path or base canaries", () => {
		const canary = "FLY1571_PRIVATE_SOURCE_CANARY";
		const pathCanary = `/private/${canary}/notify`;
		let message = "";
		try {
			renderCodexHomeConfig(
				`notify = [\n"${canary}"\n]\n${GLOBAL_CONFIG}`,
				TOKEN,
				{ notifyProgramPath: pathCanary },
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/notify/i);
		expect(message).not.toContain(canary);
	});
});

describe("renderCodexHomeConfig — FLY-1604 TOML-aware merge", () => {
	const MANAGED_BEGIN =
		"# >>> flywheel-managed credential (FLY-123) — do not edit >>>";
	const MANAGED_END = "# <<< flywheel-managed credential (FLY-123) <<<";
	const PLACEHOLDER = "__FLYWHEEL_GH_TOKEN_PLACEHOLDER__";
	const CODEX_KEYS = `BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"
NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = "41e1151f1e50f096c7561da32bb01123e74b6ecdd38f081e34da30091fc4f193,6d25aa7656feac858f3a3bdaea5bcbab0dbfd426c9de8e6931ce90c399ee8e4f"
NODE_REPL_TRUSTED_CODE_PATHS = "/Users/x/.codex"`;
	// Mirrors the real 2026-08-01 incident: codex itself wrote a
	// [shell_environment_policy.set] table into the global config.
	const SEP_CONFLICT_CONFIG = `${GLOBAL_CONFIG}
[shell_environment_policy.set]
${CODEX_KEYS}
`;

	function sepSet(out: string): Record<string, unknown> {
		const parsed = parseToml(out) as Record<
			string,
			Record<string, Record<string, unknown>>
		>;
		return parsed.shell_environment_policy.set;
	}

	it("T1 merges GH_TOKEN into the existing [shell_environment_policy.set] table (real incident shape)", () => {
		const out = renderCodexHomeConfig(SEP_CONFLICT_CONFIG, TOKEN);
		const set = sepSet(out);
		expect(Object.keys(set).sort()).toEqual([
			"BROWSER_USE_AVAILABLE_BACKENDS",
			"GH_TOKEN",
			"NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S",
			"NODE_REPL_TRUSTED_CODE_PATHS",
		]);
		expect(set.GH_TOKEN).toBe(TOKEN);
		expect(set.BROWSER_USE_AVAILABLE_BACKENDS).toBe("chrome,iab");
		// codex's own lines survive byte-for-byte
		for (const line of CODEX_KEYS.split("\n")) {
			expect(out).toContain(line);
		}
		// the sentinel-wrapped keyline sits directly after the existing header
		expect(out).toContain(
			`[shell_environment_policy.set]\n${MANAGED_BEGIN}\nGH_TOKEN = "${TOKEN}"\n${MANAGED_END}\nBROWSER_USE_AVAILABLE_BACKENDS`,
		);
		// placeholder must not leak into the final artifact (base has none)
		expect(out).not.toContain(PLACEHOLDER);
	});

	it("T2 merge path is idempotent — re-render does not stack", () => {
		const once = renderCodexHomeConfig(SEP_CONFLICT_CONFIG, TOKEN);
		const twice = renderCodexHomeConfig(once, TOKEN);
		expect(twice).toBe(once);
		expect(once.match(/GH_TOKEN/g)).toHaveLength(1);
		expect(once.match(/flywheel-managed credential/g)).toHaveLength(2);
	});

	it("T3 merge path scrub — re-render without token restores base verbatim", () => {
		const merged = renderCodexHomeConfig(SEP_CONFLICT_CONFIG, TOKEN);
		const scrubbed = renderCodexHomeConfig(merged);
		expect(scrubbed).toBe(`${SEP_CONFLICT_CONFIG.trimEnd()}\n`);
		expect(scrubbed).not.toContain("GH_TOKEN");
		expect(scrubbed).not.toContain("flywheel-managed credential");
	});

	it("T4 refuses to overwrite a pre-existing non-managed GH_TOKEN", () => {
		const base = `${GLOBAL_CONFIG}\n[shell_environment_policy.set]\nGH_TOKEN = "someone_elses_token"\n`;
		expect(() => renderCodexHomeConfig(base, TOKEN)).toThrow(
			/refusing to overwrite/,
		);
	});

	it("T6 quoted header defining the set table is unmergeable — fail loud (old code silently corrupted)", () => {
		const base = `${GLOBAL_CONFIG}\n["shell_environment_policy".set]\nFOO = "bar"\n`;
		expect(() => renderCodexHomeConfig(base, TOKEN)).toThrow(
			/shell_environment_policy/,
		);
	});

	it("T7 parent-table-only base gets the appended block (legal sub-table)", () => {
		for (const header of [
			"[shell_environment_policy]",
			"[ shell_environment_policy ]",
		]) {
			const base = `${GLOBAL_CONFIG}\n${header}\ninherit = "core"\n`;
			const out = renderCodexHomeConfig(base, TOKEN);
			const parsed = parseToml(out) as Record<string, Record<string, unknown>>;
			expect(parsed.shell_environment_policy.inherit).toBe("core");
			expect(sepSet(out).GH_TOKEN).toBe(TOKEN);
		}
	});

	it("T8 sibling sub-table shapes are mergeable — bracket and root-dotted (root-aware, R1-HIGH-2)", () => {
		// Bracket header may sit anywhere; the root-dotted sibling must sit
		// BEFORE any [table] header to actually be root-level.
		for (const base of [
			`${GLOBAL_CONFIG}\n[shell_environment_policy.exclude]\nFOO = "x"\n`,
			`shell_environment_policy.exclude.FOO = "x"\n${GLOBAL_CONFIG}`,
		]) {
			const out = renderCodexHomeConfig(base, TOKEN);
			const parsed = parseToml(out) as Record<
				string,
				Record<string, Record<string, unknown>>
			>;
			expect(parsed.shell_environment_policy.exclude.FOO).toBe("x");
			expect(sepSet(out).GH_TOKEN).toBe(TOKEN);
		}
	});

	it("T9 relative same-name key under another table is NOT the root namespace — mergeable", () => {
		const base = `${GLOBAL_CONFIG}\n[other]\nshell_environment_policy.foo = "x"\n`;
		const out = renderCodexHomeConfig(base, TOKEN);
		const parsed = parseToml(out) as Record<
			string,
			Record<string, Record<string, unknown>>
		>;
		expect(parsed.other.shell_environment_policy.foo).toBe("x");
		expect(sepSet(out).GH_TOKEN).toBe(TOKEN);
	});

	it("T10 invalid TOML base fails loud before write when injecting", () => {
		expect(() =>
			renderCodexHomeConfig("this = is [not valid\ntoml ===", TOKEN),
		).toThrow(/not valid TOML/);
	});

	it("T11 thrown errors never carry the token or base source fragments", () => {
		const canary = "ZQ9_SOURCE_CANARY_77";
		const throwers = [
			`${GLOBAL_CONFIG}\n[shell_environment_policy.set]\nGH_TOKEN = "${canary}"\n`,
			`${GLOBAL_CONFIG}\n["shell_environment_policy".set]\nFOO = "${canary}"\n`,
			`shell_environment_policy = { set = { FOO = "${canary}" } }\n${GLOBAL_CONFIG}`,
			`broken toml ${canary} ===`,
		];
		for (const base of throwers) {
			let message = "";
			try {
				renderCodexHomeConfig(base, TOKEN);
			} catch (err) {
				message = err instanceof Error ? err.message : String(err);
			}
			expect(message).not.toBe("");
			expect(message).not.toContain(TOKEN);
			expect(message).not.toContain(canary);
		}
	});

	it("T12 preservation check survives non-primitive base values (deep compare, not ===)", () => {
		const base = `${GLOBAL_CONFIG}\n[shell_environment_policy.set]\nFOO = "bar"\nEXTRA_ARR = ["a", "b"]\n`;
		const out = renderCodexHomeConfig(base, TOKEN);
		const set = sepSet(out);
		expect(set.EXTRA_ARR).toEqual(["a", "b"]);
		expect(set.GH_TOKEN).toBe(TOKEN);
		expect(out).toContain('EXTRA_ARR = ["a", "b"]');
	});

	it("T12b base bytes containing the placeholder literal survive verbatim (no global substitution, R2-HIGH-1)", () => {
		const base = `${GLOBAL_CONFIG}
# comment mentions ${PLACEHOLDER} here
[shell_environment_policy.set]
LOOKALIKE = "${PLACEHOLDER}"
${CODEX_KEYS}

[unrelated]
note = "${PLACEHOLDER}"
`;
		const out = renderCodexHomeConfig(base, TOKEN);
		// exactly the base's 3 placeholder occurrences — the managed line took
		// the real token, and no base byte was substituted
		expect(out.match(new RegExp(PLACEHOLDER, "g"))).toHaveLength(3);
		expect(out).toContain(`LOOKALIKE = "${PLACEHOLDER}"`);
		expect(out).toContain(`note = "${PLACEHOLDER}"`);
		expect(out).toContain(`# comment mentions ${PLACEHOLDER} here`);
		expect(out).toContain(`GH_TOKEN = "${TOKEN}"`);
		expect(sepSet(out).LOOKALIKE).toBe(PLACEHOLDER);
	});

	it("T13 skills: base [[skills.config]] entries extend as array-of-tables (no overlap)", () => {
		const base = `${GLOBAL_CONFIG}\n[[skills.config]]\nname = "existing:skill"\nenabled = true\n`;
		const out = renderCodexHomeConfig(base, TOKEN, {
			skillDisableNames: ["superpowers:brainstorming"],
		});
		const parsed = parseToml(out) as Record<
			string,
			Record<string, Array<Record<string, unknown>>>
		>;
		const cfg = parsed.skills.config;
		expect(cfg).toHaveLength(2);
		expect(cfg[0]).toEqual({ name: "existing:skill", enabled: true });
		expect(cfg[1]).toEqual({
			name: "superpowers:brainstorming",
			enabled: false,
		});
	});

	it("T14 skills: [skills] table, [skills.other] sub-table, and relative keys stay mergeable (root-aware)", () => {
		for (const decl of [
			"[skills]\nfoo = 1",
			'[skills.other]\nfoo = "x"',
			'[other]\nskills.foo = "x"',
		]) {
			const out = renderCodexHomeConfig(`${GLOBAL_CONFIG}\n${decl}\n`, TOKEN, {
				skillDisableNames: ["superpowers:brainstorming"],
			});
			const parsed = parseToml(out) as Record<
				string,
				Record<string, Array<Record<string, unknown>>>
			>;
			expect(parsed.skills.config).toHaveLength(1);
		}
	});

	it("T16 an empty-string token fails the boundary check — with and without skills (Codex code R1 MED-1)", () => {
		// "" is present-but-invalid: truthiness must not silently drop it (no
		// skills) or half-render an empty credential block (with skills).
		expect(() => renderCodexHomeConfig(GLOBAL_CONFIG, "")).toThrow(
			/ghToken must match/,
		);
		let message = "";
		try {
			renderCodexHomeConfig(GLOBAL_CONFIG, "", {
				skillDisableNames: ["superpowers:brainstorming"],
			});
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toMatch(/ghToken must match/);
		expect(message).not.toContain('GH_TOKEN = ""');
	});

	it("T17 rendered-candidate parse failure uses the sanitized classification message (Codex code R1 LOW-2)", () => {
		// Inline parent WITHOUT a set sub-table passes every precheck (sep is a
		// plain table, set undefined → append path) but the appended
		// [shell_environment_policy.set] header cannot extend an immutable
		// inline table — the failure surfaces ONLY at the rendered-stage parse.
		const canary = "ZQ9_RENDERED_CANARY_31";
		const base = `shell_environment_policy = { exclude = { SECRET = "${canary}" } }\n${GLOBAL_CONFIG}`;
		let message = "";
		try {
			renderCodexHomeConfig(base, TOKEN);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		// EXACT equality (Codex code R2 LOW-1): a prefix `toContain` stays green
		// when raw parser text is appended after the fixed message — the
		// sanitization contract is "this fixed string and nothing else".
		expect(message).toBe(
			"renderCodexHomeConfig: rendered config.toml would not be valid TOML — the base declares a shape this writer cannot legally extend (e.g. an inline table); refusing to write a corrupt config (parser detail withheld: it may quote config or credential content).",
		);
		expect(message).not.toContain(TOKEN);
		expect(message).not.toContain(canary);
	});

	it("T15 skills: name overlap with base entries fails loud regardless of enabled value", () => {
		for (const enabled of ["true", "false"]) {
			const base = `${GLOBAL_CONFIG}\n[[skills.config]]\nname = "superpowers:brainstorming"\nenabled = ${enabled}\n`;
			expect(() =>
				renderCodexHomeConfig(base, TOKEN, {
					skillDisableNames: ["superpowers:brainstorming"],
				}),
			).toThrow(/duplicate-name|ambiguous/);
		}
	});
});

describe("provisionCodexHome (WS-A)", () => {
	function makeMattSkillsSource(): string {
		const source = join(tmp, "matt-skills-source");
		for (const name of [
			"code-review",
			"diagnosing-bugs",
			"grilling",
			"tdd",
			"to-spec",
			"to-tickets",
		]) {
			const dir = join(source, name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
		}
		return source;
	}

	it("identifies the live source credential before provisioning", () => {
		expect(assertCodexSourceIdentity({ env, registryPath })).toEqual({
			profile: "personal",
			email: "personal@example.test",
			accountId: "acct-personal",
			plan: "pro",
			mode: "primary",
		});
	});

	it.each([
		["personal", "personal@example.test", "acct-personal", "primary"],
		["school", "school@example.test", "acct-school", "manual_backup"],
		["business", "business@example.test", "acct-business", "manual_backup"],
	] as const)(
		"provisions canonical %s, writes the truthful sidecar and ledger",
		(profile, email, accountId, mode) => {
			writeFileSync(
				join(sourceCodexDir(env), "auth.json"),
				testAuth(email, accountId),
			);

			const home = provisionCodexHome({ executionId: `exec-${profile}`, env });

			expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(
				testAuth(email, accountId),
			);
			expect(readFileSync(join(home, ".active"), "utf8")).toBe(`${profile}\n`);
			expect(
				JSON.parse(readFileSync(join(ledgerRoot, `${profile}.json`), "utf8")),
			).toMatchObject({ profile, mode, lastSource: "provision" });
		},
	);

	it("keeps a fully provisioned runner home when only the ledger is unavailable", () => {
		writeFileSync(ledgerRoot, "ledger-root-is-not-a-directory");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const home = provisionCodexHome({
				executionId: "exec-ledger-unavailable",
				ghToken: TOKEN,
				env,
			});

			expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(testAuth());
			expect(readFileSync(join(home, ".active"), "utf8")).toBe("personal\n");
			expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(TOKEN);
			expect(warning).toHaveBeenCalledWith(
				expect.stringContaining(
					"account ledger observation failed for personal; runner provisioning will continue",
				),
			);
		} finally {
			warning.mockRestore();
		}
	});

	it.each([
		["unknown", testAuth("zombie@example.test", "acct-zombie")],
		["malformed", '{"tokens":{"id_token":"not-a-jwt"}}'],
	] as const)(
		"rejects a %s source identity before changing a pre-existing execution home",
		(_label, sourceAuth) => {
			const home = codexHomeDir("exec-reject", env);
			mkdirSync(home, { recursive: true });
			writeFileSync(join(home, "auth.json"), "auth-canary");
			writeFileSync(join(home, "config.toml"), "config-canary");
			writeFileSync(join(sourceCodexDir(env), "auth.json"), sourceAuth);

			expect(() =>
				provisionCodexHome({
					executionId: "exec-reject",
					ghToken: TOKEN,
					env,
				}),
			).toThrow(/Codex|identity|JWT/);
			expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("auth-canary");
			expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(
				"config-canary",
			);
			expect(existsSync(ledgerRoot)).toBe(false);
		},
	);

	it("rejects a symlinked source auth before creating an execution home", () => {
		const srcAuth = join(sourceCodexDir(env), "auth.json");
		const realAuth = join(tmp, "real-auth.json");
		writeFileSync(realAuth, testAuth());
		rmSync(srcAuth);
		symlinkSync(realAuth, srcAuth);

		expect(() =>
			provisionCodexHome({ executionId: "exec-symlink", env }),
		).toThrow(/symlink/);
		expect(existsSync(codexHomeDir("exec-symlink", env))).toBe(false);
	});

	it("FLY-1571 provisions the managed Runner stop notify program", () => {
		const notifyProgramPath = join(tmp, "hooks", "runner-stop-notify.sh");
		const home = provisionCodexHome({
			executionId: "exec-notify",
			env,
			notifyProgramPath,
		});
		const parsed = parseToml(
			readFileSync(join(home, "config.toml"), "utf8"),
		) as Record<string, unknown>;
		expect(parsed.notify).toEqual([notifyProgramPath, "--codex"]);
	});

	it("FLY-1961 provisions trust into the execution-scoped CODEX_HOME", () => {
		const trustedProjectPath = join(tmp, "new-worktree");
		const home = provisionCodexHome({
			executionId: "exec-trust",
			env,
			trustedProjectPath,
		});
		const parsed = parseToml(
			readFileSync(join(home, "config.toml"), "utf8"),
		) as Record<string, Record<string, Record<string, unknown>>>;

		expect(parsed.projects[trustedProjectPath].trust_level).toBe("trusted");
		expect(home).toBe(join(tmp, "homes", "exec-trust"));
	});

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

	it("FLY-1395 bare provisions the disable config without a skills directory", () => {
		const home = provisionCodexHome({
			executionId: "exec-bare",
			env,
			skillFrameworkMode: "bare",
			codexSkillDisableNames: ["superpowers:brainstorming"],
		});
		const config = readFileSync(join(home, "config.toml"), "utf-8");
		expect(config).toContain('name = "superpowers:brainstorming"');
		expect(existsSync(join(home, "skills", "matt-skills"))).toBe(false);
	});

	it("FLY-1395 matt installs all six vendored skills with stable namespace names and is idempotent", () => {
		const source = makeMattSkillsSource();
		const opts = {
			executionId: "exec-matt",
			env,
			skillFrameworkMode: "matt" as const,
			codexSkillDisableNames: ["superpowers:brainstorming"],
			codexMattSkillsSourceDir: source,
		};
		const home = provisionCodexHome(opts);
		provisionCodexHome(opts);
		for (const name of [
			"code-review",
			"diagnosing-bugs",
			"grilling",
			"tdd",
			"to-spec",
			"to-tickets",
		]) {
			const skillFile = join(home, "skills", `matt-skills:${name}`, "SKILL.md");
			expect(existsSync(skillFile)).toBe(true);
			expect(readFileSync(skillFile, "utf-8")).toContain(
				`name: matt-skills:${name}`,
			);
		}
		expect(existsSync(join(home, "skills", "matt-skills"))).toBe(false);
		expect(readFileSync(join(home, "config.toml"), "utf-8")).toContain(
			'name = "superpowers:brainstorming"',
		);
	});

	it("FLY-1395 removes stale managed Matt skills when reprovisioned as bare", () => {
		const source = makeMattSkillsSource();
		const mattHome = provisionCodexHome({
			executionId: "exec-rearm",
			env,
			skillFrameworkMode: "matt",
			codexSkillDisableNames: ["superpowers:brainstorming"],
			codexMattSkillsSourceDir: source,
		});
		expect(
			existsSync(join(mattHome, "skills", "matt-skills:tdd", "SKILL.md")),
		).toBe(true);
		const home = provisionCodexHome({
			executionId: "exec-rearm",
			env,
			skillFrameworkMode: "bare",
			codexSkillDisableNames: ["superpowers:brainstorming"],
		});
		expect(existsSync(join(home, "skills", "matt-skills:tdd"))).toBe(false);
	});

	it("FLY-1395 matt source failure is loud and leaves no runner home", () => {
		expect(() =>
			provisionCodexHome({
				executionId: "exec-matt-bad",
				env,
				skillFrameworkMode: "matt",
				codexSkillDisableNames: ["superpowers:brainstorming"],
				codexMattSkillsSourceDir: join(tmp, "missing-matt"),
			}),
		).toThrow(/matt skills source/);
		expect(existsSync(join(tmp, "homes", "exec-matt-bad"))).toBe(false);
	});

	it("FLY-1395 scrubs the live token when Matt skill copying fails", () => {
		const source = makeMattSkillsSource();
		const home = codexHomeDir("exec-matt-copy-fails", env);
		const skillsRoot = join(home, "skills");
		mkdirSync(skillsRoot, { recursive: true });
		chmodSync(skillsRoot, 0o500);
		try {
			expect(() =>
				provisionCodexHome({
					executionId: "exec-matt-copy-fails",
					ghToken: TOKEN,
					env,
					skillFrameworkMode: "matt",
					codexSkillDisableNames: ["superpowers:brainstorming"],
					codexMattSkillsSourceDir: source,
				}),
			).toThrow();
			const configPath = join(home, "config.toml");
			const config = existsSync(configPath)
				? readFileSync(configPath, "utf-8")
				: "";
			expect(config).not.toContain(TOKEN);
			expect(config).not.toContain("GH_TOKEN");
		} finally {
			chmodSync(skillsRoot, 0o700);
		}
	});

	// FLY-1395 QA: every existing matt test uses a SYNTHETIC fixture whose
	// frontmatter name is written to equal its directory (so namespaceMattSkill's
	// `sourceName === skillDir` invariant is trivially satisfied). None exercises
	// the REAL vendored artifact. If an upstream matt-skills sync renames a
	// SKILL.md `name:` field, or drops/renames a skill directory, the matt arm
	// would throw at provision time in production while every fixture test stays
	// green. This guard drives production provisionCodexHome against the actual
	// git-tracked vendor/matt-skills/skills so that drift fails in CI, not on a
	// real Codex implement runner.
	it("FLY-1395 provisions the matt arm from the REAL vendored skills (drift guard)", () => {
		const repoRoot = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"..",
		);
		const vendorSkills = join(repoRoot, "vendor", "matt-skills", "skills");
		// Fail loud, not vacuously skip, if the vendored artifact is missing —
		// its absence is itself a shippable defect for the matt arm.
		expect(
			existsSync(vendorSkills),
			`vendored matt skills missing at ${vendorSkills}`,
		).toBe(true);

		const home = provisionCodexHome({
			executionId: "exec-matt-vendor",
			env,
			skillFrameworkMode: "matt",
			codexSkillDisableNames: ["superpowers:brainstorming"],
			codexMattSkillsSourceDir: vendorSkills,
		});

		for (const name of [
			"code-review",
			"diagnosing-bugs",
			"grilling",
			"tdd",
			"to-spec",
			"to-tickets",
		]) {
			const skillFile = join(home, "skills", `matt-skills:${name}`, "SKILL.md");
			expect(existsSync(skillFile), `missing installed ${name}`).toBe(true);
			// namespaceMattSkill only rewrites to `matt-skills:<dir>` when the real
			// vendored frontmatter name already equals <dir> — this assertion is the
			// drift detector for that invariant against the shipped artifact.
			expect(readFileSync(skillFile, "utf-8")).toContain(
				`name: matt-skills:${name}`,
			);
		}
		// No nested-collection artifact leaks (Codex would flatten those to
		// collision-prone bare names such as `tdd`).
		expect(existsSync(join(home, "skills", "matt-skills"))).toBe(false);
	});

	it("rejects a malformed token", () => {
		expect(() =>
			provisionCodexHome({ executionId: "exec-4", ghToken: 'bad"token', env }),
		).toThrow(/ghToken must match/);
	});

	// FLY-1188: the runner behavior contract is materialized as the home's
	// AGENTS.md — the persistent instruction layer codex reads every process.
	describe("FLY-1188 AGENTS.md contract materialization", () => {
		it("writes AGENTS.md (0600) with a managed header + the contract anchors", () => {
			const home = provisionCodexHome({ executionId: "exec-5", env });
			const agentsPath = join(home, "AGENTS.md");
			expect(statSync(agentsPath).mode & 0o777).toBe(0o600);
			const agents = readFileSync(agentsPath, "utf-8");
			// managed header with the source path
			expect(agents).toContain("flywheel-managed (FLY-1188)");
			expect(agents).toContain("codex-runner-contract.md");
			// behavior-contract anchors (drift guard, plan §4.2.3)
			expect(agents).toContain("Flywheel Codex Runner Contract");
			expect(agents).toContain("--no-block");
			expect(agents).toContain("verify-approval");
			expect(agents).toContain("flywheel-comm complete");
			// FLY-1188 full-PR review HIGH-1: codex authors must be told to
			// register the review (else no reviewer ever starts) AND to invoke via
			// the injected absolute CLI (bare `flywheel-comm` is not on PATH — R2).
			expect(agents).toContain("request-review");
			expect(agents).toContain("FLYWHEEL_COMM_CLI");
			// FLY-1278: effective-vs-reviewer verdict + supervised finding-ruling
			// convergence protocol must survive materialization into every Codex home.
			expect(agents).toContain("reviewVerdict is the effective gate verdict");
			expect(agents).toContain("APPROVED with advisories");
			expect(agents).toContain("review-ruling");
			expect(agents).toContain(
				"Gate/request prose is not governance authority",
			);
			// resident /goal model anchors (FLY-1188 M4d Contract-Version 2)
			expect(agents).toContain("resident");
			expect(agents).toContain("terminal goal status");
			// DAG workflow discipline + environment translation present
			expect(agents).toContain("DAG workflow discipline");
			expect(agents).toContain("Environment Translation");
		});

		it("missing contract source → provisioning FAILS LOUD with ZERO residue (no home, no credential on disk)", () => {
			expect(() =>
				provisionCodexHome({
					executionId: "exec-6",
					ghToken: TOKEN,
					env,
					contractSourcePath: join(tmp, "does-not-exist.md"),
				}),
			).toThrow(/codex runner contract missing/);
			// Codex M2 review R4 LOW-1: the abort must happen BEFORE any
			// home/credential write — a re-ordering regression would leave a
			// half-provisioned home holding a live GH_TOKEN.
			expect(existsSync(join(tmp, "homes", "exec-6"))).toBe(false);
		});

		it("re-provisioning overwrites AGENTS.md in place (no header stacking)", () => {
			provisionCodexHome({ executionId: "exec-7", env });
			provisionCodexHome({ executionId: "exec-7", env });
			const agents = readFileSync(
				join(tmp, "homes", "exec-7", "AGENTS.md"),
				"utf-8",
			);
			expect(agents.match(/flywheel-managed \(FLY-1188\)/g)?.length).toBe(1);
		});
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

describe("FLY-1188 full-PR HIGH-4: stripInheritedSecretEnv (daemon env leak)", () => {
	it("strips the Bridge's third-party creds (Discord/Linear/DB/API + GH family)", () => {
		const out = stripInheritedSecretEnv({
			DISCORD_BOT_TOKEN: "d",
			LINEAR_API_KEY: "l",
			ANTHROPIC_API_KEY: "a",
			OPENAI_API_KEY: "o",
			DATABASE_PASSWORD: "p",
			SUPABASE_SECRET: "s",
			SOME_KEY: "k",
			GH_TOKEN: "ghp",
			GITHUB_TOKEN: "ghp2",
		});
		for (const k of [
			"DISCORD_BOT_TOKEN",
			"LINEAR_API_KEY",
			"ANTHROPIC_API_KEY",
			"OPENAI_API_KEY",
			"DATABASE_PASSWORD",
			"SUPABASE_SECRET",
			"SOME_KEY",
			"GH_TOKEN",
			"GITHUB_TOKEN",
		]) {
			expect(out[k]).toBeUndefined();
		}
	});

	it("FLY-1643: drops every inherited FLYWHEEL_ var and keeps the safe OS base", () => {
		const out = stripInheritedSecretEnv({
			FLYWHEEL_INGEST_TOKEN: "it",
			FLYWHEEL_BRIDGE_URL: "http://x",
			FLYWHEEL_COMM_DB: "/db",
			FLYWHEEL_GATE_MARKER_DIR: "/m",
			FLYWHEEL_COMPLETE_MARKER_DIR: "/complete",
			FLYWHEEL_AGENT_TEAM_NAME: "eng",
			FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL: "output-ticket",
			FLYWHEEL_ALERT_BOT_TOKEN: "alert-secret",
			PATH: "/usr/bin",
			HOME: "/home/u",
		});
		for (const key of Object.keys(out)) expect(key).not.toMatch(/^FLYWHEEL_/);
		expect(out.PATH).toBe("/usr/bin");
		expect(out.HOME).toBe("/home/u");
	});

	// R3 HIGH: a NAME denylist misses auth-CAPABLE handles whose names don't look
	// secret. The safe-base ALLOWLIST drops them (and any unknown var) while
	// keeping the OS/locale/proxy base the daemon needs.
	it("safe-base allowlist: DROPS auth-capable + unknown vars, KEEPS OS/locale/proxy base", () => {
		const out = stripInheritedSecretEnv({
			// auth-capable / credential pointers whose names are not secret-shaped
			SSH_AUTH_SOCK: "/tmp/agent.sock",
			SSH_AGENT_PID: "123",
			AWS_SHARED_CREDENTIALS_FILE: "/root/.aws/credentials",
			GOOGLE_APPLICATION_CREDENTIALS: "/root/gcp.json",
			KUBECONFIG: "/root/.kube/config",
			DOCKER_CONFIG: "/root/.docker",
			// an arbitrary var the model or host might introduce
			SOME_RANDOM_HOST_VAR: "x",
			// safe base the daemon genuinely needs
			PATH: "/usr/bin",
			HOME: "/home/u",
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
			HTTPS_PROXY: "http://proxy:8080",
			FLYWHEEL_GATE_MARKER_DIR: "/m",
			FLYWHEEL_INGEST_TOKEN: "it",
		});
		for (const k of [
			"SSH_AUTH_SOCK",
			"SSH_AGENT_PID",
			"AWS_SHARED_CREDENTIALS_FILE",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"KUBECONFIG",
			"DOCKER_CONFIG",
			"SOME_RANDOM_HOST_VAR",
		]) {
			expect(out[k]).toBeUndefined();
		}
		expect(out.PATH).toBe("/usr/bin");
		expect(out.HOME).toBe("/home/u");
		expect(out.LANG).toBe("en_US.UTF-8");
		expect(out.LC_ALL).toBe("en_US.UTF-8");
		expect(out.HTTPS_PROXY).toBe("http://proxy:8080");
		expect(out.FLYWHEEL_GATE_MARKER_DIR).toBeUndefined();
		expect(out.FLYWHEEL_INGEST_TOKEN).toBeUndefined();
	});

	// R4/R5 HIGH: a proxy URL can embed `user:pass@` (incl. `@` inside the pass, no
	// scheme, or scheme-relative `//`). Strip to the LAST `@` of the authority; keep
	// the host; fail-closed (drop) if userinfo but no host.
	it("R5: strips credential userinfo from proxy URLs in every form (keeps the host)", () => {
		const out = stripInheritedSecretEnv({
			HTTPS_PROXY: "http://user:password@proxy:8080",
			http_proxy: "https://tok@10.0.0.1:3128",
			ALL_PROXY: "http://user:p@ss@proxy:8080", // `@` inside the password
			HTTP_PROXY: "user:pass@proxy:8080", // no scheme
			https_proxy: "//user:pass@proxy:8080", // scheme-relative
			no_proxy: "localhost,127.0.0.1", // no userinfo, unchanged
		});
		expect(out.HTTPS_PROXY).toBe("http://proxy:8080");
		expect(out.http_proxy).toBe("https://10.0.0.1:3128");
		expect(out.ALL_PROXY).toBe("http://proxy:8080"); // stripped to the LAST @
		expect(out.HTTP_PROXY).toBe("proxy:8080"); // no scheme, userinfo gone
		expect(out.https_proxy).toBe("//proxy:8080"); // scheme-relative preserved
		expect(out.no_proxy).toBe("localhost,127.0.0.1");
	});

	// R6 HIGH: redundant slashes (`http:///user:pass@host`) push the userinfo out of
	// the parsed authority — curl still reads it as creds. Any residual `@` in a
	// cleared proxy value fails-closed (the var is dropped entirely).
	it("R6: DROPS proxy values whose credentials survive normalization (redundant slashes)", () => {
		const out = stripInheritedSecretEnv({
			HTTPS_PROXY: "http:///user:pass@proxy:8080",
			HTTP_PROXY: "http:////user:pass@proxy:8080",
			ALL_PROXY: "http://proxy:8080", // clean → kept
		});
		expect(out.HTTPS_PROXY).toBeUndefined();
		expect(out.HTTP_PROXY).toBeUndefined();
		expect(out.ALL_PROXY).toBe("http://proxy:8080");
	});
});

// ── QA · FLY-1188 — the founder TUI must NOT be launched through the rotation
// shim. The shim pipes codex's stdout through `tee` (to sniff a 429 and rotate
// the account), so stdout is a pipe, and `codex resume --remote` is a TUI: it
// prints "Error: stdout is not a terminal" and exits 1. That is why the founder's
// cmux tab was empty. The daemon keeps the shim (app-server needs no TTY). ──
describe("rawCodexBin (the TTY-capable binary for the founder TUI)", () => {
	it("resolves the raw TUI binary independently of the daemon launcher", () => {
		expect(rawCodexBin({ PATH: "/usr/bin" })).not.toContain(
			"flywheel-codex-with-fallback",
		);
		// ...not even when the shim is the daemon's configured binary
		expect(
			rawCodexBin({
				PATH: "/usr/bin",
				FLYWHEEL_CODEX_BIN: "/x/flywheel-codex-with-fallback",
			}),
		).not.toContain("flywheel-codex-with-fallback");
	});

	it("honours an explicit ops/test override", () => {
		expect(rawCodexBin({ FLYWHEEL_CODEX_TUI_BIN: "/opt/codex" })).toBe(
			"/opt/codex",
		);
	});

	it("falls back to the bare name when PATH holds no codex (the tmux shell resolves it — the verified lead-side behavior)", () => {
		expect(rawCodexBin({ PATH: "/nonexistent-dir-fly1188" })).toBe("codex");
		expect(rawCodexBin({})).toBe("codex");
	});
});
