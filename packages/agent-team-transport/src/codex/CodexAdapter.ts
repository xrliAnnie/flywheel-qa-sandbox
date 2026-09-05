/**
 * CodexAdapter — vendor transport for Codex (process-boundary) runners.
 *
 * FLY-123 Phase 1 (de-stubs the FLY-142 §11 placeholder; Spike-δ validated
 * the underlying exec/resume + external-watcher semantics on 2026-06-03 —
 * see doc/engineer/research/new/FLY-123-spike-delta-gate-semantics.md).
 *
 * Unlike claude-code, Codex has NO builtin mailbox poller — `wakeMode` is
 * `external-watcher`: the mailbox is a Flywheel-owned JSON file (NOT a
 * vendor path), watched by a `CodexMailboxWatcher` that the EXECUTOR
 * adapter (`CodexTmuxAdapter`) starts/stops inside `execute()` (Codex
 * design review R1 #2 — there is no other production lifecycle owner).
 *
 * Path layout mirrors the claude shape for operator familiarity but lives
 * under a codex-owned root (per path-helpers.ts vendor-path discipline):
 *
 *   `${FLYWHEEL_CODEX_TEAMS_DIR:-~/.flywheel/codex-teams}/<safeTeam>/inboxes/<safeAgent>.json`
 *
 * Both writer (Lead-side `respond` wake via forBackend("codex")) and reader
 * (watcher in the Bridge process) are Flywheel code — the format is ours:
 * a single JSON object `{ messages: [...] }`, atomically replaced
 * (temp + rename) under an exclusive `.lock` file.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getStateDir, sanitizePathComponent } from "../path-helpers.js";
import {
	type IAgentTeamTransport,
	type ILogger,
	type IMailboxWatcher,
	type LeadSpawnConfig,
	type LeadSpawnContext,
	type MailboxMessage,
	type MailboxPayload,
	type MailboxWatcherHealth,
	MailboxWriteError,
	type MailboxWriteResult,
	type PreflightResult,
	type RunnerSpawnConfig,
	type RunnerSpawnContext,
	type TransportCapabilities,
} from "../types.js";

interface CodexInboxFile {
	messages: MailboxMessage[];
}

const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 20;

export function getCodexTeamsDir(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.FLYWHEEL_CODEX_TEAMS_DIR?.trim();
	if (fromEnv) return fromEnv;
	return join(homedir(), ".flywheel", "codex-teams");
}

export interface CodexAdapterOptions {
	/** Override the teams root (tests). Default: env / ~/.flywheel/codex-teams. */
	teamsDir?: string;
	/** Watcher poll interval (ms). Default 1000. */
	watcherPollIntervalMs?: number;
	/** Injectable for preflight tests. */
	execFileFn?: (cmd: string, args: string[]) => string;
}

export class CodexAdapter implements IAgentTeamTransport {
	private readonly teamsDir: string;
	private readonly watcherPollIntervalMs: number;
	private readonly execFileFn: (cmd: string, args: string[]) => string;

	constructor(options: CodexAdapterOptions = {}) {
		this.teamsDir = options.teamsDir ?? getCodexTeamsDir();
		this.watcherPollIntervalMs = options.watcherPollIntervalMs ?? 1000;
		this.execFileFn =
			options.execFileFn ??
			((cmd, args) =>
				execFileSync(cmd, args, { encoding: "utf-8", stdio: "pipe" }));
	}

	vendorId(): string {
		return "codex";
	}

	capabilities(): TransportCapabilities {
		return {
			wakeMode: "external-watcher",
			// Codex health probing is best-effort (codex-with-fallback rotates
			// accounts at call time; a static preflight can't see that).
			preflightIsHardGate: false,
			preservesMetadata: true,
			maxPayloadBytes: 262_144,
			requiresStableAgentIdentity: true,
		};
	}

