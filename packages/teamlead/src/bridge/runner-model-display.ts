import {
	adapterTypeToFamily,
	type RunnerModelDisplay,
	renderRunnerModelDisplay,
} from "flywheel-config";
import type { Session } from "../StateStore.js";

type DisplaySession = Pick<
	Session,
	"adapter_type" | "runner_model" | "dispatch_model" | "chat_thread_role"
>;

export function sessionModelDisplay(
	session: DisplaySession,
): RunnerModelDisplay | undefined {
	if (session.runner_model) {
		return renderRunnerModelDisplay({
			vendor: session.adapter_type
				? adapterTypeToFamily(session.adapter_type)
				: undefined,
			model: session.runner_model,
		});
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
