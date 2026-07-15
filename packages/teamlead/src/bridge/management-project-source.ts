import type { ProjectEntry } from "../ProjectConfig.js";
import { fileSourceRevision } from "./management-console-contract.js";
import type { ManagementSnapshotProvider } from "./management-console-snapshot.js";

export interface ManagementProjectSourceOptions {
	path: string;
	readFile(path: string): string;
	parse(value: unknown): ProjectEntry[];
	warm(projects: ProjectEntry[]): Promise<void>;
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function isEnoent(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		(value as { code?: unknown }).code === "ENOENT"
	);
}

/**
 * Last-good cache for the console's projects.json authority. A transient read,
 * parse, or dependent-config warm failure becomes source-health evidence; it
 * never replaces validated state or turns the entire dashboard into a 500.
 */
export class ManagementProjectSource {
	private currentProjects: ProjectEntry[] = [];
	private currentRevision = "file:unavailable";
	private currentError: Error | null = null;

	constructor(private readonly options: ManagementProjectSourceOptions) {}

	projects(): ProjectEntry[] {
		return this.currentProjects;
	}

	revision(): string {
		return this.currentRevision;
	}

	error(): Error | null {
		return this.currentError;
	}

	private async readAndWarm(): Promise<void> {
		const bytes = this.options.readFile(this.options.path);
		const projects = this.options.parse(JSON.parse(bytes));
		await this.options.warm(projects);
		this.currentProjects = projects;
		this.currentRevision = fileSourceRevision(Buffer.from(bytes));
		this.currentError = null;
	}

	async initialize(): Promise<boolean> {
		try {
			await this.readAndWarm();
			return true;
		} catch (error) {
			if (isEnoent(error)) {
				try {
					await this.options.warm([]);
				} catch (warmError) {
					this.currentError = asError(warmError);
					return false;
				}
				this.currentProjects = [];
				this.currentRevision = "file:missing";
				this.currentError = null;
				return false;
			}
			this.currentError = asError(error);
			return false;
		}
	}

	async refresh(): Promise<boolean> {
		try {
			await this.readAndWarm();
			return true;
		} catch (error) {
			this.currentError = asError(error);
			return false;
		}
	}

	healthProvider(): ManagementSnapshotProvider {
		return {
			id: "projects-json-health",
			sourceKind: "projects_json",
			read: () => {
				if (this.currentError) throw this.currentError;
				return {
					revision: this.currentRevision,
					hint: "~/.flywheel/projects.json",
					fragment: {},
				};
			},
		};
	}
}
