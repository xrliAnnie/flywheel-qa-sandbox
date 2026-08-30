export const LEGACY_WORKFLOW_SEED_DEFINITIONS = [
	{
		template_id: "tpl_eng",
		name: "Engineering (tiered)",
		project_scope: "global",
		manifest: {
			schema_version: 1,
			nodes: [
				{
					id: "design",
					type: "design",
					vendor: "claude",
					model: "claude-fable-5",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "implement",
					type: "implement",
					vendor: "codex",
					model: "gpt-5.6-sol",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "qa",
					type: "qa",
					vendor: "claude",
					model: "opus",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "founder_gate",
					type: "gate",
				},
			],
			edges: [
				{
					id: "design_done",
					from: "design",
					to: "implement",
					condition: "design_done",
				},
				{
					id: "implement_done",
					from: "implement",
					to: "qa",
					condition: "implement_done",
				},
				{
					id: "qa_pass",
					from: "qa",
					to: "founder_gate",
					condition: "qa_pass",
				},
			],
			loops: [
				{
					id: "qa_retry",
					from: "qa",
					to: "implement",
					loop_when: "qa_fail",
					exit_when: "qa_pass",
					max_iterations: 3,
					on_limit: "escalate",
				},
				{
					id: "founder_feedback",
					from: "founder_gate",
					to: "implement",
					loop_when: "founder_feedback_kickback",
					exit_when: "founder_approved",
					max_iterations: 3,
					on_limit: "escalate",
				},
			],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			ship_claims: ["qa_passed", "founder_approved"],
			tier_presets: {
				heavy: {
					reason: "eng heavy tier — xhigh implement",
					nodes: {
						implement: {
							effort: "xhigh",
						},
						qa: {
							submissionWindowMinutes: 180,
						},
					},
				},
				light: {
					reason: "eng light tier — codex design",
					nodes: {
						design: {
							vendor: "codex",
							model: "gpt-5.6-sol",
						},
					},
				},
				trivial: {
					reason: "eng trivial tier — codex design + fable QA",
					nodes: {
						design: {
							vendor: "codex",
							model: "gpt-5.6-sol",
						},
						qa: {
							model: "claude-fable-5",
						},
					},
				},
			},
		},
	},
	{
		template_id: "tpl_eng_heavy",
		name: "Engineering heavy",
		project_scope: "global",
		manifest: {
			schema_version: 1,
			nodes: [
				{
					id: "design",
					type: "design",
					vendor: "claude",
					model: "claude-fable-5",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "implement",
					type: "implement",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "xhigh",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "qa",
					type: "qa",
					vendor: "claude",
					model: "opus",
					submissionWindowMinutes: 180,
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "founder_gate",
					type: "gate",
				},
			],
			edges: [
				{
					id: "design_done",
					from: "design",
					to: "implement",
					condition: "design_done",
				},
				{
					id: "implement_done",
					from: "implement",
					to: "qa",
					condition: "implement_done",
				},
				{
					id: "qa_pass",
					from: "qa",
					to: "founder_gate",
					condition: "qa_pass",
				},
			],
			loops: [
				{
					id: "qa_retry",
					from: "qa",
					to: "implement",
					loop_when: "qa_fail",
					exit_when: "qa_pass",
					max_iterations: 3,
					on_limit: "escalate",
				},
				{
					id: "founder_feedback",
					from: "founder_gate",
					to: "implement",
					loop_when: "founder_feedback_kickback",
					exit_when: "founder_approved",
					max_iterations: 3,
					on_limit: "escalate",
				},
			],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			ship_claims: ["qa_passed", "founder_approved"],
		},
	},
	{
		template_id: "tpl_eng_heavy_land_v1",
		name: "Engineering heavy with automated land",
		project_scope: "global",
		manifest: {
			schema_version: 1,
			manifest_variant: "land_v1",
			nodes: [
				{
					id: "design",
					type: "design",
					vendor: "claude",
					model: "claude-fable-5",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "implement",
					type: "implement",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "xhigh",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "qa",
					type: "qa",
					vendor: "claude",
					model: "opus",
					submissionWindowMinutes: 180,
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "founder_gate",
					type: "gate",
				},
				{
					id: "land",
					type: "land",
					execution: "engine",
				},
			],
			edges: [
				{
					id: "design_done",
					from: "design",
					to: "implement",
					condition: "design_done",
				},
				{
					id: "implement_done",
					from: "implement",
					to: "qa",
					condition: "implement_done",
				},
				{
					id: "qa_pass",
					from: "qa",
					to: "founder_gate",
					condition: "qa_pass",
				},
				{
					id: "founder_approved",
					from: "founder_gate",
					to: "land",
					condition: "founder_approved",
				},
			],
			loops: [
				{
					id: "qa_retry",
					from: "qa",
					to: "implement",
					loop_when: "qa_fail",
					exit_when: "qa_pass",
					max_iterations: 3,
					on_limit: "escalate",
				},
				{
					id: "founder_feedback",
					from: "founder_gate",
					to: "implement",
					loop_when: "founder_feedback_kickback",
					exit_when: "founder_approved",
					max_iterations: 3,
					on_limit: "escalate",
				},
			],
			approval_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			terminal_node: {
				node: "land",
			},
			ship_claims: ["qa_passed", "founder_approved"],
		},
	},
	{
		template_id: "tpl_eng_land_v1",
		name: "Engineering (tiered) with automated land",
		project_scope: "global",
		manifest: {
			schema_version: 1,
			manifest_variant: "land_v1",
			nodes: [
				{
					id: "design",
					type: "design",
					vendor: "claude",
					model: "claude-fable-5",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "implement",
					type: "implement",
					vendor: "codex",
					model: "gpt-5.6-sol",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "qa",
					type: "qa",
					vendor: "claude",
					model: "opus",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "founder_gate",
					type: "gate",
				},
				{
					id: "land",
					type: "land",
					execution: "engine",
				},
			],
			edges: [
				{
					id: "design_done",
					from: "design",
					to: "implement",
					condition: "design_done",
				},
				{
					id: "implement_done",
					from: "implement",
					to: "qa",
					condition: "implement_done",
				},
				{
					id: "qa_pass",
					from: "qa",
					to: "founder_gate",
					condition: "qa_pass",
				},
				{
					id: "founder_approved",
					from: "founder_gate",
					to: "land",
					condition: "founder_approved",
				},
			],
			loops: [
				{
					id: "qa_retry",
					from: "qa",
					to: "implement",
					loop_when: "qa_fail",
					exit_when: "qa_pass",
					max_iterations: 3,
					on_limit: "escalate",
				},
				{
					id: "founder_feedback",
					from: "founder_gate",
					to: "implement",
					loop_when: "founder_feedback_kickback",
					exit_when: "founder_approved",
					max_iterations: 3,
					on_limit: "escalate",
				},
			],
			approval_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			terminal_node: {
				node: "land",
			},
			ship_claims: ["qa_passed", "founder_approved"],
			tier_presets: {
				heavy: {
					reason: "eng heavy tier — xhigh implement",
					nodes: {
						implement: {
							effort: "xhigh",
						},
						qa: {
							submissionWindowMinutes: 180,
						},
					},
				},
				light: {
					reason: "eng light tier — codex design",
					nodes: {
						design: {
							vendor: "codex",
							model: "gpt-5.6-sol",
						},
					},
				},
				trivial: {
					reason: "eng trivial tier — codex design + fable QA",
					nodes: {
						design: {
							vendor: "codex",
							model: "gpt-5.6-sol",
						},
						qa: {
							model: "claude-fable-5",
						},
					},
				},
			},
		},
	},
	{
		template_id: "tpl_eng_light",
		name: "Engineering light",
		project_scope: "global",
		manifest: {
			schema_version: 1,
			nodes: [
				{
					id: "design",
					type: "design",
					vendor: "codex",
					model: "gpt-5.6-sol",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "implement",
					type: "implement",
					vendor: "codex",
					model: "gpt-5.6-sol",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "qa",
					type: "qa",
					vendor: "claude",
					model: "opus",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "founder_gate",
					type: "gate",
				},
			],
			edges: [
				{
					id: "design_done",
					from: "design",
					to: "implement",
					condition: "design_done",
				},
				{
					id: "implement_done",
					from: "implement",
					to: "qa",
					condition: "implement_done",
				},
				{
					id: "qa_pass",
					from: "qa",
					to: "founder_gate",
					condition: "qa_pass",
				},
			],
			loops: [
				{
					id: "qa_retry",
					from: "qa",
					to: "implement",
					loop_when: "qa_fail",
					exit_when: "qa_pass",
					max_iterations: 3,
					on_limit: "escalate",
				},
				{
					id: "founder_feedback",
					from: "founder_gate",
					to: "implement",
					loop_when: "founder_feedback_kickback",
					exit_when: "founder_approved",
					max_iterations: 3,
					on_limit: "escalate",
				},
			],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			ship_claims: ["qa_passed", "founder_approved"],
		},
	},
	{
		template_id: "tpl_eng_light_land_v1",
		name: "Engineering light with automated land",
		project_scope: "global",
		manifest: {
			schema_version: 1,
			manifest_variant: "land_v1",
			nodes: [
				{
					id: "design",
					type: "design",
					vendor: "codex",
					model: "gpt-5.6-sol",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "implement",
					type: "implement",
					vendor: "codex",
					model: "gpt-5.6-sol",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "qa",
					type: "qa",
					vendor: "claude",
					model: "opus",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "founder_gate",
					type: "gate",
				},
				{
					id: "land",
					type: "land",
					execution: "engine",
				},
			],
			edges: [
				{
					id: "design_done",
					from: "design",
					to: "implement",
					condition: "design_done",
				},
				{
					id: "implement_done",
					from: "implement",
					to: "qa",
					condition: "implement_done",
				},
				{
					id: "qa_pass",
					from: "qa",
					to: "founder_gate",
					condition: "qa_pass",
				},
				{
					id: "founder_approved",
					from: "founder_gate",
					to: "land",
					condition: "founder_approved",
				},
			],
			loops: [
				{
					id: "qa_retry",
					from: "qa",
					to: "implement",
					loop_when: "qa_fail",
					exit_when: "qa_pass",
					max_iterations: 3,
					on_limit: "escalate",
				},
				{
					id: "founder_feedback",
					from: "founder_gate",
					to: "implement",
					loop_when: "founder_feedback_kickback",
					exit_when: "founder_approved",
					max_iterations: 3,
					on_limit: "escalate",
				},
			],
			approval_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			terminal_node: {
				node: "land",
			},
			ship_claims: ["qa_passed", "founder_approved"],
		},
	},
	{
		template_id: "tpl_eng_trivial",
		name: "Engineering trivial and smoke",
		project_scope: "global",
		manifest: {
			schema_version: 1,
			nodes: [
				{
					id: "design",
					type: "design",
					vendor: "codex",
					model: "gpt-5.6-sol",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "implement",
					type: "implement",
					vendor: "codex",
					model: "gpt-5.6-sol",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "qa",
					type: "qa",
					vendor: "claude",
					model: "claude-fable-5",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "founder_gate",
					type: "gate",
				},
			],
			edges: [
				{
					id: "design_done",
					from: "design",
					to: "implement",
					condition: "design_done",
				},
				{
					id: "implement_done",
					from: "implement",
					to: "qa",
					condition: "implement_done",
				},
				{
					id: "qa_pass",
					from: "qa",
					to: "founder_gate",
					condition: "qa_pass",
				},
			],
			loops: [
				{
					id: "qa_retry",
					from: "qa",
					to: "implement",
					loop_when: "qa_fail",
					exit_when: "qa_pass",
					max_iterations: 3,
					on_limit: "escalate",
				},
				{
					id: "founder_feedback",
					from: "founder_gate",
					to: "implement",
					loop_when: "founder_feedback_kickback",
					exit_when: "founder_approved",
					max_iterations: 3,
					on_limit: "escalate",
				},
			],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			ship_claims: ["qa_passed", "founder_approved"],
		},
	},
	{
		template_id: "tpl_eng_trivial_land_v1",
		name: "Engineering trivial and smoke with automated land",
		project_scope: "global",
		manifest: {
			schema_version: 1,
			manifest_variant: "land_v1",
			nodes: [
				{
					id: "design",
					type: "design",
					vendor: "codex",
					model: "gpt-5.6-sol",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "implement",
					type: "implement",
					vendor: "codex",
					model: "gpt-5.6-sol",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "qa",
					type: "qa",
					vendor: "claude",
					model: "claude-fable-5",
					handoff_pointer: {
						worktree: true,
						design_doc: true,
					},
				},
				{
					id: "founder_gate",
					type: "gate",
				},
				{
					id: "land",
					type: "land",
					execution: "engine",
				},
			],
			edges: [
				{
					id: "design_done",
					from: "design",
					to: "implement",
					condition: "design_done",
				},
				{
					id: "implement_done",
					from: "implement",
					to: "qa",
					condition: "implement_done",
				},
				{
					id: "qa_pass",
					from: "qa",
					to: "founder_gate",
					condition: "qa_pass",
				},
				{
					id: "founder_approved",
					from: "founder_gate",
					to: "land",
					condition: "founder_approved",
				},
			],
			loops: [
				{
					id: "qa_retry",
					from: "qa",
					to: "implement",
					loop_when: "qa_fail",
					exit_when: "qa_pass",
					max_iterations: 3,
					on_limit: "escalate",
				},
				{
					id: "founder_feedback",
					from: "founder_gate",
					to: "implement",
					loop_when: "founder_feedback_kickback",
					exit_when: "founder_approved",
					max_iterations: 3,
					on_limit: "escalate",
				},
			],
			approval_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			terminal_node: {
				node: "land",
			},
			ship_claims: ["qa_passed", "founder_approved"],
		},
	},
	{
		template_id: "tpl_generic",
		name: "Generic single-session task",
		project_scope: "global",
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "execute",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					agent_file: ".flywheel/agents/nodes/general.md",
					produces_output: true,
					output: {
						schema: "json_v1",
						max_bytes: 262144,
					},
				},
				{
					id: "founder_gate",
					type: "gate",
				},
				{
					id: "land",
					type: "land",
					execution: "engine",
				},
			],
			edges: [
				{
					id: "execute_done",
					from: "execute",
					to: "founder_gate",
					condition: "node_done",
				},
				{
					id: "founder_approved",
					from: "founder_gate",
					to: "land",
					condition: "founder_approved",
				},
			],
			loops: [],
			approval_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			terminal_node: {
				node: "land",
			},
			ship_claims: ["founder_approved"],
		},
	},
	{
		template_id: "tpl_product_designer",
		name: "Product designer flow",
		project_scope: "global",
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "design_iterate",
					type: "generic",
					vendor: "claude",
					model: "claude-fable-5",
					effort: "high",
					agent_file: ".flywheel/agents/nodes/product_design.md",
					produces_output: true,
					output: {
						schema: "json_v1",
						max_bytes: 262144,
					},
				},
				{
					id: "review",
					type: "review",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "xhigh",
				},
				{
					id: "founder_gate",
					type: "gate",
				},
				{
					id: "land",
					type: "land",
					execution: "engine",
				},
			],
			edges: [
				{
					id: "design_iterate_done",
					from: "design_iterate",
					to: "review",
					condition: "node_done",
				},
				{
					id: "review_passed",
					from: "review",
					to: "founder_gate",
					condition: "review_pass",
				},
				{
					id: "founder_approved",
					from: "founder_gate",
					to: "land",
					condition: "founder_approved",
				},
			],
			loops: [
				{
					id: "review_kickback",
					from: "review",
					to: "design_iterate",
					loop_when: "review_fail",
					exit_when: "review_pass",
					max_iterations: 3,
					on_limit: "escalate",
				},
			],
			approval_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			terminal_node: {
				node: "land",
			},
			ship_claims: ["design_review_approved", "founder_approved"],
		},
	},
	{
		template_id: "tpl_product_prototype",
		name: "Product prototype flow",
		project_scope: "global",
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "build",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "high",
					agent_file: ".flywheel/agents/nodes/proto.md",
					produces_output: true,
					output: {
						schema: "json_v1",
						max_bytes: 262144,
					},
				},
				{
					id: "review",
					type: "review",
					vendor: "claude",
					model: "opus",
					effort: "high",
				},
				{
					id: "founder_gate",
					type: "gate",
				},
				{
					id: "land",
					type: "land",
					execution: "engine",
				},
			],
			edges: [
				{
					id: "build_done",
					from: "build",
					to: "review",
					condition: "node_done",
				},
				{
					id: "review_passed",
					from: "review",
					to: "founder_gate",
					condition: "review_pass",
				},
				{
					id: "founder_approved",
					from: "founder_gate",
					to: "land",
					condition: "founder_approved",
				},
			],
			loops: [
				{
					id: "review_kickback",
					from: "review",
					to: "build",
					loop_when: "review_fail",
					exit_when: "review_pass",
					max_iterations: 2,
					on_limit: "escalate",
				},
			],
			approval_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			terminal_node: {
				node: "land",
			},
			ship_claims: ["design_review_approved", "founder_approved"],
		},
	},
	{
		template_id: "tpl_product_v1",
		name: "Product research and review",
		project_scope: "global",
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "research",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					agent_file: ".flywheel/agents/nodes/general.md",
				},
				{
					id: "produce",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "high",
					agent_file: ".flywheel/agents/nodes/general.md",
					produces_output: true,
					output: {
						schema: "json_v1",
						max_bytes: 262144,
					},
				},
				{
					id: "review",
					type: "review",
					vendor: "claude",
					model: "claude-sonnet-4-5",
					effort: "high",
				},
				{
					id: "founder_gate",
					type: "gate",
				},
				{
					id: "land",
					type: "land",
					execution: "engine",
				},
			],
			edges: [
				{
					id: "research_done",
					from: "research",
					to: "produce",
					condition: "node_done",
				},
				{
					id: "produce_done",
					from: "produce",
					to: "review",
					condition: "node_done",
				},
				{
					id: "review_passed",
					from: "review",
					to: "founder_gate",
					condition: "review_pass",
				},
				{
					id: "founder_approved",
					from: "founder_gate",
					to: "land",
					condition: "founder_approved",
				},
			],
			loops: [
				{
					id: "review_kickback",
					from: "review",
					to: "produce",
					loop_when: "review_fail",
					exit_when: "review_pass",
					max_iterations: 3,
					on_limit: "escalate",
				},
			],
			approval_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			terminal_node: {
				node: "land",
			},
			ship_claims: ["design_review_approved", "founder_approved"],
		},
	},
] as const;
