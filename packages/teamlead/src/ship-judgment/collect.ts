import {
	canonicalDigest,
	type FrozenPacket,
	frozenPacketSchema,
	type ShipJudgmentBinding,
} from "./contract.js";
import { requirementCatalog } from "./requirements.js";
import { frozenSourceText } from "./source-text.js";

export interface SourceBody {
	body: string;
	format: "html" | "text";
	revision: string;
}
export interface QaSourceBody extends SourceBody {
	runId: string;
	repoIdentity: string;
	headSha: string;
	digest: string;
	withdrawn: boolean;
}
export interface DiffSourceBody {
	baseSha: string;
	headSha: string;
	text: string;
	complete: boolean;
	files: { path: string; previous_path?: string; status: string }[];
}
type Target = ShipJudgmentBinding["targets"][number];
export interface SupplementalSource extends SourceBody {
	sourceId: string;
	kind: "prd" | "revision";
	/** Trusted source adapter supplies the durable acceptance receipt, never the model. */
	acceptanceRef?: string;
}
export interface CollectionSources {
	issue(signal: AbortSignal): Promise<SourceBody | null>;
	plan(signal: AbortSignal): Promise<SourceBody | null>;
	supplements?(signal: AbortSignal): Promise<SupplementalSource[]>;
	qa(target: Target, signal: AbortSignal): Promise<QaSourceBody | null>;
	diff(target: Target, signal: AbortSignal): Promise<DiffSourceBody | null>;
	currentBinding(): ShipJudgmentBinding | undefined;
}
export type CollectionResult =
	| { status: "ready"; packet: FrozenPacket }
	| { status: "undetermined"; reason: string };
class CollectionFailure extends Error {}

/** Source adapters resolve only configured/verified locations; the model never supplies a URL or path. */
export async function collectJudgmentInput(
	args: {
		binding: ShipJudgmentBinding;
		channelId: string;
		model: FrozenPacket["model"];
		prompt: string;
		requirements?: FrozenPacket["requirements"];
		signal?: AbortSignal;
	},
	deps: CollectionSources,
): Promise<CollectionResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 60_000);
	const signal = args.signal
		? AbortSignal.any([args.signal, controller.signal])
		: controller.signal;
	const call = async <T>(
		action: (signal: AbortSignal) => Promise<T>,
	): Promise<T> => {
		const bound = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
		bound.throwIfAborted();
		let onAbort: (() => void) | undefined;
		try {
			return await Promise.race([
				action(bound),
				new Promise<never>((_, reject) => {
					onAbort = () => reject(new CollectionFailure("source_timeout"));
					bound.addEventListener("abort", onAbort, { once: true });
					if (bound.aborted) onAbort();
				}),
			]);
		} finally {
			if (onAbort) bound.removeEventListener("abort", onAbort);
		}
	};
	try {
		if (
			args.binding.projectName !== "flywheel" ||
			args.binding.targets.length === 0
		)
			throw new CollectionFailure("binding_missing");
		const sources: FrozenPacket["sources"] = [];
		const add = (
			source_id: string,
			kind: FrozenPacket["sources"][number]["kind"],
			body: SourceBody,
		) => {
			if (sources.some((source) => source.source_id === source_id))
				throw new CollectionFailure("duplicate_source");
			const text = frozenSourceText(body.body, body.format);
			sources.push({
				source_id,
				kind,
				text: text.text,
				revision: JSON.stringify({
					source: body.revision,
					original: text.originalDigest,
					text: text.textDigest,
				}),
			});
			return text;
		};
		const issue = await call(deps.issue);
		if (!issue) throw new CollectionFailure("issue_missing");
		add("issue", "issue", issue);
		const plan = await call(deps.plan);
		if (!plan) throw new CollectionFailure("plan_missing");
		add("plan", "plan", plan);
		if (deps.supplements) {
			const supplements = await call(deps.supplements);
			if (supplements.length > 100)
				throw new CollectionFailure("input_budget_exceeded");
			for (const supplement of supplements) {
				if (supplement.kind !== "prd" && supplement.kind !== "revision")
					throw new CollectionFailure("supplement_kind_invalid");
				if (supplement.kind === "revision" && !supplement.acceptanceRef?.trim())
					throw new CollectionFailure("revision_acceptance_missing");
				add(supplement.sourceId, supplement.kind, {
					...supplement,
					revision: JSON.stringify({
						source: supplement.revision,
						acceptance: supplement.acceptanceRef ?? null,
					}),
				});
			}
		}
		const targets: FrozenPacket["targets"] = [];
		const files: FrozenPacket["files"] = [];
		for (const target of args.binding.targets) {
			const suffix = canonicalDigest([
				target.repo_identity,
				target.pr_number,
			]).slice(0, 24);
			const qa = await call((signal) => deps.qa(target, signal));
			if (!qa) throw new CollectionFailure("qa_missing");
			if (
				qa.withdrawn ||
				qa.runId !== args.binding.runId ||
				qa.repoIdentity !== target.repo_identity ||
				qa.headSha !== target.head_sha
			)
				throw new CollectionFailure("qa_binding_mismatch");
			const text = add(`qa:${suffix}`, "qa", qa);
			if (text.originalDigest !== qa.digest)
				throw new CollectionFailure("qa_digest_mismatch");
			const diff = await call((signal) => deps.diff(target, signal));
			if (!diff || !diff.complete)
				throw new CollectionFailure("diff_incomplete");
			if (diff.headSha !== target.head_sha)
				throw new CollectionFailure("diff_binding_mismatch");
			targets.push({
				repo_identity: target.repo_identity,
				pr_number: target.pr_number,
				head_sha: diff.headSha,
				diff_base_sha: diff.baseSha,
			});
			for (const file of diff.files)
				files.push({
					repo_identity: target.repo_identity,
					path: file.path,
					...(file.previous_path ? { previous_path: file.previous_path } : {}),
				});
			add(`diff:${suffix}`, "diff", {
				body: diff.text,
				format: "text",
				revision: `${diff.baseSha}:${diff.headSha}`,
			});
			add(`files:${suffix}`, "files", {
				body: JSON.stringify(diff.files),
				format: "text",
				revision: `${diff.baseSha}:${diff.headSha}`,
			});
		}
		const current = deps.currentBinding();
		if (!current || canonicalDigest(current) !== canonicalDigest(args.binding))
			throw new CollectionFailure("binding_changed");
		const packet = frozenPacketSchema.parse({
			questionId: args.binding.questionId,
			channelId: args.channelId,
			bindingDigest: canonicalDigest(args.binding),
			targets,
			sources,
			files,
			requirements: args.requirements ?? requirementCatalog(sources),
			model: args.model,
			prompt: args.prompt,
		});
		if (Buffer.byteLength(JSON.stringify(packet)) > 98_304)
			throw new CollectionFailure("input_budget_exceeded");
		for (const requirement of packet.requirements) {
			const source = packet.sources.find(
				(source) => source.source_id === requirement.source_id,
			);
			if (
				!source ||
				requirement.quote_start >= requirement.quote_end ||
				requirement.quote_end > Array.from(source.text).length
			)
				throw new CollectionFailure("requirement_source_invalid");
		}
		return { status: "ready", packet };
	} catch (error) {
		return {
			status: "undetermined",
			reason:
				error instanceof CollectionFailure
					? error.message
					: error instanceof Error &&
							[
								"source_budget_exceeded",
								"requirement_budget_exceeded",
							].includes(error.message)
						? "input_budget_exceeded"
						: "source_collection_failed",
		};
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}
