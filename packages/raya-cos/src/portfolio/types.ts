import type { RegisteredProject } from "../directory.js";

export type Reading<T> =
	| { ok: true; value: T; at: string }
	| { ok: false; reason: string };

export interface CheckoutCommit {
	sha7: string;
	committedAt: string;
	authoredAt: string;
	author: string;
	subject: string;
}

export interface CanonicalCommit {
	sha7: string;
	committedAt: string;
	subject: string;
}

export interface ProjectReading {
	projectName: string;
	repo: string | null;
	linearBinding: RegisteredProject["linear"];
	checkoutHead: {
		branch: Reading<string>;
		lastCommit: Reading<CheckoutCommit>;
		lastNonChoreCommit: Reading<CheckoutCommit | null>;
		commits30d: Reading<number>;
		nonChoreCommits30d: Reading<number>;
		dirtyCount: Reading<number>;
		worktreeCount: Reading<number>;
	};
	canonical: {
		defaultBranch: Reading<string>;
		lastCommit: Reading<CanonicalCommit>;
	};
	prActivity: {
		number: Reading<number | null>;
		state: Reading<string | null>;
		updatedAt: Reading<string | null>;
		mergedAt: Reading<string | null>;
	};
	openPrs: {
		returnedCount: Reading<number>;
		truncated: Reading<boolean>;
		newestUpdatedAt: Reading<string | null>;
		oldestUpdatedAt: Reading<string | null>;
		sample: Reading<Array<{ number: number; title: string; isDraft: boolean }>>;
	};
	linear: {
		projectState: Reading<string>;
		projectUpdatedAt: Reading<string>;
		activeIssues: Reading<{
			returnedCount: number;
			truncated: boolean;
			latestUpdatedAt: string | null;
		}>;
	};
	deployedCheckoutSummaryFiles: {
		count: Reading<number>;
		latestDate: Reading<string | null>;
		checkoutSha: Reading<string>;
	};
	activity: {
		latestObservedActivityAt: Reading<string>;
		coverage: Reading<string[]>;
		daysSinceLatestObservedActivity: Reading<number>;
	};
}

export interface PortfolioSnapshot {
	v: 1;
	snapshotId: string;
	seq: number;
	sampledAt: string;
	trigger: string;
	projects: ProjectReading[];
	activityAvailable: boolean;
	all: {
		git: "ok" | "partial" | "unavailable";
		gh: "ok" | "partial" | "unavailable";
		linear: "ok" | "partial" | "unavailable";
	};
}
