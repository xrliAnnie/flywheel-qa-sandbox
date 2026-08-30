/**
 * FLY-350 H-2: the shared role-aware Lead rule-bundle resolver.
 *
 * (1) BEHAVIORAL — executes lead-rules-bundle.sh and pins the exact ordered bundle
 *     per role + the fail-closed semantics.
 * (2) PARITY — binds the resolver to claude-lead.sh's inline assembly: every base
 *     rule file the resolver emits for a role must be referenced by claude-lead.sh,
 *     in the SAME relative order. claude-lead.sh keeps its proven inline block (every
 *     Claude Lead runs through it; refactoring is out of scope) — this test is the
 *     bind that stops claude and the Codex resolver from drifting.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPTS = join(__dirname, "..", "..", "scripts");
const RESOLVER = join(SCRIPTS, "lead-rules-bundle.sh");
const BASE_RULES_DIR = join(__dirname, "..", "..", "lead-rules-base");
const CLAUDE_SH = join(SCRIPTS, "claude-lead.sh");

/** Run the resolver; return { lines, status }. Never throws on non-zero exit. */
function runBundle(
	role: string,
	baseDir: string,
	commBackend: string,
	governanceRequired: string,
): { lines: string[]; status: number; stderr: string } {
	try {
		const out = execFileSync(
			"bash",
			[
				"-c",
				`source "${RESOLVER}"; compute_lead_rule_bundle "$1" "$2" "$3" "$4"`,
				"_",
				role,
				baseDir,
				commBackend,
				governanceRequired,
			],
			{ encoding: "utf8" },
		);
		return {
			lines: out.split("\n").filter(Boolean),
			status: 0,
			stderr: "",
		};
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			lines: (err.stdout ?? "").split("\n").filter(Boolean),
			status: err.status ?? 1,
			stderr: err.stderr ?? "",
		};
	}
}

/** The basename of each emitted absolute path. */
function names(lines: string[]): string[] {
	return lines.map((p) => p.split("/").pop() as string);
}

describe("lead-rules-bundle.sh — behavioral", () => {
	it("dept (mailbox) → full ordered bundle incl. runner-messaging + governance", () => {
		const { lines, status } = runBundle("dept", BASE_RULES_DIR, "mailbox", "1");
		expect(status).toBe(0);
		expect(names(lines)).toEqual([
			"department-lead-rules.md",
			"runner-messaging-rules.md",
			"executor-routing.md",
			"model-routing.md",
			"stuck-runner-remanage.md",
			"runner-reengage-rules.md",
			"runner-patrol-rules.md",
			"doc-flow-rules.md",
			"auto-qa-pipeline.md",
			"xiaohongshu-memory-rules.md",
			"founder-only-authority.md",
			"founder-html-delivery.md",
			"cross-dept-channel-rules.md",
		]);
	});

	it("dept (commdb) → SKIPS runner-messaging but STILL loads runner-patrol (FLY-369: patrol is backend-independent)", () => {
		const { lines } = runBundle("dept", BASE_RULES_DIR, "commdb", "1");
		expect(names(lines)).not.toContain("runner-messaging-rules.md");
		// FLY-369: RC-1 relay / RC-3 patrol / RC-6 handoff are backend-independent,
		// so patrol loads on the commdb rollback path too (its RC-2 section is
		// self-contained for commdb — it does NOT rely on runner-messaging-rules.md).
		expect(names(lines)).toContain("runner-patrol-rules.md");
		expect(names(lines)[0]).toBe("department-lead-rules.md");
		expect(names(lines)[1]).toBe("executor-routing.md");
	});

	it("cos → cos rules + universal governance (no dept/runner rules)", () => {
		const { lines, status } = runBundle("cos", BASE_RULES_DIR, "mailbox", "1");
		expect(status).toBe(0);
		expect(names(lines)).toEqual([
			"cos-lead-rules.md",
			"founder-only-authority.md",
			"founder-html-delivery.md",
			"cross-dept-channel-rules.md",
		]);
	});

	it("companion → safety contract + cross-dept ONLY (skips founder-auth + html)", () => {
		const { lines, status } = runBundle(
			"companion",
			BASE_RULES_DIR,
			"mailbox",
			"0",
		);
		expect(status).toBe(0);
		expect(names(lines)).toEqual([
			"companion-safety-contract.md",
			"cross-dept-channel-rules.md",
		]);
		expect(names(lines)).not.toContain("founder-only-authority.md");
	});

	it("unknown role → rc 2, no output", () => {
		const { status, lines, stderr } = runBundle(
			"bogus",
			BASE_RULES_DIR,
			"mailbox",
			"0",
		);
		expect(status).toBe(2);
		expect(lines).toEqual([]);
		expect(stderr).toContain("UNKNOWN_ROLE:bogus");
	});

	describe("fail-closed (required files)", () => {
		let emptyBase: string;
		beforeEach(() => {
			emptyBase = mkdtempSync(join(tmpdir(), "fly350-emptybase-"));
		});
		afterEach(() => {
			rmSync(emptyBase, { recursive: true, force: true });
		});

		it("governance_required=1 + missing founder-only-authority → rc 10 (Codex full-access fail-closed)", () => {
			// dept needs founder-only-authority; an empty base has none.
			const { status, stderr } = runBundle("dept", emptyBase, "mailbox", "1");
			expect(status).toBe(10);
			expect(stderr).toContain("MISSING_REQUIRED:");
			expect(stderr).toContain("founder-only-authority.md");
		});

		it("governance_required=0 + missing founder-only-authority → rc 0 (Claude backward-compat, optional)", () => {
			// Provide ONLY founder-html + cross-dept so the dept path reaches the
			// optional founder-auth and skips it without failing.
			writeFileSync(join(emptyBase, "founder-html-delivery.md"), "x");
			writeFileSync(join(emptyBase, "cross-dept-channel-rules.md"), "x");
			const { status, lines } = runBundle("dept", emptyBase, "mailbox", "0");
			expect(status).toBe(0);
			expect(names(lines)).not.toContain("founder-only-authority.md");
		});

		it("companion + missing safety contract → rc 10 (its only boundary, fail-STOP)", () => {
			const { status, stderr } = runBundle(
				"companion",
				emptyBase,
				"mailbox",
				"0",
			);
			expect(status).toBe(10);
			expect(stderr).toContain("companion-safety-contract.md");
		});
	});
});

