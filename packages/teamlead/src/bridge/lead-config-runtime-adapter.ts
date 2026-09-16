import { compileLeadIdentityRows } from "flywheel-comm/lead-identity";
import { readRegularFileNoFollow } from "flywheel-comm/lead-registry-file-io";
import { readSummaryGranularity } from "flywheel-comm/summary-config";
import { canonicalSubmissionDigest } from "flywheel-config";
import {
	applyCodexLeadRuntimeConfig,
	CodexLeadInboxRejectedError,
	probeCodexLeadInboxCapabilities,
	readCodexLeadRuntimeConfig,
	resolveCodexLeadInboxSocketPath,
} from "../lead-backends/codex/CodexLeadInboxSocket.js";
import type { LeadRuntimeConfigTarget } from "../lead-backends/codex/LeadRuntimeConfigCoordinator.js";
import {
	LeadConfigError,
	type LeadConfigRuntimeLease,
} from "./lead-config-service.js";
import { resolveCodexLeadStateDir } from "./lead-inbox-runtime.js";

type Selector = Pick<
	LeadRuntimeConfigTarget,
	"projectName" | "leadKey" | "identityDigest"
> & { leadId?: string };
const leaseFields = [
	"projectName",
	"leadKey",
	"identityDigest",
	"carrierId",
	"ownerEpoch",
	"runtimeGeneration",
	"threadId",
] as const;
export class LeadConfigRuntimeAdapter {
	private readonly known = new Map<
		string,
		{ fingerprint: string; lease: LeadConfigRuntimeLease }
	>();
	constructor(
		private readonly deps: {
			projectsPath: string;
			home: string;
			runtimeBuildSha: string;
			env?: NodeJS.ProcessEnv;
			stateDir?: typeof resolveCodexLeadStateDir;
			probe?: typeof probeCodexLeadInboxCapabilities;
			apply?: typeof applyCodexLeadRuntimeConfig;
			read?: typeof readCodexLeadRuntimeConfig;
		},
	) {}
	private resolve(selector: Selector) {
		const env = this.deps.env ?? process.env;
		if (env.FLYWHEEL_PROJECTS)
			throw new LeadConfigError("registry_source_env_pinned");
		const rows = compileLeadIdentityRows(
			JSON.parse(
				readRegularFileNoFollow(this.deps.projectsPath, "projects registry"),
			),
			{
				homeDir: this.deps.home,
				summarySelection: readSummaryGranularity({ homeDir: this.deps.home }),
			},
		);
		const matches = rows.filter(
			(row) =>
				row.identity.projectName === selector.projectName &&
				row.identity.leadKey === selector.leadKey &&
				(!selector.leadId || row.identity.leadId === selector.leadId),
		);
		if (
			matches.length !== 1 ||
			matches[0]!.identity.identityDigest !== selector.identityDigest
		)
			throw new LeadConfigError("runtime_identity_changed");
		const identity = matches[0]!.identity;
		if (identity.backend !== "codex-app-server")
			throw new LeadConfigError("runtime_hot_config_unsupported");
		const secret = identity.botTokenEnv ? env[identity.botTokenEnv] : undefined;
		if (!secret?.trim()) throw new LeadConfigError("runtime_auth_unavailable");
		const socketPath = resolveCodexLeadInboxSocketPath(
			(this.deps.stateDir ?? resolveCodexLeadStateDir)(
				identity.projectName,
				identity.leadId,
			),
		);
		return {
			leadId: identity.leadId,
			authSecret: secret,
			socketPath,
			fingerprint: canonicalSubmissionDigest({
				identityDigest: identity.identityDigest,
				modelContextWindow: identity.modelContextWindow,
				secret,
				socketPath,
			}),
		};
	}
	async preflight(selector: Selector): Promise<LeadConfigRuntimeLease> {
		const endpoint = this.resolve(selector);
		let capabilities: Awaited<
			ReturnType<typeof probeCodexLeadInboxCapabilities>
		>;
		try {
			capabilities = await (this.deps.probe ?? probeCodexLeadInboxCapabilities)(
				{ ...endpoint, timeoutMs: 2000 },
			);
		} catch (error) {
			if (this.resolve(selector).fingerprint !== endpoint.fingerprint)
				throw new LeadConfigError("runtime_identity_changed");
			const offline =
				!(error instanceof CodexLeadInboxRejectedError) &&
				(["ENOENT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(
					(error as NodeJS.ErrnoException).code ?? "",
				) ||
					(error instanceof Error &&
						/^Codex Lead inbox timeout after \d+ms$/.test(error.message)));
			const cached = this.known.get(selector.leadKey);
			if (offline && cached?.fingerprint === endpoint.fingerprint)
				return { ...cached.lease, online: false };
			throw new LeadConfigError("runtime_unavailable", 503);
		}
		if (this.resolve(selector).fingerprint !== endpoint.fingerprint)
			throw new LeadConfigError("runtime_identity_changed");
		this.known.delete(selector.leadKey);
		const value = capabilities?.runtimeIdentity;
		if (
			!value ||
			!Array.isArray(capabilities.features) ||
			!capabilities.features.includes("lead_runtime_config_v1") ||
			!capabilities.features.includes("registry_tuning_v1") ||
			leaseFields.some(
				(key) =>
					typeof value[key] !== "string" ||
					!value[key] ||
					value[key].length > 512,
			) ||
			value.carrierId !== capabilities.socketOwnerId ||
			!/^[a-f0-9]{40}$/.test(value.artifactBuildSha) ||
			value.artifactBuildSha !== value.bootstrapBuildSha ||
			value.artifactBuildSha !== this.deps.runtimeBuildSha
		)
			throw new LeadConfigError("runtime_hot_config_unsupported");
		if (
			value.projectName !== selector.projectName ||
			value.leadKey !== selector.leadKey ||
			value.identityDigest !== selector.identityDigest
		)
			throw new LeadConfigError("runtime_identity_changed");
		const lease: LeadConfigRuntimeLease = {
			...value,
			capabilities: [...capabilities.features],
			online: true,
		};
		this.known.set(selector.leadKey, {
			fingerprint: endpoint.fingerprint,
			lease,
		});
		return lease;
	}
	private async endpoint(target: LeadRuntimeConfigTarget) {
		const lease = await this.preflight(target);
		if (!lease.online) throw new LeadConfigError("runtime_unavailable", 503);
		if (leaseFields.some((key) => lease[key] !== target[key]))
			throw new LeadConfigError("runtime_identity_changed");
		return this.resolve(target);
	}
	async apply(target: LeadRuntimeConfigTarget) {
		const endpoint = await this.endpoint(target);
		const result = await (this.deps.apply ?? applyCodexLeadRuntimeConfig)({
			...endpoint,
			target,
			timeoutMs: 15000,
		});
		if (this.resolve(target).fingerprint !== endpoint.fingerprint)
			throw new LeadConfigError("runtime_identity_changed");
		return result;
	}
	async read(target: LeadRuntimeConfigTarget) {
		const endpoint = await this.endpoint(target);
		const result = await (this.deps.read ?? readCodexLeadRuntimeConfig)({
			...endpoint,
			target,
			timeoutMs: 2000,
		});
		if (this.resolve(target).fingerprint !== endpoint.fingerprint)
			throw new LeadConfigError("runtime_identity_changed");
		return result;
	}
}
