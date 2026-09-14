import { cpSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
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

/** Opt-in domain-only handbook for tests whose node type differs from its role.
 * Keep production assets and the default real-agent installer unchanged.
 */
export function installWorkflowDomainAgentFixture(
	projectRoot: string,
	role: "qa" | "general" | "implement",
): void {
	if (realpathSync(projectRoot) === realpathSync(REPO_ROOT)) {
		throw new Error(
			"Domain fixture requires a temporary project, not the source repository",
		);
	}
	writeFileSync(
		join(projectRoot, ".flywheel", "agents", "nodes", `${role}.md`),
		role === "implement"
			? "Produce the pinned output artifact.\n"
			: "Review the pinned output independently.\n",
	);
}
