import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLeadIdentity } from "../../lead-identity.js";

/** Build a complete canonical Lead environment for write-boundary tests. */
export function createTestLeadIdentityEnvs(
	root: string,
	leadIds: string[],
	projectName = "test-project",
): Record<string, NodeJS.ProcessEnv> {
	const projectsPath = join(root, "lead-identity-projects.json");
	writeFileSync(
		projectsPath,
		JSON.stringify([
			{
				projectName,
				projectRoot: root,
				leads: leadIds.map((agentId) => ({
					agentId,
					discordStateDir: join(root, `discord-${agentId}`),
				})),
			},
		]),
	);
	return Object.fromEntries(
		leadIds.map((leadId) => {
			const identity = resolveLeadIdentity({
				projectsPath,
				projectName,
				leadId,
				homeDir: root,
			});
			return [
				leadId,
				{
					FLYWHEEL_LEAD_LEASE_MODE: "off",
					FLYWHEEL_PROJECTS_FILE: projectsPath,
					FLYWHEEL_PROJECT_NAME: identity.projectName,
					PROJECT_NAME: identity.projectName,
					FLYWHEEL_LEAD_ID: identity.leadId,
					LEAD_ID: identity.leadId,
					FLYWHEEL_LEAD_KEY: identity.leadKey,
					FLYWHEEL_LEAD_ROLE: identity.role,
					FLYWHEEL_LEAD_BACKEND: identity.backend,
					DISCORD_STATE_DIR: identity.discordStateDir,
					DISCORD_EXPECTED_BOT_USER_ID: identity.botUserId ?? "",
					FLYWHEEL_LEAD_IDENTITY_DIGEST: identity.identityDigest,
					FLYWHEEL_LEAD_PROJECTS_DIGEST: identity.projectsDigest,
				} satisfies NodeJS.ProcessEnv,
			];
		}),
	);
}
