import type {
	DesignBackend,
	SkillFrameworkMode,
	SkillFrameworkVia,
} from "flywheel-config";

/** StateStore session fields used by reusable workflow actor recovery paths. */
export interface WorkflowActorSession {
	execution_id: string;
	issue_id: string;
	project_name?: string;
	session_role?: string;
	status: string;
	issue_identifier?: string;
	issue_title?: string;
	chat_thread_role?: string;
	review_question_id?: string;
	design_backend?: DesignBackend;
	skill_framework_mode?: SkillFrameworkMode;
	skill_framework_mode_via?: SkillFrameworkVia;
	merge_block_reason?: string;
	tmux_session?: string;
	adapter_type?: string;
	worktree_path?: string;
}
