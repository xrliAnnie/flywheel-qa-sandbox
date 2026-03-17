import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProjectEntry {
	projectName: string;
	projectRoot: string;
	projectRepo?: string;
}

export function loadProjects(): ProjectEntry[] {
	let raw: unknown;

	// Source 1: FLYWHEEL_PROJECTS env var (JSON array)
	const envProjects = process.env.FLYWHEEL_PROJECTS;
	if (envProjects) {
		raw = JSON.parse(envProjects);
	} else {
		// Source 2: ~/.flywheel/projects.json
		const filePath = join(homedir(), ".flywheel", "projects.json");
		try {
			const data = readFileSync(filePath, "utf-8");
			raw = JSON.parse(data);
		} catch {
			return [];
		}
	}

	if (!Array.isArray(raw)) {
		throw new Error("FLYWHEEL_PROJECTS must be a JSON array");
	}

	for (const entry of raw) {
		if (
			typeof entry?.projectName !== "string" ||
			typeof entry?.projectRoot !== "string"
		) {
			throw new Error(
				`Invalid project entry: each must have string "projectName" and "projectRoot". Got: ${JSON.stringify(entry)}`,
			);
		}
	}

	return raw as ProjectEntry[];
}

export function getProjectRoot(
	projects: ProjectEntry[],
	projectName: string,
): string | undefined {
	return projects.find((p) => p.projectName === projectName)?.projectRoot;
}
