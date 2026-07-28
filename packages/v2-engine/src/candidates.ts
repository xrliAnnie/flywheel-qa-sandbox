import type { EngineConfig } from "./types.js";

export type CandidateLane = "F1" | "F2" | "N1" | "N2";

export interface Candidate {
	lane: CandidateLane;
	seq: number;
	messageUid: string;
	payload: string;
	createdAt: string;
}

export interface CandidateSet {
	f1?: Candidate;
	f2?: Candidate;
	n1?: Candidate;
	n2?: Candidate;
}

function timestamp(candidate: Candidate): number {
	const value = Date.parse(candidate.createdAt);
	if (!Number.isFinite(value)) {
		throw new TypeError(
			`candidate ${candidate.messageUid} has invalid createdAt`,
		);
	}
	return value;
}

function oldest(candidates: Candidate[]): Candidate {
	const sorted = [...candidates].sort((left, right) => {
		const byCreatedAt = timestamp(left) - timestamp(right);
		return byCreatedAt === 0 ? left.seq - right.seq : byCreatedAt;
	});
	const first = sorted[0];
	if (!first) {
		throw new TypeError("oldest requires at least one candidate");
	}
	return first;
}

function isFounder(candidate: Candidate): boolean {
	return candidate.lane === "F1" || candidate.lane === "F2";
}

export function selectNext(
	candidates: CandidateSet,
	founderStreak: number,
	nowMs: number,
	config: EngineConfig,
): { pick: Candidate; nextStreak: number } | null {
	if (!Number.isInteger(founderStreak) || founderStreak < 0) {
		throw new TypeError("founderStreak must be a non-negative integer");
	}
	if (!Number.isFinite(nowMs)) {
		throw new TypeError("nowMs must be finite");
	}

	const nonFounder = [candidates.n1, candidates.n2].filter(
		(candidate): candidate is Candidate => candidate !== undefined,
	);
	const founder = [candidates.f1, candidates.f2].filter(
		(candidate): candidate is Candidate => candidate !== undefined,
	);
	if (nonFounder.length === 0 && founder.length === 0) {
		return null;
	}
	if (founderStreak >= config.vipBurst && nonFounder.length > 0) {
		return { pick: oldest(nonFounder), nextStreak: 0 };
	}

	const promoted = nonFounder.filter(
		(candidate) => nowMs - timestamp(candidate) > config.promotionAgeMs,
	);
	const founderClass = [...founder, ...promoted];
	if (founderClass.length > 0) {
		const pick = oldest(founderClass);
		return {
			pick,
			nextStreak: isFounder(pick)
				? Math.min(founderStreak + 1, config.vipBurst)
				: 0,
		};
	}
	return { pick: oldest(nonFounder), nextStreak: 0 };
}
