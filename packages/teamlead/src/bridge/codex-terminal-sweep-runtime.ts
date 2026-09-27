import { createHash } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import {
	type CodexExecutionOwnershipRegistry,
	captureCodexProcessSnapshot,
	codexHomesRoot,
	parseCodexProcessSnapshot,
	resolveDaemonSocketPath,
} from "flywheel-claude-runner";
import { CommDB } from "flywheel-comm/db";
import {
	type AlertPayload,
	type AlertResult,
	FLEET_ALERT_PROJECT,
} from "../LeadAlertNotifier.js";
import type { StateStore } from "../StateStore.js";
import { reapCodexDaemonForSession } from "./codex-daemon-teardown.js";
import {
	type RolloutLocatorDeps,
	type RolloutTokenState,
	readCodexRolloutTokens,
	readCodexSessionThreadId,
	resolveCodexRolloutPath,
} from "./codex-rollout-token-watch.js";
import { observeCodexTerminalClose } from "./codex-terminal-close-ledger.js";
import {
	CODEX_TERMINAL_SWEEP_SOURCE,
	CodexTerminalSweep,
	type CodexTerminalSweepAlert,
	type CodexTerminalSweepDeps,
	parseTerminalAtMs,
} from "./codex-terminal-sweep.js";
import { resolveCommDbPath } from "./commdb-session-prune.js";
import { hasUnresolvedCompleteMarker } from "./completion-before-death.js";

/** FLY-2903 production wiring of the terminal-body sweep (plugin stays thin). */

const TOKEN_CUT_GRACE_MS = 2 * 60_000;
const SNAPSHOT_DEADLINE_MS = 9_000;

function plain(value: string | null | undefined, max = 64): string {
	if (!value) return "unknown";
	return value.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, max);
}

/** §7.1 alert: severe, fleet-scoped, plain bounded text, one episode per state + token magnitude. */
export function buildCodexTerminalBodyAlert(
	alert: CodexTerminalSweepAlert,
): AlertPayload {
	const episode = createHash("sha256")
		.update(`${alert.executionId}\0${alert.alertKey}`)
		.digest("hex")
		.slice(0, 24);
	const exec8 = alert.executionId.slice(0, 8);
	return {
		projectName: FLEET_ALERT_PROJECT,
		leadId: "codex-terminal-sweep",
		eventId: `codex_terminal_body_alive:${plain(alert.executionId, 160)}:${alert.state}:${episode}`,
		eventType: "codex_terminal_body_alive",
		title: `终态 Codex 体仍在运行 / 仍在用额度 (${plain(alert.issueIdentifier)} ${plain(exec8)})`,
		body: [
			`issue=${plain(alert.issueIdentifier)}`,
			`exec=${plain(exec8)}`,
			`status=${plain(alert.sessionStatus)}`,
			`terminalAt=${plain(alert.terminalAt)}`,
			`state=${alert.state}`,
			`tokensAfterTerminal=${alert.tokensAfterTerminal ?? "unknown"}`,
			`action=${plain(alert.action)}`,
		].join(" "),
		severity: "severe",
	};
}

/**
 * Best-effort unlink of this execution's own socket path. A symlink is removed
 * as a link (its target is never touched); anything that is not a socket or a
 * link is left alone.
 */
export function unlinkOwnCodexSocket(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const path = resolveDaemonSocketPath(executionId, env);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		return;
	}
	if (!stat.isSocket() && !stat.isSymbolicLink()) return;
	unlinkSync(path);
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Rollout token observer: resolve once (cached in the ledger), read incrementally. */
export function createRolloutTokenObserver(deps: {
	codexHomesRoot: () => string;
	latestCursor: RolloutLocatorDeps["latestCursor"];
	readThreadId?: RolloutLocatorDeps["readThreadId"];
}): CodexTerminalSweepDeps["tokens"] {
	return ({ executionId, session, row, processHomes }) => {
		const cut = parseTerminalAtMs(session.terminal_at);
		const locate = () =>
			resolveCodexRolloutPath(executionId, {
				codexHomesRoot: deps.codexHomesRoot(),
				latestCursor: deps.latestCursor,
				processHomes,
				readThreadId: deps.readThreadId ?? readCodexSessionThreadId,
			});
		const cached = row?.rollout_path ?? null;
		let path = cached ?? locate();
		if (!path) return { rolloutPath: null };
		if (cut === null) return { rolloutPath: path };
		const cutMs = cut + TOKEN_CUT_GRACE_MS;
		const stateFor = (target: string): RolloutTokenState =>
			row && row.rollout_path === target
				? {
						offset: row.rollout_offset,
						lastTotal: row.rollout_last_total,
						tokensAtTerminal: row.tokens_at_terminal,
						tokensAfterTerminal: row.tokens_after_terminal,
					}
				: {
						offset: null,
						lastTotal: null,
						tokensAtTerminal: null,
						tokensAfterTerminal: null,
					};
		try {
			return {
				rolloutPath: path,
				read: readCodexRolloutTokens(path, stateFor(path), { cutMs }),
			};
		} catch (error) {
			if (!isMissing(error) || path !== cached) {
				return { rolloutPath: path, error: "rollout_read_failed" };
			}
		}
		// The cached file vanished (Codex archived it): resolve again once.
		path = locate();
		if (!path || path === cached) return { rolloutPath: null };
		try {
			return {
				rolloutPath: path,
				read: readCodexRolloutTokens(path, stateFor(path), { cutMs }),
			};
		} catch {
			return { rolloutPath: path, error: "rollout_read_failed" };
		}
	};
}

