/**
 * FLY-1018 ContextAssembler (plan §2.5) — three-segment system prompt,
 * immutable within a turn:
 *
 *   1. FIXED CORE (constant): role + guardrail language contract + tool
 *      usage norms. The "search memory first" instruction is the behavior
 *      source behind spike N2's 20/20 context-injection result.
 *   2. PERSONA: identity.md content (≤8000 chars). Missing file degrades
 *      gracefully — segment skipped + audit warning, never fatal.
 *   3. PROJECT: projectName + entry-injected scene context. This segment
 *      is the north-star anchor: talk to a specific Lead about a specific
 *      project.
 */

import fs from "node:fs";
import type { AuditLog } from "./types.js";

const PERSONA_MAX_CHARS = 8_000;

export const FIXED_CORE = `You are the Flywheel dispatch assistant — a tool-using agent that helps the founder file issues, dispatch engineering Runners, check run status, and keep project memory. You are NOT a Lead and NOT a Runner; you coordinate through the Bridge API only.

HARD GUARDRAILS (non-negotiable):
- You cannot merge, ship, or deploy anything. Your ONLY ship-related action is the request_ship_approval tool, which files a REQUEST for founder approval. Nothing is merged by that call.
- NEVER claim a PR is merged, shipped, or deployed. When reporting ship status, quote exactly what the tools returned — a requested approval is "requested", nothing more.
- Only call the tools declared to you. Never invent tool names or parameters.

WORKING NORMS:
- If a required parameter is missing or ambiguous, ASK the user — never fabricate values (issue ids, project names, execution ids).
- Before dispatching work or answering questions that may depend on project conventions, ALWAYS call search_memory first (shared bucket: user_id = project_name).
- After completing a meaningful task, persist the outcome with save_memory so future agents can recall it.
- Keep final answers concise and factual; include identifiers (issue ids, executionIds, PR URLs) the user needs for follow-up.`;

export interface ContextOptions {
	projectName: string;
	/**
	 * FLY-1060 QA F2: the binding's department label. Documented in the
	 * PROJECT segment so the model knows create_issue auto-applies it and
	 * never guesses label names against the dispatch admission gate.
	 */
	deptLabel?: string;
	/** Path to an identity.md persona file (optional). */
	identityPath?: string;
	/** Entry-injected scene context (e.g. Discord channel description). */
	contextNote?: string;
	audit: AuditLog;
	/** Injectable reader for tests. */
	readFile?: (path: string) => string;
}

export function assembleSystemPrompt(opts: ContextOptions): string {
	const segments: string[] = [FIXED_CORE];

	if (opts.identityPath) {
		const read = opts.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
		try {
			let persona = read(opts.identityPath);
			if (persona.length > PERSONA_MAX_CHARS) {
				persona = persona.slice(0, PERSONA_MAX_CHARS);
			}
			if (persona.trim().length > 0) {
				segments.push(`## Persona\n${persona.trim()}`);
			}
		} catch {
			// degrade, never fatal (plan §2.5 segment 2)
			opts.audit.warning(
				`identity file missing or unreadable: ${opts.identityPath} — persona segment skipped`,
			);
		}
	}

	const projectLines = [`## Project context\nProject: ${opts.projectName}`];
	if (opts.deptLabel?.trim()) {
		projectLines.push(
			`Department label: "${opts.deptLabel.trim()}" — create_issue auto-applies it to issues you create, so Runner dispatch passes the department admission check. Do not invent other department labels.`,
		);
	}
	if (opts.contextNote?.trim()) {
		projectLines.push(opts.contextNote.trim());
	}
	segments.push(projectLines.join("\n"));

	return segments.join("\n\n");
}
