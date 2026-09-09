import { CommDB } from "flywheel-comm/db";
import {
	type AccountLastSwitch,
	type AccountStore,
	defaultStorePath,
	readStoreStrict,
} from "../account-heal/account-store.js";
import type {
	AccountSwitchAction,
	AccountSwitchActionReceipt,
	AccountSwitchSnapshot,
	StateStore,
} from "../StateStore.js";
import { parseSqliteUtcMs } from "./founder-notify-utils.js";

export const ACCOUNT_SWITCH_TICK_MS = 60_000;
const ACCOUNT_SWITCH_MAX_FUTURE_MS = 5 * 60_000;
const PROFILE_NAME = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]+$/;
const TRIGGER_KINDS = new Set([
	"quota",
	"model",
	"manual",
	"repair",
	"account_dead",
	"witness",
]);

export function WAKE_TEXT(from: string, to: string): string {
	return `【账号切换】Claude 凭据已从 \`${from}\` 切到 \`${to}\`(原因 account_dead)。若你上一轮因 403 / 凭据故障中断,请按开局指令重跑那一轮;若你正常在跑,忽略本条继续。`;
}

interface AccountSwitchCommDb {
	getSession(executionId: string): { vendor?: string | null } | undefined;
	insertInstructionWithId(
		id: string,
		fromAgent: string,
		toAgent: string,
		content: string,
	): boolean;
	clearDeclaredState(executionId: string): void;
	close(): void;
}

interface AccountSwitchReviewCoordinator {
	redriveAfterAccountSwitch(input: {
		generation: number;
		atMs: number;
	}): Promise<{ requeued: number; retired: number; deferred: boolean }>;
}

export interface AccountSwitchConsumerDeps {
	store: Pick<
		StateStore,
		| "beginAccountSwitchAction"
		| "completeAccountSwitchAction"
		| "insertEvent"
		| "listNonTerminalSessions"
		| "listPendingAccountSwitchActions"
	>;
	readStore?: () => AccountStore | null;
	commDbPathFor: (projectName: string) => string;
	coordinator: AccountSwitchReviewCoordinator;
	sweepEnabled: () => boolean;
	now?: () => number;
	log?: (message: string) => void;
	openCommDb?: (path: string) => AccountSwitchCommDb;
}

export interface AccountSwitchConsumer {
	tick(): Promise<void>;
	replayPending(): Promise<void>;
}

export function validateLastSwitch(
	value: unknown,
	nowMs: number,
): AccountSwitchSnapshot | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Partial<AccountLastSwitch>;
	if (
		!Number.isSafeInteger(candidate.generation) ||
		(candidate.generation ?? 0) < 1 ||
		typeof candidate.triggerKind !== "string" ||
		!TRIGGER_KINDS.has(candidate.triggerKind) ||
		typeof candidate.from !== "string" ||
		!PROFILE_NAME.test(candidate.from) ||
		typeof candidate.to !== "string" ||
		!PROFILE_NAME.test(candidate.to) ||
		typeof candidate.at !== "string"
	) {
		return null;
	}
	const atMs = Date.parse(candidate.at);
	if (
		!Number.isSafeInteger(atMs) ||
		atMs < 0 ||
		!Number.isSafeInteger(nowMs) ||
		atMs > nowMs + ACCOUNT_SWITCH_MAX_FUTURE_MS
	) {
		return null;
	}
	return {
		generation: candidate.generation!,
		triggerKind: candidate.triggerKind as AccountSwitchSnapshot["triggerKind"],
		from: candidate.from,
		to: candidate.to,
		atMs,
	};
}

function validateReceiptSnapshot(
	value: unknown,
): value is AccountSwitchSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Partial<AccountSwitchSnapshot>;
	return (
		Number.isSafeInteger(candidate.generation) &&
		(candidate.generation ?? 0) > 0 &&
		typeof candidate.triggerKind === "string" &&
		TRIGGER_KINDS.has(candidate.triggerKind) &&
		typeof candidate.from === "string" &&
		PROFILE_NAME.test(candidate.from) &&
		typeof candidate.to === "string" &&
		PROFILE_NAME.test(candidate.to) &&
		Number.isSafeInteger(candidate.atMs) &&
		(candidate.atMs ?? -1) >= 0
	);
}

