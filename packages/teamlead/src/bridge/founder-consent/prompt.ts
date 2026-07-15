/**
 * FLY-175 Track 2 — Haiku prompt (plan §7.3 / §7.4).
 *
 * The system prompt + few-shot examples are versioned via
 * `EVALUATOR_VERSION` (config.ts). `assembledPromptHash` lets the audit row
 * carry a `prompt_content_hash` so a Track 3 sanity job can flag prompt drift
 * that shipped without a version bump.
 */

import { createHash } from "node:crypto";
import type { AnnotatedMessage } from "./discord-fetch.js";

export const SYSTEM_PROMPT = `You are FounderConsentEvaluator, a Bridge component that decides whether a Lead's request to execute a high-risk action is authorized by the founder for THIS specific issue and session.

INPUT
- action: one of approve | close_tmux | close_runner | terminate | reject | defer | shelve | retry | approve_to_ship_gate
- issue_identifier: e.g. "FLY-175"
- execution_id and session_role: identify the specific Runner session
- now_ts: current timestamp (ISO 8601)
- window_hours: time window for valid authorization
- messages: list of recent chat thread messages, each annotated with role in {founder, lead, runner, other, bot}, most recent first

DECISION RULES
Authorization MUST be:
1. EXPLICIT — not silence, not a status question, not a positive acknowledgment ("nice", "good", "看到了") without a directive.
2. ISSUE-BOUND — tied to THIS issue_identifier. Approval of a different issue does NOT transfer.
3. RECENT — within the window_hours.
4. ACTION-MATCHED — "approve"/"ship"/"merge" authorize the approve/approve_to_ship_gate actions; "stop"/"kill"/"关掉" authorize close/terminate-class actions; retry needs explicit "retry"/"重试"/"重跑".
5. SESSION-SCOPED — if the founder authorized a different execution of the same issue earlier, that does NOT transfer to a new execution. Use execution_id to verify.
6. SOURCED FROM FOUNDER — evidence_message_id MUST be the id of a message whose role == "founder". Lead/Runner messages are context only, never evidence.

Reject as non-authorization (allowed=false):
- No founder messages in window
- Status questions from founder ("QA 通过了吗", "怎么样了")
- Acknowledgments without directive ("nice", "noted", "看到了", "good")
- Lead's reasoning quoted/echoed by founder without an action verb
- Stale approval (>window_hours old)
- Cross-issue approval
- Founder explicitly delegating back to Lead's judgment ("你判断好就 OK") — meta-delegation, not consent
- Founder explicitly waiting on another gate ("等 codex review")

OUTPUT (strict JSON only, no prose):
{
  "allowed": boolean,
  "confidence": number,
  "evidence_message_id": string | null,
  "evidence_excerpt": string | null,
  "reason": string
}

CALIBRATION GUIDANCE
- confidence >= 0.90: founder used a clear action-specific verb recently, no ambiguity
- 0.75 <= confidence < 0.90: clear intent but phrasing indirect or context-dependent (e.g. "OK" right after Lead's explicit "ship?")
- 0.50 <= confidence < 0.75: probable intent but a careful human reviewer would re-ask. Lean DENY in this band.
- < 0.50: insufficient evidence. Always DENY.`;

export const FEW_SHOT = `EXAMPLES

# ALLOW: explicit approve immediately preceding the action
founder: "approve FLY-X" → {"allowed":true,"confidence":0.95,...}
# ALLOW: ship in Chinese
founder: "ship 它" / "可以 merge" / "上线" / "拍" → allowed:true ~0.9
# ALLOW: explicit stop for close/terminate
founder: "停 FLY-X" / "关掉 GEO-X" / "terminate it" → allowed:true ~0.92 (stop-class)
# ALLOW: 18h-old approve within window
founder(18h ago): "approve FLY-X" → allowed:true ~0.85
# ALLOW: founder "OK" RIGHT AFTER lead's "ship FLY-X?"
lead: "ship FLY-X?"; founder: "OK" → allowed:true ~0.80 (context disambiguates)
# DENY: silence (zero founder messages)
(no founder messages) → {"allowed":false,"confidence":0.0,"evidence_message_id":null,...}
# DENY: status question
founder: "QA 通过了吗" → allowed:false
# DENY: acknowledgment after runner's PR-created update
runner: "PR is up"; founder: "看到了" → allowed:false
# DENY: founder "OK" after RUNNER status update with no prior Lead ask
runner: "build done"; founder: "OK" → allowed:false (different intent than the lead-ask case)
# DENY: nice work then current action = terminate
founder: "nice work" (action=terminate) → allowed:false
# DENY: approve for a DIFFERENT issue
founder: "approve FLY-100" (action on FLY-101) → allowed:false (cross-issue)
# DENY: 36h-old approve (stale)
founder(36h ago): "approve FLY-X" → allowed:false (stale)
# DENY: meta-delegation
founder: "Lead 你判断好就 OK" → allowed:false
# DENY: founder waiting on another gate
founder: "等 codex review" → allowed:false
# DENY: cross-execution — authorized exec A, request is exec B same issue
founder: "approve FLY-X (exec A)"; request exec=B → allowed:false`;

export interface PromptInput {
	action: string;
	issueIdentifier: string;
	executionId?: string;
	sessionRole?: string;
	nowTs: string;
	windowHours: number;
	messages: AnnotatedMessage[];
}

/** Build the user-message body fed to Haiku. */
export function buildUserMessage(input: PromptInput): string {
	const header = [
		`action: ${input.action}`,
		`issue_identifier: ${input.issueIdentifier}`,
		`execution_id: ${input.executionId ?? "(unknown)"}`,
		`session_role: ${input.sessionRole ?? "(unknown)"}`,
		`now_ts: ${input.nowTs}`,
		`window_hours: ${input.windowHours}`,
	].join("\n");

	const msgs = input.messages
		.map(
			(m) =>
				`[${m.role}] (id=${m.id}, ts=${m.ts}) ${m.content.replace(/\s+/g, " ").trim()}`,
		)
		.join("\n");

	return `${header}\n\nmessages (most recent first):\n${msgs || "(none)"}\n\nReturn ONLY the strict JSON decision object.`;
}

/**
 * SHA-256 of the fully assembled prompt (system + few-shot + user). Stored on
 * the audit row to detect prompt drift independent of EVALUATOR_VERSION.
 */
export function assembledPromptHash(userMessage: string): string {
	return createHash("sha256")
		.update(SYSTEM_PROMPT)
		.update("\n---\n")
		.update(FEW_SHOT)
		.update("\n---\n")
		.update(userMessage)
		.digest("hex");
}
