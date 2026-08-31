/**
 * FLY-350 deploy artifacts (founder-gated; committed but NOT deployed by the
 * runner):
 *  - verify-merge-actor-denied.sh — the M-2 merge red-line acceptance gate, proven
 *    against a `gh` shim (PASS for a non-admin actor on a protected branch; FAIL on
 *    admin / no-protection / unresolved actor).
 *  - run-codex-lead-mufasa-fullaccess.sh — the full-access cutover launcher, proven
 *    (node-shim) to set the full-access profile/sandbox/project-root AND assemble
 *    the founder-only-authority governance bundle.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEAMLEAD_ROOT = join(__dirname, "..", "..");
const SCRIPTS = join(TEAMLEAD_ROOT, "scripts");
const MERGE_GATE = join(SCRIPTS, "verify-merge-actor-denied.sh");
const LAUNCHER = join(SCRIPTS, "run-codex-lead-mufasa-fullaccess.sh");

function withoutAmbientLeadIdentity(
	overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of [
		"FLYWHEEL_LEAD_ID",
		"LEAD_ID",
		"FLYWHEEL_PROJECT_NAME",
		"PROJECT_NAME",
		"FLYWHEEL_LEAD_KEY",
		"FLYWHEEL_LEAD_BACKEND",
		"FLYWHEEL_LEAD_ROLE",
		"FLYWHEEL_LEAD_SUMMARY_ROLE",
		"FLYWHEEL_LEAD_HAS_SUMMARY_DUTY",
		"FLYWHEEL_SUMMARY_GRANULARITY",
		"FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST",
		"DISCORD_STATE_DIR",
		"DISCORD_EXPECTED_BOT_USER_ID",
		"FLYWHEEL_LEAD_IDENTITY_DIGEST",
		"FLYWHEEL_CANONICAL_IDENTITY_RESOLVED",
	]) {
		delete env[name];
	}
	return { ...env, ...overrides };
}

/** Run a script; return {status, stdout, stderr} without throwing on non-zero. */
function run(
	bin: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync(bin, args, {
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, stdout, stderr: "" };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			status: err.status ?? 1,
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
		};
	}
}

