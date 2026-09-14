import { randomUUID } from "node:crypto";
import { HISTORY_PAGE_ROWS, renderHistoryPage } from "./history-pages.js";
import type { HistoryReportPublisher } from "./history-publisher.js";
import type { ShipJudgmentHistory } from "./history-query.js";
import type {
	HistoryLease,
	ShipJudgmentHistoryState,
} from "./history-state.js";

interface Dependencies {
	state: ShipJudgmentHistoryState;
	reader: Pick<ShipJudgmentHistory, "read">;
	publisher: Pick<
		HistoryReportPublisher,
		"origin" | "stage" | "publish" | "verify"
	>;
	now?: () => number;
	onChanged?: () => void;
	onError?: (code: string) => void;
}
type Result = {
	status:
		| "published"
		| "unchanged"
		| "failed"
		| "stale"
		| "busy"
		| "deferred"
		| "stopped";
	refreshRequested?: boolean;
};
/** Independent minute timer. Epic consumers only read state and never await this runtime. */
export class ShipJudgmentHistoryRuntime {
	private timer: ReturnType<typeof setInterval> | undefined;
	private controller: AbortController | undefined;
	private running: Promise<Result> | undefined;
	private stopped = false;
	private readonly owner = randomUUID();
	private readonly now: () => number;
	constructor(private readonly deps: Dependencies) {
		this.now = deps.now ?? Date.now;
	}
	start() {
		if (this.stopped || this.timer) return;
		this.timer = setInterval(() => {
			void this.run();
		}, 60000);
		this.timer.unref?.();
		void this.run();
	}
	async stop() {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.controller?.abort(new Error("history_round_canceled"));
		await this.running;
	}
	run(): Promise<Result> {
		if (this.stopped) return Promise.resolve({ status: "stopped" });
		if (this.running) return this.running;
		const pending = this.execute()
			.catch((): Result => {
				try {
					(
						this.deps.onError ??
						((code) => console.warn("[ship-judgment] " + code))
					)("history_state_unavailable");
				} catch {}
				return { status: "failed", refreshRequested: false };
			})
			.finally(() => {
				if (this.running === pending) this.running = undefined;
			});
		this.running = pending;
		return pending;
	}
	private changed() {
		try {
			this.deps.onChanged?.();
			return Boolean(this.deps.onChanged);
		} catch {
			return false;
		}
	}
	private async execute(): Promise<Result> {
		const claim = this.deps.state.claim(this.owner, this.now());
		if (claim.status !== "claimed") return claim;
		const controller = new AbortController();
		this.controller = controller;
		const deadline = setTimeout(
			() => controller.abort(new Error("history_round_timeout")),
			120000,
		);
		let rejectAbort!: (error: unknown) => void;
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = reject;
		});
		const onAbort = () => rejectAbort(controller.signal.reason);
		controller.signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([
				this.round(claim, controller.signal),
				aborted,
			]);
		} catch {
			const code = controller.signal.aborted
				? controller.signal.reason instanceof Error &&
					controller.signal.reason.message === "history_round_timeout"
					? "history_round_timeout"
					: "history_round_canceled"
				: "history_round_failed";
			const failed = this.deps.state.fail(claim, code, this.now());
			return {
				status: "failed",
				refreshRequested: failed ? this.changed() : false,
			};
		} finally {
			clearTimeout(deadline);
			controller.signal.removeEventListener("abort", onAbort);
			if (this.controller === controller) this.controller = undefined;
		}
	}
	private async round(
		claim: HistoryLease,
		signal: AbortSignal,
	): Promise<Result> {
		const { state, reader, publisher } = this.deps;
		signal.throwIfAborted();
		const snapshot = reader.read(new Date(this.now()).toISOString());
		const result = state.begin(claim, snapshot, publisher.origin(), this.now());
		if (result.status !== "building") return result;
		const manifest = result.manifest;
		for (let index = manifest.pages.length; index >= 1; index--) {
			signal.throwIfAborted();
			let page = manifest.pages[index - 1];
			if (page?.verifiedAt) continue;
			if (!page) {
				const html = renderHistoryPage(
					manifest.rows.slice(
						(index - 1) * HISTORY_PAGE_ROWS,
						index * HISTORY_PAGE_ROWS,
					),
					{
						asOf: manifest.asOf,
						page: index,
						pageCount: manifest.pages.length,
						total: manifest.rows.length,
						reportOrigin: manifest.origin,
						nextUrl: manifest.pages[index]?.url,
					},
				);
				page = await publisher.stage(html, signal);
				signal.throwIfAborted();
				if (!state.stagePage(claim, index, page, this.now()))
					throw new Error("history_lease_lost");
				manifest.pages[index - 1] = page;
			}
			await publisher.publish(page, signal);
			signal.throwIfAborted();
			await publisher.verify(page, signal);
			signal.throwIfAborted();
			if (!state.verifyPage(claim, index, this.now()))
				throw new Error("history_lease_lost");
			page.verifiedAt = new Date(this.now()).toISOString();
		}
		signal.throwIfAborted();
		if (!state.finish(claim, this.now())) return { status: "stale" };
		return { status: "published", refreshRequested: this.changed() };
	}
}
