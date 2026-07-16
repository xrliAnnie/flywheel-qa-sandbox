export interface MaterializedHeadAuthorityResult {
	head: string;
	outputId: number;
	attempt: number;
}

/**
 * Trusted read port for a review node's materialized producer. PR-7.5 supplies
 * the durable receipt-backed implementation; PR-7 deliberately defaults to a
 * closed port so a missing materializer can never promote caller-supplied data.
 */
export interface MaterializedHeadAuthority {
	resolve(
		runId: string,
		reviewNodeId: string,
	): Promise<MaterializedHeadAuthorityResult>;
}

export const unavailableMaterializedHeadAuthority: MaterializedHeadAuthority = {
	async resolve(): Promise<never> {
		throw new Error("materialized_head_unavailable");
	},
};
