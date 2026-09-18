export interface RegisteredProject {
	projectName: string;
	projectRoot: string;
	projectRepo?: string;
	linear: { team: string; project: string } | null;
}

export interface ProjectDirectory {
	projectsDigest: string;
	projects: readonly RegisteredProject[];
}
