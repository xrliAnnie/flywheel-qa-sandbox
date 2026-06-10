import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildCodexLeadRuntime,
	buildThreadParams,
	dryRunReport,
	parseCodexLeadRuntimeConfig,
	readBaseInstructions,
	readThreadId,
	writeThreadId,
} from "../codex-lead-runtime.js";

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

	it("buildCodexLeadRuntime FAIL-CLOSES a write-capable sandbox (no founder action path yet)", () => {
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
