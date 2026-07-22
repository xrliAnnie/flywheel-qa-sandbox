import type { StateStore } from "../../StateStore.js";
import { parseWorkflowRunSnapshot } from "../../workflow-run-snapshot.js";
import { isWorkflowManifestV1Land } from "../../workflow-template.js";

export interface EngineGateAuthority {
	kind: "engine";
	runId: string;
	questionId: string;
	executionId: string;
	issueId: string;
	projectName: string;
	headSha: string;
	state: "materializing" | "awaiting_review" | "approved";
	cardMessageId: string | null;
	prNumber?: number;
	issueIdentifier?: string;
}

export interface GateAuthorityView {
	resolve(
		questionId: string,
		executionId?: string,
	): EngineGateAuthority | undefined;
	resolveForExecution?(executionId: string): EngineGateAuthority | undefined;
}

/**
 * Engine-only approval authority. Both engine ownership and the pinned
 * land_v1 snapshot are required; a question shape alone can never opt into
 * this path. Legacy session authority remains outside this adapter.
 */
export function makeGateAuthorityView(store: StateStore): GateAuthorityView {
	const resolveHolder = (
		holder:
			| ReturnType<typeof store.getCurrentWorkflowGateHolderByQuestionId>
			| undefined,
		executionId?: string,
	): EngineGateAuthority | undefined => {
		if (!holder || holder.state === "superseded") return undefined;
		if (executionId && holder.source_execution_id !== executionId) {
			return undefined;
		}
		const run = store.getWorkflowRun(holder.run_id);
		if (!run?.snapshot || run.engine_owned !== 1 || run.status !== "active") {
			return undefined;
		}
		let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
		try {
			snapshot = parseWorkflowRunSnapshot(run.snapshot);
		} catch {
			return undefined;
		}
		if (
			!isWorkflowManifestV1Land(snapshot.manifest) ||
			snapshot.manifest.approval_gate.node !== holder.gate_node_id
		) {
			return undefined;
		}
		const expectedCurrentNode =
			holder.state === "approved"
				? snapshot.manifest.terminal_node.node
				: holder.gate_node_id;
		if (run.current_node_id !== expectedCurrentNode) return undefined;
		const source = store.getSession(holder.source_execution_id);
		const prNumber = store.getWorkflowRunPrNumber(
			holder.run_id,
			holder.head_sha,
		);
		return {
			kind: "engine",
			runId: holder.run_id,
			questionId: holder.question_id,
			executionId: holder.source_execution_id,
			issueId: run.issue_id,
			projectName: run.project_name,
			headSha: holder.head_sha,
			state: holder.state,
			cardMessageId: holder.card_message_id,
			...(prNumber ? { prNumber } : {}),
			...(source?.issue_identifier
				? { issueIdentifier: source.issue_identifier }
				: {}),
		};
	};
	return {
		resolve(questionId, executionId) {
			return resolveHolder(
				store.getCurrentWorkflowGateHolderByQuestionId(questionId),
				executionId,
			);
		},
		resolveForExecution(executionId) {
			return resolveHolder(
				store.getCurrentWorkflowGateHolderBySourceExecution(executionId),
				executionId,
			);
		},
	};
}
