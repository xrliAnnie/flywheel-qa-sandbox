import {
	type CommDB,
	parseReworkWakeMetadata,
	type ReworkWakeIdentity,
} from "flywheel-comm/db";
import type { StateStore } from "../../StateStore.js";

export function readProjectedReworkWake(input: {
	store: StateStore;
	commDb: CommDB;
	projectName: string;
	family: string;
	physicalId: string;
}): {
	reworkWake: ReworkWakeIdentity;
	runId: string;
	projectName: string;
	issueId: string;
} | null {
	if (input.family !== "phase_wake" && input.family !== "turn_wake")
		return null;
	const phase =
		input.family === "phase_wake"
			? input.commDb.getRunnerPhaseWakeProjectionRow(input.physicalId)
			: undefined;
	if (
		input.family === "phase_wake" &&
		(!phase || phase.message_id !== input.physicalId)
	)
		return null;
	const metadata = phase ? parseReworkWakeMetadata(phase.metadata_json) : null;
	if (phase && !metadata) return null;
	const parent = input.commDb.getTurnWake(metadata?.wakeId ?? input.physicalId);
	if (
		!parent ||
		parent.purpose !== "workflow_rework" ||
		!parent.activation_id ||
		(phase &&
			(parent.execution_id !== phase.execution_id ||
				parent.activation_id !== metadata?.activationId ||
				parent.epoch !== metadata?.epoch ||
				parent.wake_id !== metadata?.wakeId))
	)
		return null;
	const identity = {
		wakeId: parent.wake_id,
		executionId: parent.execution_id,
		activationId: parent.activation_id,
		epoch: parent.epoch,
	};
	const scoped = input.store.resolveProjectedReworkWakeIdentity({
		identity,
		projectName: input.projectName,
		issueId: parent.issue_id,
	});
	if (
		!scoped ||
		(phase?.issue_id &&
			!input.store.resolveProjectedReworkWakeIdentity({
				identity,
				projectName: input.projectName,
				issueId: phase.issue_id,
			}))
	)
		return null;
	const session = input.commDb.getSession(identity.executionId);
	if (session && session.project_name !== scoped.projectName) return null;
	return {
		reworkWake: identity,
		runId: scoped.runId,
		projectName: scoped.projectName,
		issueId: scoped.issueId,
	};
}

export function retireObservedReworkWakeAttempt(input: {
	store: StateStore;
	commDb?: CommDB;
	projectName: string;
	attempt: { attempt_id: string; family: string; contract_ref_json: string };
	now: string;
}): boolean {
	if (
		input.attempt.family !== "phase_wake" &&
		input.attempt.family !== "turn_wake"
	)
		return false;
	const ref = JSON.parse(input.attempt.contract_ref_json) as {
		pk?: unknown;
		reworkWake?: { executionId?: unknown };
	};
	if (typeof ref.pk !== "string") return false;
	if (input.commDb && ref.reworkWake) {
		const source =
			input.attempt.family === "phase_wake"
				? input.commDb.getRunnerPhaseWakeProjectionRow(ref.pk)
				: input.commDb.getTurnWake(ref.pk);
		if (source && source.execution_id !== ref.reworkWake.executionId)
			return false;
	}

	const observed = input.commDb
		? readProjectedReworkWake({
				store: input.store,
				commDb: input.commDb,
				projectName: input.projectName,
				family: input.attempt.family,
				physicalId: ref.pk,
			})
		: null;
	if (observed)
		input.store.bindProjectedReworkWakeIdentity({
			attemptId: input.attempt.attempt_id,
			physicalId: ref.pk,
			identity: observed.reworkWake,
			projectName: observed.projectName,
			issueId: observed.issueId,
			now: input.now,
		});
	return input.store.retireProjectedReworkWakeAttempt({
		attemptId: input.attempt.attempt_id,
		now: input.now,
	});
}
