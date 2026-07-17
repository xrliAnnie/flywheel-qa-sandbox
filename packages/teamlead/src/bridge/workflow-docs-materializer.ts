import type { ProjectEntry } from "../ProjectConfig.js";
import type {
	WorkflowMaterializationReceiptRow,
	WorkflowMaterializationRow,
} from "../StateStore.js";
import {
	parseWorkflowDocsOutput,
	type WorkflowDocsOutput,
} from "../workflow-docs-output.js";

export interface WorkflowMaterializationCandidate {
	runId: string;
	producerNodeId: string;
	reviewNodeId: string;
	attempt: number;
	outputId: number;
	outputDigest: string;
	payload: string;
	projectName: string;
	issueId: string;
}

export interface WorkflowDocsMaterializerStore {
	listWorkflowMaterializationCandidates(): WorkflowMaterializationCandidate[];
	getWorkflowMaterializedHead(
		runId: string,
		producerNodeId: string,
	): { head: string; outputId: number; attempt: number } | undefined;
	allocateWorkflowMaterialization(input: {
		runId: string;
		nodeId: string;
		attempt: number;
		outputId: number;
		outputDigest: string;
		repo: string;
		ref: string;
		baseHead: string;
	}): WorkflowMaterializationRow;
	getWorkflowMaterializationReceipts(
		effectId: string,
	): WorkflowMaterializationReceiptRow[];
	adoptWorkflowMaterializationCommit(input: {
		effectId: string;
		treeHead: string;
		commitHead: string;
	}): void;
	confirmWorkflowMaterializationPush(input: {
		effectId: string;
		remoteHead: string;
		reviewNodeId: string;
	}): void;
}

export interface WorkflowDocsGit {
	resolveBaseHead(input: {
		projectRoot: string;
		repo: string;
		ref: string;
	}): Promise<string>;
	prepareOrAdoptCommit(input: {
		projectRoot: string;
		repo: string;
		ref: string;
		baseHead: string;
		effectId: string;
		outputDigest: string;
		payload: WorkflowDocsOutput;
	}): Promise<{ treeHead: string; commitHead: string }>;
	readRemoteHead(input: {
		projectRoot: string;
		repo: string;
		ref: string;
	}): Promise<string | undefined>;
	pushCommit(input: {
		projectRoot: string;
		repo: string;
		ref: string;
		baseHead: string;
		commitHead: string;
	}): Promise<void>;
}

export interface WorkflowDocsMaterializerOptions {
	store: WorkflowDocsMaterializerStore;
	git: WorkflowDocsGit;
	projects: ProjectEntry[];
	withRepoLock: <T>(projectRoot: string, fn: () => Promise<T>) => Promise<T>;
	log?: (message: string) => void;
}

export class WorkflowDocsMaterializer {
	private reconciling = false;
	private timer: NodeJS.Timeout | undefined;
	private readonly log: (message: string) => void;

	constructor(private readonly options: WorkflowDocsMaterializerOptions) {
		this.log = options.log ?? (() => {});
	}

	start(intervalMs = 1_000): void {
		if (this.timer) return;
		void this.reconcile().catch((error) =>
			this.reportReconciliationFailure(error),
		);
		this.timer = setInterval(
			() =>
				void this.reconcile().catch((error) =>
					this.reportReconciliationFailure(error),
				),
			intervalMs,
		);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	async reconcile(): Promise<{ materialized: number; held: number }> {
		if (this.reconciling) return { materialized: 0, held: 0 };
		this.reconciling = true;
		const result = { materialized: 0, held: 0 };
		try {
			for (const candidate of this.options.store.listWorkflowMaterializationCandidates()) {
				try {
					const materialized = await this.consume(candidate);
					if (materialized) result.materialized += 1;
				} catch (error) {
					result.held += 1;
					this.writeLog(
						`workflow docs materialization held for ${candidate.runId}/${candidate.producerNodeId}/${candidate.attempt}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			return result;
		} catch (error) {
			result.held += 1;
			this.reportReconciliationFailure(error);
			return result;
		} finally {
			this.reconciling = false;
		}
	}

	private reportReconciliationFailure(error: unknown): void {
		this.writeLog(
			`workflow docs reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	private writeLog(message: string): void {
		try {
			this.log(message);
		} catch {
			// A diagnostic sink must never turn a contained poll failure into an
			// unhandled rejection in the always-on Bridge process.
		}
	}

	private async consume(
		candidate: WorkflowMaterializationCandidate,
	): Promise<boolean> {
		const current = this.options.store.getWorkflowMaterializedHead(
			candidate.runId,
			candidate.producerNodeId,
		);
		if (
			current?.outputId === candidate.outputId &&
			current.attempt === candidate.attempt
		) {
			return false;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate.payload);
		} catch {
			throw new Error("docs_v1 payload is not valid JSON");
		}
		const payload = parseWorkflowDocsOutput(parsed);
		const project = this.options.projects.find(
			(entry) => entry.projectName === candidate.projectName,
		);
		if (!project?.projectRepo)
			throw new Error("materializer_project_repo_unavailable");
		const safeProject = candidate.projectName.replace(/[^A-Za-z0-9._-]/g, "-");
		const safeIssue = candidate.issueId.replace(/[^A-Za-z0-9._-]/g, "-");
		const ref = `refs/heads/flywheel/docs/${safeProject}/${safeIssue}`;
		const common = {
			projectRoot: project.projectRoot,
			repo: project.projectRepo,
			ref,
		};

		return this.options.withRepoLock(project.projectRoot, async () => {
			const baseHead = await this.options.git.resolveBaseHead(common);
			const intent = this.options.store.allocateWorkflowMaterialization({
				runId: candidate.runId,
				nodeId: candidate.producerNodeId,
				attempt: candidate.attempt,
				outputId: candidate.outputId,
				outputDigest: candidate.outputDigest,
				repo: project.projectRepo!,
				ref,
				baseHead,
			});
			let receipts = this.options.store.getWorkflowMaterializationReceipts(
				intent.effect_id,
			);
			let adopted = receipts.find(
				(receipt) => receipt.stage === "commit_adopted",
			);
			if (!adopted?.tree_head || !adopted.commit_head) {
				const commit = await this.options.git.prepareOrAdoptCommit({
					...common,
					baseHead,
					effectId: intent.effect_id,
					outputDigest: candidate.outputDigest,
					payload,
				});
				this.options.store.adoptWorkflowMaterializationCommit({
					effectId: intent.effect_id,
					treeHead: commit.treeHead,
					commitHead: commit.commitHead,
				});
				receipts = this.options.store.getWorkflowMaterializationReceipts(
					intent.effect_id,
				);
				adopted = receipts.find(
					(receipt) => receipt.stage === "commit_adopted",
				);
			}
			if (!adopted?.commit_head) {
				throw new Error("materializer_commit_receipt_unavailable");
			}

			let remoteHead = await this.options.git.readRemoteHead(common);
			if (remoteHead !== adopted.commit_head) {
				await this.options.git.pushCommit({
					...common,
					baseHead,
					commitHead: adopted.commit_head,
				});
				remoteHead = await this.options.git.readRemoteHead(common);
			}
			if (remoteHead !== adopted.commit_head) {
				throw new Error("materializer_remote_head_mismatch");
			}
			this.options.store.confirmWorkflowMaterializationPush({
				effectId: intent.effect_id,
				remoteHead,
				reviewNodeId: candidate.reviewNodeId,
			});
			return true;
		});
	}
}
