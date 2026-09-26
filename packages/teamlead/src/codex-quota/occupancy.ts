import { readFileSync } from "node:fs";
import type { CodexAccountPool } from "flywheel-claude-runner/bin/codex-account-core.mjs";
import { codexQuotaIdentityReader } from "./probe.js";
import type { CodexQuotaReadinessOptions } from "./readiness.js";

type CollectHomes = CodexQuotaReadinessOptions["collectHomes"];
type Inventory = Awaited<ReturnType<CollectHomes>> & {
	canonicalChainActive?: boolean;
	activeUnsharedAccountKeys?: string[];
};

export type CodexAccountInUse = boolean | "unknown";

/** FLY-2830: an answer plus a bounded, path-free reason when it is "unknown". */
export interface OccupancyAnswer {
	verdict: CodexAccountInUse;
	detail?: string;
}

export const OCCUPANCY_DETAIL_RE = /^[a-z0-9_:.-]{1,80}$/;

export type CanonicalIdentity =
	| { known: true; accountKey: string }
	| { known: false; detail: string };

function chainActive(inventory: Inventory): boolean {
	return (
		inventory.canonicalChainActive === true ||
		inventory.homes.some(
			(home) => home.ownership === "managed" && home.activity === "active",
		)
	);
}

/**
 * FLY-2830: one account's occupancy from ONE collection. An unshared active
 * home proves "in use"; an idle canonical chain proves "free"; an active chain
 * is the canonical account — and when that identity cannot be read, nothing
 * the first rule did not prove may be called free.
 */
export function occupancyVerdict(
	inventory: Inventory,
	accountKey: string,
	canonical: CanonicalIdentity,
): OccupancyAnswer {
	if ((inventory.activeUnsharedAccountKeys ?? []).includes(accountKey))
		return { verdict: true };
	if (!chainActive(inventory)) return { verdict: false };
	if (canonical.known) return { verdict: canonical.accountKey === accountKey };
	return { verdict: "unknown", detail: canonical.detail };
}

function collectorFailure(error: unknown): string {
	const code = error instanceof Error ? error.message : "";
	const detail = `collector_failed:${code}`;
	return code && OCCUPANCY_DETAIL_RE.test(detail)
		? detail
		: "collector_failed:error";
}

type Snapshot =
	| { known: false }
	| {
			known: true;
			canonicalChainActive: boolean;
			activeUnsharedAccountKeys: ReadonlySet<string>;
	  };

/**
 * FLY-2869 — the one owner of "which Codex credentials does a live process
 * hold right now". Availability, the mutation runtime and the account readings
 * all collect through the same instance, so a readiness refresh also refreshes
 * the fence the runtime checks before it reads, probes or installs.
 *
 * Publication is fenced by start order: a collection blanks the shared fact to
 * unknown when it starts, and only the most recently started collection may
 * publish. An older collection that finishes last still answers its own caller
 * but can never roll a newer "in use" fact back to "idle".
 */
export class CodexAccountOccupancy {
	private started = 0;
	private snapshot: Snapshot = { known: false };

	constructor(private readonly source: CollectHomes) {}

	readonly collect: CollectHomes = async () => {
		const generation = ++this.started;
		this.snapshot = { known: false };
		const inventory = (await this.source()) as Inventory;
		if (generation === this.started) {
			this.snapshot = {
				known: true,
				canonicalChainActive: chainActive(inventory),
				activeUnsharedAccountKeys: new Set(
					inventory.activeUnsharedAccountKeys ?? [],
				),
			};
		}
		return inventory;
	};

	/** Synchronous fence for the mutation path; "unknown" must be treated as in use. */
	isInUse(
		accountKey: string,
		pool: CodexAccountPool,
		canonicalAuthPath: string,
	): CodexAccountInUse {
		const snapshot = this.snapshot;
		if (!snapshot.known) return "unknown";
		if (snapshot.activeUnsharedAccountKeys.has(accountKey)) return true;
		if (!snapshot.canonicalChainActive) return false;
		try {
			return (
				codexQuotaIdentityReader(pool)(readFileSync(canonicalAuthPath, "utf8"))
					.accountKey === accountKey
			);
		} catch {
			return "unknown";
		}
	}

	/**
	 * Collect now, then answer per account from THIS collection (FLY-2830: the
	 * shared snapshot may already be blanked by a newer collection that started
	 * meanwhile — the maintenance tick collects every 3 s). Failures answer
	 * "unknown" with a reason.
	 */
	async guard(
		canonicalAuthPath: string,
		pool: () => CodexAccountPool,
	): Promise<(accountKey: string) => OccupancyAnswer> {
		let inventory: Inventory;
		try {
			inventory = (await this.collect()) as Inventory;
		} catch (error) {
			const detail = collectorFailure(error);
			return () => ({ verdict: "unknown", detail });
		}
		let canonical: CanonicalIdentity;
		try {
			canonical = {
				known: true,
				accountKey: codexQuotaIdentityReader(pool())(
					readFileSync(canonicalAuthPath, "utf8"),
				).accountKey,
			};
		} catch {
			canonical = { known: false, detail: "canonical_identity_unreadable" };
		}
		return (accountKey) => occupancyVerdict(inventory, accountKey, canonical);
	}
}
