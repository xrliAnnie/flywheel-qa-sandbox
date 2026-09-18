import { randomBytes } from "node:crypto";
import type { RegisteredProject } from "../directory.js";
import { SnapshotStore } from "./snapshot-store.js";
import type { PortfolioSnapshot, ProjectReading, Reading } from "./types.js";

interface ProjectSampler {
	sampleProject(
		project: RegisteredProject,
		signal: AbortSignal,
	): Promise<ProjectReading>;
}

export interface SampleCoordinatorOptions {
	projects: RegisteredProject[];
	sampler: ProjectSampler;
	stateDir: string;
	sampleDeadlineMs: number;
	sampleConcurrency: number;
	now?: () => Date;
	random?: () => string;
	store?: Pick<SnapshotStore, "readLatest" | "write">;
}

function unavailable<T>(reason: string): Reading<T> {
	return { ok: false, reason };
}

function unavailableProject(
	project: RegisteredProject,
	reason: "deadline" | "parse_error",
): ProjectReading {
	const reading = <T>() => unavailable<T>(reason);
	return {
		projectName: project.projectName,
		repo: project.projectRepo ?? null,
		linearBinding: project.linear,
		checkoutHead: {
			branch: reading(),
			lastCommit: reading(),
			lastNonChoreCommit: reading(),
			commits30d: reading(),
			nonChoreCommits30d: reading(),
			dirtyCount: reading(),
			worktreeCount: reading(),
		},
		canonical: { defaultBranch: reading(), lastCommit: reading() },
		prActivity: {
			number: reading(),
			state: reading(),
			updatedAt: reading(),
			mergedAt: reading(),
		},
		openPrs: {
			returnedCount: reading(),
			truncated: reading(),
			newestUpdatedAt: reading(),
			oldestUpdatedAt: reading(),
			sample: reading(),
		},
		linear: {
			projectState: reading(),
			projectUpdatedAt: reading(),
			activeIssues: reading(),
		},
		deployedCheckoutSummaryFiles: {
			count: reading(),
			latestDate: reading(),
			checkoutSha: reading(),
		},
		activity: {
			latestObservedActivityAt: reading(),
			coverage: reading(),
			daysSinceLatestObservedActivity: reading(),
		},
	};
}

function sourceStatus(
	readings: Reading<unknown>[],
): "ok" | "partial" | "unavailable" {
	const available = readings.filter((reading) => reading.ok).length;
	if (available === readings.length) return "ok";
	return available === 0 ? "unavailable" : "partial";
}

export class SampleCoordinator {
	private readonly now: () => Date;
	private readonly random: () => string;
	private readonly store: Pick<SnapshotStore, "readLatest" | "write">;
	private inFlight: Promise<PortfolioSnapshot> | null = null;
	private activeController: AbortController | null = null;
	private stopped = false;

	constructor(private readonly options: SampleCoordinatorOptions) {
		this.now = options.now ?? (() => new Date());
		this.random = options.random ?? (() => randomBytes(3).toString("hex"));
		this.store = options.store ?? new SnapshotStore(options.stateDir);
	}

	sample(trigger: string): Promise<PortfolioSnapshot> {
		if (this.stopped)
			return Promise.reject(new Error("sample coordinator stopped"));
		if (this.inFlight) return this.inFlight;
		const operation = this.runSample(trigger);
		this.inFlight = operation;
		const clear = () => {
			if (this.inFlight === operation) this.inFlight = null;
		};
		void operation.then(clear, clear);
		return operation;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.activeController?.abort();
		try {
			await this.inFlight;
		} catch {
			// A stopped sample deliberately writes nothing.
		}
	}

	private async runSample(trigger: string): Promise<PortfolioSnapshot> {
		const controller = new AbortController();
		this.activeController = controller;
		const timer = setTimeout(
			() => controller.abort(),
			this.options.sampleDeadlineMs,
		);
		timer.unref();
		let wakeDeadline: () => void = () => {};
		const deadline = new Promise<void>((resolve) => {
			wakeDeadline = resolve;
			controller.signal.addEventListener("abort", () => resolve(), {
				once: true,
			});
		});
		const projects = this.options.projects;
		const results = new Array<ProjectReading>(projects.length);
		let cursor = 0;
		const worker = async () => {
			while (cursor < projects.length) {
				const index = cursor++;
				const project = projects[index];
				if (!project) return;
				if (controller.signal.aborted) {
					results[index] = unavailableProject(project, "deadline");
					continue;
				}
				results[index] = await Promise.race([
					this.options.sampler
						.sampleProject(project, controller.signal)
						.catch(() =>
							unavailableProject(
								project,
								controller.signal.aborted ? "deadline" : "parse_error",
							),
						),
					deadline.then(() => unavailableProject(project, "deadline")),
				]);
			}
		};
		try {
			await Promise.all(
				Array.from(
					{ length: Math.min(this.options.sampleConcurrency, projects.length) },
					() => worker(),
				),
			);
			if (this.stopped) throw new Error("sample coordinator stopped");
			const sampledAt = this.now().toISOString();
			const previous = this.store.readLatest();
			const snapshot: PortfolioSnapshot = {
				v: 1,
				snapshotId: `${sampledAt.replace(/[^0-9]/g, "")}-${this.random()}`,
				seq: (previous?.seq ?? 0) + 1,
				sampledAt,
				trigger,
				projects: results,
				activityAvailable: results.some(
					(project) => project.activity.daysSinceLatestObservedActivity.ok,
				),
				all: {
					git: sourceStatus(
						results.flatMap((project) => Object.values(project.checkoutHead)),
					),
					gh: sourceStatus(
						results.flatMap((project) => [
							...Object.values(project.canonical),
							...Object.values(project.prActivity),
							...Object.values(project.openPrs),
						]),
					),
					linear: sourceStatus(
						results.flatMap((project) => Object.values(project.linear)),
					),
				},
			};
			this.store.write(snapshot);
			return snapshot;
		} finally {
			clearTimeout(timer);
			wakeDeadline();
			if (this.activeController === controller) this.activeController = null;
		}
	}
}