	getInboxPath(leadName: string, agentName: string): string {
		const safeTeam = sanitizePathComponent(leadName);
		const safeAgent = sanitizePathComponent(agentName);
		return join(this.teamsDir, safeTeam, "inboxes", `${safeAgent}.json`);
	}

	getStateDir(): string {
		return getStateDir();
	}

	// ── Write side ──────────────────────────────────────────────────────

	async write(args: {
		leadName: string;
		recipient: string;
		payload: MailboxPayload;
	}): Promise<MailboxWriteResult> {
		const inboxPath = this.getInboxPath(args.leadName, args.recipient);
		const payloadBytes = Buffer.byteLength(args.payload.content, "utf-8");
		if (payloadBytes > this.capabilities().maxPayloadBytes) {
			throw new MailboxWriteError(
				`payload ${payloadBytes}B exceeds cap`,
				"unknown",
				args.recipient,
				false,
			);
		}

		return this.withLock(inboxPath, args.recipient, async () => {
			const inbox = this.readInbox(inboxPath);

			const flywheelId = args.payload.metadata?.flywheelId;
			if (flywheelId) {
				const dup = inbox.messages.find(
					(m) => m.metadata?.flywheelId === flywheelId,
				);
				if (dup) {
					// Single-phase atomic write — a present entry IS finalized.
					return {
						flywheelId,
						idempotent: true,
						wroteAt: dup.ts,
						finalized: true,
					};
				}
			}

			const now = Date.now();
			const message: MailboxMessage = {
				...args.payload,
				id: randomUUID(),
				ts: now,
				read: false,
			};
			inbox.messages.push(message);
			this.atomicWriteInbox(inboxPath, inbox, args.recipient);
			const result: MailboxWriteResult = {
				idempotent: false,
				wroteAt: now,
				finalized: true,
			};
			if (flywheelId) result.flywheelId = flywheelId;
			return result;
		});
	}

	async verifyLastWrite(args: {
		leadName: string;
		recipient: string;
		expected: MailboxPayload;
	}): Promise<void> {
		const inboxPath = this.getInboxPath(args.leadName, args.recipient);
		const inbox = this.readInbox(inboxPath);
		const last = [...inbox.messages]
			.reverse()
			.find((m) => m.from === args.expected.from && m.to === args.expected.to);
		if (!last || last.content !== args.expected.content) {
			throw new MailboxWriteError(
				`last write for ${args.expected.from}→${args.expected.to} does not match expected content`,
				"verify_mismatch",
				args.recipient,
				true,
			);
		}
	}

	// ── Read side ───────────────────────────────────────────────────────

	async readUnread(args: {
		leadName: string;
		agentName: string;
	}): Promise<MailboxMessage[]> {
		const inboxPath = this.getInboxPath(args.leadName, args.agentName);
		const inbox = this.readInbox(inboxPath);
		return inbox.messages.filter((m) => !m.read);
	}

	async ack(args: {
		leadName: string;
		agentName: string;
		messageIds: string[];
	}): Promise<void> {
		const inboxPath = this.getInboxPath(args.leadName, args.agentName);
		const ids = new Set(args.messageIds);
		await this.withLock(inboxPath, args.agentName, async () => {
			const inbox = this.readInbox(inboxPath);
			const now = Date.now();
			for (const m of inbox.messages) {
				if (ids.has(m.id) && !m.read) {
					m.read = true;
					m.deliveredAt = now;
				}
			}
			this.atomicWriteInbox(inboxPath, inbox, args.agentName);
			return undefined;
		});
	}

	dedupeKey(message: MailboxMessage): string {
		// id is assigned once at write (uuid) and persisted — stable across
		// reads by construction.
		return message.id;
	}

	// ── Receiver wake ───────────────────────────────────────────────────

	createReceiver(ctx: RunnerSpawnContext): IMailboxWatcher | null {
		return new CodexMailboxWatcher(
			this,
			ctx.teamName,
			ctx.runnerName,
			this.watcherPollIntervalMs,
		);
	}

