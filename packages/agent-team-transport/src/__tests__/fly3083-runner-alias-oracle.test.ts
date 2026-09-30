/**
 * FLY-3083 — runner alias oracle for scripts/hooks/flywheel-runner-msg-guard.py.
 *
 * The hook decides by the FINAL inbox file a native `SendMessage` would write,
 * mirroring stock `sanitizePathComponent` in Python. This test does not trust
 * that mirror: the judge is this package's `getClaudeInboxPath` (the stock
 * mirror the transport itself writes through), compared case-insensitively
 * because the deployment disk (APFS) is case-insensitive.
 *
 * D group — native direct recipients (no edge whitespace, no ` [ref]` suffix,
 * not `*`): for every name, `sameInbox ⇔ deny`, and a deny's replacement
 * command targets the canonical `runner-42afa86c`.
 * P group — policy exceptions asserted one by one, outside the equivalence:
 * edge whitespace / ref suffix (conservative deny), broadcast `*` (template
 * only), the env switch and a non-Lead session (allow).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClaudeInboxPath } from "../path-helpers.js";

const HOOK = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../scripts/hooks/flywheel-runner-msg-guard.py",
);
const TEAM = "flywheel-eng-lead";
const STANDARD = "runner-42afa86c";

interface HookOutcome {
	decision: "deny" | "allow";
	reason: string;
	to?: string;
}

let tmp: string;
let cfgDir: string;
let inboxDir: string;
const origCfg = process.env.CLAUDE_CONFIG_DIR;

function runHook(
	to: string,
	env: Record<string, string | undefined> = {},
): HookOutcome {
	const childEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined && !k.startsWith("FLYWHEEL_")) childEnv[k] = v;
	}
	Object.assign(childEnv, {
		CLAUDE_CONFIG_DIR: cfgDir,
		FLYWHEEL_LEAD_ID: TEAM,
		FLYWHEEL_RUNNER_MSG_GUARD_LOG: join(tmp, "guard.log"),
	});
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete childEnv[k];
		else childEnv[k] = v;
	}
	const p = spawnSync("python3", [HOOK], {
		input: JSON.stringify({
			tool_name: "SendMessage",
			tool_input: { to, message: "oracle probe body" },
		}),
		encoding: "utf-8",
		env: childEnv,
		timeout: 30_000,
	});
	expect(p.status).toBe(0);
	if (p.stdout.trim() === "") return { decision: "allow", reason: "" };
	const out = JSON.parse(p.stdout).hookSpecificOutput;
	expect(out.permissionDecision).toBe("deny");
	const reason: string = out.permissionDecisionReason;
	const match = /--to (\S+) /.exec(reason);
	return { decision: "deny", reason, to: match?.[1] };
}

function sameInbox(name: string): boolean {
	return (
		getClaudeInboxPath(TEAM, name).toLowerCase() ===
		getClaudeInboxPath(TEAM, STANDARD).toLowerCase()
	);
}

const caseVariants = (name: string): string[] => [
	name,
	name.toUpperCase(),
	name.charAt(0).toUpperCase() + name.slice(1),
];

function directRecipients(): string[] {
	const names = new Set<string>([
		STANDARD,
		// same-inbox aliases
		"runner/42afa86c",
		"runner.42afa86c",
		"runner 42afa86c",
		"runner:42afa86c",
		"runner‐42afa86c",
		"Runner-42AFA86C",
		"RUNNER-42afa86c",
		// distinct inboxes
		"runner-42afa86c-extra",
		"runner.42afa86c.extra",
		"runner--42afa86c",
		"team-lead",
		"main",
		"flywheel-eng-lead",
	]);
	const separators: string[] = [];
	for (let code = 0x20; code <= 0x7e; code++) {
		const c = String.fromCharCode(code);
		if (!/[A-Za-z0-9_-]/.test(c)) separators.push(c);
	}
	// BMP Unicode separators: hyphen, en dash, ideographic space.
	separators.push("‐", "–", "　");
	// Non-BMP: each is a surrogate pair → two `-` in the native file name.
	separators.push("\u{1F600}", "\u{10000}");
	for (const sep of separators) {
		for (const variant of caseVariants(STANDARD.replace("-", sep))) {
			names.add(variant);
		}
	}
	return [...names];
}

const NON_BMP = ["runner\u{1F600}42afa86c", "runner\u{10000}42afa86c"];

describe("FLY-3083 runner alias oracle (hook vs getClaudeInboxPath)", () => {
	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "fly3083-oracle-"));
		cfgDir = join(tmp, "claude-config");
		process.env.CLAUDE_CONFIG_DIR = cfgDir;
		inboxDir = dirname(getClaudeInboxPath(TEAM, STANDARD));
		mkdirSync(inboxDir, { recursive: true });
	});
	afterAll(() => {
		if (origCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = origCfg;
		rmSync(tmp, { recursive: true, force: true });
	});

	const D = directRecipients();

	it("generates a non-trivial D corpus", () => {
		// 31 ASCII + 3 BMP + 2 non-BMP separators × 3 case variants, plus fixed names.
		expect(D.length).toBeGreaterThanOrEqual(110);
	});

	it.each(D.map((name) => [name]))("D %j: sameInbox ⇔ deny", (name) => {
		const outcome = runHook(name);
		const expected = sameInbox(name);
		expect(outcome.decision === "deny").toBe(expected);
		if (expected) {
			expect(outcome.to).toBe(STANDARD);
		} else {
			expect(outcome.reason).toBe("");
		}
	});

	it.each(NON_BMP.map((name) => [name]))(
		"non-BMP %j lands in runner--42afa86c.json natively and is allowed",
		(name) => {
			expect(basename(getClaudeInboxPath(TEAM, name))).toBe(
				"runner--42afa86c.json",
			);
			expect(runHook(name).decision).toBe("allow");
		},
	);

	it.each([
		[" runner-42afa86c "],
		["runner-42afa86c [3fa9c1]"],
		["runner/42afa86c [3fa9c1]"],
	])("P %j: conservative deny with canonical --to", (name) => {
		const outcome = runHook(name);
		expect(outcome.decision).toBe("deny");
		expect(outcome.to).toBe(STANDARD);
	});

	it("P broadcast: deny with a per-Runner template, never a concrete target", () => {
		const outcome = runHook("*");
		expect(outcome.decision).toBe("deny");
		expect(outcome.reason).toContain("<runner-");
		expect(outcome.reason).not.toMatch(/runner-[0-9a-f]{8}/);
	});

	it.each([
		["switch off", { FLYWHEEL_RUNNER_MSG_GUARD: "0" }],
		["non-Lead session", { FLYWHEEL_LEAD_ID: undefined }],
	] as const)("P %s: standard name and broadcast pass", (_label, env) => {
		expect(runHook(STANDARD, env).decision).toBe("allow");
		expect(runHook("*", env).decision).toBe("allow");
	});

	it("leaves the inbox directory untouched", () => {
		expect(readdirSync(inboxDir)).toEqual([]);
	});
});
