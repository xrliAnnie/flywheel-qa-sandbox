import { join } from "node:path";
import {
	type CodexLeadInboxCapabilities,
	probeCodexLeadInboxCapabilities,
} from "./CodexLeadInboxSocket.js";
import {
	acquireProcessLifetimeFileLock,
	type ProcessLockAcquire,
	type ProcessLockHandle,
} from "./ProcessLifetimeFileLock.js";

export type { ProcessLockAcquire, ProcessLockHandle };

interface Lifecycle {
	start(): Promise<void>;
	stop(): Promise<void>;
}

interface InboxServer {
	listen(): Promise<void>;
	close(): Promise<void>;
	pauseAccepting(): void;
	resumeIfBoundPathCurrent(): boolean;
}

export interface CodexDiscordRuntimeOwnershipOptions {
	stateDir: string;
	leadId: string;
	authSecret: string;
	server: InboxServer;
	gateway: Lifecycle;
	acquireLock?: ProcessLockAcquire;
	probe?: () => Promise<unknown>;
	autoRefresh?: boolean;
	logger?: {
		info?: (message: string, context?: unknown) => void;
		warn: (message: string, context?: unknown) => void;
	};
}

const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 30_000;
const ALERT_INTERVAL_MS = 30 * 60_000;

export class CodexDiscordRuntimeOwnership {
	private readonly socketLockPath: string;
	private readonly ingressLockPath: string;
	private readonly acquireLock: ProcessLockAcquire;
	private readonly probe: () => Promise<unknown>;
	private readonly logger: Required<
		NonNullable<CodexDiscordRuntimeOwnershipOptions["logger"]>
	>;
	private running = false;
	private socketLock?: ProcessLockHandle;
	private ingressLock?: ProcessLockHandle;
	private socketListening = false;
	private gatewayStarted = false;
	private refreshPromise?: Promise<void>;
	private pollTimer?: ReturnType<typeof setInterval>;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private retryMs = INITIAL_RETRY_MS;
	private nextAttemptAt = 0;
	private lastAlertAt = 0;
	private outage = false;

	constructor(private readonly opts: CodexDiscordRuntimeOwnershipOptions) {
		this.socketLockPath = join(opts.stateDir, "codex-mailbox-socket.lock");
		this.ingressLockPath = join(opts.stateDir, "discord-inbound.lock");
		this.acquireLock =
			opts.acquireLock ??
			((path, onLost) => acquireProcessLifetimeFileLock(path, { onLost }));
		this.probe =
			opts.probe ??
			(() =>
				probeCodexLeadInboxCapabilities({
					socketPath: join(opts.stateDir, "lead-inbox.sock"),
					leadId: opts.leadId,
					authSecret: opts.authSecret,
					timeoutMs: 1_000,
				}));
		this.logger = {
			info: opts.logger?.info ?? (() => {}),
			warn:
				opts.logger?.warn ??
				((message, context) => console.warn(message, context ?? "")),
		};
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		await this.refresh();
		if (this.opts.autoRefresh !== false) {
			this.pollTimer = setInterval(
				() =>
					void this.refresh().catch((error) =>
						this.alert("codex_runtime_ownership_refresh_failed", error.message),
					),
				1_000,
			);
			this.pollTimer.unref?.();
		}
	}

	refresh(): Promise<void> {
		if (!this.running) return Promise.resolve();
		if (this.refreshPromise) return this.refreshPromise;
		this.refreshPromise = this.reconcile().finally(() => {
			this.refreshPromise = undefined;
		});
		return this.refreshPromise;
	}

	mailboxReady(): boolean {
		return this.socketListening && this.ingressLock !== undefined;
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.pollTimer = undefined;
		this.retryTimer = undefined;
		try {
			await this.setGateway(false);
		} finally {
			try {
				await this.opts.server.close();
			} finally {
				this.socketListening = false;
				try {
					await this.releaseIngress();
				} finally {
					await this.socketLock?.close();
					this.socketLock = undefined;
				}
			}
		}
	}

