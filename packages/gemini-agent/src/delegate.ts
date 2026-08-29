/**
 * FLY-1018 M3 — voice delegate seam (plan §5, seam side).
 *
 * The two-layer voice architecture (spike S3, mode a — 5/5, ~0.6s):
 * Live holds ONE delegate tool; its handler ACKs IMMEDIATELY (the ACK
 * string becomes the Live function response, spoken as "已受理") and the
 * deep text loop runs asynchronously. Completion reaches the user through
 * an injected CompletionSink — today's binding is Discord text (results
 * land regardless of voice); voice re-injection is the orchestration
 * layer's job (voice-bridge PR-2) and deliberately NOT promised here.
 *
 * Cancellation contract (voice-core tool-call-cancellation): the Live
 * `signal` only cancels PRE-ACK preparation. An accepted deep-brain task
 * is never rolled back — the acceptance/cancellation is recorded in
 * `<auditDir>/delegate.jsonl` either way.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
// type-only import — the ONLY voice-core dependency (plan §2.1)
import type { LiveToolSpec } from "flywheel-voice-core";
import { digest } from "./audit.js";
import type { AgentConfig } from "./config.js";
import { chunkMessage } from "./discord/render.js";
import {
	type AgentSessionOptions,
	runAgentSession,
	type SessionResult,
} from "./session.js";
import type { SessionBinding } from "./tools/registry.js";
import type { Terminal } from "./types.js";

export type CompletionSink = (
	taskId: string,
	terminal: Terminal,
) => void | Promise<void>;

export interface DelegateToolOptions {
	config: AgentConfig;
	binding: SessionBinding;
	identityPath?: string;
	contextNote?: string;
	/** Injected by the orchestration layer — today: Discord text sink. */
	onComplete: CompletionSink;
	/** Injectable session runner (tests). */
	runSession?: (opts: AgentSessionOptions) => Promise<SessionResult>;
	/** Injectable id source (tests). */
	newTaskId?: () => string;
	/** Injectable appender for the delegate audit line (tests). */
	appendAudit?: (line: string) => void;
}

function defaultAppendAudit(auditDir: string): (line: string) => void {
	return (line) => {
		fs.mkdirSync(auditDir, { recursive: true });
		fs.appendFileSync(path.join(auditDir, "delegate.jsonl"), line, "utf8");
	};
}

export function createDelegateTool(opts: DelegateToolOptions): LiveToolSpec {
	const runSession = opts.runSession ?? runAgentSession;
	const newTaskId = opts.newTaskId ?? (() => randomUUID().slice(0, 8));
	const appendAudit =
		opts.appendAudit ?? defaultAppendAudit(opts.config.auditDir);

	return {
		declaration: {
			name: "delegate_task",
			description:
				"Delegate a concrete task to the deep dispatch agent (file issues, dispatch engineering runners, check run status, save/search project memory). Returns an immediate acceptance — the result is announced separately when the task completes. Use for anything that requires taking action, not just talking.",
			parameters: {
				type: "OBJECT",
				properties: {
					instruction: {
						type: "STRING",
						description: "What the user wants done, self-contained.",
					},
					context: {
						type: "STRING",
						description:
							"Optional: extra conversational context the deep agent needs.",
					},
				},
				required: ["instruction"],
			},
		},

		handler: async (args, { signal }) => {
			const parsed = (args ?? {}) as Record<string, unknown>;
			const instruction =
				typeof parsed.instruction === "string" ? parsed.instruction.trim() : "";
			if (instruction === "") {
				return "无法受理:缺少 instruction(要做什么)。请把任务说完整。";
			}
			const context =
				typeof parsed.context === "string" && parsed.context.trim() !== ""
					? parsed.context.trim()
					: undefined;

			const taskId = newTaskId();

			// pre-ACK cancellation: the ONLY window the Live signal cancels
			if (signal.aborted) {
				appendAudit(
					`${JSON.stringify({ ts: new Date().toISOString(), type: "delegate_cancellation", taskId, phase: "pre_ack" })}\n`,
				);
				return `已取消(任务 ${taskId} 未开始)。`;
			}

			// acceptance on disk BEFORE the ACK goes back to Live
			appendAudit(
				`${JSON.stringify({ ts: new Date().toISOString(), type: "delegate_accept", taskId, instructionDigest: digest(instruction) })}\n`,
			);

			// async deep-brain start — NOT awaited; accepted tasks never roll
			// back on later Live cancellation (own AbortController, not the
			// Live signal)
			void runSession({
				config: opts.config,
				binding: opts.binding,
				userText: context
					? `${instruction}\n\n(语音会话补充上下文:${context})`
					: instruction,
				entry: "delegate",
				identityPath: opts.identityPath,
				contextNote: opts.contextNote,
				sessionId: taskId,
			})
				.then(({ terminal }) => opts.onComplete(taskId, terminal))
				.catch((err) => {
					// runSession returning is the norm (terminals, not throws);
					// a throw is bug-class — still fire the sink, never vanish
					const terminal: Terminal = {
						reason: "model_error",
						finalText: null,
						error: {
							kind: "unknown",
							message: String((err as Error)?.message ?? err),
						},
						stats: {
							sessionId: taskId,
							steps: 0,
							toolCalls: 0,
							toolErrors: 0,
							hallucinatedToolCalls: 0,
							inputTokens: 0,
							outputTokens: 0,
							durationMs: 0,
							model: opts.config.model,
							surface: opts.config.surface,
						},
					};
					return opts.onComplete(taskId, terminal);
				});

			// the immediate ACK — Live speaks this as the function response
			return `已受理,任务 ${taskId},完成后另行播报。`;
		},
	};
}

/**
 * Today's CompletionSink binding: post the outcome as Discord text into the
 * bound channel (M2 bot). Results land even before voice re-injection
 * exists (north star: 结果落地 doesn't wait for voice).
 */
export function createDiscordCompletionSink(
	send: (content: string) => Promise<unknown>,
): CompletionSink {
	return async (taskId, terminal) => {
		if (terminal.reason === "completed") {
			const chunks = chunkMessage(
				`✅ 任务 ${taskId} 完成:\n${terminal.finalText ?? "(无输出)"}`,
			);
			for (const chunk of chunks) {
				await send(chunk);
			}
			return;
		}
		const detail = terminal.error
			? ` — ${terminal.error.kind}: ${terminal.error.message.slice(0, 300)}`
			: "";
		await send(
			`⚠️ 任务 ${taskId} 未完成(${terminal.reason})${detail}。审计:session ${taskId}`,
		);
	};
}
