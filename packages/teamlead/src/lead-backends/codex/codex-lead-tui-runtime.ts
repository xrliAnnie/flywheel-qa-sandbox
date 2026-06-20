/**
 * FLY-259 PR-D — codex-lead-tui-runtime: the ③ (real interactive terminal)
 * entrypoint. One shared `codex remote-control` daemon; this sidecar is the
 * machine client (Discord in/out via the FLY-224 component originals over
 * WsTransport), the founder's TUI (`codex resume --remote`, PR-C window) is
 * the human client of the SAME thread.
 *
 * Assembly map (plan v1.44.0 §3, all review-pinned):
 *   - transport: connectDaemonWs → WsTransport → CodexLeadProcess (R4 HIGH-1);
 *   - lifecycle: DaemonConnectionSupervisor generations (R5 HIGH-2 fencing);
 *   - event routing: TurnDemux between the raw process and the executor —
 *     `wireDemuxedProcess` builds the facade (R4 HIGH-2 + R5 HIGH-1 +
 *     poisoned-claim R2 MED-3 → ambiguous);
 *   - founder-terminal turns: observe-only TERMINAL journal rows (D5);
 *   - pins: thread params re-pin on every resume (FLY-224 HIGH-1 original) +
 *     config.toml + TUI command line (R4 HIGH-4 multi-pin);
 *   - TUI window: ensured AFTER the thread id is known (PR-C module).
 *
 * Like FLY-224's codex-lead-runtime: the pure/IO-thin pieces are unit-tested
 * (wireDemuxedProcess here; demux/supervisor/transport in their own files);
 * `buildTuiGeneration`/`main` are assembly glue validated by the real-machine
 * bring-up.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	CodexDiscordGateway,
	type DiscordInboundMessage,
} from "./CodexDiscordGateway.js";
import { CodexLeadProcess, CodexLeadProcessError } from "./CodexLeadProcess.js";
import { CodexLeadRuntime, type RuntimeWiring } from "./CodexLeadRuntime.js";
import { CodexOutboundSender } from "./CodexOutboundSender.js";
import type { CodexProcessLike } from "./CodexTurnExecutor.js";
import { CodexTurnExecutor } from "./CodexTurnExecutor.js";
import {
	buildThreadParams,
	type CodexLeadRuntimeConfig,
	dryRunReport,
	parseCodexLeadRuntimeConfig,
	readBaseInstructions,
	readThreadId,
	writeThreadId,
} from "./codex-lead-runtime.js";
import { DaemonConnectionSupervisor } from "./DaemonConnectionSupervisor.js";
import { DirectDiscordOutboundSender } from "./DirectDiscordOutboundSender.js";
import { connectDaemonWs } from "./daemon-ws.js";
import { FileInboundCursorStore } from "./InboundCursorStore.js";
import { LeadHealthProbe } from "./LeadHealthProbe.js";
import type { OutboundSender } from "./LeadInputRouter.js";
import { LeadInputRouter } from "./LeadInputRouter.js";
import { LeadJournal } from "./LeadJournal.js";
import {
	assertLeadActionsInventory,
	LEAD_ACTIONS_MCP_SERVER_NAME,
} from "./lead-actions/mcp-config.js";
import { McpInventoryWatcher } from "./mcp-inventory.js";
import { buildMentionGate } from "./mention-gate.js";
import { RestPollDiscordInboundSource } from "./RestPollDiscordInboundSource.js";
import { resolveReadDenyThread } from "./read-deny-profile.js";
import { SqliteJournalStore } from "./SqliteJournalStore.js";
import { SecretBroker, washActionSecretEnv } from "./secret-broker.js";
import { extractTurnId, TurnDemux } from "./TurnDemux.js";
import {
	ensureTuiWindow,
	isTuiWindowAlive,
	killTuiWindow,
	type TuiWindowSpec,
} from "./tui-window.js";
import { WsTransport } from "./WsTransport.js";

const execFileP = promisify(execFile);

/** How often the generation re-checks the founder's TUI window and re-creates
 * it if it died (review HIGH-1). Coarse on purpose — it only acts on a confirmed
 * dead pane, so a healthy session is untouched between ticks. */