describe("lead-rules-bundle.sh — PARITY with claude-lead.sh (anti-drift bind)", () => {
	const claudeSh = execFileSync("cat", [CLAUDE_SH], { encoding: "utf8" });

	it("every base rule file the resolver emits is referenced by claude-lead.sh", () => {
		const roles: Array<[string, string]> = [
			["dept", "mailbox"],
			["cos", "mailbox"],
			["companion", "mailbox"],
		];
		for (const [role, backend] of roles) {
			const { lines } = runBundle(role, BASE_RULES_DIR, backend, "0");
			for (const file of names(lines)) {
				expect(
					claudeSh.includes(file),
					`claude-lead.sh must also reference ${file} (role=${role}) — resolver/claude drift`,
				).toBe(true);
			}
		}
	});

	it("dept bundle order matches claude-lead.sh's append order (path-assignment monotonic)", () => {
		const { lines } = runBundle("dept", BASE_RULES_DIR, "mailbox", "0");
		// Anchor on the PATH assignment (`…/<file>"`), not the bare filename — the
		// latter also appears in claude-lead.sh's file-list COMMENT block, which
		// would scramble the order. The `/<file>"` form only appears at the real
		// `BASE_…="${BASE_RULES_DIR}/<file>"` assignment that drives the append.
		const indices = names(lines).map((f) => claudeSh.indexOf(`/${f}"`));
		expect(
			indices.every((i) => i > 0),
			`every dept rule file must have a path assignment in claude-lead.sh (got ${JSON.stringify(
				names(lines).map((f, i) => [f, indices[i]]),
			)})`,
		).toBe(true);
		const sorted = [...indices].sort((a, b) => a - b);
		expect(indices).toEqual(sorted);
	});

	it("claude-lead.sh still gates runner-messaging on the commdb backend (guard parity)", () => {
		// the resolver mirrors this; if claude drops the guard, this catches it.
		expect(claudeSh).toMatch(/commdb[\s\S]{0,400}runner-messaging-rules\.md/);
	});
});

