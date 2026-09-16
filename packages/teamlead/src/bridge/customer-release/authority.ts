import { createHash } from "node:crypto";
import { parseCustomerReleaseConfig } from "flywheel-config";
import {
	type CustomerReleaseIdentity,
	customerReleaseIdentity,
} from "./activation.js";
import type { CustomerReleaseStore } from "./store.js";
import type { CustomerClaimActivation } from "./types.js";

interface AuthorityInput {
	config: unknown;
	founderId: string | null;
	endpoint: string;
	audience: string;
	env: Record<string, string | undefined>;
	/** Digest of trusted deployed code, reviewed workflows and their credential sources.
	 * The composition root computes this; no request/interaction can supply it. */
	deploymentDigest: string;
}
/** Refresh at every synchronous authority boundary, including after awaited
 * source/Discord probes. A recovered read never restores a revoked grant. */
export class CustomerReleaseAuthority {
	constructor(
		private readonly options: {
			store: CustomerReleaseStore;
			input: () => AuthorityInput;
			flag: () => boolean;
			healthy: () => boolean;
			evidence: (identity: CustomerReleaseIdentity) => string | null;
			now: () => number;
		},
	) {}
	read() {
		const store = this.options.store,
			now = this.options.now();
		try {
			const input = this.options.input(),
				config = parseCustomerReleaseConfig(input.config);
			if (config.mode === "off" && !config.bot_token_env) {
				store.activation.revoke("configuration_off", now);
				return null;
			}
			const base = customerReleaseIdentity({ ...input, config });
			if (!/^[a-f0-9]{64}$/.test(input.deploymentDigest))
				throw new Error("deployment identity unavailable");
			const identity = {
				...base,
				identityDigest: createHash("sha256")
					.update(JSON.stringify([base.identityDigest, input.deploymentDigest]))
					.digest("hex"),
			};
			let state = store.activation.synchronize(identity, now);
			const evidence = this.options.evidence(identity);
			if (
				state.enabled &&
				(!evidence || evidence !== state.evidenceBundleDigest)
			) {
				store.activation.revoke("activation_evidence_changed", now);
				state = store.activation.get()!;
			}
			const receipt = config.founderEnableReceiptId;
			const enableReceiptValid =
				state.enabled &&
				typeof receipt === "string" &&
				receipt.length > 0 &&
				receipt === state.enableReceiptId &&
				!!evidence &&
				evidence === state.evidenceBundleDigest;
			const activation: CustomerClaimActivation = {
				mode: config.mode,
				enabled:
					config.mode === "canary" &&
					this.options.flag() === true &&
					enableReceiptValid,
				enableReceiptValid,
				founderId: identity.founderId,
				enableReceiptId: receipt ?? "",
				evidenceBundleDigest: evidence ?? "",
				activationEpoch: state.epoch,
				policyRevision: identity.policyRevision,
				audience: identity.audience,
				sourcesHealthy: this.options.healthy() === true,
			};
			const target = {
				epoch: state.epoch,
				founderId: identity.founderId,
				applicationId: config.applicationId!,
				guildId: config.guildId!,
				channelId: config.channelId!,
				botUserId: config.botUserId!,
			};
			if (
				Object.entries(target).some(
					([key, value]) =>
						key !== "epoch" &&
						(typeof value !== "string" || !/^[1-9]\d{16,19}$/.test(value)),
				)
			)
				throw new Error("release target missing");
			return { config, identity, target, activation, evidenceDigest: evidence };
		} catch {
			// A durable revoke failure must propagate; a caller cannot safely continue
			// after claiming that old authority was revoked when SQLite rejected it.
			store.activation.revoke("runtime_authority_invalid", now);
			return null;
		}
	}
}
