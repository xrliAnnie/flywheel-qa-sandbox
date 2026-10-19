/**
 * FLY-3083: one Lead → Runner path in every text a Lead reads.
 *
 * Pins (1) no rule file still recommends `SendMessage` to a Runner — every line
 * that names it must say it is denied / forbidden / hook-blocked; (2) the Runner
 * channel contract carries the send / respond / transport_write / codex-queue
 * content; (3) claude-lead.sh no longer tells Leads to use SendMessage, loads the
 * contract on the cos + dept common path (both backends, companion / external
 * skipped), and installs the runner-msg-guard hook inside the settings.local lock.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BASE = join(__dirname, "..", "..", "lead-rules-base");
const SH_PATH = join(__dirname, "..", "..", "scripts", "claude-lead.sh");
const REPO = join(__dirname, "..", "..", "..", "..");
const RULE_FILES = [
	"runner-messaging-rules.md",
	"stuck-runner-remanage.md",
	"runner-reengage-rules.md",
	"runner-patrol-rules.md",
	"runner-channel-contract.md",
];

describe("FLY-3083 mailbox-only Lead rules", () => {
	const sh = readFileSync(SH_PATH, "utf8");

	it.each(RULE_FILES.map((f) => [f]))(
		"%s: every SendMessage line says it is denied / forbidden",
		(file) => {
			const lines = readFileSync(join(BASE, file), "utf8").split("\n");
			const offenders = lines.filter(
				(line) =>
					line.includes("SendMessage") && !/denied|拦|禁止|hook/.test(line),
			);
			expect(offenders).toEqual([]);
		},
	);

	// Code review R2: Lead-visible RUNTIME guidance (Bridge responses, MCP tool
	// descriptions / rows, hook payload hints) must not recommend SendMessage to
	// a Runner either. Remaining mentions are Runner → "team-lead" misroute
	// diagnostics, explicit "NOT SendMessage" hints, or code comments.
	it.each(
		[
			"packages/teamlead/src/bridge/runs-route.ts",
			"packages/teamlead/src/bridge/gate-poller.ts",
			"packages/teamlead/src/bridge/hook-payload.ts",
			"packages/terminal-mcp/src/index.ts",
			"packages/terminal-mcp/src/lifecycle.ts",
		].map((f) => [f]),
	)("%s: no runtime line recommends SendMessage to a Runner", (rel) => {
		const lines = readFileSync(join(REPO, rel), "utf8").split("\n");
		const offenders = lines.filter(
			(line) =>
				line.includes("SendMessage") &&
				!/NOT SendMessage|team-lead|denied|hook|^\s*(\/\/|\*)/.test(line),
		);
		expect(offenders).toEqual([]);
	});

	it("the contract states the one path, gate respond, transport_write and the Codex bypass", () => {
		const contract = readFileSync(
			join(BASE, "runner-channel-contract.md"),
			"utf8",
		);
		for (const needle of [
			"flywheel-comm send",
			"respond",
			"transport_write",
			"codex queue",
			"FLY-3083",
			"mailbox_channel_fault",
			"FLYWHEEL_LEAD_ALERT_SCRIPT",
			"--strict-delivery",
		]) {
			expect(contract).toContain(needle);
		}
		expect(contract.trimEnd().split("\n").length).toBeLessThanOrEqual(25);
	});

	it("runner-messaging-rules.md carries the channel fault table", () => {
		const msg = readFileSync(join(BASE, "runner-messaging-rules.md"), "utf8");
		expect(msg).toContain("Channel fault table");
		for (const needle of [
			"backend_commdb",
			"no_transport",
			"no_session_lead",
			"wake_error",
			"suspected_stall",
			"transport_error",
		]) {
			expect(msg).toContain(needle);
		}
	});

	it("claude-lead.sh no longer tells Leads to use SendMessage for Runner DMs", () => {
		expect(sh).not.toContain("MUST be told to use `SendMessage`");
		// the commdb guard on the mailbox-detail file stays (bundle parity).
		expect(sh).toMatch(/commdb[\s\S]{0,400}runner-messaging-rules\.md/);
	});

	it("claude-lead.sh loads the contract on the cos + dept common path, backend-independent", () => {
		const assign = sh.indexOf('BASE_RUNNER_CHANNEL_CONTRACT="');
		const cosBranch = sh.indexOf('BASE_COS_RULES="');
		const founderAuth = sh.indexOf('BASE_FOUNDER_AUTH_RULES="');
		expect(assign).toBeGreaterThan(0);
		expect(sh.slice(assign, sh.indexOf("\n", assign))).toContain(
			"/runner-channel-contract.md",
		);
		// after the role if/elif/else chain (its last branch is the cos one) and
		// right after the universal founder-only-authority block
		expect(assign).toBeGreaterThan(cosBranch);
		expect(assign).toBeGreaterThan(founderAuth);
		const guard = sh.slice(assign, sh.indexOf("\nfi\n", assign));
		expect(guard).toContain('"$IS_COMPANION_ROLE" != true');
		expect(guard).toContain('"$IS_EXTERNAL_ROLE" != true');
		expect(guard).not.toMatch(/commdb|normalize_comm_backend/);
		expect(guard).toContain(
			'CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_RUNNER_CHANNEL_CONTRACT")',
		);
	});

	it("claude-lead.sh installs the runner-msg-guard hook inside the settings.local lock", () => {
		expect(sh).toContain("scripts/hooks/install-runner-msg-guard.sh");
		const lockTake = sh.indexOf('if mkdir "$_lock_dir" 2>/dev/null; then');
		const call = sh.indexOf(
			'install_runner_msg_guard_hook "$_SETTINGS_LOCAL_JSON"',
		);
		// the release (not the stale-lock rmdir inside the spin loop) is the
		// rmdir that clears _MCP_LOCK_HELD
		const lockRelease = sh.indexOf(
			'rmdir "$_lock_dir" 2>/dev/null || true\n    _MCP_LOCK_HELD=false',
			lockTake,
		);
		expect(lockTake).toBeGreaterThan(0);
		expect(call).toBeGreaterThan(lockTake);
		expect(call).toBeLessThan(lockRelease);
		expect(sh).toContain(
			'bash "$RUNNER_MSG_GUARD_INSTALLER" --settings "$settings" --lock-held',
		);
	});
});
