import { existsSync, writeFileSync } from "node:fs";
import {
	admitCodexAgentHome,
	provisionCodexAgentHome,
} from "../../src/codex-home.js";

const required = (name: string): string => {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
};

const executionId = required("FLY_TEST_EXECUTION_ID");
const requestedAssemblyArm = required("FLY_TEST_ASSEMBLY_ARM") as
	| "superpowers"
	| "matt"
	| "bare";
const ready = required("FLY_TEST_READY");
const barrier = required("FLY_TEST_BARRIER");
writeFileSync(ready, "ready\n");
while (!existsSync(barrier)) {
	await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

const admission = await admitCodexAgentHome({
	project: "flywheel",
	role: "implement",
	executionId,
	requestedAssemblyArm,
});
await provisionCodexAgentHome(admission.handle, {
	ghToken: required("FLY_TEST_GH_TOKEN"),
	skillFrameworkMode: admission.effectiveAssemblyArm,
	trustedProjectPath: required("FLY_TEST_WORKTREE"),
	registryPath: required("FLY_TEST_REGISTRY"),
	ledgerRoot: required("FLY_TEST_LEDGER"),
	...(admission.effectiveAssemblyArm === "matt"
		? { codexMattSkillsSourceDir: required("FLY_TEST_MATT_SKILLS") }
		: {}),
});
process.stdout.write(
	`${JSON.stringify({
		requestedAssemblyArm,
		effectiveAssemblyArm: admission.effectiveAssemblyArm,
		inherited: admission.inherited,
	})}\n`,
);
