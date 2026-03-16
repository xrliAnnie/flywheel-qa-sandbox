/**
 * CIPHER module — barrel export.
 */

export { CipherWriter } from "./CipherWriter.js";
export { CipherReader } from "./CipherReader.js";
export { extractDimensions } from "./dimensions.js";
export {
	generatePatternKeys,
	getFallbackOrder,
} from "./pattern-keys.js";
export {
	posteriorMean,
	wilsonLowerBound,
	maturityLevel,
	classifyOutcome,
	shouldInjectPattern,
} from "./statistics.js";
export type {
	PatternDimensions,
	SnapshotParams,
	OutcomeParams,
	CipherContext,
	PatternStatistics,
	SnapshotInputDto,
	CipherProposalPayload,
	CipherNotifyFn,
	CipherPrinciple,
	CipherSkill,
	CipherQuestion,
} from "./types.js";
