import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ProjectEntry {
	projectName: string;
	projectRoot: string;
	projectRepo?: string;
}

export function loadProjects(): ProjectEntry[] {
	// Source 1: FLYWHEEL_PROJECTS env var (JSON array)
	const envProjects = process.env.FLYWHEEL_PROJECTS;
	if (envProjects) {
		return JSON.parse(envProjects) as ProjectEntry[];
	}

	// Source 2: ~/.flywheel/projects.json
	const filePath = join(homedir(), ".flywheel", "projects.json");
	try {
		const data = readFileSync(filePath, "utf-8");
		return JSON.parse(data) as ProjectEntry[];
	} catch {
		return [];
	}
}

export function getProjectRoot(projects: ProjectEntry[], projectName: string): string | undefined {
	return projects.find((p) => p.projectName === projectName)?.projectRoot;
}
