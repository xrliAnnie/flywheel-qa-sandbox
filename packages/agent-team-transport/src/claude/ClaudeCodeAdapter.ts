/**
 * ClaudeCodeAdapter — full IAgentTeamTransport implementation for the
 * stock claude-code Agent Team backend.
 *
 * Per plan v1.27.1 §2.0.4 (+ all R1-R5 revisions):
 *
 * - Spawn config: emits `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env +
 *   identity flags (`--agent-id`, `--agent-name`, `--team-name`,
 *   `--parent-session-id`, etc) per §2.2. Note: `--agent-teams` CLI flag is
 *   stripped from external builds (Spike α) — env var alone is sufficient.
 * - Wake mode: builtin-receiver — claude-code's internal `useInboxPoller`
 *   handles delivery, so `createReceiver()` returns null.
 * - Mailbox path: `<CLAUDE_CONFIG_DIR>/teams/<team>/inboxes/<agent>.json`
 *   (uses claude-code's native `CLAUDE_CONFIG_DIR` env — we deliberately
 *   do NOT introduce a competing `FLYWHEEL_TEAMS_*` env var per Codex r1
 *   high #5; that would create dual-truth-source paths that diverge from
 *   what stock useInboxPoller polls).
 * - Codec: `ClaudeMailboxCodec` writes stock-compatible
 *   `TeammateMessage[]` + sidecar `.flywheel.jsonl` for caller-provided
 *   idempotency keys.
 * - Preflight: lightweight (verify CLI on PATH + ephemeral codec round-trip).
 *   Full E2E spike-mailbox-wake.sh remains a separate integration test.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	getClaudeInboxPath,
	getClaudeSidecarPath,
	getStateDir,
} from "../path-helpers.js";
import {
	type AvailabilitySignal,
	type IAgentTeamTransport,
	type ILogger,
	type IMailboxWatcher,
	type LeadSpawnConfig,
	type LeadSpawnContext,
	type MailboxMessage,
	type MailboxPayload,
	MailboxWriteError,
	type MailboxWriteResult,
	type PreflightResult,
	type RunnerSpawnConfig,
	type RunnerSpawnContext,
	type TransportCapabilities,
} from "../types.js";
import {
	markEntriesAsReadUnderLock,
	readMailboxEntries,
	sidecarFindByFlywheelId,
	type TeammateMessage,
	writeMailboxEntry,
} from "./ClaudeMailboxCodec.js";

const execFileAsync = promisify(execFile);

/**
 * Optional per-instance overrides for spawn config (mostly for tests).
 * In production we read these from process.env.
 */
export interface ClaudeCodeAdapterOptions {
	/** Override `command claude` path (default: "claude" — found on PATH). */
	claudeCommand?: string;
	/** Maximum payload bytes per write — flywheel-imposed cap. */
	maxPayloadBytes?: number;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1_000_000;

export class ClaudeCodeAdapter implements IAgentTeamTransport {
	private readonly claudeCommand: string;
	private readonly maxPayloadBytes: number;

	constructor(options: ClaudeCodeAdapterOptions = {}) {
		this.claudeCommand = options.claudeCommand ?? "claude";
		this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
	}

	// ----------------------------------------------------------------------
	// Identity + capability
	// ----------------------------------------------------------------------

	vendorId(): string {
		return "claude-code";
	}

	capabilities(): TransportCapabilities {
		return {
			wakeMode: "builtin-receiver",
			preflightIsHardGate: true,
			preservesMetadata: true, // via sidecar
			maxPayloadBytes: this.maxPayloadBytes,
			requiresStableAgentIdentity: true,
		};
	}

	// ----------------------------------------------------------------------
	// Path resolution (vendor-aware helpers — production code uses these)
	// ----------------------------------------------------------------------

	getInboxPath(leadName: string, agentName: string): string {
		return getClaudeInboxPath(leadName, agentName);
	}

	getStateDir(): string {
		return getStateDir();
	}

	// ----------------------------------------------------------------------
	// IMailboxWriter
	// ----------------------------------------------------------------------

	async write(args: {
		leadName: string;
		recipient: string;
		payload: MailboxPayload;
	}): Promise<MailboxWriteResult> {
		this.validatePayloadSize(args.payload, args.recipient);

		const inboxPath = getClaudeInboxPath(args.leadName, args.recipient);
		const sidecarPath = getClaudeSidecarPath(args.leadName, args.recipient);

		const outcome = await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: args.payload.metadata?.flywheelId,
			payload: args.payload,
		});