	// ── Spawn config ────────────────────────────────────────────────────

	buildRunnerSpawnConfig(ctx: RunnerSpawnContext): RunnerSpawnConfig {
		// Codex has none of claude-code's agent-team CLI flags. Identity is
		// carried via env for the gate CLI + debuggability; the executor
		// adapter (CodexTmuxAdapter) owns the actual codex argv.
		return {
			args: [],
			env: {
				FLYWHEEL_AGENT_TEAM_NAME: ctx.teamName,
				FLYWHEEL_AGENT_NAME: ctx.runnerName,
				FLYWHEEL_RUNNER_VENDOR_ID: "codex",
			},
		};
	}

	buildLeadSpawnConfig(_ctx: LeadSpawnContext): LeadSpawnConfig {
		// Phase 1 locks Lead = claude-code (plan §4 Phase 3 / FLY-176 risk).
		// Loud failure beats a half-configured Codex Lead.
		throw new Error(
			"CodexAdapter.buildLeadSpawnConfig: Lead=codex is Phase 3 (FLY-123 plan §4) — not supported yet.",
		);
	}

	// ── Preflight ───────────────────────────────────────────────────────

	async preflight(opts?: { logger?: ILogger }): Promise<PreflightResult> {
		try {
			const version = this.execFileFn("codex", ["--version"]).trim();
			opts?.logger?.info?.("codex preflight ok", { version });
			return {
				ok: true,
				availabilitySignals: [
					{ kind: "ok", name: "codex:cli", detail: version },
				],
			};
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			opts?.logger?.warn?.("codex preflight failed", { detail });
			return {
				ok: false,
				availabilitySignals: [
					{ kind: "error", name: "codex:cli-not-found", detail },
				],
				message: `codex CLI not available: ${detail}`,
			};
		}
	}

	// ── Internals ───────────────────────────────────────────────────────

	private readInbox(inboxPath: string): CodexInboxFile {
		if (!existsSync(inboxPath)) return { messages: [] };
		try {
			const parsed = JSON.parse(readFileSync(inboxPath, "utf-8"));
			if (parsed && Array.isArray(parsed.messages)) {
				return parsed as CodexInboxFile;
			}
			return { messages: [] };
		} catch (err) {
			throw new MailboxWriteError(
				`corrupted codex inbox at ${inboxPath}: ${(err as Error).message}`,
				"corrupted_json",
				inboxPath,
				false,
			);
		}
	}

