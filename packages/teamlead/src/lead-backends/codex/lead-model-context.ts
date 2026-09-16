/** Native last-request usage is context evidence; lifetime total usage is not. */
export class LeadModelContextGuard {
	private readonly contexts = new Map<
		string,
		{ used: number; window: number }
	>();
	observe(params: unknown): void {
		const p = params as
			| {
					threadId?: unknown;
					tokenUsage?: {
						last?: { totalTokens?: unknown };
						modelContextWindow?: unknown;
					};
			  }
			| undefined;
		if (typeof p?.threadId !== "string" || !p.threadId) return;
		this.contexts.delete(p.threadId);
		const used = p.tokenUsage?.last?.totalTokens;
		const window = p.tokenUsage?.modelContextWindow;
		if (
			typeof used !== "number" ||
			!Number.isSafeInteger(used) ||
			used < 0 ||
			typeof window !== "number" ||
			!Number.isSafeInteger(window) ||
			window <= 0
		)
			return;
		this.contexts.set(p.threadId, { used, window });
		if (this.contexts.size > 8)
			this.contexts.delete(this.contexts.keys().next().value!);
	}
	assertCompatible(
		threadId: string,
		capacity: number | undefined,
		configuredWindow?: number,
	): void {
		const current = this.contexts.get(threadId);
		if (
			!current ||
			capacity === undefined ||
			!Number.isSafeInteger(capacity) ||
			capacity <= 0 ||
			capacity < Math.max(current.used, current.window, configuredWindow ?? 0)
		)
			throw new Error("context_window_incompatible");
	}
}
