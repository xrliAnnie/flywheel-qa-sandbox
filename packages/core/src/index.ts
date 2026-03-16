// Async primitives
export { Semaphore } from "./Semaphore.js";
export { ProjectLock } from "./ProjectLock.js";

// Hook callback interface (cross-package boundary)
export type { IHookCallbackServer } from "./hook-callback-types.js";

// Logging

export type { ILogger, LogContext } from "./logging/index.js";
export { createLogger, LogLevel } from "./logging/index.js";

// export { Session } from './Session.js'
// export type { SessionOptions, , NarrativeItem } from './Session.js'
// export { ClaudeSessionManager as SessionManager } from './ClaudeSessionManager.js'

// Agent Runner types
export type {
	AgentMessage,
	AgentRunnerConfig,
	AgentSessionInfo,
	AgentUserMessage,
	AskUserQuestion,
	AskUserQuestionAnswers,
	AskUserQuestionInput,
	AskUserQuestionOption,
	AskUserQuestionResult,
	HookCallbackMatcher,
	HookEvent,
	IAgentRunner,
	IMessageFormatter,
	McpServerConfig,
	OnAskUserQuestion,
	SDKAssistantMessage,
	SDKAssistantMessageError,
	SDKMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "./agent-runner-types.js";
export type {
	CyrusAgentSession,
	CyrusAgentSessionEntry,
	IssueContext,
	IssueMinimal,
	Workspace,
} from "./CyrusAgentSession.js";

// Configuration types
export type {
	EdgeConfig,
	EdgeConfigPayload,
	EdgeWorkerConfig,
	OAuthCallbackHandler,
	RepositoryConfig,
	RepositoryConfigPayload,
	UserAccessControlConfig,
	UserIdentifier,
} from "./config-types.js";
export {
	EdgeConfigPayloadSchema,
	// Zod schemas for runtime validation
	EdgeConfigSchema,
	RepositoryConfigPayloadSchema,
	RepositoryConfigSchema,
	resolvePath,
	UserAccessControlConfigSchema,
	UserIdentifierSchema,
} from "./config-types.js";

// Constants
export {
	DEFAULT_BASE_BRANCH,
	DEFAULT_CONFIG_FILENAME,
	DEFAULT_PROXY_URL,
	DEFAULT_WORKTREES_DIR,
	FLYWHEEL_MARKER_DIR,
} from "./constants.js";
// Issue Tracker Abstraction
export type {
	AgentActivity,
	AgentActivityContent,
	AgentActivityCreateInput,
	AgentActivityPayload,
	AgentActivitySDK,
	AgentEvent,
	AgentEventTransportConfig,
	AgentEventTransportEvents,
	AgentSession,
	AgentSessionCreatedWebhook,
	AgentSessionCreateOnCommentInput,
	AgentSessionCreateOnIssueInput,
	AgentSessionCreateResponse,
	AgentSessionPromptedWebhook,
	AgentSessionSDK,
	Comment,
	CommentCreateInput,
	CommentWithAttachments,
	Connection,
	FetchChildrenOptions,
	FileUploadRequest,
	FileUploadResponse,
	GuidanceRule,
	IAgentEventTransport,
	IIssueTrackerService,
	Issue,
	IssueRelation,
	IssueUnassignedWebhook,
	IssueUpdateInput,
	IssueUpdateWebhook,
	IssueWithChildren,
	Label,
	PaginationOptions,
	Team,
	User,
	Webhook,
	WebhookAgentSession,
	WebhookComment,
	WebhookIssue,
	WorkflowState,
} from "./issue-tracker/index.js";
export {
	AgentActivityContentType,
	AgentActivitySignal,
	AgentSessionStatus,
	AgentSessionType,
	CLIEventTransport,
	CLIIssueTrackerService,
	CLIRPCServer,
	isAgentSessionCreatedEvent,
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedEvent,
	isAgentSessionPromptedWebhook,
	isCommentMentionEvent,
	isIssueAssignedEvent,
	isIssueAssignedWebhook,
	isIssueCommentMentionWebhook,
	isIssueNewCommentWebhook,
	isIssueTitleOrDescriptionUpdateWebhook,
	isIssueUnassignedEvent,
	isIssueUnassignedWebhook,
	isNewCommentEvent,
} from "./issue-tracker/index.js";
// Internal Message Bus
export type {
	ContentChanges,
	ContentUpdateMessage,
	GitHubPlatformRef,
	GitHubSessionStartPlatformData,
	GitHubUserPromptPlatformData,
	GuidanceItem,
	IMessageTranslator,
	InternalMessage,
	InternalMessageBase,
	LinearContentUpdatePlatformData,
	LinearPlatformRef,
	LinearSessionStartPlatformData,
	LinearStopSignalPlatformData,
	LinearUnassignPlatformData,
	LinearUserPromptPlatformData,
	MessageAction,
	MessageAuthor,
	MessageSource,
	SessionStartMessage,
	SlackPlatformRef,
	SlackSessionStartPlatformData,
	SlackUserPromptPlatformData,
	StopSignalMessage,
	TranslationContext,
	TranslationResult,
	UnassignMessage,
	UserPromptMessage,
} from "./messages/index.js";
export {
	hasGitHubSessionStartPlatformData,
	hasGitHubUserPromptPlatformData,
	hasLinearSessionStartPlatformData,
	hasLinearUserPromptPlatformData,
	hasSlackSessionStartPlatformData,
	hasSlackUserPromptPlatformData,
	isContentUpdateMessage,
	isGitHubMessage,
	isLinearMessage,
	isSessionStartMessage,
	isSlackMessage,
	isStopSignalMessage,
	isUnassignMessage,
	isUserPromptMessage,
} from "./messages/index.js";
// Linear adapters have been moved to flywheel-linear-event-transport package
// Import them directly from that package instead of from flywheel-core
export type {
	SerializableEdgeWorkerState,
	SerializedCyrusAgentSession,
	SerializedCyrusAgentSessionEntry,
} from "./PersistenceManager.js";
export {
	PERSISTENCE_VERSION,
	PersistenceManager,
} from "./PersistenceManager.js";
export { StreamingPrompt } from "./StreamingPrompt.js";

// Adapter types (GEO-157 — unified IAdapter protocol)
export type {
	AdapterConfig,
	AdapterExecutionContext,
	AdapterExecutionResult,
	AdapterHealthCheck,
	AdapterSession,
	ClaudeAdapterConfig,
	IAdapter,
} from "./adapter-types.js";
export { AdapterRegistry } from "./AdapterRegistry.js";

// Simple Agent Runner types
/** @deprecated Use IAdapter instead (GEO-157). Will be removed in Wave 6. */
export type {
	IAgentProgressEvent,
	ISimpleAgentQueryOptions,
	ISimpleAgentResult,
	ISimpleAgentRunner,
	ISimpleAgentRunnerConfig,
} from "./simple-agent-runner-types.js";

// Flywheel Runner types — compat re-exports (GEO-157 Wave 6 cleanup)
/** @deprecated Use IAdapter + AdapterExecutionContext instead (GEO-157). */
export type {
	FlywheelRunRequest,
	FlywheelRunResult,
	IFlywheelRunner,
} from "./flywheel-runner-types.js";
/** @deprecated Use AdapterRegistry instead (GEO-157). */
export { FlywheelRunnerRegistry } from "./FlywheelRunnerRegistry.js";

// Flywheel Error types (v0.2 Step 2b)
export type { FlywheelError, RetryPolicy } from "./flywheel-error-types.js";
export {
	isRetryable,
	retryDelay,
	DEFAULT_RETRY_POLICY,
} from "./flywheel-error-types.js";

// Decision Layer types (v0.2 Step 2b)
export type {
	DecisionRoute,
	DecisionSource,
	ExecutionContext,
	DecisionResult,
	VerificationResult,
	HardRuleResult,
	LandingStatus,
} from "./decision-types.js";

// LLM Client interface (v0.2 Step 2b — model agnostic)
export type { LLMClient } from "./llm-client-types.js";
// Platform-agnostic webhook type aliases - exported from issue-tracker
// These are now defined in issue-tracker/types.ts as aliases to Linear SDK webhook types
// EdgeWorker and other high-level code should use these generic names via issue-tracker exports
