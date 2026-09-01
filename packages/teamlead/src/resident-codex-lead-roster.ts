import type { ProjectEntry } from "./ProjectConfig.js";

export interface ResidentCodexLeadTarget {
	projectName: string;
	projectRoot: string;
	leadId: string;
	leadKey: string;
}

export function findResidentCodexLeadTargets(
	projects: ReadonlyArray<ProjectEntry>,
): ResidentCodexLeadTarget[] {
	return projects.flatMap((project) =>
		project.leads.flatMap((lead) => {
			const recognizedTier =
				lead.companion === true || lead.codexProfile !== undefined;
			if (
				lead.codexResidencyPatrol !== true ||
				lead.backend !== "codex-app-server" ||
				lead.canSpawnRunners !== false ||
				!recognizedTier
			) {
				return [];
			}
			return [
				{
					projectName: project.projectName,
					projectRoot: project.projectRoot,
					leadId: lead.agentId,
					leadKey: `${project.projectName}-${lead.agentId}`,
				},
			];
		}),
	);
}
