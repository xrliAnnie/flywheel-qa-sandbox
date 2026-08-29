export type { ReadFileFn } from "./ConfigLoader.js";
export { ConfigLoader } from "./ConfigLoader.js";
export {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "./canonical-json.js";
export type { CommBackend } from "./comm-backend.js";
export { resolveCommBackend } from "./comm-backend.js";
export {
	DEFAULT_GATE_TIMEOUT_MS,
	DEFAULT_TIMEOUT_BEHAVIOR,
	GATE_TIMEOUT_BUFFER_MS,
	MIN_GATE_TIMEOUT_MS,
} from "./constants.js";
export type { DecisionMode, DecisionModeEnv } from "./decision-mode.js";
export { resolveDecisionMode } from "./decision-mode.js";
export { isUiDesignFlavored, UI_DESIGN_LABELS } from "./designer-labels.js";
export type {
	FeatureFlagSpec,
	FlagCategory,
	FlagEffectiveByProject,
	FlagPolarity,
	FlagReadSite,
	FlagResolveCtx,
	FlagScope,
	FlagSource,
	FlagToggleability,
	FlagValueKind,
	FlagView,
	ReadTiming,
} from "./feature-flags/index.js";
export {
	FEATURE_FLAGS,
	resolveAllFlags,
	resolveFlag,
} from "./feature-flags/index.js";
// FLY-869: founder-UX gate resolution choke point (absent config → enforce).
// FLY-900: fleet-wide kill-switch helper (isFounderUxGateEnabled) — default OFF.
export type { EffectiveFounderUxGateConfig } from "./founder-ux-config.js";
export {
	DEFAULT_FOUNDER_UX_EXEMPT_LABELS,
	isFounderUxGateEnabled,
	resolveEffectiveFounderUxConfig,
} from "./founder-ux-config.js";
// FLY-728: per-issue model routing — tier vocabulary (dispatch whitelist +
// tier→model default + F/O/S/H short code).
export type { ModelTier, ModelTierSpec } from "./model-tiers.js";
export {
	ACCEPTED_DISPATCH_MODELS,
	MODEL_TIERS,
	modelDisplayName,
	modelShortCode,
	normalizeDispatchModel,
} from "./model-tiers.js";
export type {
	PonytailCondition,
	PonytailEffective,
	PonytailInput,
	PonytailRequested,
	PonytailRetryPlan,
	PonytailRunSignal,
	PonytailSource,
	PonytailWant,
	ResolvePonytailResult,
} from "./ponytail.js";
export {
	decodePonytailConditionForRetry,
	PONYTAIL_CONFLICT,
	PONYTAIL_LABEL_OFF,
	PONYTAIL_LABEL_ON,
	PONYTAIL_PLUGIN,
	PONYTAIL_SELECTOR_UNAVAILABLE,
	PonytailLabelConflictError,
	resolvePonytailRequested,
	toPonytailCondition,
} from "./ponytail.js";
export { PONYTAIL_RULESET } from "./ponytail-ruleset.js";
export {
	type ProgressPathInput,
	resolveProgressPath,
} from "./progress-path-resolver.js";
// FLY-795: shared progress.md ledger schema (795 owns; 793 consumes on handoff).
export type {
	ChunkStatus,
	ProgressChunk,
	ProgressLedger,
	ProgressPointers,
} from "./progress-schema.js";
export {
	parseProgress,
	renderProgress,
	stageToPhase,
} from "./progress-schema.js";
export {
	DEFAULT_PROOFSHOT_CAPTURE_ANGLES,
	DEFAULT_PROOFSHOT_CAPTURE_STAGES,
	DEFAULT_PROOFSHOT_CONFIG,
	DEFAULT_PROOFSHOT_PATH_ALLOWLIST,
	DEFAULT_PROOFSHOT_VISION_TOKEN_BUDGET,
} from "./proofshot-defaults.js";
// FLY-1188 §7.3: family-aware review authority (reviewer-inversion invariant)
export {
	adapterTypeToFamily,
	type CrossFamilyReviewInput,
	crossFamilyReviewSatisfied,
	manifestReviewFamilyOk,
} from "./review-family.js";
// FLY-709 P4.3/P4.4: per-project runner-default / cron-model config writer.
export type {
	ApplyResult,
	CronModelChange,
	RunnerDefaultsChange,
} from "./runner-config-writer.js";
export {
	applyCronModel,
	applyRunnerDefaults,
	configContentSha,
	RunnerConfigStaleError,
	withConfigFileLock,
} from "./runner-config-writer.js";
export type {
	RunnerLabelSelection,
	RunnerVendorType,
} from "./runner-label.js";
export { parseRunnerLabels } from "./runner-label.js";
// FLY-751: per-runner MCP slimming — pure profile resolver consumed by the
// dispatcher (claude-tmux runner spawns only).
export type {
	ResolveRunnerMcpProfileArgs,
	RunnerMcpProfile,
} from "./runner-mcp-profile.js";
export {
	DEFAULT_RUNNER_DISABLED_PLUGINS,
	resolveRunnerMcpProfile,
} from "./runner-mcp-profile.js";
// FLY-793: three-stage pipeline phase model tiers.
// FLY-1224: per-phase vendor dispatch table (vendor + model + effort).
export type {
	PhaseDispatchSpec,
	PhaseDispatchVendor,
	ThreeStagePhase,
} from "./three-stage-phases.js";
export {
	DEFAULT_PHASE_DISPATCH,
	DEFAULT_PHASE_TIER,
	isThreeStagePhaseRole,
	nextPhase,
	PHASE_THREAD_BADGE,
	PHASE_THREAD_BADGE_PARTS,
	phaseMessageTag,
	phaseThreadBadge,
	resolveCompletionSessionRole,
	resolvePhaseDispatch,
	resolvePhaseModel,
	THREE_STAGE_PHASE_SEQUENCE,
} from "./three-stage-phases.js";
export type {
	AgentConfig,
	AgentNodeConfig,
	AutonomyLevel,
	CheckpointConfig,
	CheckpointsConfig,
	CIConfig,
	CleanupConfig,
	DecisionLayerConfig,
	DocFlowConfig,
	ExecutorBackend,
	FlywheelConfig,
	FounderMilestoneReportConfig,
	FounderUxGateConfig,
	FounderUxGateMode,
	MilestoneKind,
	OrchestratorConfig,
	ParallelConfig,
	PipelineConfig,
	PonytailConfig,
	ProofShotConfig,
	ReactionsConfig,
	RoleBackendConfig,
	RoleBackendMap,
	RoleEffort,
	RoleName,
	RunnerConfig,
	SkillsConfig,
	TeamConfig,
	TimeoutBehavior,
	XiaohongshuCadence,
	XiaohongshuCollectionConfig,
	XiaohongshuLearningConfig,
	XiaohongshuReviewChannel,
} from "./types.js";
export {
	EXECUTOR_BACKENDS,
	FOUNDER_UX_GATE_DEFAULT_MODE,
	FOUNDER_UX_GATE_MODES,
	ROLE_EFFORT_LEVELS,
	ROLE_NAMES,
	SUPPORTED_MILESTONE_KINDS_V1,
	XIAOHONGSHU_CADENCES,
	XIAOHONGSHU_DEFAULT_FIRST_RUN_CAP,
	XIAOHONGSHU_DEFAULT_MAX_FETCH,
	XIAOHONGSHU_DEFAULT_REVIEW_CHANNEL,
	XIAOHONGSHU_MAX_FETCH_CEILING,
	XIAOHONGSHU_REVIEW_CHANNELS,
} from "./types.js";
