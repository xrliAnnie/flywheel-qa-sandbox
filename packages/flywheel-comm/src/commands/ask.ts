import { CommDB } from "../db.js";
import { writeAskMarker } from "../gate-marker.js";

export interface AskArgs {
	lead: string;
	execId?: string;
	question: string;
	dbPath: string;
	/**
	 * FLY-1041: mark this ask as a fire-and-forget status REPORT (the
	 * LEAD REPORT-BACK "DONE:" convention). The Lead still receives it via the
	 * normal `runner_question` relay; the ONLY difference is that the founder
	 * reply deliverer excludes it from its binding candidate set — a founder
	 * "ship" in the thread can never be attributed to a runner's DONE report
	 * (the FLY-910 `founder_reply_ambiguous` noise source).
	 */
	report?: boolean;
	/** Injectable for tests. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Non-blocking question.
 *
 * FLY-161: Bridge's GatePoller picks this up within ≤1 poll tick (~3s default)
 * and emits a `runner_question` event to the Lead. The Lead notifies Annie
 * but the Runner does NOT wait for a response — the Runner should keep working
 * on other parts of the task. Use `gate` (with a checkpoint) instead when the
 * Runner needs to block until the Lead responds.
 */
export function ask(args: AskArgs): string {
	const env = args.env ?? process.env;
	const db = new CommDB(args.dbPath);
	try {
		const fromAgent = args.execId ?? "runner";
		const questionId = db.insertQuestion(
			fromAgent,
			args.lead,
			args.question,
			args.report ? { kind: "report" } : undefined,
		);

		// FLY-142 (Option Y): mirror the FLY-123 gate-marker. When
		// FLYWHEEL_GATE_MARKER_DIR is set (Codex runner env, injected by
		// CodexTmuxAdapter) write a question-bound ask-marker carrying the
		// runner's transport vendor, so a later Lead `respond` routes the
		// mailbox wake to the runner's OWN backend (Codex) instead of the
		// process-env default. Claude runners never have the env → no marker →
		// the wake falls back to fromEnv = claude-code (byte-compatible).
		//
		// Best-effort (unlike gate's fail-closed): `ask` is non-blocking, so the
		// durable question — not this wake-routing optimization — is the
		// contract. A write failure must not fail the ask; it is surfaced loudly
		// and the wake degrades to fromEnv.
		const markerDir = env.FLYWHEEL_GATE_MARKER_DIR?.trim();
		if (markerDir) {
			try {
				// The wake transport accepts ONLY "claude-code" | "codex" (see
				// wake.ts). An ask-marker is written only for Codex runners
				// (FLYWHEEL_GATE_MARKER_DIR set), so coerce an unrecognized
				// FLYWHEEL_RUNNER_VENDOR_ID (e.g. a mistaken "codex-tmux" executor
				// id) to "codex" — persisting an invalid vendor would make
				// `respond`'s wake silently no-op and strand the idle runner.
				const rawVendor = env.FLYWHEEL_RUNNER_VENDOR_ID?.trim() || "codex";
				const vendor =
					rawVendor === "claude-code" || rawVendor === "codex"
						? rawVendor
						: "codex";
				if (vendor !== rawVendor) {
					process.stderr.write(
						`[flywheel-comm ask] unrecognized FLYWHEEL_RUNNER_VENDOR_ID "${rawVendor}" — ask-marker vendor coerced to "codex"\n`,
					);
				}
				writeAskMarker(markerDir, {
					questionId,
					executionId: fromAgent,
					vendor,
				});
			} catch (err) {
				process.stderr.write(
					`[flywheel-comm ask] ask-marker write failed for ${questionId}: ${(err as Error).message} — wake will fall back to env transport\n`,
				);
			}
		}

		return questionId;
	} finally {
		db.close();
	}
}