	private async reconcile(): Promise<void> {
		if (!this.socketLock && Date.now() >= this.nextAttemptAt) {
			const attempt = await this.acquireLock(
				this.socketLockPath,
				(error) =>
					void this.socketOwnerLost(error).catch((failure) =>
						this.alert("codex_socket_owner_loss_failed", failure.message),
					),
			);
			if (attempt.status === "acquired") {
				this.socketLock = attempt.handle;
				this.retryMs = INITIAL_RETRY_MS;
				this.nextAttemptAt = 0;
				this.logger.info("codex_socket_owner_acquired", {
					leadId: this.opts.leadId,
					helperPid: attempt.handle.helperPid,
				});
			} else {
				await this.handleOwnerFailure(
					attempt.status,
					attempt.status === "unavailable" ? attempt.error : undefined,
				);
				return;
			}
		}
		if (!this.socketLock) {
			await this.setGateway(false);
			return;
		}
		if (!this.socketListening) {
			if (Date.now() < this.nextAttemptAt) {
				await this.setGateway(false);
				return;
			}
			try {
				if (!this.opts.server.resumeIfBoundPathCurrent()) {
					await this.opts.server.close();
					await this.opts.server.listen();
				}
				this.socketListening = true;
				this.recovered();
			} catch (error) {
				this.alert("codex_socket_owner_unavailable", (error as Error).message);
				this.scheduleRetry();
				await this.setGateway(false);
				return;
			}
		}
		if (!this.ingressLock && Date.now() >= this.nextAttemptAt) {
			const attempt = await this.acquireLock(
				this.ingressLockPath,
				(error) =>
					void this.ingressOwnerLost(error).catch((failure) =>
						this.alert("discord_inbound_owner_loss_failed", failure.message),
					),
			);
			if (attempt.status === "acquired") {
				this.ingressLock = attempt.handle;
				this.retryMs = INITIAL_RETRY_MS;
				this.nextAttemptAt = 0;
				this.logger.info("discord_inbound_owner_acquired", {
					leadId: this.opts.leadId,
					helperPid: attempt.handle.helperPid,
				});
				this.recovered("discord_inbound_owner_recovered");
			} else {
				this.alert(
					"discord_inbound_owner_unavailable",
					attempt.status === "unavailable" ? attempt.error : attempt.status,
				);
				this.scheduleRetry();
			}
		}
		await this.setGateway(this.ingressLock !== undefined);
	}

	private async handleOwnerFailure(
		status: "conflict" | "unavailable",
		error?: string,
	): Promise<void> {
		try {
			const capabilities =
				(await this.probe()) as Partial<CodexLeadInboxCapabilities>;
			this.logger.info("codex_socket_owner_standby", {
				leadId: this.opts.leadId,
				status,
				socketOwnerId: capabilities.socketOwnerId,
			});
			await this.setGateway(false);
		} catch (probeError) {
			this.alert(
				"codex_socket_owner_unavailable",
				error ?? (probeError as Error).message,
			);
			await this.setGateway(false);
		}
		this.scheduleRetry();
	}

	private async setGateway(wanted: boolean): Promise<void> {
		if (wanted === this.gatewayStarted) return;
		if (wanted) await this.opts.gateway.start();
		else await this.opts.gateway.stop();
		this.gatewayStarted = wanted;
	}

	private async releaseIngress(): Promise<void> {
		const lock = this.ingressLock;
		this.ingressLock = undefined;
		await lock?.close();
	}

	private scheduleRetry(): void {
		const delay = Math.round(this.retryMs * (0.75 + Math.random() * 0.5));
		this.nextAttemptAt = Date.now() + delay;
		this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.refresh().catch((error) =>
				this.alert("codex_runtime_ownership_retry_failed", error.message),
			);
		}, delay);
		this.retryTimer.unref?.();
	}

	private async socketOwnerLost(error: string): Promise<void> {
		if (!this.running || !this.socketLock) return;
		this.socketLock = undefined;
		this.socketListening = false;
		this.opts.server.pauseAccepting();
		this.alert("codex_socket_owner_unavailable", error);
		await this.setGateway(false);
		await this.releaseIngress();
		// Do not close here: Node unlinks a Unix socket during server.close(), which
		// could clobber a successor after flock loss. Reject new connections while
		// unreachable/standby; after reacquiring the lock, resume the same inode or
		// close/rebind safely while ownership is held.
		this.nextAttemptAt = 0;
		this.scheduleRetry();
	}

	private async ingressOwnerLost(error: string): Promise<void> {
		if (!this.running || !this.ingressLock) return;
		this.ingressLock = undefined;
		this.alert("discord_inbound_owner_unavailable", error);
		await this.setGateway(false);
		this.nextAttemptAt = 0;
		this.scheduleRetry();
	}

	private alert(event: string, error: string): void {
		this.outage = true;
		const now = Date.now();
		if (now - this.lastAlertAt < ALERT_INTERVAL_MS) return;
		this.lastAlertAt = now;
		this.logger.warn(event, { leadId: this.opts.leadId, error });
	}

	private recovered(event = "codex_socket_owner_recovered"): void {
		if (!this.outage) return;
		this.outage = false;
		this.lastAlertAt = 0;
		this.logger.info(event, {
			leadId: this.opts.leadId,
		});
	}
}
