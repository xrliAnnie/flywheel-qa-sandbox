import type { MaterializeEpicPageInput } from "../epic-page/materialize.js";
import type { EpicPage, RefreshReason } from "../epic-page/model.js";
import {
	EpicPageSchemaError,
	normalizeRefreshReasons,
} from "../epic-page/model.js";
import type { EpicPageRenderReceipt } from "../epic-page/receipt.js";
import type { ProjectEntry, ProjectLinearBinding } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import type {
	EpicPagePublisher,
	EpicPagePublishOutcome,
} from "./epic-page-publisher.js";
import {
	ActiveScopeNotFoundError,
	EpicSnapshotTruncatedError,
	EpicTooLargeError,
	type LinearActiveScopeSnapshot,
} from "./linear-epic-query.js";
import { LinearUpstreamError } from "./linear-query.js";

export const EPIC_PAGE_REFRESH_DEBOUNCE_MS = 5_000;

export interface EpicPageSerializer {
	run<T>(projectName: string, operation: () => Promise<T>): Promise<T>;
}

export function createEpicPageSerializer(): EpicPageSerializer {
	const tails = new Map<string, Promise<void>>();
	return {
		run<T>(projectName: string, operation: () => Promise<T>): Promise<T> {
			const prior = tails.get(projectName) ?? Promise.resolve();
			const result = prior.then(operation);
			const tail = result.then(
				() => undefined,
				() => undefined,
			);
			tails.set(projectName, tail);
			void tail.then(() => {
				if (tails.get(projectName) === tail) tails.delete(projectName);
			});
			return result;
		},
	};
}

export type EpicPageAttemptInput = Omit<MaterializeEpicPageInput, "version">;

type MaterializedEpicPage = {
	page: EpicPage;
	snapshot: LinearActiveScopeSnapshot | null;
	receipt: EpicPageRenderReceipt;
};

export type EpicPageAttemptResult =
	| {
			kind: "materialized";
			materialized: MaterializedEpicPage;
			inserted: ReturnType<StateStore["insertEpicPageRenderReceipt"]>;
			outcome: string;
	  }
	| { kind: "unavailable"; token: string; error: unknown };

export interface EpicPageAttemptDeps {
	store: Pick<
		StateStore,
		| "getNextEpicPageVersion"
		| "insertEpicPageRenderReceipt"
		| "insertEpicPageRefresh"
	>;
	serializer: EpicPageSerializer;
	materialize: (
		input: MaterializeEpicPageInput,
	) => Promise<MaterializedEpicPage>;
	publisher?: EpicPagePublisher;
	now?: () => Date;
}

function failureToken(error: unknown): string {
	if (error instanceof LinearUpstreamError)
		return "transient: linear_unavailable";
	if (error instanceof ActiveScopeNotFoundError)
		return "structural: active_scope_not_found";
	if (error instanceof EpicTooLargeError) return "structural: scope_too_large";
	if (error instanceof EpicSnapshotTruncatedError)
		return "structural: scope_snapshot_truncated";
	if (error instanceof EpicPageSchemaError)
		return "structural: epic_page_invalid";
	return "transient: epic_scan_failed";
}

export function runEpicPageAttempt(
	deps: EpicPageAttemptDeps,
	input: EpicPageAttemptInput,
): Promise<EpicPageAttemptResult> {
	return deps.serializer.run(input.projectName, async () => {
		const attemptedAt = (deps.now ?? (() => new Date()))().toISOString();
		let settled = false;
		const settle = (outcome: string): void => {
			if (settled) throw new Error("epic_page_attempt_already_settled");
			deps.store.insertEpicPageRefresh({
				projectName: input.projectName,
				attemptedAt,
				trigger: input.trigger,
				reasons: normalizeRefreshReasons(input.reasons ?? []),
				outcome,
			});
			settled = true;
		};

		const version = deps.store.getNextEpicPageVersion(input.projectName);
		let materialized: MaterializedEpicPage;
		try {
			materialized = await deps.materialize({ ...input, version });
		} catch (error) {
			const token = failureToken(error);
			settle(token);
			return { kind: "unavailable", token, error };
		}

		let inserted: ReturnType<StateStore["insertEpicPageRenderReceipt"]>;
		try {
			inserted = deps.store.insertEpicPageRenderReceipt({
				projectName: input.projectName,
				trigger: input.trigger,
				receipt: materialized.receipt,
				expectedVersion: version,
			});
		} catch (error) {
			const token = "transient: epic_scan_failed";
			settle(token);
			return { kind: "unavailable", token, error };
		}

		let outcome:
			| EpicPagePublishOutcome
			| `ok_unpublished:${number}:manual`
			| "transient: epic_scan_failed";
		if (input.trigger === "manual") {
			outcome = `ok_unpublished:${version}:manual`;
		} else {
			try {
				if (!deps.publisher) throw new Error("epic_page_publisher_missing");
				outcome = await deps.publisher.publishHosted(materialized.page);
			} catch {
				outcome = "transient: epic_scan_failed";
			}
		}
		settle(outcome);
		return { kind: "materialized", materialized, inserted, outcome };
	});
}

