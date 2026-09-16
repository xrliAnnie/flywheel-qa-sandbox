import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	recordLeadDeployment,
	verifyLeadDeployment,
} from "../lead-capabilities/deployment.js";

/** v2 launcher preflight: derives production checkout from its own dist location. */
export function verifyCodexLauncherDeployment(
	env: NodeJS.ProcessEnv = process.env,
) {
	const entry = realpathSync(fileURLToPath(import.meta.url));
	if (
		!entry.endsWith("/packages/teamlead/dist/bin/verify-codex-deployment.js") ||
		!env.HOME ||
		!env.FLYWHEEL_CODEX_LEAD_STATE_DIR
	)
		throw new Error("lead_deployment_unverified");
	const checkoutRoot = join(dirname(entry), "../../../..");
	const options = {
		checkoutRoot: realpathSync(checkoutRoot),
		deployedShaPath: join(env.HOME, ".flywheel/deployed-sha"),
		stateDir: env.FLYWHEEL_CODEX_LEAD_STATE_DIR,
	};
	return env.FLYWHEEL_LEAD_DRY_RUN === "1"
		? verifyLeadDeployment(options)
		: recordLeadDeployment(options);
}
if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
	try {
		verifyCodexLauncherDeployment();
	} catch {
		process.stderr.write("lead_deployment_unverified\n");
		process.exitCode = 78;
	}
}
