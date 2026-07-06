/**
 * CIPHER module — barrel export.
 */

export { CipherReader } from "./CipherReader.js";
export { CipherWriter } from "./CipherWriter.js";
export { extractDimensions } from "./dimensions.js";
export {
	generatePatternKeys,
	getFallbackOrder,
} from "./pattern-keys.js";
export {
	classifyOutcome,
	maturityLevel,
	posteriorMean,
	shouldInjectPattern,
	wilsonLowerBound,
} from "./statistics.js";
export type {
	CipherContext,
	CipherNotifyFn,
	CipherPrinciple,
	CipherProposalPayload,
	CipherQuestion,
	CipherSkill,
	OutcomeParams,
	PatternDimensions,
	PatternStatistics,
	SnapshotInputDto,
	SnapshotParams,
} from "./types.js";