type EventRefreshReason = Exclude<RefreshReason, "manual" | "scan">;

export interface EpicPageRefresher {
	requestRefresh(projectName: string, reason: EventRefreshReason): void;
	flushForTest(): Promise<void>;
}

export interface EpicPageRefresherDeps {
	projects: ProjectEntry[];
	linearApiKey?: string;
	store: Pick<StateStore, "insertEpicPageRefresh">;
	runAttempt: (input: {
		projectName: string;
		binding: ProjectLinearBinding;
		apiKey: string;
		trigger: "event";
		reasons: RefreshReason[];
	}) => Promise<unknown>;
	now?: () => Date;
	log?: (message: string) => void;
}

interface PendingRefresh {
	projectName: string;
	binding: ProjectLinearBinding;
	reasons: Set<EventRefreshReason>;
	timer?: ReturnType<typeof setTimeout>;
	active?: Promise<void>;
}

export function createEpicPageRefresher(
	deps: EpicPageRefresherDeps,
): EpicPageRefresher {
	const pending = new Map<string, PendingRefresh>();
	const recordedSkips = new Set<string>();
	const now = deps.now ?? (() => new Date());
	const log = deps.log ?? console.warn;

	const recordSkip = (
		projectName: string,
		reason: EventRefreshReason,
		outcome: "skipped: project_unbound" | "skipped: linear_not_configured",
	): void => {
		const key = `${projectName}:${outcome}`;
		if (recordedSkips.has(key)) return;
		recordedSkips.add(key);
		try {
			deps.store.insertEpicPageRefresh({
				projectName,
				attemptedAt: now().toISOString(),
				trigger: "event",
				reasons: [reason],
				outcome,
			});
			log(`[EpicPage] refresh project=${projectName} ${outcome}`);
		} catch (error) {
			log(
				`[EpicPage] refresh skip record failed project=${projectName}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const drain = (state: PendingRefresh): Promise<void> => {
		if (state.active) return state.active;
		const active = (async () => {
			do {
				const reasons = normalizeRefreshReasons([...state.reasons]);
				state.reasons.clear();
				try {
					await deps.runAttempt({
						projectName: state.projectName,
						binding: state.binding,
						apiKey: deps.linearApiKey as string,
						trigger: "event",
						reasons,
					});
				} catch (error) {
					log(
						`[EpicPage] refresh attempt failed project=${state.projectName}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			} while (state.reasons.size > 0);
		})().finally(() => {
			state.active = undefined;
			if (!state.timer && state.reasons.size === 0) {
				pending.delete(state.projectName);
			}
		});
		state.active = active;
		return active;
	};

	return {
		requestRefresh(projectName, reason): void {
			try {
				const project = deps.projects.find(
					(candidate) => candidate.projectName === projectName,
				);
				const binding = project?.linear ?? undefined;
				if (!project || !binding) {
					recordSkip(projectName, reason, "skipped: project_unbound");
					return;
				}
				if (!deps.linearApiKey) {
					recordSkip(projectName, reason, "skipped: linear_not_configured");
					return;
				}
				let state = pending.get(projectName);
				if (!state) {
					state = { projectName, binding, reasons: new Set() };
					pending.set(projectName, state);
				}
				state.reasons.add(reason);
				if (state.active || state.timer) return;
				state.timer = setTimeout(() => {
					state!.timer = undefined;
					void drain(state!);
				}, EPIC_PAGE_REFRESH_DEBOUNCE_MS);
				state.timer.unref?.();
			} catch (error) {
				log(
					`[EpicPage] refresh request failed project=${projectName}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
		async flushForTest(): Promise<void> {
			while (pending.size > 0) {
				const work: Promise<void>[] = [];
				for (const state of pending.values()) {
					if (state.timer) {
						clearTimeout(state.timer);
						state.timer = undefined;
					}
					work.push(drain(state));
				}
				await Promise.all(work);
			}
		},
	};
}