const TUI_LIVENESS_INTERVAL_MS = 20_000;

// ── config ─────────────────────────────────────────────────────────────────

export interface CodexLeadTuiRuntimeConfig extends CodexLeadRuntimeConfig {
	/** Working directory for the founder's TUI (`-C`). */
	tuiCwd: string;
}

export function parseCodexLeadTuiRuntimeConfig(
	env: NodeJS.ProcessEnv,
): CodexLeadTuiRuntimeConfig {
	const base = parseCodexLeadRuntimeConfig(env);
	const tuiCwd = env.FLYWHEEL_CODEX_TUI_CWD?.trim();
	if (!tuiCwd) {
		throw new Error(
			"codex-lead-tui-runtime: missing required env: FLYWHEEL_CODEX_TUI_CWD",
		);
	}
	return { ...base, tuiCwd };
}

// ── demuxed process facade (pure glue — unit-tested) ───────────────────────

export interface DemuxedWiring {
	/** What the executor consumes (only sidecar-claimed turn events arrive). */
	facade: CodexProcessLike;
	/** Single entry the raw process events must be fed into. */
	demux: TurnDemux;
	/**
	 * Await the completion of ONE specific (already-claimed) turn, used by the
	 * bootstrap turn (review HIGH-2). Resolves `"completed"` when that turn's
	 * `turn/completed` arrives, or `"timeout"` after `timeoutMs` — and on timeout
	 * it `releaseTurn`s the id so the demux tombstones any late stragglers
	 * (otherwise a slow bootstrap delta could cross-talk into the next machine
	 * turn once the gateway starts). The internal listener is always removed.
	 */
	awaitTurnCompletion: (
		turnId: string,
		timeoutMs: number,
	) => Promise<"completed" | "timeout">;
}

/**
 * Wire a TurnDemux between a raw process and the executor surface:
 *   raw notifications/turnCompleted → demux.route → (registered) executor
 *   sinks / (foreign) founder observer / (no id) activity only.
 * `startTurn` runs the pending-dispatch handshake; a poisoned claim (overflow,
 * R2 MED-3) throws → the router's existing ambiguous path takes over.
 * Completed sidecar turns are released (bounded registry + tombstones).
 */
