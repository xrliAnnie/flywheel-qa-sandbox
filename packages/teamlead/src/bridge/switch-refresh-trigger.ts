/**
 * FLY-2830 — every account switch re-reads every account.
 *
 * Each vendor's switch already has a monotonic generation the Bridge can see:
 * the Codex quota root (automatic commit and the manual `codex-profile use`
 * reconcile both bump it) and the Claude AccountStore `lastSwitch` (automatic
 * quota-monitor switch and the manual CLI both commit it). This trigger rides
 * the GatePoller tick, and when either generation moves up it
 *   1. records the switch moment (memory first, then disk) for the page, then
 *   2. runs two independent legs: ask quota-monitor for a full Claude sweep
 *      (request file + SIGUSR1), and re-read Codex + Claude cards in the Bridge.
 * Switches that arrive while a round is in flight coalesce into one trailing
 * round. Nothing here throws into the tick; failures are logged.
 *
 * FLY-2897: an optional third, independent leg re-reads the Claude charge
 * receipts, so the next-charge cells are fresh after a switch too.
 */

import type { QuotaDaemonWakeOutcome } from "./quota-daemon-wake.js";
import {
	type SwitchRecord,
	type SwitchVendor,
	withSwitch,
} from "./switch-record.js";

export type SwitchRefreshReason = "codex_switch" | "claude_switch";

export interface ClaudeSweepLegResult {
	sweepRequest: string;
	wake: QuotaDaemonWakeOutcome | string;
}

export interface SwitchRefreshTriggerDeps {
	readCodexGeneration: () => number | null;
	readClaudeGeneration: () => number | null;
	/** Leg A: durable sweep request + daemon wake (synchronous). */
	requestClaudeSweep: (reason: SwitchRefreshReason) => ClaudeSweepLegResult;
	/** Leg B: the Bridge-side re-read (Codex + Claude cards, no Vercel). */
	refreshBridge: () => Promise<unknown>;
	/** FLY-2897 leg C: the shared Claude charge-receipt round. */
	refreshClaudeCharges?: () => Promise<unknown>;
	persistSwitchRecord?: (record: SwitchRecord) => void;
	readPersistedSwitchRecord?: () => SwitchRecord | null;
	now?: () => number;
	/** Claude generation read throttle (accounts.json); Codex reads every tick. */
	throttleMs?: number;
	log?: (line: string) => void;
}

export interface SwitchRefreshTrigger {
	tick(): void;
	/** In-process last switch per vendor; survives a failed disk write. */
	latestSwitchRecord(): SwitchRecord | null;
	/** Resolves once no refresh round is in flight (tests, shutdown). */
	settled(): Promise<void>;
}

const CODE_RE = /^[a-z0-9_:.-]{1,60}$/;

/** A bounded, path-free failure code: the message only when it already is one. */
export function switchRefreshFailureCode(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	return CODE_RE.test(message) ? message : "error";
}

/** Leg A: write the request, then wake — a wake without a request is harmless. */
export function createClaudeSweepRequester(deps: {
	write: (input: { reason: SwitchRefreshReason }) => unknown;
	wake: () => QuotaDaemonWakeOutcome;
}): (reason: SwitchRefreshReason) => ClaudeSweepLegResult {
	return (reason) => {
		let sweepRequest = "ok";
		try {
			deps.write({ reason });
		} catch (error) {
			sweepRequest = `failed:${switchRefreshFailureCode(error)}`;
		}
		return { sweepRequest, wake: deps.wake() };
	};
}

