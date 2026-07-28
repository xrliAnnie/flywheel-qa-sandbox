import {
	type AttemptHandle,
	type Candidate,
	type CandidateLane,
	type CandidateSet,
	type ClaudeInjectionSessionRef,
	ClaudeInjectionShim,
	type CodexInjectionSessionRef,
	CodexInjectionShim,
	type CodexInjectionShimOptions,
	type ConsumerAuthority,
	type ConversionProposal,
	type ConversionResult,
	type Converter,
	DEFAULT_ENGINE_CONFIG,
	type DeathEvidence,
	type Effect,
	type EngineClock,
	type EngineConfig,
	EngineDriver,
	type EngineRuntime,
	type EnqueueResult,
	type IdentityDraft,
	type InjectionShim,
	type LeadIdentityDraft,
	type MailboxEnvelope,
	type PollResult,
	type RegisteredAgent,
	type RunnerIdentityDraft,
	selectNext,
} from "flywheel-v2-engine";

declare const handle: AttemptHandle;
declare const claudeSessionRef: ClaudeInjectionSessionRef;
declare const codexSessionRef: CodexInjectionSessionRef;
declare const codexShimOptions: CodexInjectionShimOptions;
declare const candidate: Candidate;
declare const lane: CandidateLane;
declare const candidates: CandidateSet;
declare const authority: ConsumerAuthority;
declare const evidence: DeathEvidence;
declare const effect: Effect;
declare const enqueueResult: EnqueueResult;
declare const envelope: MailboxEnvelope;
declare const clock: EngineClock;
declare const config: EngineConfig;
declare const runtime: EngineRuntime;
declare const draft: IdentityDraft;
declare const shim: InjectionShim;
declare const leadDraft: LeadIdentityDraft;
declare const registered: RegisteredAgent;
declare const runnerDraft: RunnerIdentityDraft;
declare const poll: PollResult;
declare const proposal: ConversionProposal;
declare const result: ConversionResult;
declare const converter: Converter;

void handle;
void claudeSessionRef;
void codexSessionRef;
void codexShimOptions;
void candidate;
void lane;
void candidates;
void authority;
void evidence;
void effect;
void enqueueResult;
void envelope;
void clock;
void config;
void runtime;
void draft;
void shim;
void leadDraft;
void registered;
void runnerDraft;
void poll;
void proposal;
void result;
void converter;
void ClaudeInjectionShim;
void CodexInjectionShim;
void EngineDriver;
void DEFAULT_ENGINE_CONFIG;
void selectNext;

// @ts-expect-error AttemptStart was replaced by PollResult.
type AttemptStart = import("flywheel-v2-engine").AttemptStart;
// @ts-expect-error RegisteredConsumer was renamed RegisteredAgent.
type RegisteredConsumer = import("flywheel-v2-engine").RegisteredConsumer;
type EngineModule = typeof import("flywheel-v2-engine");
// @ts-expect-error removed timer/ring coordinator is not public.
type ConsumerCoordinator = EngineModule["ConsumerCoordinator"];
// @ts-expect-error SQL assembly is package-private.
type EngineSql = EngineModule["ENGINE_SQL"];

void (undefined as unknown as ConsumerCoordinator);
void (undefined as unknown as EngineSql);
void (undefined as unknown as AttemptStart);
void (undefined as unknown as RegisteredConsumer);
