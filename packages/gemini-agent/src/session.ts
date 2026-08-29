/**
 * FLY-1018 runAgentSession (plan §2.1) — the single facade every entry
 * shell (CLI / Discord daemon / voice delegate) calls. Wires config +
 * context + audit + registry + loop; owns the audit-before-call ordering
 * (session_start with the user's input digest is on disk BEFORE the first
 * model call) and resume persistence (interaction id ↔ state file).
 */

import { randomUUID } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { digest, JsonlAuditLog } from "./audit.js";
import { createModelSurface, type RawGenAi } from "./client.js";
import type { AgentConfig } from "./config.js";
import { assembleSystemPrompt } from "./context.js";
import { runLoop } from "./loop.js";
import { BridgeClient } from "./tools/bridge-client.js";
import { createToolRegistry, type SessionBinding } from "./tools/registry.js";
import type { AgentEvent, Terminal } from "./types.js";

export interface AgentSessionOptions {
	config: AgentConfig;
	/** North-star anchor: this session talks to THIS lead about THIS project. */
	binding: SessionBinding;
	userText: string;
	entry: "cli" | "discord" | "delegate";
	identityPath?: string;
	contextNote?: string;
	signal?: AbortSignal;
	onEvent?: (e: AgentEvent) => void;
	/** Explicit session id (entry shell already announced it, e.g. Discord ACK). */
	sessionId?: string;
	/** Resume a prior session (server-side Interactions thread + audit file). */
	resumeSessionId?: string;
	/** Injectable raw SDK (tests / harnesses). Defaults to real GoogleGenAI. */
	ai?: RawGenAi;
}

export interface SessionResult {
	sessionId: string;
	terminal: Terminal;
}

export async function runAgentSession(
	opts: AgentSessionOptions,
): Promise<SessionResult> {
	const { config } = opts;
	const sessionId =
		opts.sessionId ?? opts.resumeSessionId ?? randomUUID().slice(0, 8);
	const audit = new JsonlAuditLog({ dir: config.auditDir, sessionId });

	const system = assembleSystemPrompt({
		projectName: opts.binding.projectName,
		deptLabel: opts.binding.deptLabel,
		identityPath: opts.identityPath,
		contextNote: opts.contextNote,
		audit,
	});

	// user input on disk BEFORE the first model call (design principle 6)
	audit.sessionStart({
		entry: opts.entry,
		model: config.model,
		surface: config.surface,
		projectName: opts.binding.projectName,
		userTextDigest: digest(opts.userText),
	});

	const bridge = new BridgeClient({
		baseUrl: config.bridgeUrl,
		token: config.bridgeToken,
		timeoutMs: config.toolTimeoutMs,
	});
	const registry = createToolRegistry(bridge, opts.binding);

	const resumeInteractionId = opts.resumeSessionId
		? JsonlAuditLog.loadInteractionId(config.auditDir, sessionId)
		: null;

	const ai =
		opts.ai ??
		(new GoogleGenAI({ apiKey: config.apiKey }) as unknown as RawGenAi);
	const surface = createModelSurface({
		ai,
		model: config.model,
		surface: config.surface,
		audit,
		onInteractionId: (id) => audit.saveInteractionId(id),
		resumeInteractionId,
	});

	const terminal = await runLoop({
		surface,
		registry,
		system,
		user: opts.userText,
		audit,
		signal: opts.signal ?? new AbortController().signal,
		onEvent: opts.onEvent,
		sessionId,
		model: config.model,
		surfaceName: config.surface,
		maxSteps: config.maxSteps,
		tokenBudgetIn: config.tokenBudgetIn,
		tokenBudgetOut: config.tokenBudgetOut,
		resultCapChars: config.resultCapChars,
	});

	return { sessionId, terminal };
}
