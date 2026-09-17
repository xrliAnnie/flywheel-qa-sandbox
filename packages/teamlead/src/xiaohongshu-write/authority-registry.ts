import { z } from "zod";
import type {
	AuthorityConfig,
	ProviderStartupConfig,
} from "./authority-config.js";
import type { ObserverPolicy } from "./observer.js";
import type { XhsProviderClient } from "./provider-client.js";

const selection = z
	.object({
		projectId: z.string().min(1).max(256),
		leadId: z.string().min(1).max(256),
	})
	.strict();
type Config = Pick<
	AuthorityConfig,
	"modelUid" | "policyVersion" | "founderConfigVersion" | "registry"
> & {
	provider: Pick<ProviderStartupConfig, "providerBinary" | "toolSchemaDigest">;
};
/** The caller passes the loader's immutable policy and the real private client.
 * Ingress can select a registered scope but cannot supply an account proof,
 * founder identity, approval, destination, or provider endpoint. */
export class XhsAuthorityRegistry {
	private readonly config: Config;
	private readonly epochs = new Map<string, number>();
	constructor(
		config: Config,
		private readonly provider: Pick<XhsProviderClient, "account">,
	) {
		this.config = structuredClone(config);
	}
	/** Synchronous resource guard: no provider I/O is allowed inside write leases.
	 * Only a previously accepted private observation can establish this epoch. */
	assertAccountEpoch(
		account: Pick<
			ObserverPolicy,
			| "providerInstanceId"
			| "accountUserId"
			| "providerGeneration"
			| "accountEpoch"
		>,
	): void {
		const key = JSON.stringify([
			account.providerInstanceId,
			account.accountUserId,
			account.providerGeneration,
		]);
		if (this.epochs.get(key) !== account.accountEpoch)
			throw Error("write_scope_unavailable");
	}
	/** Call before freezing a proposal, outside an active provider write lease.
	 * Lease preparation/commit independently recheck the same account again. */
	async proveAccount(
		peerUid: number,
		input: unknown,
		signal?: AbortSignal,
	): Promise<ObserverPolicy & { initialCursor: string }> {
		const { loggedIn, ...policy } = await this.observeAccount(
			peerUid,
			input,
			signal,
		);
		if (!loggedIn) throw Error("write_scope_unavailable");
		return policy;
	}
	/** Read-only observation preserves private peer/account/provider checks but
	 * does not claim an authenticated platform session or authorize any write. */
	async observeAccount(
		peerUid: number,
		input: unknown,
		signal?: AbortSignal,
	): Promise<ObserverPolicy & { initialCursor: string; loggedIn: boolean }> {
		try {
			const requested = selection.parse(input);
			if (peerUid !== this.config.modelUid || signal?.aborted) throw Error();
			const entry = this.config.registry.find(
				(item) =>
					item.projectId === requested.projectId &&
					item.leadId === requested.leadId,
			);
			if (!entry || entry.founderId !== entry.canonicalFounderId) throw Error();
			const proof = await this.provider.account(signal);
			const current = proof.account;
			const key = JSON.stringify([
				entry.account.providerInstanceId,
				entry.account.accountUserId,
				entry.account.providerGeneration,
			]);
			if (
				signal?.aborted ||
				proof.upstream.guardProtocol !== 1 ||
				proof.upstream.binarySha256 !==
					this.config.provider.providerBinary.sha256 ||
				proof.upstream.toolSchemaDigest !==
					this.config.provider.toolSchemaDigest ||
				current.accountUserId !== entry.account.accountUserId ||
				current.providerInstanceId !== entry.account.providerInstanceId ||
				current.providerGeneration !== entry.account.providerGeneration ||
				!Number.isSafeInteger(current.accountEpoch) ||
				current.accountEpoch <
					Math.max(entry.account.accountEpoch, this.epochs.get(key) ?? 0)
			)
				throw Error();
			this.epochs.set(key, current.accountEpoch);
			return {
				loggedIn: proof.loggedIn,
				requesterUid: peerUid,
				projectId: entry.projectId,
				leadId: entry.leadId,
				authorityPolicyVersion: this.config.policyVersion,
				founderConfigVersion: this.config.founderConfigVersion,
				providerInstanceId: current.providerInstanceId,
				accountUserId: current.accountUserId,
				accountEpoch: current.accountEpoch,
				providerGeneration: current.providerGeneration,
				founderId: entry.founderId,
				canonicalFounderId: entry.canonicalFounderId,
				botId: entry.botId,
				guildId: entry.guildId,
				channelId: entry.channelId,
				initialCursor: entry.initialCursor,
			};
		} catch {
			throw Error("write_scope_unavailable");
		}
	}
}
