import type { BackgroundTurnTerminal } from "./BrainCoordinator.js";

export interface ThreadEventRouterProcess {
	on(
		event: "notification",
		callback: (method: string, params: unknown) => void,
	): void;
}

export interface ThreadCompletedItem {
	turnId: string;
	itemId?: string;
	type: string;
	raw: Record<string, unknown>;
}

export interface ThreadEventRouterHandlers {
	onTurnStarted(turnId: string): void;
	onTurnTerminal(turn: BackgroundTurnTerminal): void;
	onItemCompleted?(item: ThreadCompletedItem): void;
}

interface TurnState {
	started: boolean;
	agentMessages: string[];
}

interface ThreadState {
	handlers: ThreadEventRouterHandlers;
	turns: Map<string, TurnState>;
	terminalTurnIds: Set<string>;
	activeTurnId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function turnId(params: Record<string, unknown>): string | undefined {
	if (typeof params.turnId === "string" && params.turnId.length > 0)
		return params.turnId;
	const turn = record(params.turn);
	return typeof turn?.id === "string" && turn.id.length > 0
		? turn.id
		: undefined;
}

function spokenSegments(messages: readonly string[]): string[] {
	const result: string[] = [];
	for (const message of messages) {
		const pattern =
			/【口语】\s*([\s\S]*?)(?=(?:\r?\n)?【(?:口语|文字版)】|$)/gu;
		for (const match of message.matchAll(pattern)) {
			const segment = match[1]?.trim();
			if (segment) result.push(segment);
		}
	}
	return result;
}

function completionOutcome(
	params: Record<string, unknown>,
): BackgroundTurnTerminal["outcome"] {
	const status = record(params.turn)?.status;
	if (typeof status !== "string") return "failed";
	if (status.toLowerCase() === "completed") return "completed";
	if (status.toLowerCase() === "interrupted") return "interrupted";
	return "failed";
}

function errorText(value: unknown): string {
	try {
		return JSON.stringify(value).toLowerCase();
	} catch {
		return String(value).toLowerCase();
	}
}

function reasonCategory(
	params: Record<string, unknown>,
): BackgroundTurnTerminal["reasonCategory"] {
	const text = errorText(record(params.turn)?.error ?? params);
	if (/quota|rate.?limit|usage.?limit|额度/u.test(text)) return "额度";
	if (/permission|denied|unauthori[sz]ed|forbidden|sandbox|权限/u.test(text))
		return "权限";
	return "出错";
}

/**
 * Process-level turn routing. It deliberately knows nothing about realtime
 * generations so a turn terminal cannot disappear while a realtime leg is
 * cancelling, opening, or already replaced.
 */
export class ThreadEventRouter {
	private readonly threads = new Map<string, ThreadState>();

	constructor(process: ThreadEventRouterProcess) {
		process.on("notification", (method, params) =>
			this.notification(method, params),
		);
	}

	register(threadId: string, handlers: ThreadEventRouterHandlers): () => void {
		if (!threadId || this.threads.has(threadId))
			throw new Error("thread_event_router_registration_invalid");
		const state: ThreadState = {
			handlers,
			turns: new Map(),
			terminalTurnIds: new Set(),
		};
		this.threads.set(threadId, state);
		return () => {
			if (this.threads.get(threadId) === state) this.threads.delete(threadId);
		};
	}

	activeTurnId(threadId: string): string | undefined {
		return this.threads.get(threadId)?.activeTurnId;
	}

	private notification(method: string, value: unknown): void {
		const params = record(value);
		if (!params || typeof params.threadId !== "string") return;
		const state = this.threads.get(params.threadId);
		if (!state) return;
		const id = turnId(params);
		if (!id || state.terminalTurnIds.has(id)) return;

		if (method === "turn/started") {
			const turn = state.turns.get(id) ?? {
				started: false,
				agentMessages: [],
			};
			state.turns.set(id, turn);
			state.activeTurnId = id;
			if (!turn.started) {
				turn.started = true;
				state.handlers.onTurnStarted(id);
			}
			return;
		}

		if (method === "item/completed") {
			const item = record(params.item);
			if (!item || typeof item.type !== "string") return;
			const turn = state.turns.get(id) ?? {
				started: false,
				agentMessages: [],
			};
			state.turns.set(id, turn);
			if (item.type === "agentMessage" && typeof item.text === "string")
				turn.agentMessages.push(item.text);
			state.handlers.onItemCompleted?.({
				turnId: id,
				...(typeof item.id === "string" && item.id.length > 0
					? { itemId: item.id }
					: {}),
				type: item.type,
				raw: item,
			});
			return;
		}

		if (method !== "turn/completed") return;
		const turn = state.turns.get(id);
		const outcome = completionOutcome(params);
		const terminal: BackgroundTurnTerminal = {
			turnId: id,
			outcome,
			spokenSegments:
				outcome === "completed"
					? spokenSegments(turn?.agentMessages ?? [])
					: [],
			...(outcome === "completed"
				? {}
				: { reasonCategory: reasonCategory(params) }),
		};
		state.turns.delete(id);
		state.terminalTurnIds.add(id);
		if (state.activeTurnId === id) state.activeTurnId = undefined;
		state.handlers.onTurnTerminal(terminal);
	}
}