export function wireDemuxedProcess(args: {
	proc: CodexLeadProcess;
	onFounderTurnCompleted: (turnId: string) => void;
	onActivity?: () => void;
	log?: (m: string) => void;
}): DemuxedWiring {
	const listeners = {
		notification: [] as Array<(method: string, params: unknown) => void>,
		turnCompleted: [] as Array<(params: unknown) => void>,
	};
	// Bounded record of recently-completed turn ids (review R2 HIGH-1): a turn can
	// complete DURING claim-replay (completion-before-response) — i.e. before the
	// bootstrap waiter is registered. The waiter checks this set first so it never
	// misses an already-delivered completion and falsely times out.
	const recentlyCompleted = new Set<string>();
	const recentlyCompletedFifo: string[] = [];
	const RECENT_COMPLETED_CAP = 64;
	const markCompleted = (id: string) => {
		if (recentlyCompleted.has(id)) return;
		recentlyCompleted.add(id);
		recentlyCompletedFifo.push(id);
		if (recentlyCompletedFifo.length > RECENT_COMPLETED_CAP) {
			const evicted = recentlyCompletedFifo.shift();
			if (evicted) recentlyCompleted.delete(evicted);
		}
	};
	const demux = new TurnDemux({
		toExecutor: (method, params) => {
			if (method === "turn/completed") {
				const id = extractTurnId(params);
				for (const cb of listeners.turnCompleted) cb(params);
				if (id) {
					markCompleted(id); // record BEFORE release so a later waiter sees it
					demux.releaseTurn(id); // release AFTER delivery (bounded registry)
				}
			} else {
				for (const cb of listeners.notification) cb(method, params);
			}
		},
		toObserver: (method, params) => {
			// One observe row per founder turn — keyed on its completion (bounded,
			// idempotent; deltas are visible live in the TUI anyway).
			if (method === "turn/completed") {
				const id = extractTurnId(params);
				if (id) args.onFounderTurnCompleted(id);
			}
		},
		onActivity: args.onActivity,
		log: args.log,
	});
	args.proc.on("notification", (method, params) => demux.route(method, params));
	args.proc.on("turnCompleted", (params) =>
		demux.route("turn/completed", params),
	);

	const facade: CodexProcessLike = {
		on(event: "notification" | "turnCompleted" | "exit", cb: never): void {
			if (event === "notification") listeners.notification.push(cb);
			else if (event === "turnCompleted") listeners.turnCompleted.push(cb);
			else args.proc.on("exit", cb);
		},
		startTurn: async (a) => {
			demux.beginDispatch();
			let turnId: string | undefined;
			try {
				turnId = await args.proc.startTurn(a);
			} catch (err) {
				demux.abortDispatch();
				throw err;
			}
			if (turnId === undefined) {
				demux.abortDispatch();
				return undefined;
			}
			if (!demux.claimTurn(turnId)) {
				// R2 MED-3: window was force-settled by overflow — early events are
				// gone; never wait on this turn. The router treats this throw as
				// ambiguous (its existing failure path).
				throw new Error(
					`dispatch window poisoned for turn ${turnId} (hold-buffer overflow) — ambiguous`,
				);
			}
			return turnId;
		},
		request: (m, p) => args.proc.request(m, p),
	} as CodexProcessLike;

	const awaitTurnCompletion = (
		turnId: string,
		timeoutMs: number,
	): Promise<"completed" | "timeout"> =>
		new Promise((resolve) => {
			// Completion-before-response (R2 HIGH-1): if this turn ALREADY completed
			// (consumed during claim-replay before we got here), resolve immediately
			// rather than registering a listener that will never fire → false timeout.
			if (recentlyCompleted.has(turnId)) {
				resolve("completed");
				return;
			}
			let settled = false;
			const remove = () => {
				const i = listeners.turnCompleted.indexOf(onDone);
				if (i >= 0) listeners.turnCompleted.splice(i, 1);
			};
			const onDone = (params: unknown) => {
				if (settled || extractTurnId(params) !== turnId) return;
				settled = true;
				remove();
				clearTimeout(timer);
				resolve("completed");
			};
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				remove();
				// Tombstone the abandoned turn so any late delta is dropped and can
				// never be mistaken for the next machine turn's output (HIGH-2).
				demux.releaseTurn(turnId);
				resolve("timeout");
			}, timeoutMs);
			(timer as { unref?: () => void }).unref?.();
			listeners.turnCompleted.push(onDone);
		});

	return { facade, demux, awaitTurnCompletion };
}

/** Does a persisted rollout exist for this thread? (Real-machine finding:
 * the daemon writes a thread's rollout only at its FIRST TURN — a turnless
 * thread has none, and the TUI's resume bootstrap then fails with "no
 * rollout found". Checked directly so a stale thread-id pointing at a
 * turnless thread also self-heals via the bootstrap turn.) */
export function rolloutExistsFor(codexHome: string, threadId: string): boolean {
	const root = join(codexHome, "sessions");
	if (!existsSync(root)) return false;
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: Array<{ name: string; isDirectory(): boolean }>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.isDirectory()) stack.push(join(dir, e.name));
			else if (e.name.includes(threadId)) return true;
		}
	}
	return false;
}

/**
 * Is this resume error the specific "turnless thread has no rollout" case
 * (JSON-RPC -32600) that is safe to self-heal with a fresh thread? Gated on the
 * STRUCTURED rpc code AND the exact message (review HIGH-3) — a substring match
 * alone would silently drop a thread on any unrelated resume error that happened
 * to contain the phrase, which is unacceptable memory loss. Everything else is
 * NOT self-healable and must rethrow.
 */
