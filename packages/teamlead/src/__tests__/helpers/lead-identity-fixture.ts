import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLeadIdentity } from "flywheel-comm/lead-identity";

export function createLeadIdentityFixture(input: {
	root: string;
	projectName: string;
	leadId: string;
}): { identityDigest: string; env: NodeJS.ProcessEnv } {
	const projectsPath = join(input.root, "projects.json");
	writeFileSync(
		projectsPath,
		JSON.stringify([
			{
				projectName: input.projectName,
				leads: [
					{
						agentId: input.leadId,
						discordStateDir: join(input.root, `discord-${input.leadId}`),
					},
				],
			},
		]),
	);
	const identity = resolveLeadIdentity({
		projectsPath,
		projectName: input.projectName,
		leadId: input.leadId,
	});
	return {
		identityDigest: identity.identityDigest,
		env: {
			FLYWHEEL_PROJECTS_FILE: projectsPath,
			FLYWHEEL_LEAD_LEASE_MODE: "off",
		},
	};
}
