import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	identityEnvProjection,
	resolveLeadIdentity,
} from "flywheel-comm/lead-identity";
export function runnerActionEnv(
	home: string,
	projectRoot: string,
): NodeJS.ProcessEnv {
	mkdirSync(join(home, ".flywheel"), { recursive: true });
	writeFileSync(
		join(home, ".flywheel", "summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "test",
			setAt: "2026-09-10T00:00:00Z",
		}),
	);
	const projectsPath = join(home, "projects.json");
	writeFileSync(
		projectsPath,
		JSON.stringify([
			{
				projectName: "flywheel",
				projectRoot,
				leads: [
					{
						agentId: "flywheel-product-lead",
						summaryRole: "producer",
						chatChannel: "11111111111111111",
						match: { labels: ["Product"] },
						backend: "codex-app-server",
						codexProfile: "full-access",
						canSpawnRunners: true,
						codexRunnerActions: true,
					},
				],
			},
		]),
	);
	const identity = resolveLeadIdentity({
		projectsPath,
		projectName: "flywheel",
		leadId: "flywheel-product-lead",
		homeDir: home,
	});
	return {
		HOME: home,
		PATH: process.env.PATH,
		FLYWHEEL_PROJECTS_FILE: projectsPath,
		FLYWHEEL_CODEX_LEAD_PROFILE: "full-access",
		FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS: "1",
		FLYWHEEL_LEAD_LEASE_MODE: "off",
		FLYWHEEL_LEAD_LEASE_MODE_FILE: join(home, "mode.json"),
		FLYWHEEL_STATE_DIR: join(home, ".flywheel"),
		...Object.fromEntries(
			identityEnvProjection(identity).map((line) => {
				const i = line.indexOf("=");
				return [line.slice(0, i), line.slice(i + 1)];
			}),
		),
		FLYWHEEL_LEAD_ACTIONS_MAIN_JS: join(
			process.cwd(),
			"dist/lead-backends/codex/lead-actions/lead-actions-main.js",
		),
		FLYWHEEL_LEAD_ACTIONS_NODE_BIN: process.execPath,
		FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "11111111111111111",
		FLYWHEEL_LEAD_ACTIONS_STATE_DIR: join(home, "actions"),
		FLYWHEEL_COMM_DB: join(home, "comm.db"),
		FLYWHEEL_CODEX_LEAD_OUTBOUND: "direct",
		DISCORD_BOT_TOKEN: "TEST_DISCORD",
		TEAMLEAD_API_TOKEN: "TEST_BRIDGE",
		BRIDGE_URL: "http://localhost:9876",
	};
}