export function isTurnlessRolloutError(err: unknown): boolean {
	return (
		err instanceof CodexLeadProcessError &&
		err.rpcCode === -32600 &&
		/no rollout found/i.test(err.message)
	);
}

/**
 * Read the persona/identity files into `baseInstructions`, FAIL-CLOSED when files
 * were configured but none is readable/non-empty (review MED, R2 MED — applied at
 * EVERY read point: boot AND each generation rebuild, so a companion never
 * silently falls back to the default engineering persona mid-run). No files
 * configured → undefined → no persona (byte-compat).
 */
export function requirePersona(
	config: CodexLeadRuntimeConfig,
): string | undefined {
	const baseInstructions = readBaseInstructions(config.systemPromptFiles);
	if (config.systemPromptFiles.length > 0 && !baseInstructions) {
		throw new Error(
			`codex-lead-tui-runtime: FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES set but no file was readable/non-empty: ${config.systemPromptFiles.join(", ")}`,
		);
	}
	return baseInstructions;
}

// ── generation assembly (glue — validated by real bring-up) ────────────────

function buildTuiGeneration(
	config: CodexLeadTuiRuntimeConfig,
	logger: {
		info: (m: string, c?: unknown) => void;
		warn: (m: string, c?: unknown) => void;
		error: (m: string, c?: unknown) => void;
	},
) {
	const journal = new LeadJournal({
		store: new SqliteJournalStore(config.journalDbPath),
	});
	// PROCESS-scope (review R2 HIGH-2): the thread id the founder's TUI is bound
	// to. The first generation, or any generation whose thread CHANGED (turnless
	// self-heal → fresh thread), must UNCONDITIONALLY ensure the window
	// (stale-kill a leftover same-named Claude pane on first cutover, or a TUI
	// still bound to the OLD thread). Only same-thread transient rebuilds preserve
	// a live founder session.
	let ownedTuiThreadId: string | undefined;
	return () => {
		let runtime: CodexLeadRuntime | null = null;
		let proc: CodexLeadProcess | null = null;
		let lostCb: (() => void) | undefined;
		// Generation-owned TUI lifecycle (review HIGH-1): the window is no longer
		// fire-and-forget — a liveness cadence re-creates it if the founder closes
		// it (only when actually dead, so a healthy session is never disrupted),
		// and `sender`/timer are torn down on stop.
		let sender: OutboundSender | null = null;
		let tuiSpec: TuiWindowSpec | null = null;
		let livenessTimer: ReturnType<typeof setInterval> | null = null;
		let stopped = false;
		// Single TUI-health entry, used by wire() and the liveness cadence (review
		// R2 HIGH-2 + R4 MED-1). Ownership-aware:
		//   - ownedTuiThreadId !== this thread → UNCONDITIONAL ensure (PR-C
		//     stale-kill): first generation, a thread change (turnless self-heal),
		//     OR a previous ensure that FAILED (ownership never recorded). Record
		//     ownership only on success so a failed create keeps retrying instead of
		//     trusting the probe on a leftover old-thread pane.
		//   - same thread, already owned → only re-create if the founder's live
		//     window actually died (never flap a healthy session on rebuild).
		const ensureTuiHealthy = () => {
			if (stopped || !tuiSpec) return;
			if (ownedTuiThreadId !== tuiSpec.threadId) {
				const created = ensureTuiWindow(tuiSpec, {
					log: (m) => logger.warn(m),
				});
				if (created) ownedTuiThreadId = tuiSpec.threadId;
			} else if (!isTuiWindowAlive(tuiSpec)) {
				ensureTuiWindow(tuiSpec, { log: (m) => logger.warn(m) });
			}
		};
		return {
			start: async () => {
				// Validate persona BEFORE opening the WS (review R3 MED-2): a
				// fail-close here must not leak an already-connected transport (at
				// this point `runtime` is unassigned, so stop() couldn't close it).
				// Re-read on every (re)build so a persona edit takes effect on restart.
				const baseInstructions = requirePersona(config);
				const ws = await connectDaemonWs({ codexHome: config.codexHome });
				const transport = new WsTransport(ws);
				proc = new CodexLeadProcess({ spawnChild: () => transport });
				if (lostCb) proc.on("exit", () => lostCb?.());

				// FLY-350 §10 inventory gate (content-coordination only): record the
				// daemon's MCP startup / tool advertisements from connection so the
				// gateway can fail-closed-assert the tool surface before any Discord
				// traffic. companion path: no watcher (byte-compat).
				const inventoryWatcher =
					config.codexProfile === "content-coordination"
						? new McpInventoryWatcher()
						: undefined;
				if (inventoryWatcher) {
					proc.on("notification", (method: string, params: unknown) =>
						inventoryWatcher.record(method, params),
					);
				}

				let alive = true;
				let lastActivityAt: number | undefined;
				proc.on("exit", () => {
					alive = false;
				});
				const { facade, awaitTurnCompletion } = wireDemuxedProcess({
					proc,
					onFounderTurnCompleted: (turnId) => {
						journal.recordObservation({
							idempotencyKey: `founder:${turnId}`,
							payload: "founder terminal turn (observed; see TUI/rollout)",
						});
					},
					onActivity: () => {
						lastActivityAt = Date.now();
					},
					log: (m) => logger.warn(m),
				});

				const builtSender: OutboundSender =
					config.outboundMode === "bridge"
						? new CodexOutboundSender({
								bridgeUrl: config.bridgeUrl,
								apiToken: config.apiToken,
								projectName: config.projectName,
								channelId: config.chatChannelId,
								dbPath: config.outboxDbPath,
							})
						: new DirectDiscordOutboundSender({
								botToken: config.botToken,
								channelId: config.chatChannelId,
							});
				sender = builtSender; // closure-tracked so stop() can close its DB handle

				const threadParams = buildThreadParams(config, baseInstructions);
				const health = new LeadHealthProbe({
					processAlive: () => alive,
					lastActivityAt: () => lastActivityAt,
					journal: { listUnfinished: () => journal.listUnfinished() },
				});

				const p = proc;
				runtime = new CodexLeadRuntime({
					startProcess: () => p.start(), // initialize/initialized over WS
					ensureThread: async (): Promise<string> => {
						const saved = readThreadId(config.threadIdPath);
						// FLY-260 read-deny: the pre-gateway ephemeral-start enforcement gate +
						// resume(+assert)/fresh-start decision lives in resolveReadDenyThread
						// (fail-closed; throws BEFORE wire()/TUI window on any profile mismatch).
						// The TUI turnless self-heal ("no rollout") is passed through as the
						// resume-self-heal predicate. Flag-off keeps the legacy path below.
						if (config.readDeny) {
							const { id, fresh } = await resolveReadDenyThread(p, {
								saved,
								threadParams,
								isResumeSelfHeal: isTurnlessRolloutError,
							});
							if (fresh) writeThreadId(config.threadIdPath, id);
							return id;
						}
						if (saved) {
							try {
								await p.resumeThread(saved, threadParams); // re-pin (HIGH-1)
								return saved;
							} catch (err) {
								// Real-machine finding: a TURNLESS thread has no rollout —
								// once evicted from daemon memory it is unrecoverable
								// ("no rollout found", JSON-RPC -32600). Nothing to preserve
								// (zero turns) → self-heal with a fresh thread.
								// Review HIGH-3: gate on the STRUCTURED rpc code -32600 AND the
								// exact message (see isTurnlessRolloutError). Any other failure
								// rethrows (memory loss is never silent).
								if (!isTurnlessRolloutError(err)) throw err;
								logger.warn(
									"saved thread has no persisted rollout (turnless) — starting a fresh thread",
									{ saved },
								);
							}
						}
						const id = await p.startThread(threadParams);
						writeThreadId(config.threadIdPath, id);
						return id;
					},
					wire: async (threadId: string): Promise<RuntimeWiring> => {
						// FLY-350 §10 fail-closed inventory gate (code-review HIGH-1): assert
						// the lead-actions MCP advertises EXACTLY the approved tool surface
						// BEFORE any model turn. The first-boot/turnless bootstrap turn below
						// (facade.startTurn) could otherwise call discord_send — proactive
						// Discord traffic that bypasses the gateway — before the assertion.
						// A missing / extra / failed / timed-out inventory throws → the
						// generation fails before ANY thread turn. companion path: no watcher
						// → unchanged (byte-compat).
						if (inventoryWatcher) {
							await inventoryWatcher.waitForExact(
								[LEAD_ACTIONS_MCP_SERVER_NAME],
								30_000,
							);
							assertLeadActionsInventory(inventoryWatcher.observedTools());
						}
						const executor = new CodexTurnExecutor({
							process: facade, // demuxed: foreign turns never arrive
							threadId,
						});
						const router = new LeadInputRouter({
							leadId: config.leadId,
							threadId,
							journal,
							executor,
							sender: builtSender,
						});
						const source = new RestPollDiscordInboundSource({
							botToken: config.botToken,
							channelIds: config.channelIds,
							cursorStore: new FileInboundCursorStore(config.inboundCursorPath),
						});
						// FLY-267 判 + 回: mirror the headless mention-gate + reply-routing so
						// the TUI runtime does NOT spam shared channels and routes replies back
						// to the source channel. No cross-dept → neither hook → byte-compat.
						const crossDeptSet = new Set(config.crossDeptChannelIds);
						const shouldHandle =
							config.crossDeptChannelIds.length > 0
								? buildMentionGate({
										botUserId: config.botUserId,
										sharedChannelIds: config.crossDeptChannelIds,
										mentionPatterns: config.mentionPatterns,
									})
								: undefined;
						const resolveReplyChannelId =
							config.crossDeptChannelIds.length > 0
								? (msg: DiscordInboundMessage) =>
										crossDeptSet.has(msg.channelId) ? msg.channelId : undefined
								: undefined;
						const gateway = new CodexDiscordGateway({
							source,
							router,
							botUserId: config.botUserId,
							channelIds: config.channelIds,
							...(shouldHandle ? { shouldHandle } : {}),
							...(resolveReplyChannelId ? { resolveReplyChannelId } : {}),
						});
						// FIRST-BOOT/TURNLESS bootstrap turn (real-machine finding): the daemon
						// persists a thread's rollout only at its FIRST TURN — a turnless
						// thread has no rollout and the TUI's resume bootstrap fails with
						// "no rollout found". Run one tiny turn (await completion, bounded)
						// BEFORE creating the window.
						if (!rolloutExistsFor(config.codexHome, threadId)) {
							let bootstrapTurnId: string | undefined;
							try {
								bootstrapTurnId = await facade.startTurn({
									threadId,
									input: [
										{
											type: "text",
											text: "(系统首启自检,简短回复一句即可,例如:就绪。)",
										},
									],
								});
							} catch (err) {
								// startTurn rejected (rpc failure / poisoned-claim ambiguous):
								// no turn was registered, nothing to release.
								logger.warn(
									"bootstrap turn dispatch failed (TUI window may not attach until the first real turn)",
									{ err: (err as Error).message },
								);
							}
							if (bootstrapTurnId) {
								// Await THIS turn specifically; on timeout the id is released
								// (tombstoned) so a late delta can't bleed into the next
								// machine turn once the gateway starts (review HIGH-2).
								const outcome = await awaitTurnCompletion(
									bootstrapTurnId,
									90_000,
								);
								if (outcome === "completed") {
									logger.info("bootstrap turn completed (rollout persisted)");
								} else {
									logger.warn(
										"bootstrap turn timed out — released to avoid cross-talk; TUI may attach on first real turn",
										{ bootstrapTurnId },
									);
								}
							}
						}
						// TUI window AFTER the thread is known (the founder's client
						// resumes the SAME machine-owned thread). Fail-open. Pass the
						// VALIDATED codex binary (review HIGH-4) — a bare `codex` under a
						// sparse launchd PATH could miss or hit the wrong (npm) build.
						tuiSpec = {
							projectName: config.projectName,
							leadId: config.leadId,
							codexHome: config.codexHome,
							threadId,
							cwd: config.tuiCwd,
							codexBin: config.codexBin,
							// FLY-260: omit `-s read-only` from the founder TUI resume so the
							// read-deny profile stays active for the shared thread.
							readDeny: config.readDeny,
						};
						// Identity-aware ensure (review R2 HIGH-2 + R3 MED-1 + R4 MED-1):
						// ensureTuiHealthy does the UNCONDITIONAL ensure (PR-C stale-kill)
						// on first generation / thread change / a prior failed ensure, and
						// records ownership only on success; once owned it only re-creates a
						// genuinely dead window (never flaps a healthy founder session).
						ensureTuiHealthy();
						// Liveness cadence (review HIGH-1 + R4 MED-1): re-create the window
						// if the founder closes it, AND retry the unconditional ensure if a
						// prior one failed. Started once per generation; unref'd so it never
						// holds the process open; cleared on stop().
						if (!livenessTimer) {
							livenessTimer = setInterval(
								ensureTuiHealthy,
								TUI_LIVENESS_INTERVAL_MS,
							);
							(livenessTimer as { unref?: () => void }).unref?.();
						}
						return {
							recover: () => router.recover(),
							// (FLY-350 §10 inventory gate runs at wire-top, before any model
							// turn — code-review HIGH-1.)
							startGateway: () => gateway.start(),
							stopGateway: () => gateway.stop(),
						};
					},
					shutdownProcess: () => p.stop(),
					healthProbe: () => health.probe(),
					logger,
				});
				await runtime.start();
			},
			stop: async () => {
				// Stop the probe FIRST so a tick can't re-create the window during
				// teardown. NOTE: we do NOT kill the TUI window here — generation stop
				// also fires on a transient daemon-WS rebuild, and the founder's
				// `codex resume --remote` window (connected to the still-live daemon)
				// must survive that. The orphan-kill on real shutdown lives in main().
				stopped = true;
				if (livenessTimer) {
					clearInterval(livenessTimer);
					livenessTimer = null;
				}
				await runtime?.stop(); // gateway first (review-pinned), then process
				sender?.close?.(); // close the outbox SQLite handle (review MED — no leak per rebuild)
				runtime = null;
				proc = null;
				sender = null;
			},
			onConnectionLost: (cb: () => void) => {
				lostCb = cb;
				if (proc) proc.on("exit", () => lostCb?.());
				return () => {
					lostCb = undefined;
				};
			},
		};
	};
}

