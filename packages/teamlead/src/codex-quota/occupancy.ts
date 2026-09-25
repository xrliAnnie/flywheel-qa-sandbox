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
				canonicalChainActive:
					inventory.canonicalChainActive === true ||
					inventory.homes.some(
						(home) =>
							home.ownership === "managed" && home.activity === "active",
					),
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

	/** Collect now, then answer per account; failures answer "unknown". */
	async guard(
		canonicalAuthPath: string,
		pool: () => CodexAccountPool,
	): Promise<(accountKey: string) => CodexAccountInUse> {
		try {
			await this.collect();
			const current = pool();
			return (accountKey) =>
				this.isInUse(accountKey, current, canonicalAuthPath);
		} catch {
			return () => "unknown";
		}
	}
}
