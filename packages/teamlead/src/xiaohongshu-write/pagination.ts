import { canonical } from "./canonical.js";
export type ObserverCursor = {
	cursor: string;
	before: string | null;
	head: string | null;
	pending: string[];
	collecting: boolean;
};
export interface ObserverCursorStore {
	observerState(channelId: string, initialCursor: string): ObserverCursor;
	saveObserverState(
		channelId: string,
		expected: ObserverCursor,
		next: ObserverCursor,
	): void;
}
const validId = (value: unknown): value is string =>
	typeof value === "string" && /^[1-9][0-9]{16,19}$/.test(value);
/** Persist a backwards scan before processing forwards, so a newest-first page cannot skip history. */
export class XhsMessagePagination {
	private busy = false;
	constructor(
		private readonly store: ObserverCursorStore,
		private readonly channelId: string,
		private readonly initialCursor: string,
		private readonly page: (before: string | null) => Promise<string[]>,
		private readonly process: (messageId: string) => Promise<void>,
	) {
		if (!validId(channelId) || !validId(initialCursor))
			throw Error("observer_page_invalid");
	}
	async poll() {
		if (this.busy) throw Error("observer_busy");
		this.busy = true;
		try {
			let state = this.store.observerState(this.channelId, this.initialCursor);
			const save = (next: ObserverCursor) => {
				this.store.saveObserverState(this.channelId, state, next);
				state = next;
			};
			let scanned = 0,
				processed = 0;
			for (
				let pageNumber = 0;
				state.collecting && pageNumber < 5;
				pageNumber++
			) {
				const ids = await this.page(state.before);
				if (
					!Array.isArray(ids) ||
					ids.length > 100 ||
					ids.some(
						(value, index) =>
							!validId(value) ||
							(index > 0 && BigInt(ids[index - 1]!) <= BigInt(value)) ||
							(state.before !== null && BigInt(value) >= BigInt(state.before)),
					)
				)
					throw Error("observer_page_invalid");
				scanned += ids.length;
				const fresh = ids.filter(
					(value) => BigInt(value) > BigInt(state.cursor),
				);
				if (state.pending.length + fresh.length > 10000)
					throw Error("observer_backlog_full");
				const complete =
					ids.length < 100 ||
					ids.some((value) => BigInt(value) <= BigInt(state.cursor));
				const pending = [...state.pending, ...fresh];
				if (complete) pending.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
				save({
					...state,
					head: state.head ?? fresh[0] ?? state.cursor,
					before: ids.at(-1) ?? state.before,
					pending,
					collecting: !complete,
				});
			}
			if (!state.collecting) {
				while (state.pending.length && processed < 500) {
					const id = state.pending[0]!;
					await this.process(id);
					save({ ...state, cursor: id, pending: state.pending.slice(1) });
					processed++;
				}
				if (state.pending.length === 0)
					save({
						cursor: state.cursor,
						head: null,
						before: null,
						pending: [],
						collecting: true,
					});
			}
			return { scanned, processed, pending: state.pending.length };
		} finally {
			this.busy = false;
		}
	}
}
export function cursorJson(state: ObserverCursor): string {
	if (
		!validId(state.cursor) ||
		(state.before !== null && !validId(state.before)) ||
		(state.head !== null && !validId(state.head)) ||
		typeof state.collecting !== "boolean" ||
		!Array.isArray(state.pending) ||
		state.pending.length > 10000 ||
		state.pending.some((value) => !validId(value))
	)
		throw Error("observer_page_invalid");
	return canonical(state);
}
