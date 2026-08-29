/**
 * FLY-1018 flywheel-gemini-agent — public surface.
 *
 * Entry shells (CLI / Discord daemon / voice delegate) are thin; everything
 * runs through runAgentSession.
 */

export { digest, JsonlAuditLog } from "./audit.js";
export { createModelSurface, type RawGenAi } from "./client.js";
export {
	type AgentConfig,
	ConfigError,
	loadAgentConfig,
	MODEL_IDS,
} from "./config.js";
export { assembleSystemPrompt } from "./context.js";
export {
	type CompletionSink,
	createDelegateTool,
	createDiscordCompletionSink,
	type DelegateToolOptions,
} from "./delegate.js";
export {
	type ChannelBinding,
	loadBindings,
	parseBindings,
} from "./discord/bindings.js";
export {
	COMMAND_DEFINITION,
	COMMAND_NAME,
	createInteractionHandler,
} from "./discord/daemon.js";
export { chunkMessage } from "./discord/render.js";
export { runLoop } from "./loop.js";
export {
	type AgentSessionOptions,
	runAgentSession,
	type SessionResult,
} from "./session.js";
export { BridgeClient, isWhitelistedEndpoint } from "./tools/bridge-client.js";
export {
	createToolRegistry,
	registryFor,
	type SessionBinding,
	validateArgs,
} from "./tools/registry.js";
export { TOOL_DECLARATIONS } from "./tools/schemas.js";
export { truncateResult } from "./truncate.js";
export type {
	AgentEvent,
	AgentState,
	AuditLog,
	JsonSchema,
	ModelSurface,
	ModelTurn,
	SessionStats,
	Terminal,
	TerminalReason,
	ToolResult,
	ToolSpec,
} from "./types.js";
