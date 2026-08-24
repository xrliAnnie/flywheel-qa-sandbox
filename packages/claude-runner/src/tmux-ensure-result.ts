export const TMUX_ENSURE_SUCCESS_ACTIONS = new Set([
	"verified",
	"created",
	"rescued_then_verified",
	"rescued_then_created",
]);

export type TmuxEnsureSuccess = {
	action: string;
	reachablePid: number;
	createStdout?: string;
};

export function parseTmuxEnsureSuccess(
	stdout: string | Buffer | undefined,
): TmuxEnsureSuccess | undefined {
	if (stdout === undefined) return undefined;
	try {
		const parsed = JSON.parse(stdout.toString()) as {
			action?: unknown;
			reachablePid?: unknown;
			createStdout?: unknown;
		};
		if (
			typeof parsed.action !== "string" ||
			!TMUX_ENSURE_SUCCESS_ACTIONS.has(parsed.action) ||
			!Number.isSafeInteger(parsed.reachablePid) ||
			(parsed.reachablePid as number) <= 0
		) {
			return undefined;
		}
		return {
			action: parsed.action,
			reachablePid: parsed.reachablePid as number,
			...(typeof parsed.createStdout === "string"
				? { createStdout: parsed.createStdout }
				: {}),
		};
	} catch {
		return undefined;
	}
}
