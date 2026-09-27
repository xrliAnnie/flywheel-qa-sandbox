/**
 * FLY-2900 §3.2 — the Codex quota standby resume loop.
 *
 * Rides the always-on quota maintenance tick. It never probes, installs or
 * rotates credentials (the auto-switch runtime owns that); it only turns
 * recovery evidence into capacity permits and drives the resumer and the
 * fallback evaluator. Constructed and called whether or not auto-switch is
 * enabled.
 */

import type { CodexReadingPermitOutcome } from "../bridge/codex-quota-store.js";
import type { StateStore } from "../StateStore.js";
import type { CodexAccountQuotaStore } from "./codex-account-quota-store.js";

/** Minimum spacing of the (process-scanning) precondition + permit evaluation. */
export const CODEX_STANDBY_EVALUATION_INTERVAL_MS = 15_000;
/** On-demand reading refresh while a wall waits for newer evidence (§3.2). */
export const CODEX_STANDBY_REFRESH_THROTTLE_MS = 60_000;

export interface CodexQuotaCanonicalIdentity {
	rootKey: string;
	accountKey: string;
	profile: string;
	generation: number;
	authDigest: string;
}

export interface CodexQuotaResumeLoopContext {
	now: number;
	/** The canonical root when every permit precondition held this round. */
	root: CodexQuotaCanonicalIdentity | null;
	readings: CodexAccountQuotaStore | null;
}

export interface CodexQuotaResumeLoopOptions {
	store: StateStore;
	/** reconcileCodexCanonicalRoot: manual switches become generations here. */
	reconcileCanonical(): Promise<CodexQuotaCanonicalIdentity>;
	/** Shared-credential readiness (every Codex home reads the canonical auth). */
	readiness(): Promise<{ ready: boolean; failureCode?: string }>;
	readReadings(): CodexAccountQuotaStore | null;
	/** The shared single-flight Codex reading round (account page + scheduler). */
	requestReadingRefresh(): Promise<unknown>;
	/** §6: claims permits and relaunches parked executions. */
	resumer?: { tick(context: CodexQuotaResumeLoopContext): Promise<void> };
	/** §5: fallback evaluation for walled pools and exhausted resumes. */
	fallback?: { tick(context: CodexQuotaResumeLoopContext): Promise<void> };
	now?: () => number;
	warn?: (message: string, detail: string) => void;
}

export interface CodexQuotaResumeLoopSnapshot {
	parked: number;
	lastEvaluatedAt: string | null;
	/** null when every permit precondition held on the last evaluation. */
	precondition: string | null;
	permit: CodexReadingPermitOutcome["outcome"] | null;
	permitReason: string | null;
}

const MACHINE_CODE = /^[a-z0-9_:.-]{1,80}$/;

function code(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message : "";
	return MACHINE_CODE.test(message) ? message : fallback;
}

export function createCodexQuotaResumeLoop(
	options: CodexQuotaResumeLoopOptions,
): {
	tick(): Promise<void>;
	snapshot(): CodexQuotaResumeLoopSnapshot;
} {
	const now = options.now ?? Date.now;
	const warn =
		options.warn ?? ((message, detail) => console.warn(message, detail));
	let lastEvaluatedAt = Number.NEGATIVE_INFINITY;
	let lastRefreshAt = Number.NEGATIVE_INFINITY;
	let lastRoot: CodexQuotaCanonicalIdentity | null = null;
	const state: CodexQuotaResumeLoopSnapshot = {
		parked: 0,
		lastEvaluatedAt: null,
		precondition: null,
		permit: null,
		permitReason: null,
	};

	const diagnose = (rootKey: string, generation: number, reason: string) => {
		try {
			options.store.codexQuota.enqueueOutbox({
				incidentId: `codex-standby-permit:${rootKey}`,
				kind: "lead_diagnostic",
				eventId: `codex-standby-permit:${rootKey}:${generation}:${reason}`,
				destination: "lead",
				payload: {
					reason: "standby_permit_precondition",
					detail: reason,
					rootKey,
					generation,
				},
			});
		} catch (error) {
			warn("[Bridge] Codex standby diagnostic failed", code(error, "error"));
		}
	};

	const evaluate = async (nowMs: number): Promise<void> => {
		lastEvaluatedAt = nowMs;
		state.lastEvaluatedAt = new Date(nowMs).toISOString();
		lastRoot = null;
		let root: CodexQuotaCanonicalIdentity;
		try {
			root = await options.reconcileCanonical();
		} catch (error) {
			state.precondition = `reconcile_failed:${code(error, "error")}`.slice(
				0,
				80,
			);
			return;
		}
		let readiness: { ready: boolean; failureCode?: string };
		try {
			readiness = await options.readiness();
		} catch (error) {
			readiness = { ready: false, failureCode: code(error, "error") };
		}
		if (!readiness.ready) {
			state.precondition = `readiness:${
				readiness.failureCode && MACHINE_CODE.test(readiness.failureCode)
					? readiness.failureCode
					: "not_ready"
			}`.slice(0, 80);
			diagnose(root.rootKey, root.generation, state.precondition);
			return;
		}
		state.precondition = null;
		lastRoot = root;
		let readings: CodexAccountQuotaStore | null = null;
		try {
			readings = options.readReadings();
		} catch (error) {
			warn("[Bridge] Codex readings unreadable", code(error, "error"));
		}
		const outcome = options.store.codexQuota.issueReadingConfirmedPermit({
			rootKey: root.rootKey,
			expectedGeneration: root.generation,
			authDigest: root.authDigest,
			reading: readings?.accounts.find((a) => a.name === root.profile),
			activeAccount: readings?.activeAccount ?? null,
			nowMs,
		});
		state.permit = outcome.outcome;
		state.permitReason = outcome.outcome === "refused" ? outcome.reason : null;
		if (
			outcome.outcome === "refused" &&
			outcome.needsRefresh &&
			nowMs - lastRefreshAt >= CODEX_STANDBY_REFRESH_THROTTLE_MS
		) {
			lastRefreshAt = nowMs;
			void Promise.resolve()
				.then(() => options.requestReadingRefresh())
				.catch((error: unknown) =>
					warn(
						"[Bridge] Codex standby reading refresh failed",
						code(error, "refresh_failed"),
					),
				);
		}
	};

	return {
		async tick() {
			const nowMs = now();
			const nowIso = new Date(nowMs).toISOString();
			try {
				options.store.finalizeReleasedCodexQuotaStandby(nowIso);
			} catch (error) {
				warn(
					"[Bridge] Codex standby release finalize failed",
					code(error, "error"),
				);
			}
			const parked = options.store.codexQuota.listStandby();
			state.parked = parked.length;
			if (
				parked.some((row) => row.state === "standby") &&
				nowMs - lastEvaluatedAt >= CODEX_STANDBY_EVALUATION_INTERVAL_MS
			) {
				try {
					await evaluate(nowMs);
				} catch (error) {
					warn(
						"[Bridge] Codex standby evaluation failed",
						code(error, "error"),
					);
				}
			}
			let readings: CodexAccountQuotaStore | null = null;
			try {
				readings = options.readReadings();
			} catch {
				readings = null;
			}
			const context: CodexQuotaResumeLoopContext = {
				now: nowMs,
				root: lastRoot,
				readings,
			};
			for (const [name, stage] of [
				["resumer", options.resumer],
				["fallback", options.fallback],
			] as const) {
				if (!stage) continue;
				try {
					await stage.tick(context);
				} catch (error) {
					warn(`[Bridge] Codex standby ${name} failed`, code(error, "error"));
				}
			}
		},
		snapshot: () => ({ ...state }),
	};
}
