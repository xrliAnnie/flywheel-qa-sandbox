export interface ReportCriticalSection {
	run<T>(operation: () => Promise<T>): Promise<T>;
}

export function createReportCriticalSection(): ReportCriticalSection {
	let tail: Promise<void> = Promise.resolve();
	return {
		async run<T>(operation: () => Promise<T>): Promise<T> {
			let release = (): void => {};
			const previous = tail;
			tail = new Promise<void>((resolve) => {
				release = resolve;
			});
			await previous;
			try {
				return await operation();
			} finally {
				release();
			}
		},
	};
}
