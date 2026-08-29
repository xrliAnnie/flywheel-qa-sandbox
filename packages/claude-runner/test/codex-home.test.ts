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
			// resident /goal model anchors (FLY-1188 M4d Contract-Version 2)
			expect(agents).toContain("resident");
			expect(agents).toContain("terminal goal status");
			// three-stage discipline + environment translation present
			expect(agents).toContain("Three-stage discipline");
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

	it("KEEPS the allowlisted ingest token + non-secret FLYWHEEL_ dirs/urls/ids", () => {
		const out = stripInheritedSecretEnv({
			FLYWHEEL_INGEST_TOKEN: "it", // secret-shaped but the daemon NEEDS it (allowlist)
			FLYWHEEL_BRIDGE_URL: "http://x",
			FLYWHEEL_COMM_DB: "/db",
			FLYWHEEL_GATE_MARKER_DIR: "/m",
			PATH: "/usr/bin",
			HOME: "/home/u",
		});
		expect(out.FLYWHEEL_INGEST_TOKEN).toBe("it");
		expect(out.FLYWHEEL_BRIDGE_URL).toBe("http://x");
		expect(out.FLYWHEEL_COMM_DB).toBe("/db");
		expect(out.FLYWHEEL_GATE_MARKER_DIR).toBe("/m");
		expect(out.PATH).toBe("/usr/bin");
		expect(out.HOME).toBe("/home/u");
	});

	// R2 HIGH: a blanket FLYWHEEL_ prefix exemption would leak OTHER FLYWHEEL_
	// Bridge secrets into the model-driven daemon. Only the explicit allowlist is
	// kept; every other secret-shaped FLYWHEEL_ var is stripped like any 3rd-party
	// cred.
	it("STRIPS non-allowlisted FLYWHEEL_ secrets (e.g. an alert bot token)", () => {
		const out = stripInheritedSecretEnv({
			FLYWHEEL_INGEST_TOKEN: "keep",
			FLYWHEEL_ALERT_BOT_TOKEN: "leak",
			FLYWHEEL_WEBHOOK_SECRET: "leak2",
			FLYWHEEL_SIGNING_KEY: "leak3",
		});
		expect(out.FLYWHEEL_INGEST_TOKEN).toBe("keep");
		expect(out.FLYWHEEL_ALERT_BOT_TOKEN).toBeUndefined();
		expect(out.FLYWHEEL_WEBHOOK_SECRET).toBeUndefined();
		expect(out.FLYWHEEL_SIGNING_KEY).toBeUndefined();
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
		expect(out.FLYWHEEL_GATE_MARKER_DIR).toBe("/m");
		expect(out.FLYWHEEL_INGEST_TOKEN).toBe("it");
	});

	// R4 HIGH: an exact FLYWHEEL_ allowlist — a FLYWHEEL_ name/shape PATTERN pass
	// leaked auth-CAPABLE FLYWHEEL_ handles (Keychain coords / secret .env path /
	// broker socket) whose names aren't secret-shaped.
	it("R4: DROPS auth-capable FLYWHEEL_ vars not on the exact allowlist", () => {
		const out = stripInheritedSecretEnv({
			FLYWHEEL_INGEST_TOKEN: "keep", // exact-allowlisted → kept
			FLYWHEEL_COMM_CLI: "/cli.js", // exact-allowlisted → kept
			FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE: "svc", // Keychain coords → dropped
			FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT: "acct",
			FLYWHEEL_WRAPPER_ENV_FILE: "/secret.env", // secret .env path → dropped
			FLYWHEEL_GATEWAY_BROKER_SOCKET: "/broker.sock", // broker socket → dropped
		});
		expect(out.FLYWHEEL_INGEST_TOKEN).toBe("keep");
		expect(out.FLYWHEEL_COMM_CLI).toBe("/cli.js");
		expect(out.FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE).toBeUndefined();
		expect(out.FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT).toBeUndefined();
		expect(out.FLYWHEEL_WRAPPER_ENV_FILE).toBeUndefined();
		expect(out.FLYWHEEL_GATEWAY_BROKER_SOCKET).toBeUndefined();
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

	it("R5: keeps the transport-injected Agent Team identity (exact-allowlisted)", () => {
		const out = stripInheritedSecretEnv({
			FLYWHEEL_AGENT_TEAM_NAME: "eng",
			FLYWHEEL_AGENT_NAME: "codex-runner",
			FLYWHEEL_RUNNER_VENDOR_ID: "codex",
		});
		expect(out.FLYWHEEL_AGENT_TEAM_NAME).toBe("eng");
		expect(out.FLYWHEEL_AGENT_NAME).toBe("codex-runner");
		expect(out.FLYWHEEL_RUNNER_VENDOR_ID).toBe("codex");
	});
});

// ── QA · FLY-1188 — the founder TUI must NOT be launched through the rotation
// shim. The shim pipes codex's stdout through `tee` (to sniff a 429 and rotate
// the account), so stdout is a pipe, and `codex resume --remote` is a TUI: it
// prints "Error: stdout is not a terminal" and exits 1. That is why the founder's
// cmux tab was empty. The daemon keeps the shim (app-server needs no TTY). ──
describe("rawCodexBin (the TTY-capable binary for the founder TUI)", () => {
	it("is NEVER the stdout-piping rotation shim", () => {
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