export function createAccountSwitchConsumer(
	deps: AccountSwitchConsumerDeps,
): AccountSwitchConsumer {
	const now = deps.now ?? Date.now;
	const log = deps.log ?? ((message: string) => console.warn(message));
	const readStore =
		deps.readStore ?? (() => readStoreStrict(defaultStorePath()));
	const openCommDb =
		deps.openCommDb ?? ((path: string) => new CommDB(path, false));
	let lastTickAtMs: number | null = null;

	const complete = (
		snapshot: AccountSwitchSnapshot,
		action: AccountSwitchAction,
		outcome: unknown,
	): void => {
		deps.store.completeAccountSwitchAction(
			snapshot.generation,
			action,
			outcome,
			now(),
		);
	};

	const runReviewRedrive = async (
		snapshot: AccountSwitchSnapshot,
	): Promise<void> => {
		const outcome = await deps.coordinator.redriveAfterAccountSwitch({
			generation: snapshot.generation,
			atMs: snapshot.atMs,
		});
		if (outcome.deferred) return;
		complete(snapshot, "review_redrive", outcome);
	};

	const runWakeSweep = async (
		snapshot: AccountSwitchSnapshot,
	): Promise<void> => {
		if (snapshot.triggerKind !== "account_dead") {
			complete(snapshot, "wake_sweep", "skipped:trigger_kind");
			return;
		}
		if (!deps.sweepEnabled()) {
			complete(snapshot, "wake_sweep", "skipped:flag_off");
			return;
		}

		const outcome = {
			sent: 0,
			skipped_vendor: 0,
			skipped_started_after: 0,
			skipped_not_running: 0,
		};
		for (const session of deps.store.listNonTerminalSessions()) {
			if (session.status !== "running") {
				outcome.skipped_not_running += 1;
				continue;
			}
			const startedAtMs = parseSqliteUtcMs(session.started_at);
			if (startedAtMs === null || startedAtMs >= snapshot.atMs) {
				outcome.skipped_started_after += 1;
				continue;
			}

			let db: AccountSwitchCommDb | undefined;
			try {
				db = openCommDb(deps.commDbPathFor(session.project_name));
				if (db.getSession(session.execution_id)?.vendor !== "claude-code") {
					outcome.skipped_vendor += 1;
					continue;
				}
				const dedupeId = `account-switch-wake:g${snapshot.generation}:${session.execution_id}`;
				db.insertInstructionWithId(
					dedupeId,
					"bridge",
					session.execution_id,
					WAKE_TEXT(snapshot.from, snapshot.to),
				);
				db.clearDeclaredState(session.execution_id);
				deps.store.insertEvent({
					event_id: dedupeId,
					execution_id: session.execution_id,
					issue_id: session.issue_id,
					project_name: session.project_name,
					event_type: "account_switch_wake",
					severity: "info",
					payload: {
						generation: snapshot.generation,
						from: snapshot.from,
						to: snapshot.to,
					},
					source: "account-switch-consumer",
				});
				outcome.sent += 1;
			} finally {
				db?.close();
			}
		}
		complete(snapshot, "wake_sweep", outcome);
	};

	const runAction = async (
		action: AccountSwitchAction,
		snapshot: AccountSwitchSnapshot,
	): Promise<void> => {
		try {
			if (action === "review_redrive") await runReviewRedrive(snapshot);
			else await runWakeSweep(snapshot);
		} catch (error) {
			log(
				`[account-switch-consumer] ${action} generation ${snapshot.generation} remains pending: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const runReceipt = async (
		receipt: AccountSwitchActionReceipt,
	): Promise<void> => {
		if (receipt.status !== "pending") return;
		if (!validateReceiptSnapshot(receipt.switch)) {
			log(
				`[account-switch-consumer] pending ${receipt.action} receipt has invalid switch snapshot`,
			);
			return;
		}
		await runAction(receipt.action, receipt.switch);
	};

	const beginAndRun = async (
		action: AccountSwitchAction,
		snapshot: AccountSwitchSnapshot,
	): Promise<void> => {
		try {
			const begun = deps.store.beginAccountSwitchAction(
				snapshot.generation,
				action,
				snapshot,
				now(),
			);
			if (begun.outcome !== "started") return;
			await runReceipt(begun.receipt);
		} catch (error) {
			log(
				`[account-switch-consumer] could not begin ${action} generation ${snapshot.generation}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const replayPending = async (): Promise<void> => {
		let receipts: AccountSwitchActionReceipt[];
		try {
			receipts = deps.store.listPendingAccountSwitchActions();
		} catch (error) {
			log(
				`[account-switch-consumer] pending receipt read failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		for (const receipt of receipts) await runReceipt(receipt);
	};

	return {
		replayPending,

		async tick(): Promise<void> {
			const tickAt = now();
			if (
				lastTickAtMs !== null &&
				tickAt - lastTickAtMs < ACCOUNT_SWITCH_TICK_MS
			) {
				return;
			}
			lastTickAtMs = tickAt;
			await replayPending();
			let accountState: AccountStore | null;
			try {
				accountState = readStore();
			} catch (error) {
				log(
					`[account-switch-consumer] account store unreadable: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			if (accountState === null) {
				log("[account-switch-consumer] account store unreadable");
				return;
			}
			if (accountState.lastSwitch === undefined) return;
			const snapshot = validateLastSwitch(accountState.lastSwitch, tickAt);
			if (!snapshot) {
				log("[account-switch-consumer] invalid account store lastSwitch");
				return;
			}
			await beginAndRun("review_redrive", snapshot);
			await beginAndRun("wake_sweep", snapshot);
		},
	};
}
