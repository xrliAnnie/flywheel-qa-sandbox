import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

import {
	assertWriteCapableRelease,
	buildActionSurfaceDisableArgv,
	buildCodexLeadRuntime,
	buildConfinementArgv,
	buildThreadParams,
	dryRunReport,
	parseCodexLeadRuntimeConfig,
	pathsOverlap,
	readBaseInstructions,
	readThreadId,
	resolveLeadWorkspace,
	writeThreadId,
} from "../codex-lead-runtime.js";
import { McpInventoryWatcher } from "../mcp-inventory.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function fullEnv(
	over: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
	return {
		FLYWHEEL_LEAD_ID: "mufasa",
		FLYWHEEL_PROJECT_NAME: "mufasa-project",
		FLYWHEEL_LEAD_BOT_USER_ID: "1499895683287748679",
		DISCORD_BOT_TOKEN: "tok",
		FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "chan-chat",
		FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
		FLYWHEEL_API_TOKEN: "api",
		FLYWHEEL_CODEX_LEAD_STATE_DIR: "/var/state/mufasa",
		FLYWHEEL_CODEX_BIN: "/usr/local/bin/codex",
		CODEX_HOME: "/Users/x/.codex-mufasa",
		...over,
	};
}

describe("parseCodexLeadRuntimeConfig", () => {
	it("parses a full env and derives the state paths", () => {
		const c = parseCodexLeadRuntimeConfig(fullEnv());
		expect(c.leadId).toBe("mufasa");
		expect(c.botUserId).toBe("1499895683287748679");
		expect(c.codexHome).toBe("/Users/x/.codex-mufasa");
		expect(c.journalDbPath).toBe("/var/state/mufasa/journal.db");
		expect(c.outboxDbPath).toBe("/var/state/mufasa/outbox.db");
		expect(c.threadIdPath).toBe("/var/state/mufasa/thread-id");
		expect(c.channelIds).toEqual(["chan-chat"]); // no core channel set
		expect(c.chrome).toBeUndefined();
	});

	// FLY-350: codexProfile (content-coordination enables the lead-actions MCP).
	it("defaults codexProfile to companion when unset", () => {
		expect(parseCodexLeadRuntimeConfig(fullEnv()).codexProfile).toBe(
			"companion",
		);
	});

	it("parses codexProfile=content-coordination from the exact env value (under read-deny)", () => {
		expect(
			parseCodexLeadRuntimeConfig(
				fullEnv({
					FLYWHEEL_CODEX_LEAD_PROFILE: "content-coordination",
					FLYWHEEL_CODEX_LEAD_READ_DENY: "1",
				}),
			).codexProfile,
		).toBe("content-coordination");
	});

	it("rejects content-coordination without read-deny (FLY-260/FLY-350 fail-closed)", () => {
		expect(() =>
			parseCodexLeadRuntimeConfig(
				fullEnv({ FLYWHEEL_CODEX_LEAD_PROFILE: "content-coordination" }),
			),
		).toThrow(/requires FLYWHEEL_CODEX_LEAD_READ_DENY=1/);
	});

	it("falls SAFE to companion on an unknown codexProfile value (never silently enables the MCP)", () => {
		expect(
			parseCodexLeadRuntimeConfig(
				fullEnv({ FLYWHEEL_CODEX_LEAD_PROFILE: "write-capable" }),
			).codexProfile,
		).toBe("companion");
	});

	it("rejects content-coordination paired with a write-capable sandbox (read-only only)", () => {
		expect(() =>
			parseCodexLeadRuntimeConfig(
				fullEnv({
					FLYWHEEL_CODEX_LEAD_PROFILE: "content-coordination",
					FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write",
				}),
			),
		).toThrow(/content-coordination requires sandbox=read-only/);
	});

	it("includes the core channel + chrome when set", () => {
		const c = parseCodexLeadRuntimeConfig(
			fullEnv({
				FLYWHEEL_LEAD_CORE_CHANNEL_ID: "chan-core",
				FLYWHEEL_LEAD_CHROME_ENABLED: "1",
				FLYWHEEL_LEAD_CHROME_URL: "http://127.0.0.1:9222",
			}),
		);
		expect(c.channelIds).toEqual(["chan-chat", "chan-core"]);
		expect(c.chrome).toEqual({
			enabled: true,
			browserUrl: "http://127.0.0.1:9222",
		});
	});

	// ── FLY-267 收: cross-dept channels merged into channelIds ──────────────
	it("FLY-267: byte-compat — no cross-dept env leaves channelIds + crossDeptChannelIds untouched", () => {
		const c = parseCodexLeadRuntimeConfig(fullEnv());
		expect(c.channelIds).toEqual(["chan-chat"]); // exactly as before (no Set reorder)
		expect(c.crossDeptChannelIds).toEqual([]);
		expect(c.mentionPatterns).toEqual([]);
	});

	it("FLY-267: merges cross-dept channels into channelIds + exposes crossDeptChannelIds", () => {
		const c = parseCodexLeadRuntimeConfig(
			fullEnv({
				FLYWHEEL_LEAD_CORE_CHANNEL_ID: "chan-core",
				FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "round-1, round-2",
			}),
		);
		expect(c.channelIds).toEqual([
			"chan-chat",
			"chan-core",
			"round-1",
			"round-2",
		]);
		expect(c.crossDeptChannelIds).toEqual(["round-1", "round-2"]);
	});

	it("FLY-267: dedups cross-dept ids and excludes any that overlap chat/core", () => {
		const c = parseCodexLeadRuntimeConfig(
			fullEnv({
				FLYWHEEL_LEAD_CORE_CHANNEL_ID: "chan-core",
				// chan-chat + chan-core already in base; round-1 duplicated
				FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS:
					"chan-chat, round-1, round-1, chan-core, round-2",
			}),
		);
		expect(c.crossDeptChannelIds).toEqual(["round-1", "round-2"]);
		expect(c.channelIds).toEqual([
			"chan-chat",
			"chan-core",
			"round-1",
			"round-2",
		]);
	});

	it("FLY-267: REFUSES bridge outbound mode + cross-dept channels (R1 HIGH — Bridge 403 footgun)", () => {
		// The Bridge's buildAuthorizeLeadChannel only authorizes chat + generalChannel,
		// so a roundtable reply in bridge mode would 403 → ambiguous. Fail loud at parse;
		// server-side shared-channel authorization is a follow-up. (direct mode is fine.)
		expect(() =>
			parseCodexLeadRuntimeConfig(
				fullEnv({
					FLYWHEEL_CODEX_LEAD_OUTBOUND: "bridge",
					FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "round-1",
				}),
			),
		).toThrow(/cross-dept.*bridge|bridge.*cross-dept/i);
	});

	it("FLY-267: cross-dept channels ARE allowed in direct mode (default)", () => {
		const c = parseCodexLeadRuntimeConfig(
			fullEnv({ FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "round-1" }),
		);
		expect(c.outboundMode).toBe("direct");
		expect(c.crossDeptChannelIds).toEqual(["round-1"]);
	});

	it("FLY-267: parses mention patterns (comma-separated, trimmed)", () => {
		const c = parseCodexLeadRuntimeConfig(
			fullEnv({ FLYWHEEL_LEAD_MENTION_PATTERNS: "\\bMufasa\\b , \\bMufu\\b" }),
		);
		expect(c.mentionPatterns).toEqual(["\\bMufasa\\b", "\\bMufu\\b"]);
	});

	it("fail-loud: lists ALL missing always-required env in one error", () => {
		const env = fullEnv({
			DISCORD_BOT_TOKEN: undefined,
			CODEX_HOME: undefined,
			FLYWHEEL_LEAD_BOT_USER_ID: "  ", // whitespace = missing
		});
		expect(() => parseCodexLeadRuntimeConfig(env)).toThrow(/DISCORD_BOT_TOKEN/);
		try {
			parseCodexLeadRuntimeConfig(env);
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain("CODEX_HOME");
			expect(msg).toContain("FLYWHEEL_LEAD_BOT_USER_ID");
		}
	});

	it("DEFAULT direct mode needs NO Bridge env (low-risk first test)", () => {
		const env = fullEnv({
			FLYWHEEL_BRIDGE_URL: undefined,
			FLYWHEEL_API_TOKEN: undefined,
		});
		const c = parseCodexLeadRuntimeConfig(env); // must NOT throw
		expect(c.outboundMode).toBe("direct");
		expect(c.bridgeUrl).toBe("");
		expect(c.apiToken).toBe("");
	});

	it("bridge mode REQUIRES the Bridge env (fail-loud)", () => {
		const env = fullEnv({
			FLYWHEEL_CODEX_LEAD_OUTBOUND: "bridge",
			FLYWHEEL_BRIDGE_URL: undefined,
			FLYWHEEL_API_TOKEN: undefined,
		});
		expect(() => parseCodexLeadRuntimeConfig(env)).toThrow(
			/FLYWHEEL_BRIDGE_URL/,
		);
		try {
			parseCodexLeadRuntimeConfig(env);
		} catch (e) {
			expect((e as Error).message).toContain("FLYWHEEL_API_TOKEN");
		}
	});
});

