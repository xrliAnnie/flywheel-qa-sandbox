export type WorkflowNodeTypeId =
	| "design"
	| "implement"
	| "qa"
	| "gate"
	| "land"
	| "generic"
	| "review";

export type WorkflowCompletionRoute =
	| "phase_design_complete"
	| "needs_review"
	| "no_code";

export type WorkflowOutputMode = "none" | "json_v1";

export interface WorkflowNodeCapabilities {
	shared_branch_writer: boolean;
	creates_pr: boolean;
	can_ship: boolean;
	can_land: boolean;
	/** Land-v1 only. Omitted from legacy snapshots to preserve their digest. */
	can_request_ship_approval?: boolean;
	approval_gate_holder: boolean;
	needs_review_evidence: boolean;
	needs_mailbox_transport: boolean;
	keepalive_park: boolean;
	qa_verdict_emitter: boolean;
	produces_output: boolean;
	completion_route: WorkflowCompletionRoute;
	output_mode: WorkflowOutputMode;
}

export interface NodeTypeRegistryEntry {
	id: WorkflowNodeTypeId;
	isPhaseRole: boolean;
	preserveCompletionRole: boolean;
	badge: string;
	capabilities: Readonly<WorkflowNodeCapabilities>;
}

const noCode = (
	completionRoute: WorkflowCompletionRoute,
): WorkflowNodeCapabilities => ({
	shared_branch_writer: false,
	creates_pr: false,
	can_ship: false,
	can_land: false,
	approval_gate_holder: false,
	needs_review_evidence: false,
	needs_mailbox_transport: false,
	keepalive_park: false,
	qa_verdict_emitter: false,
	produces_output: false,
	completion_route: completionRoute,
	output_mode: "none",
});

export const NODE_TYPE_REGISTRY: Readonly<
	Record<WorkflowNodeTypeId, NodeTypeRegistryEntry>
> = {
	design: {
		id: "design",
		isPhaseRole: true,
		preserveCompletionRole: true,
		badge: "🎨设计",
		capabilities: {
			...noCode("phase_design_complete"),
			shared_branch_writer: true,
			needs_review_evidence: true,
			needs_mailbox_transport: true,
			keepalive_park: true,
		},
	},
	implement: {
		id: "implement",
		isPhaseRole: true,
		preserveCompletionRole: true,
		badge: "🔨实现",
		capabilities: {
			...noCode("needs_review"),
			shared_branch_writer: true,
			creates_pr: true,
			can_ship: true,
			can_land: true,
			approval_gate_holder: true,
			needs_review_evidence: true,
			needs_mailbox_transport: true,
			keepalive_park: true,
		},
	},
	qa: {
		id: "qa",
		isPhaseRole: true,
		preserveCompletionRole: true,
		badge: "🧪QA",
		capabilities: {
			...noCode("no_code"),
			shared_branch_writer: true,
			needs_mailbox_transport: true,
			qa_verdict_emitter: true,
		},
	},
	gate: {
		id: "gate",
		isPhaseRole: false,
		preserveCompletionRole: false,
		badge: "✅",
		capabilities: {
			...noCode("needs_review"),
			approval_gate_holder: true,
		},
	},
	land: {
		id: "land",
		isPhaseRole: false,
		preserveCompletionRole: false,
		badge: "🏁",
		capabilities: {
			...noCode("no_code"),
			can_ship: true,
			can_land: true,
		},
	},
	generic: {
		id: "generic",
		isPhaseRole: false,
		preserveCompletionRole: false,
		badge: "🧩",
		// generic is the default single-stage dispatch type. With an all-false
		// capability set the engine injected a "no-write node" instruction, so a
		// single-stage runner could never commit, push, or open a PR — its work
		// had nowhere to land. It carries the same capability shape as implement.
		//
		// completion_route MUST be "needs_review", not "no_code": creates_pr makes
		// this node a ship-bundle carrier, and resolveWorkflowGateAuthority only
		// accepts a carrier whose completion_route is "needs_review" — anything
		// else throws incoherent_ship_bundle.
		capabilities: {
			...noCode("needs_review"),
			shared_branch_writer: true,
			creates_pr: true,
			can_ship: true,
			can_land: true,
			approval_gate_holder: true,
			needs_review_evidence: true,
			needs_mailbox_transport: true,
			keepalive_park: true,
		},
	},
	review: {
		id: "review",
		isPhaseRole: false,
		preserveCompletionRole: false,
		badge: "🔎",
		capabilities: {
			...noCode("needs_review"),
			needs_review_evidence: true,
			needs_mailbox_transport: true,
		},
	},
};

export function getNodeTypeRegistryEntry(type: string): NodeTypeRegistryEntry {
	const entry = NODE_TYPE_REGISTRY[type as WorkflowNodeTypeId];
	if (!entry) throw new Error(`unknown workflow node type: ${type}`);
	return entry;
}

export function nodeTypeWritesCode(type: string): boolean {
	const capabilities = getNodeTypeRegistryEntry(type).capabilities;
	return capabilities.shared_branch_writer || capabilities.creates_pr;
}
