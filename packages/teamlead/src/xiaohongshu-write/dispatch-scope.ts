import type { AuthorityConfig } from "./authority-config.js";
import type { ProviderDispatchScope } from "./provider-authority.js";
import type { XhsWriteStore } from "./store.js";

type Config = Pick<
	AuthorityConfig,
	"enabled" | "modelUid" | "policyVersion" | "founderConfigVersion" | "keyId"
> & {
	registry: readonly Pick<
		AuthorityConfig["registry"][number],
		"projectId" | "leadId" | "account"
	>[];
	provider: { providerBinary: { sha256: string }; toolSchemaDigest: string };
};
/** Private callback only. The loader proves root policy, and assertCurrent
 * rechecks that policy/lifetime. Activation comes only from the saved attempt.
 * Actual account/epoch is independently verified by the provider's lease. */
export function createPinnedDispatchScope(
	config: Config,
	store: Pick<XhsWriteStore, "pinnedDispatch">,
	assertCurrent: () => void,
) {
	const root = structuredClone(config);
	return async (
		proposalId: string,
		signal: AbortSignal,
	): Promise<ProviderDispatchScope | null> => {
		try {
			signal.throwIfAborted();
			assertCurrent();
			if (!root.enabled) return null;
			const saved = store.pinnedDispatch(proposalId);
			if (!saved) return null;
			const f = saved.frozen;
			const entries = root.registry.filter(
				(entry) => entry.projectId === f.projectId && entry.leadId === f.leadId,
			);
			if (entries.length !== 1) return null;
			const account = entries[0]!.account;
			if (
				f.requesterUid !== root.modelUid ||
				f.authorityPolicyVersion !== root.policyVersion ||
				f.account.accountUserId !== account.accountUserId ||
				f.account.providerInstanceId !== account.providerInstanceId ||
				f.account.providerGeneration !== account.providerGeneration ||
				f.account.accountEpoch < account.accountEpoch ||
				f.upstream.binarySha256 !== root.provider.providerBinary.sha256 ||
				f.upstream.toolSchemaDigest !== root.provider.toolSchemaDigest ||
				f.upstream.guardProtocol !== 1
			)
				return null;
			assertCurrent();
			signal.throwIfAborted();
			return {
				identity: {
					...f.account,
					requesterUid: root.modelUid,
					projectId: f.projectId,
					leadId: f.leadId,
					authorityPolicyVersion: root.policyVersion,
					founderConfigVersion: root.founderConfigVersion,
				},
				activationId: saved.activationId,
				keyId: root.keyId,
			};
		} catch {
			return null;
		}
	};
}
