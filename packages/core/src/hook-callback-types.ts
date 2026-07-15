/**
 * Cross-package interface for HookCallbackServer.
 * Lives in core so claude-runner can depend on it without
 * importing edge-worker (would create circular dependency).
 */
export interface IHookCallbackServer {
	getPort(): number;
	/**
	 * Wait for a SessionEnd callback carrying this token.
	 * When expectedSessionId is given, callbacks whose sessionId does not match
	 * are ignored (logged + keep waiting) — nested sessions inherit the parent's
	 * callback token via env, so token alone cannot identify the runner (FLY-921).
	 */
	waitForCompletion(
		callbackToken: string,
		timeoutMs: number,
		expectedSessionId?: string,
	): Promise<{ token: string; sessionId: string; issueId: string } | null>;
	/** Cancel a pending waitForCompletion/waitForEvent listener by token */
	cancelWait(token: string): void;
}
