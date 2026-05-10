/**
 * CodexAdapter — STUB ONLY for Phase 0 (plan v1.27.1 §11).
 *
 * This stub exists to:
 * 1. Lock the `IAgentTeamTransport` interface so it doesn't drift toward
 *    claude-code specifics
 * 2. Make accidental production activation of Codex backend fail loud
 *    (every method throws "not implemented yet")
 * 3. Provide a compile-time anchor that future implementers can use to find
 *    every method that needs implementation
 *
 * Future implementation work is described in §11 of the plan and will land
 * in a separate ~1-2 week PR after Spike-δ validates Codex CLI session +
 * external watcher wake semantics.
 *
 * @see doc/engineer/plan/inprogress/v1.27.1-FLY-142-agent-team-full-mirror-vendor-neutral.md §11
 */

import type {
	IAgentTeamTransport,
	ILogger,
	IMailboxWatcher,
	LeadSpawnConfig,
	LeadSpawnContext,
	MailboxMessage,
	MailboxPayload,
	MailboxWriteResult,
	PreflightResult,
	RunnerSpawnConfig,
	RunnerSpawnContext,
	TransportCapabilities,
} from "../types.js";

const NOT_IMPLEMENTED_MSG =
	"CodexAdapter is not implemented yet. " +
	"See doc/engineer/plan/inprogress/v1.27.1-FLY-142-agent-team-full-mirror-vendor-neutral.md §11 " +
	"for the plug-in guide. Production activation requires Spike-δ first.";

/**
 * Stub adapter — every method throws. Never silently succeeds; never returns
 * a half-functional response.
 *
 * AgentTeamTransportFactory throws if `FLYWHEEL_AGENT_BACKEND=codex` is set,
 * to surface this loud at boot time. Constructor itself does NOT throw so
 * that compile-time imports succeed and the type still asserts the interface.
 */
export class CodexAdapter implements IAgentTeamTransport {
	vendorId(): string {
		return "codex";
	}

	capabilities(): TransportCapabilities {
		// Documented future capability shape (Spike-δ will validate). Do NOT
		// rely on these values until the adapter is fully implemented.
		throw new Error(NOT_IMPLEMENTED_MSG);
	}

	getInboxPath(_leadName: string, _agentName: string): string {
		throw new Error(NOT_IMPLEMENTED_MSG);
	}

	getStateDir(): string {
		throw new Error(NOT_IMPLEMENTED_MSG);
	}

	async write(_args: {
		leadName: string;
		recipient: string;
		payload: MailboxPayload;
	}): Promise<MailboxWriteResult> {
		throw new Error(NOT_IMPLEMENTED_MSG);
	}

	async verifyLastWrite(_args: {
		leadName: string;
		recipient: string;
		expected: MailboxPayload;
	}): Promise<void> {
		throw new Error(NOT_IMPLEMENTED_MSG);
	}

	async readUnread(_args: {
		leadName: string;
		agentName: string;
	}): Promise<MailboxMessage[]> {
		throw new Error(NOT_IMPLEMENTED_MSG);
	}

	async ack(_args: {
		leadName: string;
		agentName: string;
		messageIds: string[];
	}): Promise<void> {
		throw new Error(NOT_IMPLEMENTED_MSG);
	}

	dedupeKey(_message: MailboxMessage): string {
		throw new Error(NOT_IMPLEMENTED_MSG);
	}

	createReceiver(_ctx: RunnerSpawnContext): IMailboxWatcher | null {
		throw new Error(NOT_IMPLEMENTED_MSG);
	}

	buildRunnerSpawnConfig(_ctx: RunnerSpawnContext): RunnerSpawnConfig {
		throw new Error(NOT_IMPLEMENTED_MSG);
	}

	buildLeadSpawnConfig(_ctx: LeadSpawnContext): LeadSpawnConfig {
		throw new Error(NOT_IMPLEMENTED_MSG);
	}

	async preflight(_opts: { logger: ILogger }): Promise<PreflightResult> {
		throw new Error(NOT_IMPLEMENTED_MSG);
	}
}
