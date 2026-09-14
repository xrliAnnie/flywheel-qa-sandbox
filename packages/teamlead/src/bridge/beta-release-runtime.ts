import {
	type BetaProject,
	readBetaReleaseProjects,
} from "./beta-release-config-source.js";
import { BetaReleaseGitHub } from "./beta-release-github.js";
import { BetaReleaseScheduler } from "./beta-release-scheduler.js";
import type { BetaReleaseStore } from "./beta-release-store.js";
import { readLocalDeployedSha } from "./release-readiness/subject.js";
/** Independent of management-console flags; the store getter follows StateStore connection recovery. */
export function createBetaReleaseRuntime(options: {
	store: () => BetaReleaseStore;
	projects: () => BetaProject[];
	env: Readonly<Record<string, string | undefined>>;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	now?: () => number;
	onError?: (code: string) => void;
}): BetaReleaseScheduler {
	return new BetaReleaseScheduler({
		get store() {
			return options.store();
		},
		transport: new BetaReleaseGitHub({
			env: options.env,
			fetch: options.fetch,
			now: options.now,
		}),
		projects: () => readBetaReleaseProjects(options.projects(), options.env),
		localDeployedSha: () =>
			readLocalDeployedSha(options.env.FLYWHEEL_DEPLOYED_SHA_FILE),
		now: options.now,
		onError: options.onError,
	});
}
