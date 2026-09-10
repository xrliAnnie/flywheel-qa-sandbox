import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPTS = join(__dirname, "..", "..", "scripts");
const LAUNCHER = join(SCRIPTS, "codex-lead.sh");

describe("codex-lead registry launcher authority", () => {
	let home: string;
	let shimDir: string;
	let dumpFile: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "fly1981-codex-lead-home-"));
		shimDir = mkdtempSync(join(tmpdir(), "fly1981-codex-lead-shim-"));
		dumpFile = join(home, "launcher-env.json");
		mkdirSync(join(home, ".flywheel"), { recursive: true });
		const nodeShim = join(shimDir, "node");
		writeFileSync(
			nodeShim,
			`#!/bin/sh
case " $* " in
  *" lead-identity resolve "*)
    printf '%s\n' "$CANONICAL_JSON"
    exit 0
    ;;
  *"core-room-gate-cli.js"*)
	if [ "$*" != "$EXPECTED_CORE_GATE_CLI --lead-id $EXPECTED_LEAD_ID --project $EXPECTED_PROJECT" ]; then
		exit 97
	fi
	if [ "$CORE_GATE_RESULT" = "fail" ]; then
		exit 98
	fi
    printf '{"gateNonCoS":%s}\n' "$CORE_GATE_RESULT"
    exit 0
    ;;
esac
printf '{"core":"%s","ignored":"%s"}' \
  "\${FLYWHEEL_LEAD_CORE_MENTION_GATED-unset}" \
  "\${FLYWHEEL_LEAD_IGNORED_AUTHOR_IDS-unset}" > "$DUMP_FILE"
exit 0
`,
		);
		chmodSync(nodeShim, 0o755);
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(shimDir, { recursive: true, force: true });
	});

	function launch(
		inherited: string,
		computed: boolean | "fail",
		voiceBotUserId?: string,
		inheritedIgnored = "stale-bot",
	): { core: string; ignored: string } {
		writeFileSync(
			join(home, ".flywheel", "projects.json"),
			JSON.stringify([
				{
					projectName: "growth",
					...(voiceBotUserId
						? { huddle: { orchestratorBotUserId: voiceBotUserId } }
						: {}),
				},
			]),
		);
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
		execFileSync("bash", [LAUNCHER, "growth-lead", home, "growth"], {
			env: {
				...env,
				HOME: home,
				PATH: `${shimDir}:${process.env.PATH}`,
				DUMP_FILE: dumpFile,
				CORE_GATE_RESULT: String(computed),
				EXPECTED_CORE_GATE_CLI: `${SCRIPTS}/../dist/core-room-gate-cli.js`,
				EXPECTED_LEAD_ID: "growth-lead",
				EXPECTED_PROJECT: "growth",
				FLYWHEEL_COMM_CLI: join(
					SCRIPTS,
					"..",
					"..",
					"flywheel-comm",
					"dist",
					"index.js",
				),
				FLYWHEEL_LEAD_CORE_CHANNEL_ID: "core-room",
				FLYWHEEL_LEAD_CORE_MENTION_GATED: inherited,
				FLYWHEEL_LEAD_IGNORED_AUTHOR_IDS: inheritedIgnored,
				GROWTH_BOT_TOKEN: "token",
				CANONICAL_JSON: JSON.stringify({
					schemaVersion: 1,
					leadId: "growth-lead",
					projectName: "growth",
					leadKey: "growth-growth-lead",
					agentTeamName: "growth-lead",
					botUserId: "1499895683287748679",
					botTokenEnv: "GROWTH_BOT_TOKEN",
					discordStateDir: join(home, "discord-growth"),
					backend: "codex-app-server",
					role: "dept",
					summaryRole: "producer",
					summaryGranularity: "per-lead",
					hasSummaryDuty: true,
					summaryAssignmentDigest: "c".repeat(64),
					projectsDigest: "b".repeat(64),
					identityDigest: "a".repeat(64),
				}),
			},
			stdio: "pipe",
		});
		return JSON.parse(readFileSync(dumpFile, "utf8"));
	}

	it("an inherited 1 cannot survive when projects.json computes the gate off", () => {
		expect(launch("1", false).core).toBe("unset");
	});

	it("an inherited 0 cannot suppress a projects.json computation of gate on", () => {
		expect(launch("0", true).core).toBe("1");
	});

	it("a resolver failure clears inherited state and does not abort launch", () => {
		expect(launch("1", "fail").core).toBe("unset");
	});

	it("projects the current project's voice bot id and clears inherited drift", () => {
		expect(launch("0", false, "123456789012345678").ignored).toBe(
			"123456789012345678",
		);
		expect(launch("0", false).ignored).toBe("unset");
	});
});
