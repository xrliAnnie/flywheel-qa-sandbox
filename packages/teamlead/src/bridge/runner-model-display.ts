import {
	adapterTypeToFamily,
	isThreeStagePhaseRole,
	type RunnerModelDisplay,
	renderRunnerModelDisplay,
	resolvePhaseDispatch,
} from "flywheel-config";
import type { Session } from "../StateStore.js";

type DisplaySession = Pick<
	Session,
	"adapter_type" | "runner_model" | "dispatch_model" | "chat_thread_role"
>;

export function sessionModelDisplay(
	session: DisplaySession,
	env: Record<string, string | undefined> = process.env,
): RunnerModelDisplay | undefined {
	if (session.runner_model) {
		return renderRunnerModelDisplay({
			vendor: session.adapter_type
				? adapterTypeToFamily(session.adapter_type)
				: undefined,
			model: session.runner_model,
		});
	}
	if (isThreeStagePhaseRole(session.chat_thread_role)) {
		return renderRunnerModelDisplay(
			resolvePhaseDispatch(session.chat_thread_role, env),
		);
	}
	if (session.dispatch_model) {
		return renderRunnerModelDisplay({
			vendor: session.adapter_type
				? adapterTypeToFamily(session.adapter_type)
				: undefined,
			model: session.dispatch_model,
		});
	}
	return undefined;
}
