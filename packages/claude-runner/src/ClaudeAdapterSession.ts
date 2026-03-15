import type {
	AdapterSession,
	AgentMessage,
	IMessageFormatter,
} from "flywheel-core";
import type { ClaudeRunner } from "./ClaudeRunner.js";

/**
 * ClaudeAdapterSession — wraps a running ClaudeRunner into the AdapterSession interface.
 *
 * Created by ClaudeAdapter.startSession(). Delegates all streaming lifecycle
 * methods to the underlying ClaudeRunner instance.
 */
export class ClaudeAdapterSession implements AdapterSession {
	readonly startedAt: Date;
	readonly adapterType = "claude-sdk";

	constructor(private runner: ClaudeRunner) {
		this.startedAt = new Date();
	}

	get sessionId(): string | null {
		return this.runner.getSessionInfo()?.sessionId ?? null;
	}

	addMessage(content: string): void {
		this.runner.addStreamMessage(content);
	}

	completeStream(): void {
		this.runner.completeStream();
	}

	isStreaming(): boolean {
		return this.runner.isStreaming();
	}

	stop(): void {
		this.runner.stop();
	}

	isRunning(): boolean {
		return this.runner.isRunning();
	}

	getMessages(): AgentMessage[] {
		return this.runner.getMessages();
	}

	getFormatter(): IMessageFormatter {
		return this.runner.getFormatter();
	}
}