export function createSwitchRefreshTrigger(
	deps: SwitchRefreshTriggerDeps,
): SwitchRefreshTrigger {
	const now = deps.now ?? Date.now;
	const throttleMs = deps.throttleMs ?? 10_000;
	const log = deps.log ?? ((line: string) => console.warn(line));
	const baseline: Record<SwitchVendor, number | undefined> = {
		codex: undefined,
		claude: undefined,
	};
	const unreadable: Record<SwitchVendor, boolean> = {
		codex: false,
		claude: false,
	};
	let lastClaudeReadAt: number | null = null;
	let latest: SwitchRecord | null = null;
	let running: Promise<void> | null = null;
	let pending: SwitchRefreshReason | null = null;

	const read = (vendor: SwitchVendor): number | null => {
		try {
			const value =
				vendor === "codex"
					? deps.readCodexGeneration()
					: deps.readClaudeGeneration();
			return typeof value === "number" && Number.isSafeInteger(value)
				? value
				: null;
		} catch {
			return null;
		}
	};

	const record = (vendor: SwitchVendor, generation: number) => {
		const entry = { generation, observedAt: new Date(now()).toISOString() };
		// Memory first: the page can mark stale cells even if the disk is gone.
		latest = withSwitch(latest, vendor, entry);
		if (!deps.persistSwitchRecord) return;
		try {
			let persisted: SwitchRecord | null = null;
			try {
				persisted = deps.readPersistedSwitchRecord?.() ?? null;
			} catch {
				persisted = null;
			}
			deps.persistSwitchRecord(withSwitch(persisted, vendor, entry));
		} catch {
			log("[switch-record] persist_failed");
		}
	};

	const runOnce = async (reason: SwitchRefreshReason) => {
		const charges = deps.refreshClaudeCharges;
		const [sweep, bridge, charge] = await Promise.allSettled([
			Promise.resolve().then(() => deps.requestClaudeSweep(reason)),
			Promise.resolve().then(() => deps.refreshBridge()),
			charges ? Promise.resolve().then(() => charges()) : undefined,
		]);
		const leg: ClaudeSweepLegResult =
			sweep.status === "fulfilled"
				? sweep.value
				: {
						sweepRequest: `failed:${switchRefreshFailureCode(sweep.reason)}`,
						wake: "signal_failed",
					};
		const bridgeRefresh =
			bridge.status === "fulfilled"
				? "ok"
				: `failed:${switchRefreshFailureCode(bridge.reason)}`;
		const chargeRefresh = !charges
			? ""
			: charge.status === "fulfilled"
				? " chargeRefresh=ok"
				: ` chargeRefresh=failed:${switchRefreshFailureCode(charge.reason)}`;
		log(
			`[switch-refresh] reason=${reason} codexGen=${baseline.codex ?? "none"} claudeGen=${baseline.claude ?? "none"} sweepRequest=${leg.sweepRequest} wake=${leg.wake} bridgeRefresh=${bridgeRefresh}${chargeRefresh}`,
		);
	};

	const fire = (reason: SwitchRefreshReason) => {
		if (running) {
			pending = reason;
			return;
		}
		running = (async () => {
			let next: SwitchRefreshReason | null = reason;
			while (next) {
				pending = null;
				try {
					await runOnce(next);
				} catch {
					log("[switch-refresh] round_failed");
				}
				next = pending;
			}
		})().finally(() => {
			running = null;
		});
	};

	const observe = (vendor: SwitchVendor, generation: number | null) => {
		if (generation === null) {
			if (!unreadable[vendor])
				log(`[switch-refresh] ${vendor}_generation_unreadable`);
			unreadable[vendor] = true;
			return;
		}
		unreadable[vendor] = false;
		const base = baseline[vendor];
		baseline[vendor] = generation;
		if (base === undefined || generation === base) return;
		if (generation < base) {
			log(
				`[switch-refresh] ${vendor}_generation_rewound from=${base} to=${generation}`,
			);
			return;
		}
		record(vendor, generation);
		fire(vendor === "codex" ? "codex_switch" : "claude_switch");
	};

	return {
		tick() {
			try {
				observe("codex", read("codex"));
				const current = now();
				if (
					lastClaudeReadAt === null ||
					current - lastClaudeReadAt >= throttleMs
				) {
					lastClaudeReadAt = current;
					observe("claude", read("claude"));
				}
			} catch {
				log("[switch-refresh] tick_failed");
			}
		},
		latestSwitchRecord: () => latest,
		async settled() {
			while (running) await running;
		},
	};
}