	private atomicWriteInbox(
		inboxPath: string,
		inbox: CodexInboxFile,
		recipient: string,
	): void {
		try {
			mkdirSync(dirname(inboxPath), { recursive: true, mode: 0o700 });
			const tmp = `${inboxPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
			writeFileSync(tmp, JSON.stringify(inbox, null, 2), {
				encoding: "utf-8",
				mode: 0o600,
			});
			renameSync(tmp, inboxPath);
		} catch (err) {
			throw new MailboxWriteError(
				`codex inbox write failed: ${(err as Error).message}`,
				"unknown",
				recipient,
				true,
				{ cause: err },
			);
		}
	}

	/** Exclusive advisory lock via O_EXCL lock file + bounded retries. */
	private async withLock<T>(
		inboxPath: string,
		recipient: string,
		fn: () => Promise<T>,
	): Promise<T> {
		mkdirSync(dirname(inboxPath), { recursive: true, mode: 0o700 });
		const lockPath = `${inboxPath}.lock`;
		let acquired = false;
		for (let i = 0; i < LOCK_RETRIES; i++) {
			try {
				const handle = await open(lockPath, "wx");
				await handle.close();
				acquired = true;
				break;
			} catch {
				await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
			}
		}
		if (!acquired) {
			throw new MailboxWriteError(
				`could not acquire codex inbox lock ${lockPath} after ${LOCK_RETRIES} retries`,
				"lock_timeout",
				recipient,
				true,
			);
		}
		try {
			return await fn();
		} finally {
			rmSync(lockPath, { force: true });
		}
	}
}

/**
 * External watcher for a Codex runner's mailbox (wakeMode external-watcher).
 *
 * Lifecycle owner: `CodexTmuxAdapter.execute()` (R1 #2). Detection is
 * fs.watch on the inbox directory (file may not exist yet) + a poll-loop
 * fallback. Dedupe is the persisted message id (`dedupeKey`) — a message is
 * delivered at most once per watcher instance, and `ack` persists delivery
 * across watcher restarts.
 */
export class CodexMailboxWatcher implements IMailboxWatcher {
	onDelivered?: (msg: MailboxMessage) => void | Promise<void>;

	private poller: ReturnType<typeof setInterval> | null = null;
	private fsWatcher: ReturnType<typeof watch> | null = null;
	private delivered = new Set<string>();
	private lastEventTs: number | undefined;
	private running = false;
	private scanInFlight = false;

	constructor(
		private readonly adapter: CodexAdapter,
		private readonly teamName: string,
		private readonly agentName: string,
		private readonly pollIntervalMs: number,
	) {}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;

		const inboxPath = this.adapter.getInboxPath(this.teamName, this.agentName);
		const dir = dirname(inboxPath);
		mkdirSync(dir, { recursive: true, mode: 0o700 });

		try {
			this.fsWatcher = watch(dir, () => {
				void this.scan();
			});
			this.fsWatcher.on("error", (err) => {
				// Some platforms report watch exhaustion asynchronously. Keep the
				// poll fallback alive and prevent an unhandled FSWatcher error.
				console.error(
					`[CodexMailboxWatcher] fs.watch failed for ${this.agentName}: ${err.message}`,
				);
				this.fsWatcher?.close();
				this.fsWatcher = null;
			});
		} catch {
			// fs.watch is best-effort — poller below is the reliable path.
		}
		this.poller = setInterval(() => {
			void this.scan();
		}, this.pollIntervalMs);
		await this.scan();
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.poller) clearInterval(this.poller);
		this.poller = null;
		this.fsWatcher?.close();
		this.fsWatcher = null;
	}

	async health(): Promise<MailboxWatcherHealth> {
		const result: MailboxWatcherHealth = { ok: this.running };
		if (this.lastEventTs !== undefined) result.lastEventTs = this.lastEventTs;
		return result;
	}

	private async scan(): Promise<void> {
		if (!this.running || this.scanInFlight) return;
		this.scanInFlight = true;
		try {
			const unread = await this.adapter.readUnread({
				leadName: this.teamName,
				agentName: this.agentName,
			});
			this.lastEventTs = Date.now();
			const fresh = unread.filter(
				(m) => !this.delivered.has(this.adapter.dedupeKey(m)),
			);
			if (fresh.length === 0) return;

			const acceptedIds: string[] = [];
			for (const msg of fresh) {
				try {
					await this.onDelivered?.(msg);
					this.delivered.add(this.adapter.dedupeKey(msg));
					this.lastEventTs = Date.now();
					acceptedIds.push(msg.id);
				} catch (err) {
					// Consumer callback failure must not kill the watcher loop —
					// but it must be LOUD (silent loss = stranded runner).
					console.error(
						`[CodexMailboxWatcher] onDelivered failed for ${msg.id}: ${(err as Error).message}`,
					);
				}
			}
			if (acceptedIds.length > 0) {
				await this.adapter.ack({
					leadName: this.teamName,
					agentName: this.agentName,
					messageIds: acceptedIds,
				});
			}
		} catch (err) {
			console.error(
				`[CodexMailboxWatcher] scan failed for ${this.agentName}: ${(err as Error).message}`,
			);
		} finally {
			this.scanInFlight = false;
		}
	}
}
