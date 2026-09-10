import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
	type CodexQuotaBindingV1,
	parseCodexQuotaBindingV1,
} from "flywheel-core";
import type { StateStore } from "../StateStore.js";
import { checkCodexQuotaReadiness } from "./readiness.js";

export class CodexQuotaLaunchPausedError extends Error {
	constructor() {
		super("quota_launch_paused");
		this.name = "CodexQuotaLaunchPausedError";
	}
}

export function createCodexQuotaLaunchBinder(options: {
	store: StateStore;
	canonicalHome: string;
	identify(auth: string): { profile: string; accountKey: string };
}): (home: string, executionId: string) => Promise<CodexQuotaBindingV1> {
	return async (home, executionId) => {
		const session = options.store.getSession(executionId);
		if (!session) throw new Error("quota_launch_session_missing");
		const canonicalHome = await realpath(options.canonicalHome);
		const rootKey = createHash("sha256").update(canonicalHome).digest("hex");
		const quota = options.store.codexQuota;
		if (quota.isPaused(rootKey) || quota.isExecutionPaused(executionId))
			throw new CodexQuotaLaunchPausedError();
		const canonicalAuthPath = join(canonicalHome, "auth.json");
		const readiness = await checkCodexQuotaReadiness({
			canonicalAuthPath,
			collectHomes: async () => ({
				complete: true,
				homes: [{ home, ownership: "managed", activity: "active" }],
			}),
		});
		if (!readiness.ready) throw new Error("quota_launch_home_not_shared");
		const actual = options.identify(
			await readFile(join(home, "auth.json"), "utf8"),
		);
		// Readiness and auth reads yield; reject a pause that opened meanwhile.
		if (quota.isPaused(rootKey) || quota.isExecutionPaused(executionId))
			throw new CodexQuotaLaunchPausedError();
		const existing = quota.getRoot(rootKey);
		quota.initializeRoot({
			rootKey,
			...actual,
			generation: existing?.generation ?? 1,
		});
		const root = quota.getRoot(rootKey)!;
		const execution =
			options.store.getGeneralizedWorkflowNodeForExecution(executionId);
		const binding = parseCodexQuotaBindingV1({
			bindingId: randomUUID(),
			executionId,
			runId: execution?.run.run_id ?? null,
			accountKey: actual.accountKey,
			profile: actual.profile,
			generation: root.generation,
			credentialRootKey: rootKey,
			purpose: "runner",
		});
		if (!binding) throw new Error("quota_launch_identity_invalid");
		quota.registerBinding(binding);
		return binding;
	};
}
