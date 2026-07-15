/**
 * headphone — FLY-546 离屏推进 pure-logic layer (PRD §17).
 * Everything here is I/O-free: the voice-headphone daemon composes these
 * with Discord gateway / Bridge / audio adapters.
 */
export {
	APPROVE_INTENT,
	CONFIRM,
	DENY,
	matchPhrase,
	normalizePhrase,
	OPEN_WORD,
	PAUSE,
	REPLY,
	SKIP,
	STOP_WORD,
} from "./phrases.js";
export {
	HeadphoneQueue,
	type HeadphoneQueueOptions,
	type QueueItem,
	type QueueSnapshot,
} from "./queue.js";
export {
	shouldEnqueue,
	type TapConfig,
	type TapMessage,
} from "./tap-filter.js";
export {
	formatHeadline,
	type GraceInfo,
	type HeadphoneIO,
	HeadphoneTurnMachine,
	type ItemPhase,
	type ModeOffReason,
	type PersistedTurnState,
	type TimerHost,
	type TurnEvent,
	type TurnMachineOptions,
	type TurnState,
	type Vocabulary,
} from "./turn-machine.js";
export { VoiceDirectory } from "./voice-directory.js";