describe("verify-merge-actor-denied.sh (M-2 merge red line)", () => {
	let shimDir: string;
	beforeEach(() => {
		shimDir = mkdtempSync(join(tmpdir(), "fly350-gh-"));
	});
	afterEach(() => {
		rmSync(shimDir, { recursive: true, force: true });
	});

	/** Write a `gh` shim driven by SHIM_* env: user login, the RAW branch-protection
	 * JSON (the script fetches it once + jq-parses locally), and the actor's
	 * permission. SHIM_PROTECTION_JSON empty → the protection endpoint 404s (exit 1),
	 * modelling an unprotected branch; SHIM_PERM empty → permission unresolved. */
	function ghShim(): string {
		const gh = join(shimDir, "gh");
		writeFileSync(
			gh,
			[
				"#!/bin/sh",
				"# args: api <path> [-q <filter>]",
				'case "$2" in',
				'  user) printf "%s" "$SHIM_ACTOR" ;;',
				'  */protection) [ -n "$SHIM_PROTECTION_JSON" ] && printf "%s" "$SHIM_PROTECTION_JSON" || exit 1 ;;',
				'  */permission) [ -n "$SHIM_PERM" ] && printf "%s" "$SHIM_PERM" || exit 1 ;;',
				"  *) exit 1 ;;",
				"esac",
				"",
			].join("\n"),
		);
		chmodSync(gh, 0o755);
		return gh;
	}

	/** Build a branch-protection JSON blob (the shape the script jq-parses). */
	function protJson(
		reviews: number,
		opts: {
			bypassUsers?: string[];
			bypassTeams?: number;
			bypassApps?: number;
		} = {},
	): string {
		return JSON.stringify({
			required_pull_request_reviews: {
				required_approving_review_count: reviews,
				bypass_pull_request_allowances: {
					users: (opts.bypassUsers ?? []).map((login) => ({ login })),
					teams: Array.from({ length: opts.bypassTeams ?? 0 }, (_, i) => ({
						slug: `team-${i}`,
					})),
					apps: Array.from({ length: opts.bypassApps ?? 0 }, (_, i) => ({
						slug: `app-${i}`,
					})),
				},
			},
		});
	}

	function baseEnv(over: Record<string, string>): NodeJS.ProcessEnv {
		return {
			...process.env,
			GH_BIN: ghShim(),
			FLY350_MERGE_GATE_REPOS: "xrliAnnie/growth",
			...over,
		};
	}

	it("PASS — non-admin actor + protection REQUIRES a review + NO bypass (founder gate proven)", () => {
		const { status, stdout } = run(
			"bash",
			[MERGE_GATE],
			baseEnv({
				SHIM_ACTOR: "mufasa-bot",
				SHIM_PROTECTION_JSON: protJson(1),
				SHIM_PERM: "write",
			}),
		);
		expect(status).toBe(0);
		expect(stdout).toContain("MERGE RED LINE: PASS");
		expect(stdout).toContain("mufasa-bot");
		expect(stdout).toMatch(/requires 1 approving review/);
	});

	it("FAIL — actor has ADMIN (can bypass protection)", () => {
		const { status, stderr } = run(
			"bash",
			[MERGE_GATE],
			baseEnv({
				SHIM_ACTOR: "mufasa-bot",
				SHIM_PROTECTION_JSON: protJson(1),
				SHIM_PERM: "admin",
			}),
		);
		expect(status).toBe(1);
		expect(stderr).toContain("ADMIN");
		expect(stderr).toContain("MERGE RED LINE: FAIL");
	});

	// Codex review HIGH: a 'write' actor on a branch whose protection does NOT
	// require a review COULD merge after CI — must FAIL (no merge-denial proof).
	it("FAIL — protection does NOT require an approving review (write could self-merge)", () => {
		const { status, stderr } = run(
			"bash",
			[MERGE_GATE],
			baseEnv({
				SHIM_ACTOR: "mufasa-bot",
				SHIM_PROTECTION_JSON: protJson(0),
				SHIM_PERM: "write",
			}),
		);
		expect(status).toBe(1);
		expect(stderr).toMatch(/does NOT require an approving review/);
	});

	it("FAIL — branch has NO protection at all (404)", () => {
		const { status, stderr } = run(
			"bash",
			[MERGE_GATE],
			baseEnv({
				SHIM_ACTOR: "mufasa-bot",
				SHIM_PROTECTION_JSON: "",
				SHIM_PERM: "write",
			}),
		);
		expect(status).toBe(1);
		expect(stderr).toMatch(/NO branch protection/);
	});

	// Codex re-review HIGH: required reviews alone is NOT proof — a non-admin actor on
	// the PR-bypass allowances list can merge WITHOUT a review → must FAIL.
	it("FAIL — actor is on the PR-bypass allowances list (can skip review)", () => {
		const { status, stderr } = run(
			"bash",
			[MERGE_GATE],
			baseEnv({
				SHIM_ACTOR: "mufasa-bot",
				SHIM_PROTECTION_JSON: protJson(1, { bypassUsers: ["mufasa-bot"] }),
				SHIM_PERM: "write",
			}),
		);
		expect(status).toBe(1);
		expect(stderr).toMatch(/PR-bypass allowances list/);
	});

	it("FAIL (fail-closed) — team/app PR-bypass configured (actor coverage unprovable)", () => {
		const { status, stderr } = run(
			"bash",
			[MERGE_GATE],
			baseEnv({
				SHIM_ACTOR: "mufasa-bot",
				SHIM_PROTECTION_JSON: protJson(1, { bypassTeams: 1 }),
				SHIM_PERM: "write",
			}),
		);
		expect(status).toBe(1);
		expect(stderr).toMatch(/team\/app PR-bypass/);
	});

	// Codex re-review MED: an UNRECOGNIZED permission value must fail-closed.
	it("FAIL (fail-closed) — unrecognized permission value", () => {
		const { status, stderr } = run(
			"bash",
			[MERGE_GATE],
			baseEnv({
				SHIM_ACTOR: "mufasa-bot",
				SHIM_PROTECTION_JSON: protJson(1),
				SHIM_PERM: "superadmin",
			}),
		);
		expect(status).toBe(1);
		expect(stderr).toMatch(/did not resolve to a recognized level/);
	});

	// Codex review HIGH: an UNRESOLVED permission must fail-closed.
	it("FAIL (fail-closed) — actor permission cannot be resolved", () => {
		const { status, stderr } = run(
			"bash",
			[MERGE_GATE],
			baseEnv({
				SHIM_ACTOR: "mufasa-bot",
				SHIM_PROTECTION_JSON: protJson(1),
				SHIM_PERM: "",
			}),
		);
		expect(status).toBe(1);
		expect(stderr).toMatch(/did not resolve to a recognized level/);
	});

	it("FAIL (fail-closed) — gh actor cannot be resolved", () => {
		const { status, stderr } = run(
			"bash",
			[MERGE_GATE],
			baseEnv({
				SHIM_ACTOR: "",
				SHIM_PROTECTION_JSON: protJson(1),
				SHIM_PERM: "write",
			}),
		);
		expect(status).toBe(1);
		expect(stderr).toContain("could not resolve the gh actor");
	});
});

