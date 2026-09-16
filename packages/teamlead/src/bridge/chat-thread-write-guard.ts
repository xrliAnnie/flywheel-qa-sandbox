/** Optional trusted capability boundary; ordinary Bridge callers do not opt in. */
export interface ChatThreadWriteGuard {
	beforeSideEffect?: () => Promise<void>;
	/** Trusted synchronous registry and target-binding check; required by capability callers alongside the async hook. */
	assertSideEffectCurrent?: () => void;
	signal?: AbortSignal;
}
export class ChatThreadSideEffectDenied extends Error {
	constructor() {
		super("chat_thread_side_effect_denied");
	}
}
/** Injected at the helpers' actual HTTP call, not around the entire multi-step ensure operation. */
export function guardChatThreadFetch(
	guard: ChatThreadWriteGuard,
	fetchImpl: typeof fetch = fetch,
): typeof fetch {
	if (
		!guard.beforeSideEffect &&
		!guard.signal &&
		!guard.assertSideEffectCurrent
	)
		return fetchImpl;
	return async (input, init) => {
		try {
			if (guard.beforeSideEffect) await guard.beforeSideEffect();
			guard.assertSideEffectCurrent?.();
		} catch {
			throw new ChatThreadSideEffectDenied();
		}
		if (guard.signal?.aborted) throw new ChatThreadSideEffectDenied();
		return fetchImpl(input, {
			...init,
			...(guard.signal
				? {
						signal: init?.signal
							? AbortSignal.any([init.signal, guard.signal])
							: guard.signal,
					}
				: {}),
		});
	};
}