export interface BridgeCodexTerminalSweepOptions {
	store: StateStore;
	owners: Pick<
		CodexExecutionOwnershipRegistry,
		"ownershipState" | "requestStop"
	>;
	bodyObserver: CodexTerminalSweepDeps["bodyObserver"];
	reapEnabled: () => boolean;
	alertSink: {
		current?: { alert: (payload: AlertPayload) => Promise<AlertResult> };
	};
	env?: NodeJS.ProcessEnv;
}

export function createBridgeCodexTerminalSweep(
	options: BridgeCodexTerminalSweepOptions,
): CodexTerminalSweep {
	const { store } = options;
	const env = options.env ?? process.env;
	return new CodexTerminalSweep({
		now: () => new Date(),
		ledger: store.codexTerminalClose,
		observe: (executionId, observation) =>
			observeCodexTerminalClose(
				{
					store: store.codexTerminalClose,
					events: {
						insertEvent: (event) => store.insertEvent(event),
						transaction: (fn) => store.runInTransaction(fn),
					},
				},
				executionId,
				observation,
			),
		getSession: (executionId) => store.getSession(executionId),
		processBodyState: (executionId) =>
			store.getWorkflowExecutionProcessBody(executionId)?.state,
		residentHoldState: (executionId) =>
			store.getResidentHold(executionId)?.state,
		snapshot: async () =>
			parseCodexProcessSnapshot(
				await captureCodexProcessSnapshot(SNAPSHOT_DEADLINE_MS),
			),
		owners: options.owners,
		bodyObserver: {
			observe: (executionId) => options.bodyObserver.observe(executionId),
			isCurrent: (observation) => {
				if (!options.bodyObserver.isCurrent(observation)) return false;
				// Terminal runs need not still be active. Fence newer logical work
				// using immutable bindings, not the active-run recovery selector.
				const bindings = store.listWorkflowActivationsForActor(
					observation.identity.executionId,
				);
				if (observation.identity.activationId === null)
					return bindings.length === 0;
				const exact = bindings.find(
					(binding) =>
						binding.activation_id === observation.identity.activationId,
				);
				return Boolean(
					exact &&
						bindings.every(
							(binding) =>
								binding.activation_id === exact.activation_id ||
								binding.bound_at < exact.bound_at,
						),
				);
			},
		},
		completionPending: (executionId) =>
			hasUnresolvedCompleteMarker(executionId),
		stopAuthorized: (executionId) => {
			let db: CommDB | undefined;
			try {
				const session = store.getSession(executionId);
				const dbPath = session?.project_name
					? resolveCommDbPath(session.project_name)
					: undefined;
				if (!dbPath || !session?.issue_id) return false;
				db = CommDB.openReadonly(dbPath);
				return !db
					.listTurns()
					.some((turn) => turn.holder_exec_id === executionId);
			} catch {
				return false;
			} finally {
				db?.close();
			}
		},

		reap: (session, beforeSignal) =>
			reapCodexDaemonForSession(store, session, CODEX_TERMINAL_SWEEP_SOURCE, {
				beforeSignal,
			}),
		tokens: createRolloutTokenObserver({
			codexHomesRoot: () => codexHomesRoot(env),
			latestCursor: (executionId) =>
				store.workflowScorecard.latestCodexSourceForExecution(executionId),
			readThreadId: (executionId) => readCodexSessionThreadId(executionId, env),
		}),
		unlinkSocket: (executionId) => unlinkOwnCodexSocket(executionId, env),
		reapEnabled: options.reapEnabled,
		alert: async (alert) => {
			const sink = options.alertSink.current;
			if (!sink) throw new Error("terminal sweep alert sink is not bound yet");
			await sink.alert(buildCodexTerminalBodyAlert(alert));
		},
	});
}
