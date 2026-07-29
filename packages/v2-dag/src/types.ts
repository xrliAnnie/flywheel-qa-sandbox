import type { DeathEvidence, SessionBinding } from "flywheel-v2-engine";
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

export interface InjectionRefBuilder {
	build(input: {
		taskId: string;
		attemptId: string;
		attemptGeneration: number;
		activationId: string;
		sessionRef: string;
		agentId: string;
		executor: ExecutorDescriptor;
	}): string;
}

export interface RunnerLaunchIdentity {
	kind: "runner";
	agentId: string;
	instanceId: string;
	generation: number;
	activationId: string;
}

export interface SpawnRequest {
	taskId: string;
	attemptId: string;
	attemptGeneration: number;
	activationId: string;
	sessionRef: string;
	injectionRef: string;
	ownerToken: string;
	agent: RunnerLaunchIdentity;
	deathEvidence?: DeathEvidence;
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
	injectionRef: InjectionRefBuilder;
	locks: LaunchLockPort;
	spawn: SpawnPort;
	githubObservation?: GitHubObservationPort;
	githubMerge?: GitHubMergePort;
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

export interface ExecutorDescriptor {
	logicalAgentId: string;
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
}

export interface DispatchFailure {
	taskId: string;
	stage: string;
	audited: boolean;
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