describe("run-codex-lead-mufasa-fullaccess.sh (full-access cutover launcher)", () => {
	let home: string;
	let shimDir: string;
	let dumpFile: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "fly350-fa-home-"));
		shimDir = mkdtempSync(join(tmpdir(), "fly350-fa-shim-"));
		dumpFile = join(home, "dump.json");
		const shim = join(shimDir, "node");
		// `exec node "$RUNTIME"` → dump the env vars the runtime would read.
		writeFileSync(
			shim,
			[
				"#!/bin/sh",
				'case " $* " in *" lead-identity resolve "*)',
				'  printf "%s\\n" "$CANONICAL_JSON"',
				"  exit 0",
				"esac",
				`cat > ${JSON.stringify(dumpFile)} <<EOF`,
				"{",
				'  "profile": "$FLYWHEEL_CODEX_LEAD_PROFILE",',
				'  "sandbox": "$FLYWHEEL_CODEX_LEAD_SANDBOX",',
				'  "projectDir": "$FLYWHEEL_CODEX_LEAD_PROJECT_DIR",',
				'  "stateDir": "$FLYWHEEL_CODEX_LEAD_STATE_DIR",',
				'  "commCli": "$FLYWHEEL_COMM_CLI",',
				'  "promptFiles": "$FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES"',
				"}",
				"EOF",
				"exit 0",
				"",
			].join("\n"),
		);
		chmodSync(shim, 0o755);
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(shimDir, { recursive: true, force: true });
	});

	it("dry-run sets full-access profile/sandbox/project-root + assembles founder governance", () => {
		const { status, stderr } = run(
			"bash",
			[LAUNCHER],
			withoutAmbientLeadIdentity({
				HOME: home,
				PATH: `${shimDir}:${process.env.PATH}`,
				FLYWHEEL_TEAMLEAD_ROOT: TEAMLEAD_ROOT, // dist/ is built in-repo
				FLYWHEEL_LEAD_DRY_RUN: "1",
				FLYWHEEL_COMM_CLI: "",
				MUFASA_BOT_TOKEN: "x",
				CANONICAL_JSON: JSON.stringify({
					schemaVersion: 1,
					leadId: "mufasa-lead",
					projectName: "growth",
					leadKey: "growth-mufasa-lead",
					agentTeamName: "mufasa-lead",
					botUserId: "1499895683287748679",
					botTokenEnv: "MUFASA_BOT_TOKEN",
					discordStateDir: join(home, "discord-mufasa"),
					backend: "codex-app-server",
					role: "dept",
					summaryRole: "producer",
					summaryGranularity: "per-lead",
					hasSummaryDuty: true,
					summaryAssignmentDigest: "c".repeat(64),
					projectsDigest: "b".repeat(64),
					identityDigest: "a".repeat(64),
				}),
				FLYWHEEL_CODEX_LEAD_PROJECT_DIR: home, // a real dir (skips the non-dry checks anyway)
			}),
		);
		expect(status, stderr).toBe(0);
		const dumped = JSON.parse(
			execFileSync("cat", [dumpFile], { encoding: "utf8" }),
		) as Record<string, string>;
		expect(dumped.profile).toBe("full-access");
		expect(dumped.sandbox).toBe("workspace-write");
		expect(dumped.projectDir).toBe(home);
		// memory continuity: the pinned per-Lead state dir (thread 019eaf5d resumes).
		expect(dumped.stateDir).toContain("state/codex-lead/mufasa-lead");
		expect(dumped.commCli).toContain("flywheel-comm/dist/index.js");
		// persona first, founder-only-authority governance appended after.
		expect(dumped.promptFiles).toContain("identity.md");
		expect(dumped.promptFiles).toContain("founder-only-authority.md");
		expect(dumped.promptFiles).toContain("cross-dept-channel-rules.md");
	});
});
