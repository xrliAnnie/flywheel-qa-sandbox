type Poller = { poll(signal?: AbortSignal): Promise<unknown> };

/** Authority lifecycle owns these tasks; no execution/provider capability is
 * passed here. Close drains callbacks before the owner closes the private DB. */
export function startAuthorityWorkers(options: {
	observers: (signal: AbortSignal) => readonly Poller[];
	notifications: Poller;
}): { close(): Promise<void> } {
	const controller = new AbortController();
	const observers = options.observers(controller.signal);
	const running = new Set<Promise<unknown>>();
	const timers: ReturnType<typeof setInterval>[] = [];
	let closing: Promise<void> | undefined;
	const schedule = (poller: Poller, interval: number) => {
		let active = false;
		const tick = () => {
			if (active || controller.signal.aborted) return;
			active = true;
			const work = Promise.resolve()
				.then(() => {
					if (!controller.signal.aborted) return poller.poll(controller.signal);
					return undefined;
				})
				.catch(() => {
					// Source failures retain their own durable cursors/outboxes for the next tick.
				})
				.finally(() => {
					active = false;
					running.delete(work);
				});
			running.add(work);
		};
		timers.push(setInterval(tick, interval));
		tick();
	};
	for (const observer of observers) schedule(observer, 15000);
	schedule(options.notifications, 5000);
	return {
		close() {
			if (!closing) {
				controller.abort();
				for (const timer of timers) clearInterval(timer);
				closing = Promise.all([...running]).then(() => undefined);
			}
			return closing;
		},
	};
}
