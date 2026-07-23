export const CLOSED_SETTLED_COMPLETIONS = [
	"stale_execution_superseded",
	"stale_resubmission_escalated",
] as const;

export type ClosedSettledCompletion =
	(typeof CLOSED_SETTLED_COMPLETIONS)[number];

export function isClosedSettledCompletion(
	settled: unknown,
): settled is ClosedSettledCompletion {
	return (CLOSED_SETTLED_COMPLETIONS as readonly unknown[]).includes(settled);
}
