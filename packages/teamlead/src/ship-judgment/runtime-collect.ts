import type { lookupLinearIssueByIdentifier } from "../bridge/linear-query.js";
import type {
	RecordUrlClassificationOptions,
	StrengthTwoReportRegistry,
} from "../bridge/strength-two-probes.js";
import type { StateStore } from "../StateStore.js";
import {
	type CollectionResult,
	collectJudgmentInput,
	type SupplementalSource,
} from "./collect.js";
import { canonicalDigest, type ShipJudgmentBinding } from "./contract.js";
import type { FrozenGitReader } from "./git-input.js";
import { readJudgmentIssueSource } from "./issue-source.js";
import { readReviewedPlanSource } from "./plan-source.js";
import { readHostedQaSource } from "./qa-source.js";
import {
	JUDGMENT_PROMPT,
	judgmentModelSnapshot,
} from "./subscription-evaluator.js";
import { readReviewedSupplements } from "./supplement-source.js";

export interface PreparedJudgmentGit {
	repoIdentity: string;
	repoSlug: string;
	prNumber: number;
	headSha: string;
	diffBaseSha: string;
	reader(
		signal: AbortSignal,
	): Pick<FrozenGitReader, "readText" | "diff" | "listTextFiles">;
}
export interface LiveCollectionDependencies {
	store: Pick<
		StateStore,
		| "readShipJudgmentBinding"
		| "readShipJudgmentPlanReference"
		| "listStrengthTwoRecordsForHead"
	>;
	linearApiKey: string;
	planRepoIdentity: string;
	git: PreparedJudgmentGit[];
	registry: Pick<StrengthTwoReportRegistry, "readReportHtml">;
	hosting: RecordUrlClassificationOptions;
	lookupIssue?: typeof lookupLinearIssueByIdentifier;
	supplements?(signal: AbortSignal): Promise<SupplementalSource[]>;
}

/** Compose production read adapters around one live binding and caller-prepared isolated Git objects. */
export async function collectLiveJudgment(
	questionId: string,
	channelId: string,
	deps: LiveCollectionDependencies,
	signal?: AbortSignal,
): Promise<CollectionResult> {
	const binding = deps.store.readShipJudgmentBinding(questionId, channelId);
	if (!binding) return { status: "undetermined", reason: "binding_missing" };
	const reference = deps.store.readShipJudgmentPlanReference(
		binding.runId,
		deps.planRepoIdentity,
	);
	const planTargets = binding.targets.filter(
		(target) => target.repo_identity === deps.planRepoIdentity,
	);
	if (planTargets.length !== 1)
		return { status: "undetermined", reason: "plan_target_ambiguous" };
	const gitFor = (target: ShipJudgmentBinding["targets"][number]) => {
		const candidates = deps.git.filter(
			(git) =>
				git.repoIdentity === target.repo_identity &&
				git.repoSlug === target.repo_slug &&
				git.prNumber === target.pr_number &&
				git.headSha === target.head_sha,
		);
		return candidates.length === 1 ? candidates[0] : undefined;
	};
	const planTarget = planTargets[0]!;
	const planGit = gitFor(planTarget);
	if (
		!planGit ||
		deps.git.length !== binding.targets.length ||
		binding.targets.some((target) => {
			const git = gitFor(target);
			return (
				!git ||
				!/^[a-f0-9]{40}$/.test(git.diffBaseSha) ||
				!/^[a-f0-9]{40}$/.test(git.headSha)
			);
		})
	)
		return { status: "undetermined", reason: "git_material_missing" };
	const qaDigests = new Map<string, string>();
	const readQa = (target: ShipJudgmentBinding["targets"][number]) =>
		readHostedQaSource(
			{
				runId: binding.runId,
				repoIdentity: target.repo_identity,
				headSha: target.head_sha,
			},
			deps.store.listStrengthTwoRecordsForHead(
				binding.runId,
				target.repo_identity,
				target.head_sha,
			),
			deps.registry,
			deps.hosting,
		);
	try {
		return await collectJudgmentInput(
			{
				binding,
				channelId,
				model: judgmentModelSnapshot(),
				prompt: JUDGMENT_PROMPT,
				signal,
			},
			{
				issue: (abort) =>
					readJudgmentIssueSource(
						binding.issueId,
						deps.linearApiKey,
						abort,
						deps.lookupIssue,
					),
				plan: (abort) =>
					readReviewedPlanSource(
						reference,
						planTarget.head_sha,
						planGit.reader(abort),
					),
				supplements: async (abort) => [
					...(await readReviewedSupplements(
						reference,
						planTarget.head_sha,
						planGit.reader(abort),
						abort,
					)),
					...(deps.supplements ? await deps.supplements(abort) : []),
				],
				qa: async (target) => {
					const source = readQa(target);
					qaDigests.set(canonicalDigest(target), canonicalDigest(source));
					return source;
				},
				diff: async (target, abort) => {
					abort.throwIfAborted();
					const git = gitFor(target);
					if (!git) return null;
					return {
						...(await git.reader(abort).diff(git.diffBaseSha, git.headSha)),
						baseSha: git.diffBaseSha,
						headSha: git.headSha,
					};
				},
				currentBinding: () => {
					const currentReference = deps.store.readShipJudgmentPlanReference(
						binding.runId,
						deps.planRepoIdentity,
					);
					if (
						canonicalDigest(reference ?? null) !==
						canonicalDigest(currentReference ?? null)
					)
						return undefined;
					if (
						binding.targets.some(
							(target) =>
								qaDigests.get(canonicalDigest(target)) !==
								canonicalDigest(readQa(target)),
						)
					)
						return undefined;
					return deps.store.readShipJudgmentBinding(questionId, channelId);
				},
			},
		);
	} catch {
		return { status: "undetermined", reason: "source_collection_failed" };
	}
}