// ── entrypoint ─────────────────────────────────────────────────────────────

export async function main(
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const config = parseCodexLeadTuiRuntimeConfig(env);
	// HIGH-1 transplant: a write-capable TUI Lead is refused (chat-only contract).
	if (config.sandboxMode !== "read-only") {
		throw new Error(
			`codex-lead-tui-runtime: sandbox="${config.sandboxMode}" is write-capable — the ③ TUI Lead is chat-only until FLY-245. Refusing to start.`,
		);
	}
	// Persona fail-close at boot (review MED — parity with headless). The same
	// check runs at every generation read point (requirePersona), so a companion
	// never silently falls back to the default persona.
	requirePersona(config);
	// DRY-RUN (review MED — parity with headless): describe what WOULD start with
	// zero side effects (no daemon connect, no Discord poll). The launcher skips
	// ensure-home/ensure-daemon in dry-run so this path is genuinely side-effect free.
	if (env.FLYWHEEL_LEAD_DRY_RUN === "1") {
		console.log(
			"[codex-lead-tui-runtime] DRY-RUN — ③ real terminal (TUI) mode",
		);
		console.log(`  tui cwd       : ${config.tuiCwd}`);
		for (const line of dryRunReport(config)) console.log(line);
		return;
	}
	// Resolve the home script for BOTH layouts: from dist/lead-backends/codex
	// it's ../../../scripts; from src/lead-backends/codex it's ../../scripts
	// is wrong too — scripts/ lives at the package root in both cases, three
	// levels up from this module's directory.
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const homeScript = join(
		moduleDir,
		"..",
		"..",
		"..",
		"scripts",
		"codex-lead-tui-home.sh",
	);
	// FLY-350 content-coordination: the runtime OWNS the broker → daemon ordering
	// (R3#1). Start the parent SecretBroker (the lead-actions MCP child fetches the
	// bot token over it) BEFORE the daemon, and WASH the daemon spawn env so no
	// *TOKEN*/*SECRET*/*KEY* reaches the app-server process (R3#2). The companion
	// path is unchanged (no broker, env as-is) → byte-compat / dormant.
	const contentCoordination = config.codexProfile === "content-coordination";
	const brokerSocketPath =
		env.FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET?.trim() ||
		join(config.stateDir, "lead-actions.sock");
	let leadActionsBroker: SecretBroker | undefined;
	if (contentCoordination) {
		leadActionsBroker = new SecretBroker({
			socketPath: brokerSocketPath,
			secrets: { DISCORD_BOT_TOKEN: config.botToken },
		});
		await leadActionsBroker.listen();
		console.warn(
			`[codex-lead-tui-runtime] lead-actions broker listening (${brokerSocketPath})`,
		);
	}
	const ensureDaemon = async () => {
		await execFileP("/bin/bash", [homeScript, "ensure-daemon"], {
			env: contentCoordination
				? // R3#2: the daemon (app-server) must start with a SECRET-WASHED env —
					// the bot token reaches the MCP child only over the broker, never the
					// daemon process env.
					{
						...washActionSecretEnv(env),
						FLYWHEEL_CODEX_TUI_HOME: config.codexHome,
					}
				: {
						...env,
						FLYWHEEL_CODEX_TUI_HOME: config.codexHome,
					},
		});
	};
	const supervisor = new DaemonConnectionSupervisor({
		buildGeneration: buildTuiGeneration(config, console),
		ensureDaemon,
		log: (m) => console.warn(`[codex-lead-tui-runtime] ${m}`),
	});
	const shutdown = (sig: NodeJS.Signals) => {
		console.warn(`[codex-lead-tui-runtime] ${sig} → stopping`);
		supervisor
			.stop()
			.finally(() => {
				// Real shutdown (not a transient rebuild): tear down the orphan TUI
				// window so a `codex resume --remote` pane never outlives its Lead
				// (review HIGH-1 / cutover "stop the sidecar+TUI first" contract).
				killTuiWindow(
					{ projectName: config.projectName, leadId: config.leadId },
					{ log: (m) => console.warn(`[codex-lead-tui-runtime] ${m}`) },
				);
			})
			// FLY-350: tear down the lead-actions broker (releases the socket) on a
			// real shutdown. No-op for the companion path (undefined).
			.finally(() => leadActionsBroker?.close())
			.finally(() => process.exit(0));
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
	try {
		await supervisor.start();
	} catch (err) {
		// Startup-failure path (review R2 HIGH-2): a generation may have created
		// the TUI window before failing — tear it down so it never orphans, same
		// as the signal handlers do.
		killTuiWindow(
			{ projectName: config.projectName, leadId: config.leadId },
			{ log: (m) => console.warn(`[codex-lead-tui-runtime] ${m}`) },
		);
		await leadActionsBroker?.close().catch(() => {});
		throw err;
	}
	console.warn(
		`[codex-lead-tui-runtime] ${config.leadId}@${config.projectName} started (③ real terminal)`,
	);
}

// Run when executed directly (codex-lead.sh TUI mode execs the built file).
if (process.argv[1]?.includes("codex-lead-tui-runtime")) {
	main().catch((err) => {
		console.error("[codex-lead-tui-runtime] fatal:", err);
		process.exit(1);
	});
}
