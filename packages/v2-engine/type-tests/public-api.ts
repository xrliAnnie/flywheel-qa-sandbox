import {
	type AttemptHandle,
	type Candidate,
	type CandidateLane,
	type CandidateSet,
	type ConsumerAuthority,
	type ConversionActionSpec,
	type ConversionContext,
	type ConversionProposal,
	type ConversionResult,
	type Converter,
	DEFAULT_ENGINE_CONFIG,
	type Effect,
	type EngineClock,
	type EngineConfig,
	EngineDriver,
	type EngineRuntime,
	type EnqueueResult,
	type IdentityDraft,
	type LeadIdentityDraft,
	type MailboxEnvelope,
	type PollResult,
	type RegisteredAgent,
	reportConversionFailure,
	selectNext,
	submitProposal,
} from "flywheel-v2-engine";

declare const handle: AttemptHandle;
declare const candidate: Candidate;
declare const lane: CandidateLane;
declare const candidates: CandidateSet;
declare const authority: ConsumerAuthority;
declare const action: ConversionActionSpec;
declare const context: ConversionContext;
declare const effect: Effect;
declare const enqueueResult: EnqueueResult;
declare const envelope: MailboxEnvelope;
declare const clock: EngineClock;
declare const config: EngineConfig;
declare const runtime: EngineRuntime;
declare const draft: IdentityDraft;
declare const leadDraft: LeadIdentityDraft;
declare const registered: RegisteredAgent;
declare const poll: PollResult;
declare const proposal: ConversionProposal;
declare const result: ConversionResult;
declare const converter: Converter;

void handle;
void candidate;
void lane;
void candidates;
void authority;
void action;
void context;
void effect;
void enqueueResult;
void envelope;
void clock;
void config;
void runtime;
void draft;
void leadDraft;
void registered;
void poll;
void proposal;
void result;
void converter;
void EngineDriver;
void DEFAULT_ENGINE_CONFIG;
void selectNext;
void reportConversionFailure;
void submitProposal;
void context.performAction(action, () => ({ ok: true }));
void new EngineDriver({} as never, runtime).performConversionAction(
	handle,
	action,
	() => ({ ok: true }),
);

const commandEffect: Effect = {
	// @ts-expect-error command effects retired in favor of conversion actions.
	kind: "command",
	commandKind: "legacy",
	payload: "{}",
	effectKey: "legacy",
};
void commandEffect;

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
