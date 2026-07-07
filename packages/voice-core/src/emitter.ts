/** Tiny typed event emitter — on() returns an unsubscribe function. */
export class TypedEmitter<M extends Record<string, unknown[]>> {
	private handlers: { [K in keyof M]?: Set<(...a: M[K]) => void> } = {};

	on<E extends keyof M>(e: E, h: (...a: M[E]) => void): () => void {
		let set = this.handlers[e];
		if (!set) {
			set = new Set();
			this.handlers[e] = set;
		}
		set.add(h);
		return () => this.handlers[e]?.delete(h);
	}

	emit<E extends keyof M>(e: E, ...args: M[E]): void {
		const set = this.handlers[e];
		if (!set) return;
		for (const h of [...set]) h(...args);
	}
}