		return {
			flywheelId: outcome.flywheelId,
			idempotent: outcome.idempotent,
			wroteAt: outcome.wroteAt,
			// Codex r2 PR 1.3 HIGH #1: surface finalized state so wrappers
			// (MailboxTransport.writeVerified) can distinguish durable
			// idempotent hits from in-flight pending hits.
			finalized: outcome.finalized,
		};
	}

	async verifyLastWrite(args: {
		leadName: string;
		recipient: string;
		expected: MailboxPayload;
	}): Promise<void> {
		// FLY-142 PR #186 Codex Round 1 HIGH: the original implementation
		// only checked `messages[messages.length - 1]`. Under concurrent
		// writers (e.g., Bridge fans out two ordinary-DM events back-to-back
		// for the same Runner), Writer A could finalize msg-A, Writer B
		// appends msg-B, A then verifies and sees B as last → false
		// `verify_mismatch` even though A's write durably landed.
		//
		// Fix in two layers:
		//
		// 1. **Sidecar lookup** — when caller provides a stable `flywheelId`
		//    in `expected.metadata` (MailboxLeadRuntime always does), check
		//    the sidecar for a `finalized` record. Two-phase sidecar plus
		//    the `finalized` flag give an authoritative "this specific
		//    write landed" answer that's race-free across concurrent writers.
		//
		// 2. **Main-file scan fallback** — when no flywheelId is available
		//    OR the sidecar lookup is inconclusive, scan ALL entries in the
		//    main inbox for a match on `(from, content)`. Doesn't rely on
		//    LAST entry, so concurrent writers no longer step on each other.
		const sidecarPath = getClaudeSidecarPath(args.leadName, args.recipient);
		const flywheelId =
			typeof args.expected.metadata?.flywheelId === "string"
				? args.expected.metadata.flywheelId
				: undefined;
		if (flywheelId) {
			const record = await sidecarFindByFlywheelId(sidecarPath, flywheelId);
			if (record?.status === "finalized") {
				return;
			}
			// Pending or missing — fall through to main scan in case sidecar
			// JSONL was truncated / the writer is mid-Phase-C.
		}

		const inboxPath = getClaudeInboxPath(args.leadName, args.recipient);
		const messages = await readMailboxEntries(inboxPath);
		const found = messages.some(
			(m) => m.from === args.expected.from && m.text === args.expected.content,
		);
		if (!found) {
			throw new MailboxWriteError(
				`verifyLastWrite mismatch for ${args.recipient}: expected from=${args.expected.from} content=${truncate(args.expected.content)} not found in inbox (${messages.length} entries${flywheelId ? `, sidecar flywheelId=${flywheelId} not finalized` : ""})`,
				"verify_mismatch",
				args.recipient,
				false,
			);
		}
	}

	// ----------------------------------------------------------------------
	// IMailboxReader
	// ----------------------------------------------------------------------

	async readUnread(args: {
		leadName: string;
		agentName: string;
	}): Promise<MailboxMessage[]> {
		const inboxPath = getClaudeInboxPath(args.leadName, args.agentName);
		const entries = await readMailboxEntries(inboxPath);
		return entries
			.filter((e) => !e.read)
			.map((e) => this.toMailboxMessage(e, args.agentName));
	}

	async ack(args: {
		leadName: string;
		agentName: string;
		messageIds: string[];
	}): Promise<void> {
		if (args.messageIds.length === 0) return;
		const inboxPath = getClaudeInboxPath(args.leadName, args.agentName);
		const idSet = new Set(args.messageIds);
		await markEntriesAsReadUnderLock({
			inboxPath,
			predicate: (entry) => idSet.has(this.deriveId(entry)),
		});
	}

	dedupeKey(message: MailboxMessage): string {
		// `message.id` is already vendor-stable (`${from}:${timestamp}`).
		return message.id;
	}

	private deriveId(entry: TeammateMessage): string {
		return `${entry.from}:${entry.timestamp}`;
	}

	private toMailboxMessage(
		entry: TeammateMessage,
		recipient: string,
	): MailboxMessage {
		return {
			id: this.deriveId(entry),
			from: entry.from,
			to: recipient,
			content: entry.text,
			ts: Date.parse(entry.timestamp),
			read: entry.read,
		};
	}

	// ----------------------------------------------------------------------
	// IReceiverWakeTransport
	// ----------------------------------------------------------------------

	createReceiver(_ctx: RunnerSpawnContext): IMailboxWatcher | null {
		// claude-code has builtin useInboxPoller — no external watcher needed.
		return null;
	}

	// ----------------------------------------------------------------------
	// IAgentSpawnTransport
	// ----------------------------------------------------------------------

	buildRunnerSpawnConfig(ctx: RunnerSpawnContext): RunnerSpawnConfig {
		const agentId = `${ctx.runnerName}@${ctx.teamName}`;
		// NOTE per Spike α: do NOT pass --agent-teams CLI flag (stripped from
		// external claude builds in v2.1.132+). Env var alone activates Agent
		// Team mode.
		const args: string[] = [
			"--agent-id",
			agentId,
			"--agent-name",
			ctx.runnerName,
			"--team-name",
			ctx.teamName,
		];
		if (ctx.parentSessionId !== undefined) {
			args.push("--parent-session-id", String(ctx.parentSessionId));
		}
		if (ctx.color !== undefined) {
			args.push("--agent-color", String(ctx.color));
		}
		if (ctx.sessionId !== undefined) {
			args.push("--session-id", String(ctx.sessionId));
		}
		if (ctx.permissionMode !== undefined) {
			args.push("--permission-mode", String(ctx.permissionMode));
		}

		return {
			args,
			env: this.runtimeEnv(),
		};
	}

	buildLeadSpawnConfig(ctx: LeadSpawnContext): LeadSpawnConfig {
		const agentId = `${ctx.leadName}@${ctx.teamName}`;
		const args: string[] = [
			"--agent-id",
			agentId,
			"--agent-name",
			ctx.leadName,
			"--team-name",
			ctx.teamName,
		];
		if (ctx.parentSessionId !== undefined) {
			args.push("--parent-session-id", String(ctx.parentSessionId));
		}

		return {
			args,
			env: this.runtimeEnv(),
		};
	}

	private runtimeEnv(): Record<string, string> {
		const env: Record<string, string> = {
			CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
			FLYWHEEL_AGENT_BACKEND: "claude-code",
		};
		// Pass through CLAUDE_CONFIG_DIR if set so the spawned process polls
		// the same teams dir we write to.
		const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		if (claudeConfigDir !== undefined && claudeConfigDir.length > 0) {
			env.CLAUDE_CONFIG_DIR = claudeConfigDir;
		}
		const flywheelStateDir = process.env.FLYWHEEL_STATE_DIR;
		if (flywheelStateDir !== undefined && flywheelStateDir.length > 0) {
			env.FLYWHEEL_STATE_DIR = flywheelStateDir;
		}
		return env;
	}

	// ----------------------------------------------------------------------
	// ITransportPreflight
	// ----------------------------------------------------------------------

	async preflight(opts?: { logger?: ILogger }): Promise<PreflightResult> {
		const signals: AvailabilitySignal[] = [];

		// 1. CLI presence
		try {
			const result = await execFileAsync(this.claudeCommand, ["--version"]);
			const version = result.stdout.trim();
			signals.push({
				kind: "ok",
				name: "claude-code:cli-version",
				detail: version,
			});
			// FLY-142 verify (2026-05-12): logger is optional per
			// ITransportPreflight contract. Use optional chaining — Bridge
			// `createLeadRuntime` legitimately calls `preflight()` without
			// an opts arg.
			opts?.logger?.info("[ClaudeCodeAdapter] CLI version detected", {
				version,
			});
		} catch (error) {
			signals.push({
				kind: "error",
				name: "claude-code:cli-not-found",
				detail: (error as Error).message,
			});
			return {
				ok: false,
				availabilitySignals: signals,
				message: `claude CLI not found on PATH: ${(error as Error).message}`,
			};
		}

		// 2. Codec round-trip on ephemeral inbox (validates filesystem +
		//    proper-lockfile + sidecar work in current environment).
		const probeDir = await mkdtemp(join(tmpdir(), "claude-adapter-preflight-"));
		try {
			const probePath = join(probeDir, "probe.json");
			const sidecar = `${probePath}.flywheel.jsonl`;
			await writeMailboxEntry({
				inboxPath: probePath,
				sidecarPath: sidecar,
				flywheelId: "preflight-probe",
				payload: {
					from: "preflight",
					to: "self",
					content: "preflight probe",
				},
			});
			const messages = await readMailboxEntries(probePath);
			if (messages.length !== 1) {
				signals.push({
					kind: "error",
					name: "claude-code:codec-roundtrip-failed",
					detail: `expected 1 message, got ${messages.length}`,
				});
				return {
					ok: false,
					availabilitySignals: signals,
					message: "Codec round-trip failed",
				};
			}
			signals.push({
				kind: "ok",
				name: "claude-code:codec-roundtrip-pass",
			});
		} finally {
			await rm(probeDir, { recursive: true, force: true });
		}

		return {
			ok: true,
			availabilitySignals: signals,
		};
	}

	// ----------------------------------------------------------------------
	// Helpers
	// ----------------------------------------------------------------------

	private validatePayloadSize(
		payload: MailboxPayload,
		recipient: string,
	): void {
		const size = Buffer.byteLength(payload.content, "utf-8");
		if (size > this.maxPayloadBytes) {
			throw new MailboxWriteError(
				`Payload size ${size} bytes exceeds adapter cap ${this.maxPayloadBytes} for recipient ${recipient}`,
				"unknown",
				recipient,
				false,
			);
		}
	}
}

function truncate(s: string, max = 80): string {
	return s.length > max ? `${s.slice(0, max)}...` : s;
}
