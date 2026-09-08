import {
	cleanupRunnerSnapshots,
	inspectManagedSnapshotDirectories,
	isOperatorSnapshotOwnerDead,
	MANAGED_SNAPSHOT_LIMIT_BYTES,
	pruneRepairSnapshots,
	readManagedSnapshotOwner,
	type SnapshotOwner,
} from "flywheel-comm/snapshot-storage";
import {
	CMUX_LIVE_SESSION_STATUSES,
	isOperationalTerminalStatus,
} from "../operational-terminal-status.js";
import type { StateStore } from "../StateStore.js";

type SnapshotStateStore = Pick<
	StateStore,
	| "getSession"
	| "getWorkflowActivation"
	| "getWorkflowNodeCompletion"
	| "resolveCurrentWorkflowActivation"
>;

export type SnapshotOwnerResolution =
	| { kind: "current"; owner: SnapshotOwner }
	| { kind: "none" }
	| { kind: "ambiguous" };

export function resolveActiveSnapshotOwner(
	store: SnapshotStateStore,
	executionId: string,
): SnapshotOwnerResolution {
	const workflow = store.resolveCurrentWorkflowActivation(executionId);
	if (workflow.kind === "ambiguous") return { kind: "ambiguous" };
	if (workflow.kind === "current") {
		const binding = workflow.binding;
		if (
			store.getWorkflowNodeCompletion(
				binding.run_id,
				binding.node_id,
				binding.attempt,
			)
		) {
			return { kind: "none" };
		}
		return {
			kind: "current",
			owner: {
				kind: "workflow",
				executionId,
				runId: binding.run_id,
				nodeId: binding.node_id,
				attempt: binding.attempt,
				activationId: binding.activation_id,
			},
		};
	}
	const session = store.getSession(executionId);
	if (!session?.started_at || !CMUX_LIVE_SESSION_STATUSES.has(session.status)) {
		return { kind: "none" };
	}
	return {
		kind: "current",
		owner: {
			kind: "session",
			executionId,
			sessionStartedAt: session.started_at,
		},
	};
}

function ownersEqual(left: SnapshotOwner, right: SnapshotOwner): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isTerminalOwner(
	store: SnapshotStateStore,
	owner: SnapshotOwner,
	terminalAuthority: boolean,
	operatorIsDead: typeof isOperatorSnapshotOwnerDead,
): boolean {
	if (owner.kind === "operator") return operatorIsDead(owner);
	if (owner.kind === "session") {
		const session = store.getSession(owner.executionId);
		return (
			session?.started_at === owner.sessionStartedAt &&
			(terminalAuthority || isOperationalTerminalStatus(session.status))
		);
	}
	const binding = store.getWorkflowActivation(owner.activationId);
	if (
		!binding ||
		binding.execution_id !== owner.executionId ||
		binding.run_id !== owner.runId ||
		binding.node_id !== owner.nodeId ||
		binding.attempt !== owner.attempt
	) {
		return false;
	}
	const completion = store.getWorkflowNodeCompletion(
		owner.runId,
		owner.nodeId,
		owner.attempt,
	);
	return (
		terminalAuthority ||
		(completion?.activation_id === owner.activationId &&
			completion.execution_id === owner.executionId)
	);
}

export async function cleanupExecutionSnapshots(
	store: SnapshotStateStore,
	executionId: string,
	deps: {
		readOwner?: typeof readManagedSnapshotOwner;
		cleanup?: typeof cleanupRunnerSnapshots;
		terminalAuthority?: boolean;
		operatorIsDead?: typeof isOperatorSnapshotOwnerDead;
	} = {},
) {
	const owner = (deps.readOwner ?? readManagedSnapshotOwner)(executionId);
	if (!owner) return { status: "already_absent" as const, bytesReleased: 0 };
	return (deps.cleanup ?? cleanupRunnerSnapshots)({
		executionId,
		expectedOwner: owner,
		authorize: (freshOwner) =>
			ownersEqual(freshOwner, owner) &&
			isTerminalOwner(
				store,
				freshOwner,
				deps.terminalAuthority === true,
				deps.operatorIsDead ?? isOperatorSnapshotOwnerDead,
			),
	});
}

export async function runSnapshotMaintenance(
	store: SnapshotStateStore,
	deps: {
		prune?: typeof pruneRepairSnapshots;
		inspect?: typeof inspectManagedSnapshotDirectories;
		readOwner?: typeof readManagedSnapshotOwner;
		cleanup?: typeof cleanupRunnerSnapshots;
		operatorIsDead?: typeof isOperatorSnapshotOwnerDead;
		now?: () => Date;
		log?: (event: string, detail: unknown) => void;
	} = {},
) {
	const prune = deps.prune ?? pruneRepairSnapshots;
	const now = deps.now ?? (() => new Date());
	const log = deps.log ?? ((event, detail) => console.info(event, detail));
	const dryRun = await prune({ dryRun: true, now: now() });
	log("snapshot_retention_dry_run", dryRun);
	const applied = await prune({ dryRun: false, now: now() });
	log("snapshot_retention_apply", applied);
	const cleanup: Array<{
		executionId: string;
		bytes: number;
		status: string;
	}> = [];
	for (const entry of (deps.inspect ?? inspectManagedSnapshotDirectories)()) {
		if (entry.bytes > MANAGED_SNAPSHOT_LIMIT_BYTES) {
			log("snapshot_directory_over_budget", {
				executionId: entry.owner.executionId,
				bytes: entry.bytes,
				limitBytes: MANAGED_SNAPSHOT_LIMIT_BYTES,
			});
		}
		const result = await cleanupExecutionSnapshots(
			store,
			entry.owner.executionId,
			{
				readOwner: deps.readOwner,
				cleanup: deps.cleanup,
				operatorIsDead: deps.operatorIsDead,
			},
		);
		cleanup.push({
			executionId: entry.owner.executionId,
			bytes: entry.bytes,
			status: result.status,
		});
	}
	return { dryRun, applied, cleanup };
}