describe("FLY-127 Runner-start identity rules", () => {
	const departmentRules = execFileSync(
		"cat",
		[join(BASE_RULES_DIR, "department-lead-rules.md")],
		{ encoding: "utf8" },
	);
	const docFlowRules = execFileSync(
		"cat",
		[join(BASE_RULES_DIR, "doc-flow-rules.md")],
		{ encoding: "utf8" },
	);

	it("requires every Runner start to carry the current Lead's own non-empty identity", () => {
		expect(departmentRules).toMatch(
			/every `POST \/api\/runs\/start`[\s\S]{0,300}own non-empty `leadId`/,
		);
		expect(departmentRules).toContain('"leadId": "<your-agentId>"');
	});

	it("forbids substituting a canonical or other Lead identity", () => {
		expect(departmentRules).toMatch(
			/never substitute `canonicalLeadId`[\s\S]{0,200}another Lead/,
		);
		expect(departmentRules).toContain("lead_identity_required");
	});

	it("keeps Lead identity in the doc-flow Runner-start example", () => {
		expect(docFlowRules).toContain('"leadId": "<your-agentId>"');
	});
});

describe("codex-lead.sh — full-access governance wiring (H-2)", () => {
	const codexSh = execFileSync("cat", [join(SCRIPTS, "codex-lead.sh")], {
		encoding: "utf8",
	});

	it("sources the shared resolver + gates assembly on the full-access profile", () => {
		expect(codexSh).toContain("lead-rules-bundle.sh");
		expect(codexSh).toContain("assemble_full_access_governance");
		expect(codexSh).toMatch(/FLYWHEEL_CODEX_LEAD_PROFILE.*=.*"?full-access/);
	});

	it("fail-closes (aborts boot) when the shared assembler reports a missing required file", () => {
		expect(codexSh).toMatch(/Refusing to start a full-access Codex Lead/);
		// the assembler itself calls the resolver with governance_required=1.
		const bundleSh = execFileSync(
			"cat",
			[join(SCRIPTS, "lead-rules-bundle.sh")],
			{ encoding: "utf8" },
		);
		expect(bundleSh).toMatch(/compute_lead_rule_bundle[^\n]*"\$comm" 1/);
	});

	// BEHAVIORAL: run codex-lead.sh with the full-access profile and a `node` shim
	// that dumps FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES — proves the governance bundle is
	// actually assembled into the env the runtime reads.
	describe("behavioral (node-shim)", () => {
		let home: string;
		let shimDir: string;
		let dumpFile: string;
		beforeEach(() => {
			home = mkdtempSync(join(tmpdir(), "fly350-cxhome-"));
			shimDir = mkdtempSync(join(tmpdir(), "fly350-shim-"));
			dumpFile = join(home, "dump.txt");
			// `exec node "$RUNTIME_DIST"` → our shim dumps the env var + exits 0.
			const shim = join(shimDir, "node");
			writeFileSync(
				shim,
				`#!/bin/sh\nprintf '%s' "$FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES" > "${dumpFile}"\nexit 0\n`,
			);
			execFileSync("chmod", ["+x", shim]);
		});
		afterEach(() => {
			rmSync(home, { recursive: true, force: true });
			rmSync(shimDir, { recursive: true, force: true });
		});

		it("full-access run assembles founder-only-authority into the prompt files", () => {
			execFileSync(
				"bash",
				[join(SCRIPTS, "codex-lead.sh"), "growth-lead", home, "growth"],
				{
					encoding: "utf8",
					env: {
						...process.env,
						HOME: home,
						PATH: `${shimDir}:${process.env.PATH}`,
						FLYWHEEL_CODEX_LEAD_PROFILE: "full-access",
						// a pre-existing persona file must be PRESERVED, governance appended after
						FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES: "/persona/identity.md",
					},
				},
			);
			const dumped = execFileSync("cat", [dumpFile], { encoding: "utf8" });
			// persona stays first; governance bundle appended after
			expect(dumped.startsWith("/persona/identity.md,")).toBe(true);
			expect(dumped).toContain("founder-only-authority.md");
			expect(dumped).toContain("department-lead-rules.md");
			expect(dumped).toContain("cross-dept-channel-rules.md");
		});

		it("a NON-full-access run leaves the prompt files untouched (byte-compat)", () => {
			execFileSync(
				"bash",
				[join(SCRIPTS, "codex-lead.sh"), "growth-lead", home, "growth"],
				{
					encoding: "utf8",
					env: {
						...process.env,
						HOME: home,
						PATH: `${shimDir}:${process.env.PATH}`,
						FLYWHEEL_CODEX_LEAD_PROFILE: "companion",
						FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES: "/persona/identity.md",
					},
				},
			);
			const dumped = execFileSync("cat", [dumpFile], { encoding: "utf8" });
			expect(dumped).toBe("/persona/identity.md");
		});
	});
});
