import type { StateStore } from "../StateStore.js";
import {
	canonicalDigest,
	type OpinionCandidate,
	type ShipJudgmentBinding,
} from "./contract.js";
import type { JudgmentMaterials, TargetMaterials } from "./evidence-ledger.js";
import type { PreparedJudgmentGit } from "./runtime-collect.js";

export type EvidenceStore = Pick<
	StateStore,
	| "readShipJudgmentIssueAliases"
	| "readShipJudgmentDesignApproval"
	| "readShipJudgmentCodeReviewAtHead"
	| "readShipJudgmentQaAuthority"
>;

/** Read database authorities independently: failure to retrieve one does not erase the others. */
export function readAuthorityMaterials(
	store: EvidenceStore,
	binding: ShipJudgmentBinding,
	mechanical: OpinionCandidate["mechanical"],
	at: string,
): JudgmentMaterials {
	const result: JudgmentMaterials = {
		targets: [],
		mechanical,
		input: { status: "ready", reason: "evidence_complete" },
		computedAt: at,
	};
	const read = <T>(fn: () => T): T | undefined => {
		try {
			return fn();
		} catch {
			result.input = { status: "unavailable", reason: "authority_read_failed" };
			return undefined;
		}
	};
	const aliases =
		read(() => store.readShipJudgmentIssueAliases(binding.runId)) ?? [];
	result.targets = binding.targets.map((target) => {
		const material: TargetMaterials = {
			repoIdentity: target.repo_identity,
			prNumber: target.pr_number,
			headSha: target.head_sha,
			diffBaseSha: null,
		};
		material.designApproval = read(() =>
			store.readShipJudgmentDesignApproval(
				binding.issueId,
				aliases,
				target.repo_identity,
				at,
			),
		);
		material.codeReview = read(() =>
			store.readShipJudgmentCodeReviewAtHead(
				binding.issueId,
				aliases,
				target.repo_identity,
				target.head_sha,
				at,
			),
		);
		material.qaAuthority = read(() =>
			store.readShipJudgmentQaAuthority(
				binding.runId,
				target.repo_identity,
				target.head_sha,
				at,
			),
		);
		return material;
	});
	return result;
}

/** Cache object reads within one prepared Git lifetime, shared with the optional semantic packet. */
export function cachePreparedMaterial(
	git: PreparedJudgmentGit,
): PreparedJudgmentGit {
	const texts = new Map<
		string,
		ReturnType<ReturnType<PreparedJudgmentGit["reader"]>["readText"]>
	>();
	const diffs = new Map<
		string,
		ReturnType<ReturnType<PreparedJudgmentGit["reader"]>["diff"]>
	>();
	return {
		...git,
		reader: (signal) => {
			const reader = git.reader(signal);
			return {
				listTextFiles: reader.listTextFiles.bind(reader),
				readText: (head, path) => {
					signal.throwIfAborted();
					const key = canonicalDigest([head, path]);
					if (!texts.has(key)) texts.set(key, reader.readText(head, path));
					return texts.get(key)!;
				},
				diff: (base, head) => {
					signal.throwIfAborted();
					const key = canonicalDigest([base, head]);
					if (!diffs.has(key)) diffs.set(key, reader.diff(base, head));
					return diffs.get(key)!;
				},
			};
		},
	};
}
