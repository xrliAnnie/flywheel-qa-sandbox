import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
	buildFullAccessArgv,
	buildFullAccessEnv,
	buildThreadParams,
	dryRunReport,
	FULL_ACCESS_ENV_ALLOWLIST,
	parseCodexLeadRuntimeConfig,
	pathsOverlap,
	readBaseInstructions,
	readThreadId,
	resolveCoreStrictChannelIds,
	resolveFullAccessProjectRoot,
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
		FLYWHEEL_LEAD_KEY: "mufasa-project-mufasa",
		FLYWHEEL_LEAD_BACKEND: "codex-app-server",
		FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
		DISCORD_EXPECTED_BOT_USER_ID: "1499895683287748679",
		DISCORD_BOT_TOKEN: "tok",
		FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "chan-chat",
		FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
		FLYWHEEL_API_TOKEN: "api",
		FLYWHEEL_CODEX_LEAD_STATE_DIR: "/var/state/mufasa",
		FLYWHEEL_CODEX_BIN: "/usr/local/bin/codex",
		CODEX_HOME: "/Users/x/.codex-mufasa",
		FLYWHEEL_COMM_DB: "/var/state/flywheel/comm.db",
		...over,
	};
}

describe("parseCodexLeadRuntimeConfig", () => {
	it("parses a full env and derives the state paths", () => {
		const c = parseCodexLeadRuntimeConfig(fullEnv());
		expect(c.leadId).toBe("mufasa");
		expect(c.leadKey).toBe("mufasa-project-mufasa");
		expect(c.identityDigest).toBe("a".repeat(64));
		expect(c.botUserId).toBe("1499895683287748679");
		expect(c.codexHome).toBe("/Users/x/.codex-mufasa");
		expect(c.journalDbPath).toBe("/var/state/mufasa/journal.db");
		expect(c.outboxDbPath).toBe("/var/state/mufasa/outbox.db");
		expect(c.threadIdPath).toBe("/var/state/mufasa/thread-id");
		expect(c.channelIds).toEqual(["chan-chat"]); // no core channel set
		expect(c.chrome).toBeUndefined();
	});

	it("keeps model, effort, and context window absent without materializing empty config", () => {
		const c = parseCodexLeadRuntimeConfig(fullEnv());
		expect(Object.hasOwn(c, "model")).toBe(false);
		expect(Object.hasOwn(c, "reasoningEffort")).toBe(false);
		expect(Object.hasOwn(c, "modelContextWindow")).toBe(false);
		expect(buildThreadParams(c, undefined)).toEqual({
			approvalPolicy: "never",
			sandbox: "read-only",
		});
		expect(Object.hasOwn(buildThreadParams(c, undefined), "config")).toBe(
			false,
		);
	});

	it("maps configured model, effort, and 1M window into the Codex thread schema", () => {
		const c = parseCodexLeadRuntimeConfig(
			fullEnv({
				FLYWHEEL_LEAD_MODEL: "gpt-5.6-sol",
				FLYWHEEL_LEAD_EFFORT: "xhigh",
				FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW: "1000000",
			}),
		);
		expect(c).toMatchObject({
			model: "gpt-5.6-sol",
			reasoningEffort: "xhigh",
			modelContextWindow: 1_000_000,
		});
		expect(buildThreadParams(c, undefined)).toEqual({
			approvalPolicy: "never",
			sandbox: "read-only",
			model: "gpt-5.6-sol",
			config: {
				model_reasoning_effort: "xhigh",
				model_context_window: 1_000_000,
			},
		});
	});

	it.each([
		[{ FLYWHEEL_LEAD_MODEL: "gpt\n5" }, /FLYWHEEL_LEAD_MODEL/],
		[{ FLYWHEEL_LEAD_EFFORT: "ultra" }, /FLYWHEEL_LEAD_EFFORT/],
		[{ FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW: "0" }, /MODEL_CONTEXT_WINDOW/],
		[{ FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW: "1.5" }, /MODEL_CONTEXT_WINDOW/],
		[
			{ FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW: "10000001" },
			/MODEL_CONTEXT_WINDOW/,
		],
	] as const)(
		"fails loudly on invalid model runtime parameters: %j",
		(over, error) => {
			expect(() => parseCodexLeadRuntimeConfig(fullEnv(over))).toThrow(error);
		},
	);

	it("defaults codexProfile to companion when unset", () => {
		expect(parseCodexLeadRuntimeConfig(fullEnv()).codexProfile).toBe(
			"companion",
		);
	});

	it("FAIL-LOUD on an unknown codexProfile value (R2-4: never silently default)", () => {
		expect(() =>
			parseCodexLeadRuntimeConfig(
				fullEnv({ FLYWHEEL_CODEX_LEAD_PROFILE: "bogus-tier" }),
			),
		).toThrow(/FLYWHEEL_CODEX_LEAD_PROFILE="bogus-tier" invalid/);
	});

	it("FLY-350 (Z): write-capable profile is valid WITH a workspace-write sandbox", () => {
		const c = parseCodexLeadRuntimeConfig(
			fullEnv({
				FLYWHEEL_CODEX_LEAD_PROFILE: "write-capable",
				FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write",
			}),
		);
		expect(c.codexProfile).toBe("write-capable");
		expect(c.sandboxMode).toBe("workspace-write");
	});

	it("FLY-350 (Z): write-capable profile REQUIRES workspace-write (read-only → fail-loud)", () => {
		expect(() =>
			parseCodexLeadRuntimeConfig(
				fullEnv({ FLYWHEEL_CODEX_LEAD_PROFILE: "write-capable" }),
			),
		).toThrow(/write-capable requires sandbox=workspace-write/);
	});

	// FLY-350 (Z) M-3 (Codex review MEDIUM): the profile is the SSOT — a
	// workspace-write sandbox under companion (the default) must fail-loud, never
	// silently run write-capable with a companion label (config/fleet drift).
	it("rejects workspace-write under the default companion profile (SSOT, fail-loud)", () => {
		expect(() =>
			parseCodexLeadRuntimeConfig(
				fullEnv({ FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write" }),
			),
		).toThrow(
			/workspace-write requires FLYWHEEL_CODEX_LEAD_PROFILE=write-capable/,
		);
	});

	it("includes the core channel while Chrome integration stays disabled", () => {
		const c = parseCodexLeadRuntimeConfig(
			fullEnv({
				FLYWHEEL_LEAD_CORE_CHANNEL_ID: "chan-core",
				FLYWHEEL_LEAD_CHROME_URL: "http://127.0.0.1:9222",
			}),
		);
		expect(c.channelIds).toEqual(["chan-chat", "chan-core"]);
		expect(c.chrome).toBeUndefined();
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

	it("FLY-1806: typingEnabled is fixed on (parity with Claude Lead)", () => {
		expect(parseCodexLeadRuntimeConfig(fullEnv()).typingEnabled).toBe(true);
	});

	it("fail-loud: lists ALL missing always-required env in one error", () => {
		const env = fullEnv({
			DISCORD_BOT_TOKEN: undefined,
			CODEX_HOME: undefined,
			DISCORD_EXPECTED_BOT_USER_ID: "  ", // whitespace = missing
		});
		expect(() => parseCodexLeadRuntimeConfig(env)).toThrow(/DISCORD_BOT_TOKEN/);
		try {
			parseCodexLeadRuntimeConfig(env);
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain("CODEX_HOME");
			expect(msg).toContain("DISCORD_EXPECTED_BOT_USER_ID");
		}
	});

	it.each([
		["lead key", { FLYWHEEL_LEAD_KEY: "wrong-key" }, "FLYWHEEL_LEAD_KEY"],
		[
			"backend",
			{ FLYWHEEL_LEAD_BACKEND: "claude-code" },
			"FLYWHEEL_LEAD_BACKEND",
		],
		[
			"identity digest",
			{ FLYWHEEL_LEAD_IDENTITY_DIGEST: "short" },
			"FLYWHEEL_LEAD_IDENTITY_DIGEST",
		],
	] as const)(
		"rejects a non-canonical %s projection",
		(_label, over, expected) => {
			expect(() => parseCodexLeadRuntimeConfig(fullEnv(over))).toThrow(
				expected,
			);
		},
	);

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

	it("surfaces the fixed-on typing state in the dry-run", () => {
		expect(
			dryRunReport(parseCodexLeadRuntimeConfig(fullEnv())).join("\n"),
		).toContain("typing        : ON");
	});

	// FLY-350 (Z) L-1 (Codex review LOW): a write-capable dry-run surfaces the
	// audited Z-mode fields (gateway 5-tool surface, net-off, writable root, PR
	// scope + GH-token source redacted, structural no-merge).
	it("write-capable dry-run surfaces the (Z) gateway/net-off/PR-scope fields, GH token redacted", () => {
		const root = mkdtempSync(join(tmpdir(), "fly350-zdryrun-"));
		try {
			const ws = join(root, "scratch");
			mkdirSync(ws, { recursive: true });
			const report = dryRunReport(
				parseCodexLeadRuntimeConfig(
					fullEnv({
						FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write",
						FLYWHEEL_CODEX_LEAD_PROFILE: "write-capable",
						FLYWHEEL_CODEX_LEAD_STATE_DIR: join(root, "state"),
						FLYWHEEL_CODEX_LEAD_WORKSPACE: ws,
						FLYWHEEL_GATEWAY_GITHUB_TOKEN: "ghp_zdryrun_secret_value",
						FLYWHEEL_GATEWAY_PROJECT_REPO: "xrliAnnie/growth",
					}),
				),
			).join("\n");
			expect(report).toContain("(Z) gateway");
			expect(report).toContain("git_push");
			expect(report).toContain("open_pr");
			expect(report).toContain("(Z) network   : OFF");
			expect(report).toContain("xrliAnnie/growth");
			expect(report).toContain("STRUCTURALLY impossible");
			// the GH token is redacted, never leaked
			expect(report).not.toContain("ghp_zdryrun_secret_value");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
				fullEnv({
					FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write",
					// FLY-350 (Z) M-3: workspace-write now requires the write-capable profile (SSOT).
					FLYWHEEL_CODEX_LEAD_PROFILE: "write-capable",
				}),
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
					// M-3: workspace-write requires the profile; the release gate (not the
					// parse profile check) is what this test asserts fail-closes.
					FLYWHEEL_CODEX_LEAD_PROFILE: "write-capable",
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

// ── FLY-350: generic full-access Codex Lead (= Claude-equal) ────────────────
describe("FLY-350 full-access profile (= Claude-equal, opt-in)", () => {
	let projDir: string;
	// FLY-304: a real (stub) lead-actions entry so the runtime's existsSync
	// fail-closed (resolveLeadActionsEntry) passes in tests where the dist isn't built.
	let leadActionsEntry: string;
	beforeEach(() => {
		projDir = realpathSync(mkdtempSync(join(tmpdir(), "fly350-fa-proj-")));
		leadActionsEntry = join(projDir, "lead-actions-main.js");
		writeFileSync(leadActionsEntry, "// stub lead-actions entry\n");
	});
	afterEach(() => {
		rmSync(projDir, { recursive: true, force: true });
	});

	function fullAccessEnv(over: Record<string, string | undefined> = {}) {
		return fullEnv({
			FLYWHEEL_CODEX_LEAD_PROFILE: "full-access",
			FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write",
			FLYWHEEL_CODEX_LEAD_PROJECT_DIR: projDir,
			// FLY-304: point at the stub entry (prod resolves dist next to the runtime).
			FLYWHEEL_LEAD_ACTIONS_ENTRY: leadActionsEntry,
			...over,
		});
	}

	it("parses full-access WITH a workspace-write sandbox + resolves the project root", () => {
		const c = parseCodexLeadRuntimeConfig(fullAccessEnv());
		expect(c.codexProfile).toBe("full-access");
		expect(c.sandboxMode).toBe("workspace-write");
		expect(c.fullAccessProjectRoot).toBe(projDir);
		// full-access is NOT the (Z) write-capable path — no scratch workspace.
		expect(c.workspace).toBeUndefined();
	});

	it("full-access REQUIRES workspace-write (read-only → fail-loud)", () => {
		expect(() =>
			parseCodexLeadRuntimeConfig(
				fullAccessEnv({ FLYWHEEL_CODEX_LEAD_SANDBOX: undefined }),
			),
		).toThrow(/full-access requires sandbox=workspace-write/);
	});

	it("workspace-write now accepts full-access too (not only write-capable)", () => {
		// The SSOT cross-field used to demand write-capable; full-access is a second
		// legal workspace-write tier. Companion+workspace-write still fails (below).
		expect(parseCodexLeadRuntimeConfig(fullAccessEnv()).sandboxMode).toBe(
			"workspace-write",
		);
	});

	it("full-access REQUIRES FLYWHEEL_CODEX_LEAD_PROJECT_DIR (missing → fail-loud)", () => {
		expect(() =>
			parseCodexLeadRuntimeConfig(
				fullAccessEnv({ FLYWHEEL_CODEX_LEAD_PROJECT_DIR: undefined }),
			),
		).toThrow(/FLYWHEEL_CODEX_LEAD_PROJECT_DIR/);
	});

	it("honors FLYWHEEL_CODEX_LEAD_SUBDIR under the project root", () => {
		mkdirSync(join(projDir, "growth"), { recursive: true });
		const c = parseCodexLeadRuntimeConfig(
			fullAccessEnv({ FLYWHEEL_CODEX_LEAD_SUBDIR: "growth" }),
		);
		expect(c.fullAccessProjectRoot).toBe(realpathSync(join(projDir, "growth")));
	});

	it("buildThreadParams pins cwd=projectRoot + workspace-write for full-access", () => {
		expect(
			buildThreadParams(
				{ sandboxMode: "workspace-write", fullAccessProjectRoot: projDir },
				undefined,
			),
		).toEqual({
			approvalPolicy: "never",
			sandbox: "workspace-write",
			cwd: projDir,
		});
	});

	it("buildCodexLeadRuntime BUILDS a full-access Lead (no release gate, no gateway/broker)", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly350-fa-state-"));
		try {
			const config = parseCodexLeadRuntimeConfig(
				fullAccessEnv({ FLYWHEEL_CODEX_LEAD_STATE_DIR: dir }),
			);
			// Unlike write-capable (which fail-closes without the §7 release inputs),
			// full-access constructs cleanly — its control is the founder-gate rule
			// bundle + branch protection, not the confinement/gateway release gate.
			expect(() => buildCodexLeadRuntime(config, silentLogger)).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// FLY-304: proactive discord_send wiring for full-access.
	it("full-access wires proactive discord_send + surfaces roundtable AVAILABLE", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly304-state-"));
		try {
			const logs: string[] = [];
			const cap = {
				info: (m: string) => logs.push(m),
				warn: () => {},
				error: () => {},
			};
			const config = parseCodexLeadRuntimeConfig(
				fullAccessEnv({
					FLYWHEEL_CODEX_LEAD_STATE_DIR: dir,
					FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "1512578695468941333",
				}),
			);
			expect(config.leadActionsEntry).toBe(leadActionsEntry);
			expect(() => buildCodexLeadRuntime(config, cap)).not.toThrow();
			const line = logs.find((l) => /proactive discord_send enabled/.test(l));
			expect(line).toBeDefined();
			expect(line).toMatch(/roundtable available \(1512578695468941333\)/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("full-access logs roundtable UNAVAILABLE when no cross-dept channel", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly304-state-"));
		try {
			const logs: string[] = [];
			const cap = {
				info: (m: string) => logs.push(m),
				warn: () => {},
				error: () => {},
			};
			const config = parseCodexLeadRuntimeConfig(
				fullAccessEnv({ FLYWHEEL_CODEX_LEAD_STATE_DIR: dir }),
			);
			buildCodexLeadRuntime(config, cap);
			expect(logs.some((l) => /roundtable UNAVAILABLE/.test(l))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("full-access FAIL-CLOSES when the lead-actions entry is not deployed (item 2)", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly304-state-"));
		try {
			const config = parseCodexLeadRuntimeConfig(
				fullAccessEnv({
					FLYWHEEL_CODEX_LEAD_STATE_DIR: dir,
					FLYWHEEL_LEAD_ACTIONS_ENTRY: join(projDir, "does-not-exist.js"),
				}),
			);
			expect(() => buildCodexLeadRuntime(config, silentLogger)).toThrow(
				/lead-actions entry not deployed/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// FLY-304 R1#3: dry-run preflight must reflect the LIVE full-access MCP injection
	// (lead_actions + token-by-name), never the token value.
	it("dry-run reflects lead_actions injection + token-by-name, never the token value", () => {
		const config = parseCodexLeadRuntimeConfig(
			fullAccessEnv({
				DISCORD_BOT_TOKEN: "topsecrettoken1234567890",
				FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "1512578695468941333",
			}),
		);
		const report = dryRunReport(config).join("\n");
		expect(report).toMatch(/MCP injected\s*:.*lead_actions/);
		expect(report).toContain('env_vars=["DISCORD_BOT_TOKEN"]');
		// the raw token VALUE must never appear (redacted bot-token line shows ≤4 chars).
		expect(report).not.toContain("topsecrettoken1234567890");
		// literal env carries non-secret coords only.
		expect(report).toContain(
			"mcp_servers.lead_actions.env.FLYWHEEL_LEAD_CHAT_CHANNEL_ID",
		);
	});

	// FLY-304 R1#2: full-access forwards the explicit roundtable alias pin so the
	// documented multi-cross-dept disambiguation actually reaches the MCP child.
	it("forwards FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES to the lead_actions child", () => {
		const config = parseCodexLeadRuntimeConfig(
			fullAccessEnv({
				FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "111,222",
				FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES: "roundtable:222",
			}),
		);
		expect(config.leadActionsChannelAliases).toBe("roundtable:222");
		const report = dryRunReport(config).join("\n");
		expect(report).toContain(
			'mcp_servers.lead_actions.env.FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES="roundtable:222"',
		);
	});

	// R2#1: the boot log must reflect a valid pin (not say "ambiguous") so operator
	// preflight evidence matches what the MCP child actually authorizes.
	it("boot log reports the PINNED roundtable target for multi cross-dept (R2#1)", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly304-state-"));
		try {
			const logs: string[] = [];
			const cap = {
				info: (m: string) => logs.push(m),
				warn: () => {},
				error: () => {},
			};
			const config = parseCodexLeadRuntimeConfig(
				fullAccessEnv({
					FLYWHEEL_CODEX_LEAD_STATE_DIR: dir,
					FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "111,222",
					FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES: "roundtable:222",
				}),
			);
			buildCodexLeadRuntime(config, cap);
			const line = logs.find((l) => /proactive discord_send enabled/.test(l));
			expect(line).toMatch(/roundtable available \(pinned 222\)/);
			expect(line).not.toMatch(/ambiguous/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("dry-run surfaces full-access: network ON, project root, NO gateway, merge founder-gated", () => {
		const report = dryRunReport(
			parseCodexLeadRuntimeConfig(fullAccessEnv()),
		).join("\n");
		expect(report).toContain("sandbox=workspace-write");
		expect(report).toMatch(/full-access/i);
		expect(report).toMatch(/network\s*:\s*ON/i);
		expect(report).toContain(projDir);
		// honest red line: merge is founder-gated (contract + branch protection), NOT
		// the (Z) structural impossibility.
		expect(report).toMatch(/founder-gate/i);
		// no gateway / broker disclosure for full-access (local gh/git).
		expect(report).not.toContain("flywheel_gateway MCP");
	});
});

describe("resolveFullAccessProjectRoot", () => {
	let home: string;
	beforeEach(() => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "fly350-home-")));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	function ctx(
		over: Partial<Parameters<typeof resolveFullAccessProjectRoot>[2]> = {},
	) {
		return {
			home,
			flywheelDir: join(home, ".flywheel"),
			stateDir: join(home, ".flywheel", "state", "codex-lead", "x"),
			codexHome: join(home, ".codex-mufasa"),
			...over,
		};
	}

	it("resolves + realpath-canonicalizes an absolute project dir (no subdir)", () => {
		const proj = realpathSync(mkdtempSync(join(tmpdir(), "fly350-proj-")));
		try {
			expect(resolveFullAccessProjectRoot(proj, undefined, ctx())).toBe(proj);
		} finally {
			rmSync(proj, { recursive: true, force: true });
		}
	});

	it("joins + validates a subdir", () => {
		const proj = realpathSync(mkdtempSync(join(tmpdir(), "fly350-proj-")));
		mkdirSync(join(proj, "sub"), { recursive: true });
		try {
			expect(resolveFullAccessProjectRoot(proj, "sub", ctx())).toBe(
				realpathSync(join(proj, "sub")),
			);
		} finally {
			rmSync(proj, { recursive: true, force: true });
		}
	});

	it("rejects a non-absolute path", () => {
		expect(() =>
			resolveFullAccessProjectRoot("relative/dir", undefined, ctx()),
		).toThrow(/absolute path/);
	});

	it("rejects a non-existent path (fail-loud)", () => {
		expect(() =>
			resolveFullAccessProjectRoot("/no/such/fly350/dir", undefined, ctx()),
		).toThrow(/does not exist/);
	});

	it("rejects overlap with the Lead state dir (model must not write runtime state)", () => {
		const stateDir = join(home, ".flywheel", "state", "codex-lead", "x");
		mkdirSync(stateDir, { recursive: true });
		expect(() =>
			resolveFullAccessProjectRoot(stateDir, undefined, ctx({ stateDir })),
		).toThrow(/overlap/);
	});

	it("rejects overlap with CODEX_HOME", () => {
		const codexHome = join(home, ".codex-mufasa");
		mkdirSync(codexHome, { recursive: true });
		expect(() =>
			resolveFullAccessProjectRoot(codexHome, undefined, ctx({ codexHome })),
		).toThrow(/overlap/);
	});

	it("rejects $HOME itself", () => {
		expect(() => resolveFullAccessProjectRoot(home, undefined, ctx())).toThrow(
			/\$HOME/,
		);
	});

	it("ALLOWS a normal descendant of $HOME (e.g. ~/Dev/project)", () => {
		const proj = join(home, "Dev", "project");
		mkdirSync(proj, { recursive: true });
		expect(resolveFullAccessProjectRoot(proj, undefined, ctx())).toBe(
			realpathSync(proj),
		);
	});

	// Codex review next-item: a SYMLINK whose realpath lands in a sensitive dir must
	// NOT smuggle the project root past the overlap check (the resolver realpath-
	// canonicalizes BEFORE comparing, like resolveLeadWorkspace).
	it("rejects a symlink that realpath-resolves INTO CODEX_HOME (symlink bypass)", () => {
		const codexHome = join(home, ".codex-mufasa");
		mkdirSync(codexHome, { recursive: true });
		const link = join(home, "innocent-looking-project");
		symlinkSync(codexHome, link);
		expect(() =>
			resolveFullAccessProjectRoot(link, undefined, ctx({ codexHome })),
		).toThrow(/overlap/);
	});

	// A subdir that escapes (via a symlink) back into a sensitive dir is also caught
	// — the join + realpath collapses the indirection before the overlap check.
	it("rejects a subdir symlink that resolves into the state dir", () => {
		const proj = realpathSync(mkdtempSync(join(tmpdir(), "fly350-proj-")));
		const stateDir = join(home, ".flywheel", "state", "codex-lead", "x");
		mkdirSync(stateDir, { recursive: true });
		// a "esc" entry under proj symlinks to the state dir, addressed via subdir
		symlinkSync(realpathSync(stateDir), join(proj, "esc"));
		try {
			expect(() =>
				resolveFullAccessProjectRoot(proj, "esc", ctx({ stateDir })),
			).toThrow(/overlap/);
		} finally {
			rmSync(proj, { recursive: true, force: true });
		}
	});
});

describe("buildFullAccessArgv (= Claude-equal: net ON, project writable, NO env wash)", () => {
	it("sets network ON + the project root as the single writable root", () => {
		const argv = buildFullAccessArgv("/Users/x/Dev/growth");
		expect(argv).toEqual([
			"-c",
			"sandbox_workspace_write.network_access=true",
			"-c",
			'sandbox_workspace_write.writable_roots=["/Users/x/Dev/growth"]',
		]);
	});

	it("does NOT emit a shell_environment_policy.exclude (full-access keeps its gh/git env)", () => {
		expect(buildFullAccessArgv("/p").join(" ")).not.toContain(
			"shell_environment_policy",
		);
	});
});

describe("buildFullAccessEnv (H-1: positive allowlist mirroring a Claude Lead pane)", () => {
	it("keeps the allowlisted Claude-pane vars + gh auth, drops everything else", () => {
		const out = buildFullAccessEnv({
			HOME: "/Users/x",
			PATH: "/usr/bin",
			DISCORD_BOT_TOKEN: "discord", // Claude pane HAS this — allowed
			TEAMLEAD_API_TOKEN: "tl", // Claude pane HAS this — allowed
			OPENAI_API_KEY: "oai", // Claude pane HAS this — allowed
			FLYWHEEL_COMM_DB: "/db",
			FLYWHEEL_FOUNDER_TZ: "Asia/Tokyo",
			BRIDGE_URL: "http://b", // Claude pane HAS this (NOT the FLYWHEEL_ alias)
			// NOT in the Claude pane allowlist — must be dropped even though needed
			// elsewhere; a full-access Lead must never get MORE secrets than Claude.
			// FLYWHEEL_API_TOKEN is the Codex-caught extra (Claude has TEAMLEAD_API_TOKEN).
			FLYWHEEL_API_TOKEN: "leak",
			SOME_OTHER_LEAD_BOT_TOKEN: "leak",
			VERCEL_TOKEN: "leak",
			BLOB_READ_WRITE_TOKEN: "leak",
			AWS_SECRET_ACCESS_KEY: "leak",
			RANDOM_VAR: "leak",
		});
		expect(out.HOME).toBe("/Users/x");
		expect(out.DISCORD_BOT_TOKEN).toBe("discord");
		expect(out.TEAMLEAD_API_TOKEN).toBe("tl");
		expect(out.BRIDGE_URL).toBe("http://b");
		expect(out.FLYWHEEL_FOUNDER_TZ).toBe("Asia/Tokyo");
		expect(out.FLYWHEEL_API_TOKEN).toBeUndefined(); // extra token — dropped
		expect(out.SOME_OTHER_LEAD_BOT_TOKEN).toBeUndefined();
		expect(out.VERCEL_TOKEN).toBeUndefined();
		expect(out.BLOB_READ_WRITE_TOKEN).toBeUndefined();
		expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(out.RANDOM_VAR).toBeUndefined();
	});

	it("env-diff: NO *TOKEN*/*SECRET*/*KEY* key outside the allowlist", () => {
		const noisy: NodeJS.ProcessEnv = {};
		for (const k of [
			"FOO_TOKEN",
			"BAR_SECRET",
			"BAZ_KEY",
			"ANTHROPIC_API_KEY",
			"GITLAB_TOKEN",
		]) {
			noisy[k] = "leak";
		}
		const out = buildFullAccessEnv(noisy);
		const survivingSecretShaped = Object.keys(out).filter((k) =>
			/TOKEN|SECRET|KEY/i.test(k),
		);
		for (const k of survivingSecretShaped) {
			expect(FULL_ACCESS_ENV_ALLOWLIST).toContain(k);
		}
		// none of the noisy non-allowlisted secrets survived
		expect(out.ANTHROPIC_API_KEY).toBeUndefined();
		expect(out.GITLAB_TOKEN).toBeUndefined();
	});

	it("omits allowlisted vars that are absent from the source env (no empty injection)", () => {
		const out = buildFullAccessEnv({ HOME: "/Users/x", PATH: "/usr/bin" });
		expect("DISCORD_BOT_TOKEN" in out).toBe(false);
		expect("GH_TOKEN" in out).toBe(false);
	});

	// Codex code-review HIGH: the allowlist must never carry a SECRET a Claude pane
	// does not. Bind every secret-shaped allowlist entry to what claude-lead.sh
	// actually injects (claude-lead.sh:901-942 `-e "NAME=…"`) ∪ the sanctioned
	// gh-auth set — so a future edit can't slip in e.g. FLYWHEEL_API_TOKEN again.
	it("every secret-shaped allowlist entry IS injected by a Claude pane (or is sanctioned gh-auth)", () => {
		const claudeSh = readFileSync(
			join(TEST_DIR, "..", "..", "..", "..", "scripts", "claude-lead.sh"),
			"utf8",
		);
		// names claude-lead.sh injects into the pane: `-e "NAME=...` and `-e NAME=...`
		const claudePaneVars = new Set<string>();
		for (const m of claudeSh.matchAll(/-e\s+"?([A-Z0-9_]+)=/g)) {
			claudePaneVars.add(m[1] as string);
		}
		// sanity: the parse found the real Claude-pane token names
		expect(claudePaneVars.has("TEAMLEAD_API_TOKEN")).toBe(true);
		expect(claudePaneVars.has("DISCORD_BOT_TOKEN")).toBe(true);
		// the ONLY secrets allowed beyond the Claude pane = the gh-auth set (plan H-1)
		const SANCTIONED_GH_AUTH = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);
		const secretShaped = FULL_ACCESS_ENV_ALLOWLIST.filter((k) =>
			/TOKEN|SECRET|KEY/i.test(k),
		);
		expect(secretShaped.length).toBeGreaterThan(0);
		for (const k of secretShaped) {
			expect(
				claudePaneVars.has(k) || SANCTIONED_GH_AUTH.has(k),
				`allowlist secret ${k} is NOT injected by a Claude pane and is not sanctioned gh-auth — extra secret exposure`,
			).toBe(true);
		}
		// regression pins for the Codex-caught extras
		expect(FULL_ACCESS_ENV_ALLOWLIST as readonly string[]).not.toContain(
			"FLYWHEEL_API_TOKEN",
		);
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
					FLYWHEEL_CODEX_LEAD_PROFILE: "write-capable",
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
						FLYWHEEL_CODEX_LEAD_PROFILE: "write-capable",
						CODEX_HOME: codexHome,
						FLYWHEEL_CODEX_LEAD_WORKSPACE: codexHome,
					}),
				),
			).toThrow(/CODEX_HOME/);
		});

		it("write-capable + no workspace env → undefined (fail-close at release gate still governs)", () => {
			const c = parseCodexLeadRuntimeConfig(
				fullEnv({
					FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write",
					FLYWHEEL_CODEX_LEAD_PROFILE: "write-capable",
				}),
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
						FLYWHEEL_CODEX_LEAD_PROFILE: "write-capable",
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
						FLYWHEEL_CODEX_LEAD_PROFILE: "write-capable",
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
			// FLY-350 (Z) M-3: workspace-write requires the write-capable profile (SSOT).
			FLYWHEEL_CODEX_LEAD_PROFILE: "write-capable",
			FLYWHEEL_CODEX_LEAD_WORKSPACE: workspace,
			FLYWHEEL_FOUNDER_DISCORD_USER_ID: "annie-987",
			FLYWHEEL_CODEX_CLI_VERSION_ALLOWLIST: "0.99.0",
			FLYWHEEL_GATEWAY_ENTRY: gatewayEntry,
			// FLY-350 (Z) unit 5: a write-capable Lead is PR-capable.
			FLYWHEEL_GATEWAY_GITHUB_TOKEN: "ghp_dummy_release_token",
			FLYWHEEL_GATEWAY_PROJECT_REPO: "xrliAnnie/Flywheel",
			...over,
		});
	}

	it("UNLOCKS: all release conditions present → buildCodexLeadRuntime succeeds", () => {
		const config = parseCodexLeadRuntimeConfig(releaseEnv());
		expect(() => buildCodexLeadRuntime(config, silentLogger)).not.toThrow();
	});

	it("danger-full-access is PERMANENTLY refused by the release gate (everything else present)", () => {
		// Route to the release gate's permanent-refusal: M-3's parse check
		// (write-capable ⟺ workspace-write) would otherwise preempt a
		// write-capable + danger-full-access combo. A companion profile parses, then
		// the release gate (sandbox !== read-only) refuses danger-full-access.
		const config = parseCodexLeadRuntimeConfig(
			releaseEnv({
				FLYWHEEL_CODEX_LEAD_SANDBOX: "danger-full-access",
				FLYWHEEL_CODEX_LEAD_PROFILE: "",
			}),
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

	// FLY-350 (Z) unit 5: write-capable = PR-capable → GH_TOKEN source + project
	// repo are boot-time release conditions (the runtime probe re-checks scope).
	it("(Z) missing FLYWHEEL_GATEWAY_GITHUB_TOKEN → fail-closed (PR-capable Lead needs the broker GH token)", () => {
		const config = parseCodexLeadRuntimeConfig(
			releaseEnv({ FLYWHEEL_GATEWAY_GITHUB_TOKEN: undefined }),
		);
		expect(() => buildCodexLeadRuntime(config, silentLogger)).toThrow(
			/GATEWAY_GITHUB_TOKEN/,
		);
	});

	it("(Z) missing FLYWHEEL_GATEWAY_PROJECT_REPO → fail-closed", () => {
		const config = parseCodexLeadRuntimeConfig(
			releaseEnv({ FLYWHEEL_GATEWAY_PROJECT_REPO: undefined }),
		);
		expect(() => buildCodexLeadRuntime(config, silentLogger)).toThrow(
			/GATEWAY_PROJECT_REPO/,
		);
	});

	it("(Z) malformed FLYWHEEL_GATEWAY_PROJECT_REPO slug → fail-closed", () => {
		const config = parseCodexLeadRuntimeConfig(
			releaseEnv({ FLYWHEEL_GATEWAY_PROJECT_REPO: "not-a-slug" }),
		);
		expect(() => buildCodexLeadRuntime(config, silentLogger)).toThrow(
			/owner\/repo.*slug/i,
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

// ─── FLY-898: core-room mention gate ────────────────────────────────────────
describe("FLY-898 core-room mention gate (Codex)", () => {
	it("parse: byte-compat — coreMentionGated false by default", () => {
		expect(parseCodexLeadRuntimeConfig(fullEnv()).coreMentionGated).toBe(false);
	});

	it("parse: FLYWHEEL_LEAD_CORE_MENTION_GATED=1 → coreMentionGated true", () => {
		const c = parseCodexLeadRuntimeConfig(
			fullEnv({
				FLYWHEEL_LEAD_CORE_CHANNEL_ID: "chan-core",
				FLYWHEEL_LEAD_CORE_MENTION_GATED: "1",
			}),
		);
		expect(c.coreMentionGated).toBe(true);
	});

	it("resolveCoreStrictChannelIds: ON + core subscribed → [core]", () => {
		expect(
			resolveCoreStrictChannelIds({
				coreMentionGated: true,
				coreChannelId: "chan-core",
				channelIds: ["chan-chat", "chan-core"],
			}),
		).toEqual(["chan-core"]);
	});

	it("resolveCoreStrictChannelIds: OFF → [] (byte-compat)", () => {
		expect(
			resolveCoreStrictChannelIds({
				coreMentionGated: false,
				coreChannelId: "chan-core",
				channelIds: ["chan-chat", "chan-core"],
			}),
		).toEqual([]);
	});

	it("resolveCoreStrictChannelIds: ON but no coreChannelId → [] (nothing to gate)", () => {
		expect(
			resolveCoreStrictChannelIds({
				coreMentionGated: true,
				coreChannelId: undefined,
				channelIds: ["chan-chat"],
			}),
		).toEqual([]);
	});

	it("resolveCoreStrictChannelIds: ON but core NOT in subscribed channels → [] (guardrail #1)", () => {
		expect(
			resolveCoreStrictChannelIds({
				coreMentionGated: true,
				coreChannelId: "chan-core",
				channelIds: ["chan-chat"], // core not subscribed
			}),
		).toEqual([]);
	});

	it("dryRunReport: 'core mention gate: on' ONLY when gate is effective", () => {
		const on = parseCodexLeadRuntimeConfig(
			fullEnv({
				FLYWHEEL_LEAD_CORE_CHANNEL_ID: "chan-core",
				FLYWHEEL_LEAD_CORE_MENTION_GATED: "1",
			}),
		);
		expect(dryRunReport(on).join("\n")).toMatch(/core mention gate\s*: on/);

		// gated flag set but no core channel subscribed → off (guardrail #1)
		const noCore = parseCodexLeadRuntimeConfig(
			fullEnv({ FLYWHEEL_LEAD_CORE_MENTION_GATED: "1" }),
		);
		expect(dryRunReport(noCore).join("\n")).toMatch(
			/core mention gate\s*: off/,
		);

		// default (no env) → off
		const off = parseCodexLeadRuntimeConfig(
			fullEnv({ FLYWHEEL_LEAD_CORE_CHANNEL_ID: "chan-core" }),
		);
		expect(dryRunReport(off).join("\n")).toMatch(/core mention gate\s*: off/);
	});
});
