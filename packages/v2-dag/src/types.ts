import type { SessionBinding } from "flywheel-v2-engine";
import type { Kernel } from "flywheel-v2-kernel";

export interface DagClock {
	nowMs(): number;
	nowIso(): string;
}

export interface GitPort {
	readHead(worktreePath: string): Promise<string>;
	mergeBase(worktreePath: string, mergeTargetRef: string): Promise<string>;
	isAncestor(
		worktreePath: string,
		ancestor: string,
		head: string,
	): Promise<boolean>;
	rawDiff(worktreePath: string, base: string, head: string): Promise<string>;
	readRef(repoIdentity: string, ref: string): Promise<string | null>;
}

export interface WorktreeRefPort {
	worktreePresent(worktreePath: string): Promise<boolean>;
	readExactRef(repoIdentity: string, ref: string): Promise<string | null>;
}

export interface ProcessProbePort {
	probe(sessionRef: string): Promise<
		| {
				state: "present";
				confirmedAt: string;
				sessionBinding: SessionBinding;
		  }
		| { state: "absent"; confirmedAt: string }
	>;
}

export interface RunnerControlPort {
	requestStop(sessionRef: string): Promise<void>;
}

export interface HostPort {
	hostEpoch(): string;
}

export interface LaunchLockPort {
	withSessionLock<T>(sessionRef: string, fn: () => Promise<T>): Promise<T>;
}

export interface RunnerLaunchIdentity {
	kind: "runner";
	/** FLY-1543 ⑤: = sessionRef. The role name never enters the ledger. */
	agentId: string;
	instanceId: string;
	/** = the DAG attempt generation (activations.generation). */
	generation: number;
	activationId: string;
}

export interface SpawnRequest {
	taskId: string;
	attemptId: string;
	attemptGeneration: number;
	activationId: string;
	sessionRef: string;
	ownerToken: string;
	agent: RunnerLaunchIdentity;
	/**
	 * FLY-1544 ①: the DAG node kind (tasks.kind). The role layer is deleted --
	 * the node kind selects the instruction file
	 * (.flywheel/agents/nodes/<kind>.md) and the window name; it keys no ledger
	 * row and no occupancy check.
	 */
	taskKind: string;
	executor: ExecutorDescriptor;
}

export interface SpawnPort {
	spawn(request: SpawnRequest): Promise<SessionBinding>;
}

export interface GitHubObservationPort {
	readPrHead(target: { repo: string; pr: number }): Promise<string>;
	readMergeState(target: {
		repo: string;
		pr: number;
		head: string;
	}): Promise<
		| { state: "open" }
		| { state: "merged"; head: string }
		| { state: "rejected"; evidenceRef: string }
		| { state: "unknown" }
	>;
}

export interface GitHubMergePort {
	merge(
		repo: string,
		pr: number,
		expectedSha: string,
	): Promise<{ mergedSha: string }>;
}

export interface FaultPort {
	hit(point: string): void;
}

export interface DagPorts {
	clock: DagClock;
	git: GitPort;
	worktreeRef: WorktreeRefPort;
	process: ProcessProbePort;
	runnerControl: RunnerControlPort;
	host: HostPort;
	locks: LaunchLockPort;
	spawn: SpawnPort;
	githubObservation?: GitHubObservationPort;
	githubMerge?: GitHubMergePort;
	/** FLY-1544 ⑥: worktree/branch cleanup capability (host runtime only). */
	issueCleanup?: import("./closure.js").IssueCleanupPort;
	/** FLY-1544 doorbell: paste-into-terminal delivery (host runtime only). */
	sessionDelivery?: import("./doorbell.js").SessionDeliveryPort;
	faults?: FaultPort;
}

export type DeclaredContractItem =
	| { kind: "verdict" }
	| { kind: "review_approval"; review: string }
	| {
			kind: "artifact";
			path: string;
			cardinality: "one" | "many";
			digest?: string;
	  };

/**
 * FLY-1544 ①: no logicalAgentId. The role/岗位 layer is deleted -- an executor
 * is a vendor+model+effort choice, and the instruction book hangs off the DAG
 * node kind (tasks.kind), not off a role name.
 */
export interface ExecutorDescriptor {
	family: string;
	vendor: string;
	model: string;
	effort: string;
}

export interface WorktreeDescriptor {
	worktreeId: string;
	repoIdentity: string;
	worktreePath: string;
	branchRef: string;
	mergeTargetRef: string;
}

export interface TaskDescriptor {
	localId: string;
	kindLabel: string;
	contract: DeclaredContractItem[];
	writesRepo: boolean;
	worktreeId: string | null;
	executor: ExecutorDescriptor;
}

export interface IssueDagDescriptor {
	admissionUid: string;
	projectId: string;
	issueId: string;
	notifyAgentId: string;
	shipWorktreeId: string;
	worktrees: WorktreeDescriptor[];
	tasks: TaskDescriptor[];
	edges: [string, string][];
}

export interface AdmissionResult {
	status: "admitted" | "replayed";
	issueId: string;
	taskIds: Record<string, string>;
}

export interface DispatchResult {
	dispatched: SpawnRequest[];
	failures: DispatchFailure[];
	/** FLY-1543 ⑥: every skipped candidate, with its visible reason. */
	skips: DispatchSkip[];
}

export interface DispatchFailure {
	taskId: string;
	stage: string;
	audited: boolean;
}

/**
 * FLY-1543 ⑥: the full taxonomy of reasons a dispatch/recovery pass can pass a
 * task over. Every `continue` that used to collapse into an unlabeled boolean
 * now names one of these; the occupancy family died with the badge system.
 */
export type DispatchSkipReason =
	| "ineligible_dependency"
	| "attempt_active"
	| "task_not_ready"
	| "issue_receipt_missing"
	| "worktree_receipt_missing"
	| "writer_span_open"
	| "writer_head_drift"
	| "launch_claim_lost"
	| "launch_gate_lost"
	| "reap_grace"
	| "reap_process_present"
	| "reap_head_unreadable"
	| "reap_lineage_diverged"
	| "recovery_claim_missing"
	| "recovery_request_unrecoverable";

export interface DispatchSkip {
	/** Null when the skipped unit cannot be tied to a task (e.g. an
	 * unrecoverable claim whose task row is gone). */
	taskId: string | null;
	reason: DispatchSkipReason;
}

export interface ManifestEntry {
	status: "A" | "D" | "M" | "R" | "C";
	oldPath?: string;
	path: string;
	classification: "test" | "docs" | "product";
}

export interface CompletionObservation {
	base: string;
	head: string;
	manifest: ManifestEntry[];
	manifestDigest: string;
	reviewSubjectDigest: string;
	authorFamilies: string[];
	writerRevision: number | null;
}

export interface DagEngineContext {
	kernel: Kernel;
	ports: DagPorts;
}
