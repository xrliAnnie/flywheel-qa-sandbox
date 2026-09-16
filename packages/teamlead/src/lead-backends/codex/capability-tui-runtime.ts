import { startDefaultLeadCapabilityParent } from "../../lead-capabilities/default-runtime.js";
import type { LeadCapabilityParent } from "../../lead-capabilities/runtime-parent.js";
import { startCapabilityAppServer } from "./capability-app-server.js";
import {
	buildTuiGeneration,
	type CodexLeadTuiRuntimeConfig,
} from "./codex-lead-tui-runtime.js";
import { DaemonConnectionSupervisor } from "./DaemonConnectionSupervisor.js";
import { SqliteJournalStore } from "./SqliteJournalStore.js";
import { killTuiWindow } from "./tui-window.js";

/** v2 process owner; WS rebuilds share one parent/journal, shutdown revokes both. */
export function createCapabilityTuiRuntime(
	config: CodexLeadTuiRuntimeConfig,
	env: NodeJS.ProcessEnv,
	logger: {
		info(message: string, context?: unknown): void;
		warn(message: string): void;
		error(message: string): void;
	},
	deps: {
		parent?: typeof startDefaultLeadCapabilityParent;
		server?: typeof startCapabilityAppServer;
		generation?: typeof buildTuiGeneration;
		killWindow?: typeof killTuiWindow;
	} = {},
) {
	const abort = new AbortController();
	let parent: LeadCapabilityParent | undefined;
	let journal: SqliteJournalStore | undefined;
	let server: Awaited<ReturnType<typeof startCapabilityAppServer>> | undefined;
	let supervisor: DaemonConnectionSupervisor | undefined;
	let windowOwned = false;
	let startup: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	const cleanup = () => {
		if (closing) return closing;
		closing = (async () => {
			try {
				await supervisor?.stop();
			} finally {
				try {
					if (windowOwned)
						(deps.killWindow ?? killTuiWindow)({
							projectName: config.projectName,
							leadId: config.leadId,
						});
				} finally {
					try {
						await server?.close();
					} finally {
						try {
							await parent?.close();
						} finally {
							journal?.close();
						}
					}
				}
			}
		})();
		return closing;
	};
	const start = () => {
		if (startup) return startup;
		startup = (async () => {
			try {
				abort.signal.throwIfAborted();
				if (config.capabilityBundleVersion !== 2 || !config.carrierInstanceId)
					throw new Error("capability_tui_identity_unavailable");
				journal = new SqliteJournalStore(config.journalDbPath);
				parent = await (deps.parent ?? startDefaultLeadCapabilityParent)({
					config,
					journal,
					carrierInstanceId: config.carrierInstanceId,
				});
				abort.signal.throwIfAborted();
				const capabilitySession = {
					parent,
					journal,
					socket: {
						get path() {
							if (!server) throw new Error("capability_app_server_unavailable");
							return server.socketPath;
						},
						async assertCurrent() {
							if (!server) throw new Error("capability_app_server_unavailable");
							await server.assertCurrent();
						},
					},
				};
				const generation = (deps.generation ?? buildTuiGeneration)(
					config,
					logger,
					{
						capabilitySession,
						onWindowOwned: () => {
							windowOwned = true;
						},
					},
				);
				supervisor = new DaemonConnectionSupervisor({
					buildGeneration: generation,
					ensureDaemon: async () => {
						await parent!.assertCurrent();
						abort.signal.throwIfAborted();
						if (server) {
							try {
								await server.assertCurrent();
								return;
							} catch (error) {
								if (
									!(error instanceof Error) ||
									error.message !== "capability_app_server_exited"
								)
									throw error;
								await server.close();
								server = undefined;
							}
						}
						server = await (deps.server ?? startCapabilityAppServer)({
							parent: parent!,
							env,
							signal: abort.signal,
						});
						logger.info("Codex Lead TUI transport ready", server.receipt);
					},
					log: (message) => logger.warn(message),
				});
				await supervisor.start();
			} catch (error) {
				await cleanup().catch(() =>
					logger.warn("Capability TUI startup cleanup failed"),
				);
				throw error;
			}
		})();
		return startup;
	};
	const stop = async () => {
		abort.abort(new Error("capability_tui_stopped"));
		await startup?.catch(() => {});
		await cleanup();
	};
	return { start, stop };
}
