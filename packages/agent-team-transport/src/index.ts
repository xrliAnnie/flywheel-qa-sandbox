/**
 * Public API for the vendor-neutral transport adapter package.
 *
 * Per plan v1.27.1 §2.0, all production code outside this package
 * imports the **types** from here and the **concrete adapter** via
 * `AgentTeamTransportFactory.fromEnv()` (selected by
 * `FLYWHEEL_AGENT_BACKEND` env, default `claude-code`).
 */

// Factory (production callers — selects adapter from env)
export {
	AgentTeamTransportFactory,
	type FactoryOptions,
	type SupportedBackend,
} from "./AgentTeamTransportFactory.js";
// Adapters (production callers should prefer Factory; direct imports OK for
// tests and migration code that has explicit vendor coupling)
export {
	ClaudeCodeAdapter,
	type ClaudeCodeAdapterOptions,
} from "./claude/ClaudeCodeAdapter.js";
// claude/team-bootstrap helpers (used by edge-worker / teamlead via adapter,
// but exported here for code that needs direct TeamFile schema access).
export {
	type AddMemberArgs,
	addMember,
	type EnsureTeamArgs,
	ensureTeam,
	getTeamFilePath,
	type RemoveMemberArgs,
	readTeamFile,
	removeMember,
	sanitizeName,
	type TeamFile,
	type TeamMember,
} from "./claude/team-bootstrap.js";
export { CodexAdapter } from "./codex/CodexAdapter.js";
// Path helpers (vendor-neutral parts only — claude-specific helpers stay in claude/)
export { deriveRunnerMailboxIdentity, getStateDir } from "./path-helpers.js";
// Types (vendor-neutral)
export type {
	AvailabilitySignal,
	IAgentSpawnTransport,
	IAgentTeamTransport,
	ILogger,
	IMailboxReader,
	IMailboxWatcher,
	IMailboxWriter,
	IReceiverWakeTransport,
	ITransportPreflight,
	LeadSpawnConfig,
	LeadSpawnContext,
	MailboxMessage,
	MailboxMetadata,
	MailboxPayload,
	MailboxWatcherHealth,
	MailboxWriteResult,
	PreflightResult,
	RunnerSpawnConfig,
	RunnerSpawnContext,
	TransportCapabilities,
} from "./types.js";
export { MailboxWriteError } from "./types.js";
