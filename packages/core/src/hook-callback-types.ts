/**
 * Cross-package interface for HookCallbackServer.
 * Lives in core so claude-runner can depend on it without
 * importing edge-worker (would create circular dependency).
 */
export interface IHookCallbackServer {
	getPort(): number;
	waitForCompletion(
		callbackToken: string,
		timeoutMs: number,
	): Promise<{ token: string; sessionId: string; issueId: string } | null>;
	/** Cancel a pending waitForCompletion/waitForEvent listener by token */
	cancelWait(token: string): void;
}
