/**
 * FLY-1018 voice phase — /gemini-advanced deep-dispatch injection (route A).
 *
 * Mounts gemini-agent's delegate_task LiveToolSpec (M3 seam) onto a SEPARATE
 * voice command (/gemini-advanced by default) that rides the merged /gemini
 * engine — /gemini itself stays plain and never carries the delegate
 * (founder contract 2026-07-11). The Live session ACKs a spoken "已受理"
 * immediately, the deep text loop runs asynchronously, and completion is
 * announced back through the session's speak channel
 * (RotatorConversationAdapter.sendText) plus an optional Discord-text
 * fallback.
 *
 * Authority note: the deep loop is PR #518's closed 6-tool registry behind
 * the scoped Bridge token — this layer adds ZERO new authority surface; ship
 * intent still ends at request_ship_approval.
 */

import {
	ConfigError,
	createDelegateTool,
	createDiscordCompletionSink,
	type DelegateToolOptions,
	loadAgentConfig,
	type Terminal,
} from "flywheel-gemini-agent";
import type { LiveToolSpec } from "flywheel-voice-core";

export interface AssistantAdvancedConfig {
	/** the explicit dispatch Lead — the session binding's leadId (never inferred). */
	leadId: string;
	/** the SEPARATE voice command the delegate mounts on (founder contract
	 * 2026-07-11: /gemini stays plain). Optional for hand-constructed configs;
	 * config resolution and wiring both default it to "gemini-advanced". */
	commandName?: string;
	/** department label auto-applied by create_issue (dispatch admission, F2). */
	deptLabel?: string;
	/** persona file for the deep agent. */
	identityPath?: string;
}

/** spoken copy stays short — the full outcome goes to the text fallback. */
const SPOKEN_RESULT_CAP = 240;

export function formatSpokenAnnouncement(
	taskId: string,
	terminal: Terminal,
): string {
	if (terminal.reason === "completed") {
		const text = (terminal.finalText ?? "").trim();
		if (text === "") return `任务 ${taskId} 完成,没有文字结果。`;
		const summary =
			text.length > SPOKEN_RESULT_CAP
				? `${text.slice(0, SPOKEN_RESULT_CAP)}……详情见文字记录。`
				: text;
		return `任务 ${taskId} 完成:${summary}`;
	}
	const detail = terminal.error ? `,${terminal.error.kind}` : "";
	return `任务 ${taskId} 未完成(${terminal.reason}${detail}),详情见审计记录。`;
}

export interface AdvancedDelegateDeps {
	advanced: AssistantAdvancedConfig;
	projectName: string;
	env: NodeJS.ProcessEnv;
	/** the Live speak channel — completion is announced OUT LOUD through it. */
	speak: (text: string) => void;
	log: (msg: string) => void;
	/** optional Discord-text fallback; when set the FULL outcome also lands as text. */
	sendText?: (content: string) => Promise<unknown>;
	/** test injectables forwarded to createDelegateTool. */
	_test?: Pick<DelegateToolOptions, "runSession" | "newTaskId" | "appendAudit">;
}

/**
 * Build the delegate tool for an advanced-mode assistant session. Fails fast
 * (throw) when the deep-agent env is incomplete — a half-configured advanced
 * mode must kill the deploy at startup, never at Annie's first use (same
 * discipline as the GEMINI_API_KEY assistant check in cli.ts).
 */
/**
 * Startup preflight shared with the daemon boot path (cli.ts): a
 * half-configured advanced mode must kill the deploy at startup with fix
 * guidance, never at the founder's first /gemini-advanced use.
 */
export function loadAdvancedAgentConfig(
	env: NodeJS.ProcessEnv,
): ReturnType<typeof loadAgentConfig> {
	try {
		return loadAgentConfig(env);
	} catch (err) {
		if (err instanceof ConfigError) {
			throw new Error(
				`voice-bridge: huddle.assistant.advanced is configured but the deep agent env is incomplete — ${err.message}. ` +
					"Set FLYWHEEL_GEMINI_AGENT=1 / GEMINI_API_KEY / FLYWHEEL_BRIDGE_URL / FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN (scoped token ONLY, never the master token), or remove huddle.assistant.advanced.",
			);
		}
		throw err;
	}
}

export function buildAdvancedDelegateTool(
	deps: AdvancedDelegateDeps,
): LiveToolSpec {
	const config = loadAdvancedAgentConfig(deps.env);

	const textSink = deps.sendText
		? createDiscordCompletionSink(deps.sendText)
		: null;

	return createDelegateTool({
		config,
		binding: {
			projectName: deps.projectName,
			leadId: deps.advanced.leadId,
			...(deps.advanced.deptLabel && { deptLabel: deps.advanced.deptLabel }),
		},
		identityPath: deps.advanced.identityPath,
		onComplete: async (taskId, terminal) => {
			// announce failure paths too — a silent sink would strand the founder
			// waiting on a task that already died (delegate.ts fires this sink for
			// every terminal, including runSession throws).
			try {
				deps.speak(formatSpokenAnnouncement(taskId, terminal));
			} catch (err) {
				deps.log(
					`advanced announce (spoken) failed for task ${taskId}: ${String((err as Error).message ?? err)}`,
				);
			}
			if (textSink) {
				try {
					await textSink(taskId, terminal);
				} catch (err) {
					deps.log(
						`advanced announce (text) failed for task ${taskId}: ${String((err as Error).message ?? err)}`,
					);
				}
			}
		},
		...deps._test,
	});
}
