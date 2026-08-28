import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLeadIdentity } from "flywheel-comm/lead-identity";

export function createLeadIdentityFixture(input: {
	root: string;
	projectName: string;
	leadId: string;
}): { identityDigest: string; env: NodeJS.ProcessEnv } {
	const projectsPath = join(input.root, "projects.json");
	mkdirSync(join(input.root, ".flywheel"), { recursive: true });
	writeFileSync(
		join(input.root, ".flywheel", "summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "test",
			setAt: "2026-08-28T00:00:00.000Z",
		}),
	);
	writeFileSync(
		projectsPath,
		JSON.stringify([
			{
				projectName: input.projectName,
				leads: [
					{
						agentId: input.leadId,
						summaryRole: "producer",
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
		homeDir: input.root,
	});
	return {
		identityDigest: identity.identityDigest,
		env: {
			HOME: input.root,
			FLYWHEEL_PROJECTS_FILE: projectsPath,
			FLYWHEEL_STATE_DIR: join(input.root, ".flywheel"),
			FLYWHEEL_LEAD_LEASE_MODE: "off",
		},
	};
}