describe("dryRunReport", () => {
	it("describes direct mode + redacts the token + confirms zero prod intrusion", () => {
		const c = parseCodexLeadRuntimeConfig(
			fullEnv({ DISCORD_BOT_TOKEN: "supersecrettoken1234567890" }),
		);
		const report = dryRunReport(c).join("\n");
		expect(report).toContain("DRY RUN");
		expect(report).toContain("DIRECT post to Discord");
		expect(report).toContain("NOT CONNECTED (zero prod intrusion)");
		expect(report).toContain(".codex-mufasa"); // isolated CODEX_HOME
		// NEVER leak the full token
		expect(report).not.toContain("supersecrettoken1234567890");
		expect(report).toContain("supe…"); // redacted form
	});

	it("bridge mode shows the Bridge connection", () => {
		const c = parseCodexLeadRuntimeConfig(
			fullEnv({ FLYWHEEL_CODEX_LEAD_OUTBOUND: "bridge" }),
		);
		const report = dryRunReport(c).join("\n");
		expect(report).toContain("WILL CONNECT (bridge mode)");
	});

	it("persona line: none by default, injected when systemPromptFiles read", () => {
		const none = dryRunReport(parseCodexLeadRuntimeConfig(fullEnv())).join(
			"\n",
		);
		expect(none).toContain("persona");
		expect(none).toContain("none — default Codex persona");

		const dir = mkdtempSync(join(tmpdir(), "fly224-persona-dry-"));
		try {
			const f = join(dir, "identity.md");
			writeFileSync(f, "You are Mufasa, a warm companion.", "utf8");
			const c = parseCodexLeadRuntimeConfig(
				fullEnv({ FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES: f }),
			);
			const report = dryRunReport(c).join("\n");
			expect(report).toContain("→ injected");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("parseCodexLeadRuntimeConfig — systemPromptFiles", () => {
	it("defaults to [] and splits/trims/filters a comma list", () => {
		expect(parseCodexLeadRuntimeConfig(fullEnv()).systemPromptFiles).toEqual(
			[],
		);
		const c = parseCodexLeadRuntimeConfig(
			fullEnv({
				FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES: " /a/identity.md , ,/b/contract.md ",
			}),
		);
		expect(c.systemPromptFiles).toEqual(["/a/identity.md", "/b/contract.md"]);
	});
});

describe("sandbox policy (review HIGH-1: pin approvalPolicy + sandbox)", () => {
	it("defaults sandboxMode to read-only", () => {
		expect(parseCodexLeadRuntimeConfig(fullEnv()).sandboxMode).toBe(
			"read-only",
		);
	});

	it("accepts the valid sandbox modes + rejects an unknown one (fail-loud)", () => {
		expect(
			parseCodexLeadRuntimeConfig(
				fullEnv({ FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write" }),
			).sandboxMode,
		).toBe("workspace-write");
		expect(() =>
			parseCodexLeadRuntimeConfig(
				fullEnv({ FLYWHEEL_CODEX_LEAD_SANDBOX: "yolo" }),
			),
		).toThrow(/FLYWHEEL_CODEX_LEAD_SANDBOX/);
	});

	it("buildThreadParams pins approvalPolicy=never + sandbox, adds persona when present", () => {
		expect(buildThreadParams({ sandboxMode: "read-only" }, undefined)).toEqual({
			approvalPolicy: "never",
			sandbox: "read-only",
		});
		expect(
			buildThreadParams({ sandboxMode: "read-only" }, "You are Mufasa."),
		).toEqual({
			approvalPolicy: "never",
			sandbox: "read-only",
			baseInstructions: "You are Mufasa.",
		});
	});

	// FLY-245 F-b: FLIPPED from the FLY-224 unconditional fail-close — a
	// write-capable sandbox WITHOUT the §7 release conditions still fail-closes
	// (same throw semantics); WITH all of them it builds. See the dedicated
	// release-gate matrix below for the full per-condition coverage.
	it("buildCodexLeadRuntime still FAIL-CLOSES a write-capable sandbox missing the release conditions", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly224-sandbox-"));
		try {
			const config = parseCodexLeadRuntimeConfig(
				fullEnv({
					FLYWHEEL_CODEX_LEAD_STATE_DIR: dir,
					FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write",
				}),
			);
			expect(() => buildCodexLeadRuntime(config, silentLogger)).toThrow(
				/write-capable.*FLY-245/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("read-only sandbox surfaces in the dry-run report", () => {
		const report = dryRunReport(parseCodexLeadRuntimeConfig(fullEnv())).join(
			"\n",
		);
		expect(report).toContain("approvalPolicy=never sandbox=read-only");
		expect(report).toContain("cannot act");
	});
});

describe("FLY-260 read-deny flag (default OFF — byte-compat)", () => {
	it("defaults readDeny=false (flag unset)", () => {
		expect(parseCodexLeadRuntimeConfig(fullEnv()).readDeny).toBe(false);
	});

	it("FLYWHEEL_CODEX_LEAD_READ_DENY=1 sets readDeny on a read-only Lead", () => {
		const c = parseCodexLeadRuntimeConfig(
			fullEnv({ FLYWHEEL_CODEX_LEAD_READ_DENY: "1" }),
		);
		expect(c.readDeny).toBe(true);
		expect(c.sandboxMode).toBe("read-only");
	});

	it("readDeny + a write-capable sandbox is a parse-time fail-loud (R1-#8)", () => {
		expect(() =>
			parseCodexLeadRuntimeConfig(
				fullEnv({
					FLYWHEEL_CODEX_LEAD_READ_DENY: "1",
					FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write",
				}),
			),
		).toThrow(/requires sandbox=read-only/);
	});

	it("buildThreadParams OMITS the legacy sandbox param under readDeny+read-only", () => {
		expect(
			buildThreadParams(
				{ sandboxMode: "read-only", readDeny: true },
				undefined,
			),
		).toEqual({ approvalPolicy: "never" });
		// persona still flows through
		expect(
			buildThreadParams(
				{ sandboxMode: "read-only", readDeny: true },
				"You are Mufasa.",
			),
		).toEqual({ approvalPolicy: "never", baseInstructions: "You are Mufasa." });
	});

	it("buildThreadParams KEEPS sandbox when readDeny is off (byte-compat)", () => {
		expect(
			buildThreadParams(
				{ sandboxMode: "read-only", readDeny: false },
				undefined,
			),
		).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
	});

	it("dry-run report surfaces read-deny ON", () => {
		const report = dryRunReport(
			parseCodexLeadRuntimeConfig(
				fullEnv({ FLYWHEEL_CODEX_LEAD_READ_DENY: "1" }),
			),
		).join("\n");
		expect(report).toContain("read-deny     : ON");
		expect(report).toContain("flywheel-lead-secret-deny");
	});
});

describe("FLY-245 Phase A: write-capable confinement (plan §3.1/§3.3)", () => {
	let root: string;
	let home: string;
	let workspace: string;
	let flywheelDir: string;
	let stateDir: string;
	let codexHome: string;
	let ctx: () => Parameters<typeof resolveLeadWorkspace>[1];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly245-A-"));
		home = join(root, "home");
		workspace = join(root, "scratch");
		flywheelDir = join(home, ".flywheel");
		stateDir = join(home, "state", "mufasa");
		codexHome = join(home, ".codex-mufasa");
		for (const d of [home, workspace, flywheelDir, stateDir, codexHome]) {
			mkdirSync(d, { recursive: true });
		}
		ctx = () => ({ home, flywheelDir, stateDir, codexHome });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	describe("pathsOverlap", () => {
		it("detects equal / ancestor / descendant; rejects siblings", () => {
			expect(pathsOverlap("/a/b", "/a/b")).toBe(true);
			expect(pathsOverlap("/a", "/a/b")).toBe(true); // b under a
			expect(pathsOverlap("/a/b", "/a")).toBe(true); // a under b
			expect(pathsOverlap("/a/b", "/a/c")).toBe(false); // siblings
			expect(pathsOverlap("/a/bc", "/a/b")).toBe(false); // prefix-not-path
		});
	});

	describe("resolveLeadWorkspace", () => {
		it("accepts a valid dedicated scratch (canonicalized)", () => {
			expect(resolveLeadWorkspace(workspace, ctx())).toBe(
				realpathSync(workspace),
			);
		});

		it("rejects a non-absolute path", () => {
			expect(() => resolveLeadWorkspace("relative/dir", ctx())).toThrow(
				/absolute path/,
			);
		});

		it("rejects a path that does not exist", () => {
			expect(() => resolveLeadWorkspace(join(root, "nope"), ctx())).toThrow(
				/does not exist/,
			);
		});

		it("rejects $HOME itself and any ancestor of $HOME", () => {
			expect(() => resolveLeadWorkspace(home, ctx())).toThrow(/\$HOME itself/);
			expect(() => resolveLeadWorkspace(root, ctx())).toThrow(
				/ancestor of \$HOME/,
			);
		});

		it("rejects overlap with ~/.flywheel, state dir, CODEX_HOME", () => {
			expect(() => resolveLeadWorkspace(flywheelDir, ctx())).toThrow(
				/\.flywheel/,
			);
			expect(() => resolveLeadWorkspace(stateDir, ctx())).toThrow(/state dir/);
			expect(() => resolveLeadWorkspace(codexHome, ctx())).toThrow(
				/CODEX_HOME/,
			);
			// a parent of the state dir also overlaps (state dir under it).
			expect(() => resolveLeadWorkspace(join(home, "state"), ctx())).toThrow(
				/state dir/,
			);
		});

		it("rejects a symlink that resolves into a sensitive dir (realpath defeats smuggling)", () => {
			const sneaky = join(root, "sneaky-link");
			symlinkSync(flywheelDir, sneaky);
			expect(() => resolveLeadWorkspace(sneaky, ctx())).toThrow(/\.flywheel/);
		});

		it("rejects overlap with an explicit trusted control-plane path", () => {
			const checkout = join(root, "flywheel-checkout");
			mkdirSync(checkout, { recursive: true });
			expect(() =>
				resolveLeadWorkspace(checkout, { ...ctx(), trustedPaths: [checkout] }),
			).toThrow(/trusted control-plane/);
		});
	});

	describe("buildConfinementArgv", () => {
		it("pins network OFF + single writable root + secret-scrubbing env policy", () => {
			const argv = buildConfinementArgv("/scratch/lead");
			expect(argv).toContain("sandbox_workspace_write.network_access=false");
			expect(argv).toContain(
				'sandbox_workspace_write.writable_roots=["/scratch/lead"]',
			);
			const exclude = argv.find((a) =>
				a.startsWith("shell_environment_policy.exclude="),
			);
			expect(exclude).toBeDefined();
			expect(exclude).toContain("*TOKEN*");
			expect(exclude).toContain("CODEX_*");
		});
	});

	describe("parseCodexLeadRuntimeConfig — workspace wiring", () => {
		it("read-only: workspace ignored even if env is set (byte-compat)", () => {
			const c = parseCodexLeadRuntimeConfig(
				fullEnv({ FLYWHEEL_CODEX_LEAD_WORKSPACE: workspace }),
			);
			expect(c.sandboxMode).toBe("read-only");
			expect(c.workspace).toBeUndefined();
		});

		it("write-capable + valid workspace → canonical workspace on config", () => {
			const c = parseCodexLeadRuntimeConfig(
				fullEnv({
					FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write",
					FLYWHEEL_CODEX_LEAD_STATE_DIR: stateDir,
					CODEX_HOME: codexHome,
					FLYWHEEL_CODEX_LEAD_WORKSPACE: workspace,
				}),
			);
			expect(c.workspace).toBe(realpathSync(workspace));
		});

		it("write-capable + workspace overlapping CODEX_HOME → throws at parse", () => {
			expect(() =>
				parseCodexLeadRuntimeConfig(
					fullEnv({
						FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write",
						CODEX_HOME: codexHome,
						FLYWHEEL_CODEX_LEAD_WORKSPACE: codexHome,
					}),
				),
			).toThrow(/CODEX_HOME/);
		});

		it("write-capable + no workspace env → undefined (fail-close at :336 still governs)", () => {
			const c = parseCodexLeadRuntimeConfig(
				fullEnv({ FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write" }),
			);
			expect(c.workspace).toBeUndefined();
		});

		// Codex code-review R1 HIGH-2: production must PASS the control-plane
		// trusted roots into resolveLeadWorkspace (the overlap option was wired but
		// never supplied). A workspace overlapping the gateway DEPLOY directory must
		// now be rejected at parse — a model that can write that dir could rewrite
		// the gateway code launchd later runs OUTSIDE the sandbox.
		it("write-capable + workspace overlapping the gateway deploy dir → throws at parse (HIGH-2)", () => {
			const deployDir = join(root, "deploy");
			mkdirSync(deployDir, { recursive: true });
			const gw = join(deployDir, "gateway-main.js");
			writeFileSync(gw, "// deployed\n");
			expect(() =>
				parseCodexLeadRuntimeConfig(
					fullEnv({
						FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write",
						FLYWHEEL_CODEX_LEAD_STATE_DIR: stateDir,
						CODEX_HOME: codexHome,
						FLYWHEEL_GATEWAY_ENTRY: gw,
						// the workspace IS the gateway deploy directory → symmetric overlap
						FLYWHEEL_CODEX_LEAD_WORKSPACE: deployDir,
					}),
				),
			).toThrow(/trusted control-plane path|overlap/i);
		});

		it("write-capable + workspace overlapping the teamlead checkout (deps closure) → throws at parse (HIGH-2)", () => {
			// The teamlead package root is derived from the runtime module — a
			// workspace at/above it would let the model rewrite the runtime + its
			// dependency closure. Use the real package root as the workspace.
			const pkgRoot = realpathSync(join(TEST_DIR, "..", "..", "..", ".."));
			expect(() =>
				parseCodexLeadRuntimeConfig(
					fullEnv({
						FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write",
						FLYWHEEL_CODEX_LEAD_STATE_DIR: stateDir,
						CODEX_HOME: codexHome,
						FLYWHEEL_CODEX_LEAD_WORKSPACE: pkgRoot,
					}),
				),
			).toThrow(/trusted control-plane path|overlap/i);
		});
	});

	describe("buildThreadParams — cwd pin", () => {
		it("write-capable with workspace → cwd pinned", () => {
			expect(
				buildThreadParams(
					{ sandboxMode: "workspace-write", workspace: "/scratch/lead" },
					undefined,
				),
			).toEqual({
				approvalPolicy: "never",
				sandbox: "workspace-write",
				cwd: "/scratch/lead",
			});
		});

		it("read-only (no workspace) → NO cwd (byte-compat)", () => {
			expect(
				buildThreadParams({ sandboxMode: "read-only" }, undefined),
			).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
		});
	});
});

describe("buildCodexLeadRuntime — persona fail-closed (review MEDIUM)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly224-persona-fc-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("throws when systemPromptFiles is configured but nothing is readable", () => {
		const config = parseCodexLeadRuntimeConfig(
			fullEnv({
				FLYWHEEL_CODEX_LEAD_STATE_DIR: dir,
				FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES: join(dir, "does-not-exist.md"),
			}),
		);
		expect(() => buildCodexLeadRuntime(config, silentLogger)).toThrow(
			/FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES set but no file/,
		);
	});

	it("does NOT throw when no persona files are configured (byte-compat)", () => {
		const config = parseCodexLeadRuntimeConfig(
			fullEnv({ FLYWHEEL_CODEX_LEAD_STATE_DIR: dir }),
		);
		expect(() => buildCodexLeadRuntime(config, silentLogger)).not.toThrow();
	});
});

describe("readBaseInstructions (persona → baseInstructions)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly224-persona-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("concatenates files and strips YAML frontmatter (model:opus must not leak)", () => {
		const identity = join(dir, "identity.md");
		writeFileSync(
			identity,
			"---\nname: mufasa-lead\nmodel: opus\n---\nYou are Mufasa, a warm peer-level companion.",
			"utf8",
		);
		const contract = join(dir, "contract.md");
		writeFileSync(contract, "Safety: never open Runners.", "utf8");

		const out = readBaseInstructions([identity, contract]);
		expect(out).toBe(
			"You are Mufasa, a warm peer-level companion.\n\nSafety: never open Runners.",
		);
		expect(out).not.toContain("model: opus"); // frontmatter stripped
		expect(out).not.toContain("---");
	});

	it("skips missing/unreadable files (never throws)", () => {
		const ok = join(dir, "ok.md");
		writeFileSync(ok, "Persona body.", "utf8");
		expect(readBaseInstructions([join(dir, "nope.md"), ok])).toBe(
			"Persona body.",
		);
	});

	it("returns undefined when nothing readable/non-empty (byte-compat)", () => {
		expect(readBaseInstructions([])).toBeUndefined();
		expect(readBaseInstructions([join(dir, "missing.md")])).toBeUndefined();
		const empty = join(dir, "empty.md");
		writeFileSync(empty, "---\nonly: frontmatter\n---\n", "utf8");
		expect(readBaseInstructions([empty])).toBeUndefined();
	});
});

describe("thread-id store", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly224-thread-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("absent → undefined; write then read round-trips", () => {
		const path = join(dir, "nested", "thread-id");
		expect(readThreadId(path)).toBeUndefined();
		writeThreadId(path, "thread-abc");
		expect(readThreadId(path)).toBe("thread-abc");
	});

	it("blank file → undefined", () => {
		const path = join(dir, "thread-id");
		writeThreadId(path, "   ");
		expect(readThreadId(path)).toBeUndefined();
	});
});

// ── FLY-245 F-b: the §7 write-capable release gate ───────────────────────────

describe("FLY-245 F-b: write-capable release gate (plan §7)", () => {
	let root: string;
	let stateDir: string;
	let workspace: string;
	let gatewayEntry: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly245-release-"));
		stateDir = join(root, "state");
		workspace = join(root, "workspace");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(workspace, { recursive: true });
		const gwDir = join(root, "deploy");
		mkdirSync(gwDir, { recursive: true });
		gatewayEntry = join(gwDir, "gateway-main.js");
		writeFileSync(gatewayEntry, "// deployed gateway entry stub\n");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function releaseEnv(
		over: Record<string, string | undefined> = {},
	): NodeJS.ProcessEnv {
		return fullEnv({
			FLYWHEEL_CODEX_LEAD_STATE_DIR: stateDir,
			FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write",
			FLYWHEEL_CODEX_LEAD_WORKSPACE: workspace,
			FLYWHEEL_FOUNDER_DISCORD_USER_ID: "annie-987",
			FLYWHEEL_CODEX_CLI_VERSION_ALLOWLIST: "0.99.0",
			FLYWHEEL_GATEWAY_ENTRY: gatewayEntry,
			...over,
		});
	}

	it("UNLOCKS: all release conditions present → buildCodexLeadRuntime succeeds", () => {
		const config = parseCodexLeadRuntimeConfig(releaseEnv());
		expect(() => buildCodexLeadRuntime(config, silentLogger)).not.toThrow();
	});

	it("danger-full-access is PERMANENTLY refused, even with everything else present", () => {
		const config = parseCodexLeadRuntimeConfig(
			releaseEnv({ FLYWHEEL_CODEX_LEAD_SANDBOX: "danger-full-access" }),
		);
		expect(() => buildCodexLeadRuntime(config, silentLogger)).toThrow(
			/permanently refused/i,
		);
	});

	it("② missing workspace → fail-closed", () => {
		const config = parseCodexLeadRuntimeConfig(
			releaseEnv({ FLYWHEEL_CODEX_LEAD_WORKSPACE: undefined }),
		);
		expect(() => buildCodexLeadRuntime(config, silentLogger)).toThrow(
			/WORKSPACE/,
		);
	});

	it("⑤ missing founder id → fail-closed", () => {
		const config = parseCodexLeadRuntimeConfig(
			releaseEnv({ FLYWHEEL_FOUNDER_DISCORD_USER_ID: undefined }),
		);
		expect(() => buildCodexLeadRuntime(config, silentLogger)).toThrow(
			/FOUNDER_DISCORD_USER_ID/,
		);
	});

	it("⑤ missing cliVersion allowlist → fail-closed (a new Codex must re-pass the threat matrix)", () => {
		const config = parseCodexLeadRuntimeConfig(
			releaseEnv({ FLYWHEEL_CODEX_CLI_VERSION_ALLOWLIST: undefined }),
		);
		expect(() => buildCodexLeadRuntime(config, silentLogger)).toThrow(
			/VERSION_ALLOWLIST/,
		);
	});

	it("⑥ gateway entry not deployed → fail-closed", () => {
		// Keep the deploy dir a SIBLING of the workspace (root/deploy vs
		// root/workspace) so the new HIGH-2 trusted-root check doesn't fire first;
		// the missing file is what we're testing (assertWriteCapableRelease ⑥).
		const config = parseCodexLeadRuntimeConfig(
			releaseEnv({
				FLYWHEEL_GATEWAY_ENTRY: join(root, "deploy", "missing.js"),
			}),
		);
		expect(() => buildCodexLeadRuntime(config, silentLogger)).toThrow(
			/gateway entry/i,
		);
	});

	it("⑥ gateway entry INSIDE the model-writable workspace → fail-closed (tamper risk)", () => {
		// With HIGH-2, the gateway DEPLOY dir is now a trusted root; an entry inside
		// the workspace means the workspace overlaps that trusted root → rejected at
		// PARSE (earlier than the assertWriteCapableRelease ⑥ check, same outcome).
		const inside = join(workspace, "gateway-main.js");
		writeFileSync(inside, "// tampered\n");
		expect(() =>
			parseCodexLeadRuntimeConfig(
				releaseEnv({ FLYWHEEL_GATEWAY_ENTRY: inside }),
			),
		).toThrow(/trusted control-plane path|overlap|INSIDE the model-writable/i);
	});

	it("⑦ missing FLYWHEEL_API_TOKEN → fail-closed (gateway broker incomplete)", () => {
		const config = parseCodexLeadRuntimeConfig(
			releaseEnv({ FLYWHEEL_API_TOKEN: undefined }),
		);
		expect(() => buildCodexLeadRuntime(config, silentLogger)).toThrow(
			/API_TOKEN/,
		);
	});

	it("a refusal lists EVERY failed condition at once (operator-debuggable)", () => {
		const config = parseCodexLeadRuntimeConfig(
			releaseEnv({
				FLYWHEEL_CODEX_LEAD_WORKSPACE: undefined,
				FLYWHEEL_FOUNDER_DISCORD_USER_ID: undefined,
				FLYWHEEL_CODEX_CLI_VERSION_ALLOWLIST: undefined,
			}),
		);
		expect(() => assertWriteCapableRelease(config)).toThrow(
			/WORKSPACE.*FOUNDER_DISCORD_USER_ID.*VERSION_ALLOWLIST/s,
		);
	});

	it("read-only companions never touch the release gate (byte-compat path)", () => {
		const config = parseCodexLeadRuntimeConfig(
			fullEnv({ FLYWHEEL_CODEX_LEAD_STATE_DIR: stateDir }),
		);
		expect(() => buildCodexLeadRuntime(config, silentLogger)).not.toThrow();
	});

	it("buildActionSurfaceDisableArgv pins the verified non-MCP disable keys (⑧ static)", () => {
		expect(buildActionSurfaceDisableArgv()).toEqual([
			"-c",
			"tools.web_search=false",
		]);
	});
});

describe("FLY-245 F-b: McpInventoryWatcher (release ④ runtime half)", () => {
	it("resolves once exactly the allowlist is ready", async () => {
		const w = new McpInventoryWatcher();
		w.record("mcpServer/startupStatus/updated", {
			name: "flywheel_gateway",
			status: "ready",
		});
		await expect(
			w.waitForExact(["flywheel_gateway"], 500),
		).resolves.toBeUndefined();
	});

	it("an EXTRA observed server fail-closes (injected Chrome / unknown connector)", async () => {
		const w = new McpInventoryWatcher();
		w.record("mcpServer/startupStatus/updated", {
			name: "flywheel_gateway",
			status: "ready",
		});
		w.record("mcpServer/startupStatus/updated", {
			name: "chrome_devtools",
			status: "starting",
		});
		await expect(w.waitForExact(["flywheel_gateway"], 500)).rejects.toThrow(
			/unexpected server/i,
		);
	});

	it("a FAILED required server fail-closes", async () => {
		const w = new McpInventoryWatcher();
		w.record("mcpServer/startupStatus/updated", {
			name: "flywheel_gateway",
			status: "failed",
		});
		await expect(w.waitForExact(["flywheel_gateway"], 500)).rejects.toThrow(
			/reported "failed"/i,
		);
	});

	it("never-ready → timeout fail-closes (an unconfirmed gateway can't unlock)", async () => {
		const w = new McpInventoryWatcher();
		await expect(w.waitForExact(["flywheel_gateway"], 200, 20)).rejects.toThrow(
			/timed out/i,
		);
	});

	it("alternate notification shapes (server.{name,status}) are parsed", async () => {
		const w = new McpInventoryWatcher();
		w.record("mcpServer/startupStatus/updated", {
			server: { name: "flywheel_gateway", status: "running" },
		});
		await expect(
			w.waitForExact(["flywheel_gateway"], 500),
		).resolves.toBeUndefined();
	});

	it("unrelated notifications are ignored", () => {
		const w = new McpInventoryWatcher();
		w.record("turn/completed", { name: "x", status: "ready" });
		expect(w.observedServers()).toEqual([]);
	});

	// Codex code-review R1 HIGH-1: the watcher must ALSO collect the advertised
	// model-callable tool names (feeds the ⑧ tool-surface assertion).
	it("collects tool names from a `tools: [...]` advertisement", () => {
		const w = new McpInventoryWatcher();
		w.record("mcpServer/tools/listChanged", {
			tools: [
				{ name: "request_runner_lifecycle" },
				{ name: "relay_ship_decision" },
			],
		});
		expect(new Set(w.observedTools())).toEqual(
			new Set(["request_runner_lifecycle", "relay_ship_decision"]),
		);
	});

	it("collects a tool name from string-array and single-tool shapes", () => {
		const w = new McpInventoryWatcher();
		w.record("notifications/tools/list_changed", { tools: ["web_search"] });
		w.record("mcpServer/tool/added", { tool: "github_connector" });
		expect(new Set(w.observedTools())).toEqual(
			new Set(["web_search", "github_connector"]),
		);
	});

	it("a non-tool notification contributes no tools (empty → ⑧ fails closed)", () => {
		const w = new McpInventoryWatcher();
		w.record("mcpServer/startupStatus/updated", {
			name: "flywheel_gateway",
			status: "ready",
		});
		expect(w.observedTools()).toEqual([]);
	});
});
