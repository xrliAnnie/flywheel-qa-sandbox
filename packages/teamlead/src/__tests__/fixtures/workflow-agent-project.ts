import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/** Install the real bundled node implementations into a temporary test project. */
export function installWorkflowAgentFiles(projectRoot: string): void {
	const agentsRoot = join(projectRoot, ".flywheel", "agents");
	mkdirSync(agentsRoot, { recursive: true });
	cpSync(
		join(REPO_ROOT, ".flywheel", "agents", "nodes"),
		join(agentsRoot, "nodes"),
		{ recursive: true },
	);
}

/** Make a temp project satisfy the self-hosted registry projection contract. */
export function installSelfHostedWorkflowAgentProject(
	projectRoot: string,
): void {
	installWorkflowAgentFiles(projectRoot);
	writeFileSync(
		join(projectRoot, ".flywheel", "config.yaml"),
		"project: flywheel\n",
	);
}
