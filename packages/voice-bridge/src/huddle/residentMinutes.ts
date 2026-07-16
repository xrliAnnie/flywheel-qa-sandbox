/**
 * summarizeViaResidentBrain (FLY-1160 §4.1-6) — the /glaw resident-mode meeting
 * minutes. The HOST's resident session already holds the whole conversation, so
 * the summary is one final turn on it (quote founder's words with timestamps).
 *
 * Failure contract (Codex R1 HIGH-3): the model output is landed ONLY on a CLEAN
 * terminal completion. A mid-stream failure that already emitted a prefix must
 * NOT land a truncated summary (ConclusionPipeline would treat any non-empty
 * string as success and mark the issue Done) — ANY exception falls back to the
 * raw journal, so the meeting's facts are never silently discarded.
 */
export interface ResidentSummaryBrain {
	respond(
		turn: { text: string; history: [] },
		opts: { signal: AbortSignal },
	): AsyncIterable<string>;
	/** true once the brain began tearing down (dispose/forceKill). An external
	 * teardown interrupt ends the summary turn's iterator CLEANLY (same as a real
	 * completion), so the helper reads this to reject a partial (Codex R3 HIGH). */
	health?(): { disposed: boolean };
}

/** the raw-journal fallback body — a degraded but complete landing. */
export function rawJournalMinutes(journalSnapshot: string): string {
	return `## 结论\n(常驻大脑此刻不可用,直接附上带时间戳的会议记录)\n\n${journalSnapshot}`;
}

export async function summarizeViaResidentBrain(
	brain: ResidentSummaryBrain | undefined,
	journalSnapshot: string,
): Promise<string> {
	if (brain) {
		let out = "";
		let clean = false;
		const ac = new AbortController();
		try {
			for await (const chunk of brain.respond(
				{
					text: `[控制] 会议结束。请把本场 huddle 整理成会议纪要:一段「结论」+ 一个 Action items 列表,每条引用 founder 的原话并带 [时间戳](可追溯)。用 markdown、中文、简洁。会议记录(带时间戳):\n\n${journalSnapshot}`,
					history: [],
				},
				{ signal: ac.signal },
			)) {
				out += chunk;
			}
			// A completion is CLEAN only if the stream finished a NORMAL terminal
			// result AND the brain was not being torn down while it ran — a daemon
			// shutdown (dispose) interrupts the turn but its iterator still returns
			// cleanly, so `disposed` is the only way to tell that apart (Codex R3).
			clean = !brain.health?.().disposed;
		} catch {
			// brain failed mid-summary — fall through to the raw-journal fallback.
		}
		// only a CLEAN, non-empty completion lands the model output.
		if (clean && out.trim()) return out;
	}
	return rawJournalMinutes(journalSnapshot);
}
