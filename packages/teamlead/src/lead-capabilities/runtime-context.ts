import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
	type CompiledLeadIdentityRow,
	identityEnvProjection,
	resolveLeadIdentityRow,
} from "flywheel-comm/lead-identity";
import {
	type LeadWriteAuthorizationDeps,
	validateLeadCarrierAuthorization,
} from "flywheel-comm/lead-lease";
import { resolveLeadCapabilities } from "./resolve.js";

/** Trusted parent registry context. This alone is not a provider write authorization. */
export function createLeadCapabilityContext(input: NodeJS.ProcessEnv) {
	const env = Object.freeze({ ...input });
	const required = (name: string) => {
		const value = env[name];
		if (!value) throw new Error(`capability context missing ${name}`);
		return value;
	};
	if (env.FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION !== "2")
		throw new Error("capability context requires explicit bundle v2");
	const projectsPath = required("FLYWHEEL_PROJECTS_FILE");
	const homeDir = env.FLYWHEEL_SUMMARY_CONFIG_HOME ?? required("HOME");
	if (!isAbsolute(projectsPath) || !isAbsolute(homeDir))
		throw new Error("capability context paths must be absolute");
	const projectName = required("FLYWHEEL_PROJECT_NAME");
	const leadId = required("FLYWHEEL_LEAD_ID");
	const read = (): CompiledLeadIdentityRow => {
		const row = resolveLeadIdentityRow({
			projectsPath,
			homeDir,
			projectName,
			leadId,
		});
		if (
			!resolveLeadCapabilities({
				row,
				integrationIds: [],
				handlerOperationIds: [],
				adoptedMenuShapes: [],
			})
		)
			throw new Error("capability revoked in current registry");
		if (env.FLYWHEEL_CODEX_LEAD_PROFILE !== row.lead.codexProfile)
			throw new Error("capability profile changed");
		for (const line of identityEnvProjection(row.identity)) {
			const pos = line.indexOf("=");
			const name = line.slice(0, pos);
			if (name === "FLYWHEEL_LEAD_PROJECTS_DIGEST") continue;
			if (env[name] !== line.slice(pos + 1))
				throw new Error("capability canonical identity mismatch");
		}
		return row;
	};
	const root = (row: CompiledLeadIdentityRow) => {
		const value = row.project.projectRoot;
		if (typeof value !== "string" || !isAbsolute(value))
			throw new Error("capability project root must be absolute");
		return realpathSync(value);
	};
	const projectRoot = root(read());
	const assertCurrent = () => {
		const row = read();
		if (root(row) !== projectRoot)
			throw new Error("capability project root changed");
		return row;
	};
	return Object.freeze({
		projectRoot,
		assertCurrent,
		/** Call at the actual dispatch boundary; authority never comes from model input. */
		assertActivationCurrent(
			deps: Pick<
				LeadWriteAuthorizationDeps,
				"now" | "processAliveWithStart"
			> = {},
		) {
			assertCurrent();
			const carrier = validateLeadCarrierAuthorization(
				{ claimedLeadId: leadId, env },
				deps,
			);
			if (!carrier.valid || carrier.processIndeterminate)
				throw new Error("capability carrier is not currently verified");
			// Re-read registry after process probing, including any callback yield.
			return assertCurrent();
		},
	});
}
