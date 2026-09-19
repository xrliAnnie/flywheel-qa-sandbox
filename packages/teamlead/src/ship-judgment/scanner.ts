import type { StateStore } from "../StateStore.js";
import { isJudgmentEnabled } from "./contract.js";

export interface JudgmentScannerDependencies {
	store: Pick<
		StateStore,
		"listShipJudgmentScanQuestions" | "advanceShipJudgmentScanCursor"
	>;
	mode(): string;
	/** Must revalidate the live binding before collecting or freezing any input. */
	process(questionId: string, signal: AbortSignal): Promise<void>;
	onError?(code: string): void;
}

/** Independent background scanning: no network or model waits in the Bridge gate poll. */
export class ShipJudgmentScanner {
	private readonly abort = new AbortController();
	private timer: ReturnType<typeof setInterval> | undefined;
	private active: Promise<void> | undefined;
	private readonly pending = new Set<string>();
	private notificationScheduled = false;
	constructor(private readonly deps: JudgmentScannerDependencies) {}
	start(): void {
		if (this.timer || this.abort.signal.aborted) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, 30_000);
		this.timer.unref();
		void this.tick();
	}
	/** The durable current holder is the recovery queue; this bounded hint only improves latency. */
	enqueue(questionId: string): void {
		if (
			this.abort.signal.aborted ||
			!isJudgmentEnabled("flywheel", this.deps.mode()) ||
			!questionId ||
			questionId.length > 200
		)
			return;
		if (this.pending.size < 50) this.pending.add(questionId);
		if (!this.timer || this.notificationScheduled) return;
		this.notificationScheduled = true;
		queueMicrotask(() => {
			this.notificationScheduled = false;
			void this.tick();
		});
	}
	tick(): Promise<void> {
		if (this.active) return this.active;
		if (this.abort.signal.aborted) return Promise.resolve();
		this.active = Promise.resolve()
			.then(async () => {
				if (!isJudgmentEnabled("flywheel", this.deps.mode())) return;
				const questions = [
					...new Set(
						[...this.pending]
							.slice(0, 10)
							.concat(this.deps.store.listShipJudgmentScanQuestions()),
					),
				].slice(0, 50);
				for (const question of questions) {
					if (
						this.abort.signal.aborted ||
						!isJudgmentEnabled("flywheel", this.deps.mode())
					)
						return;
					this.pending.delete(question);
					try {
						await this.deps.process(question, this.abort.signal);
					} catch {
						if (!this.abort.signal.aborted)
							this.deps.onError?.("judgment_card_scan_failed");
					}
					if (this.abort.signal.aborted) return;
					this.deps.store.advanceShipJudgmentScanCursor(question);
				}
			})
			.catch(() => {
				this.deps.onError?.("judgment_scan_failed");
			})
			.finally(() => {
				this.active = undefined;
			});
		return this.active;
	}
	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.abort.abort();
		this.pending.clear();
		await this.active;
	}
}
