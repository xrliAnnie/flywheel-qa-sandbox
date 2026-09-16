import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModelConfigSnapshot } from "flywheel-config";
import { LeadConfigRegistryWriter } from "../lead-config-registry.js";
import type { StateStore } from "../StateStore.js";
import { ConfirmTokenStore } from "./fleet-admin.js";
import { LeadConfigRuntimeAdapter } from "./lead-config-runtime-adapter.js";
import { LeadConfigService } from "./lead-config-service.js";
import type { resolveCodexLeadStateDir } from "./lead-inbox-runtime.js";
export function createProductionLeadConfigService(
	store: StateStore,
	runtimeBuildSha: string,
	options: {
		home?: string;
		root?: string;
		env?: NodeJS.ProcessEnv;
		stateDir?: typeof resolveCodexLeadStateDir;
	} = {},
): LeadConfigService {
	const home = options.home ?? homedir(),
		env = options.env ?? process.env;
	const root =
		options.root ??
		(env.FLYWHEEL_REPO_ROOT?.trim() ||
			fileURLToPath(new URL("../../../../", import.meta.url)));
	const projectsPath =
		env.FLYWHEEL_PROJECTS_FILE ?? join(home, ".flywheel/projects.json");
	const writer = new LeadConfigRegistryWriter({
		store,
		home,
		root,
		projectsPath,
		receiptPath: join(
			home,
			".flywheel/state/summary-registry/migration-receipt.json",
		),
		env,
		modelSnapshot: getModelConfigSnapshot,
	});
	const runtime = new LeadConfigRuntimeAdapter({
		projectsPath,
		home,
		env,
		runtimeBuildSha,
		stateDir: options.stateDir,
	});
	return new LeadConfigService({
		store,
		writer,
		runtime,
		tokens: new ConfirmTokenStore(),
		runtimeBuildSha,
	});
}
/** One pass at a time; shutdown drains the active pass before the DB may close. */
export function startLeadConfigReconciler(
	service: Pick<LeadConfigService, "reconcile">,
	onError: (error: unknown) => void,
) {
	let stopped = false;
	let flight: Promise<void> | undefined;
	const tick = () => {
		if (stopped || flight) return;
		flight = Promise.resolve()
			.then(() => service.reconcile())
			.catch(onError)
			.finally(() => {
				flight = undefined;
			});
	};
	const timer = setInterval(tick, 5000);
	timer.unref?.();
	tick();
	return async () => {
		stopped = true;
		clearInterval(timer);
		await flight;
	};
}
