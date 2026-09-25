import type { RoomIO } from "../room-io.js";
import {
	SPEAK_BARGE_IN_REASON,
	type SpeakKind,
	type SpeakReceipt,
	type VoiceV1Session,
} from "../types.js";
import {
	type AgendaSayRejection,
	agendaCheckinFallbackLine,
	agendaFallbackLine,
	agendaTransitionLine,
	DEFAULT_AGENDA_MAX_SAY_CODE_POINTS,
	validateAgendaSay,
} from "./speech.js";
import {
	AGENDA_CLASSES,
	type AgendaBriefPurpose,
	type AgendaDisposition,
	type AgendaDispositionRecord,
	type AgendaItem,
	type AgendaOutstanding,
	type AgendaResult,
	type AgendaSnapshot,
	type AgendaState,
} from "./types.js";

/** The founder set this on 2026-09-24; it is not an engineering default. */
export const DEFAULT_AGENDA_CHECKIN_INTERVAL_MS = 600_000;
export const DEFAULT_AGENDA_LEAD_REPLY_TIMEOUT_MS = 20_000;
export const DEFAULT_AGENDA_RESUME_GAP_MS = 8_000;
export const DEFAULT_AGENDA_POLL_INTERVAL_MS = 30_000;
const SAFE_BOUNDARY_RECHECK_MS = 250;
/** A barge-in that never reported its end stops counting after this long. */
const DEFAULT_FOUNDER_SPEAKING_STALE_MS = 20_000;
const MAX_APPLIED_REQUESTS = 64;

export interface AgendaBriefRequestInput {
	purpose: AgendaBriefPurpose;
	itemKey: string | null;
	clientRequestId: string;
	rewriteReason?: AgendaSayRejection;
	previous?: { itemKey: string; closedAs: AgendaDisposition | "source_gone" };
}

/** Bridge-facing seams. Every one is authenticated by the session lease; the
 * conductor never names a Lead, a scope or an item body. */
export interface AgendaPorts {
	fetchSnapshot(): Promise<AgendaSnapshot>;
	loadState(): Promise<AgendaState | undefined>;
	saveState(input: {
		state: AgendaState;
		expectedVersion: number;
		dispositions: readonly AgendaDispositionRecord[];
	}): Promise<{ ok: true } | { ok: false; current?: AgendaState }>;
	requestBrief(input: AgendaBriefRequestInput): Promise<{ requestId: string }>;
	/** Results of one request with seq > after, in seq order. */
	listResults(requestId: string, after: number): Promise<AgendaResult[]>;
	bindTurn(input: { utteranceId: string; itemKey: string }): Promise<void>;
}

export interface AgendaConductorOptions {
	mode: "headphone" | "meeting";
	sessionId: string;
	generation: number;
	engine: Pick<VoiceV1Session, "speak" | "onUtterance">;
	room: Pick<RoomIO, "audibleTail" | "onBargeIn">;
	ports: AgendaPorts;
	record(event: Record<string, unknown>): void;
	textStatus?(message: string): void;
	checkinIntervalMs?: number;
	leadReplyTimeoutMs?: number;
	resumeGapMs?: number;
	pollIntervalMs?: number;
	maxSayCodePoints?: number;
	founderSpeakingStaleMs?: number;
	now?: () => number;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
	nextId?: () => string;
}

export interface AgendaTurnBinding {
	owner: "agenda" | "front";
	itemKey: string | null;
}

type Timer = ReturnType<typeof setTimeout>;

function positiveMs(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
		throw new Error(
			`agenda.${name} must be a positive safe integer no greater than 2147483647`,
		);
	return value;
}

function classRank(item: AgendaItem): number {
	return AGENDA_CLASSES.indexOf(item.class);
}

/** Q1 default order: blocked → awaiting approval → needs answer → Lead said,
 * then by the time the item entered its class. */
export function defaultAgendaOrder(items: readonly AgendaItem[]): AgendaItem[] {
	return [...items].sort(
		(left, right) =>
			classRank(left) - classRank(right) ||
			Date.parse(left.since) - Date.parse(right.since) ||
			left.itemKey.localeCompare(right.itemKey),
	);
}

/** The Bridge already checked `order` against the frozen opening brief; here
 * it only reorders what is still queued. Later arrivals and keys the brief
 * never had keep their place behind it (Q3). */
function applyOpeningOrder(
	order: readonly string[],
	queue: readonly string[],
): string[] {
	const ordered = order.filter((key) => queue.includes(key));
	return [...ordered, ...queue.filter((key) => !ordered.includes(key))];
}

/**
 * Engine-independent agenda for both voice modes (FLY-2863 plan §4). Words
 * come from the Lead; this class only decides when an item opens, closes, or
 * is interrupted, and it persists every advance through a CAS write so a
 * restart continues from the same item.
 */
export class AgendaConductor {
	private readonly checkinIntervalMs: number;
	private readonly leadReplyTimeoutMs: number;
	private readonly resumeGapMs: number;
	private readonly pollIntervalMs: number;
	private readonly maxSayCodePoints: number;
	private readonly founderSpeakingStaleMs: number;
	private readonly now: () => number;
	private readonly setTimeoutFn: typeof setTimeout;
	private readonly clearTimeoutFn: typeof clearTimeout;
	private readonly nextId: () => string;
	private state: AgendaState;
	private work: Promise<unknown> = Promise.resolve();
	private started = false;
	private closing = false;
	private founderSpeaking = false;
	private lastBargeEventAt = 0;
	private sourceHealthy = true;
	private lastActivity: number;
	private lastCheckinAttempt = Number.NEGATIVE_INFINITY;
	private checkinPending: string | null = null;
	private readonly knownRequests = new Set<string>();
	private readonly leadTimeoutStage = new Map<string, number>();
	private readonly turns = new Map<string, AgendaTurnBinding>();
	private readonly turnOrders = new Map<string, number>();
	private turnCounter = 0;
	private readonly turnWork = new Map<string, Promise<void>>();
	private leadTimer?: Timer;
	private checkinTimer?: Timer;
	private pollTimer?: Timer;
	private resumeTimer?: Timer;
	private lastFounderUtteranceAt = 0;
	private readonly unsubscribers: Array<() => void> = [];

	constructor(private readonly options: AgendaConductorOptions) {
		this.checkinIntervalMs = positiveMs(
			options.checkinIntervalMs ?? DEFAULT_AGENDA_CHECKIN_INTERVAL_MS,
			"checkinIntervalMs",
		);
		this.leadReplyTimeoutMs = positiveMs(
			options.leadReplyTimeoutMs ?? DEFAULT_AGENDA_LEAD_REPLY_TIMEOUT_MS,
			"leadReplyTimeoutMs",
		);
		this.resumeGapMs = positiveMs(
			options.resumeGapMs ?? DEFAULT_AGENDA_RESUME_GAP_MS,
			"resumeGapMs",
		);
		this.pollIntervalMs = positiveMs(
			options.pollIntervalMs ?? DEFAULT_AGENDA_POLL_INTERVAL_MS,
			"pollIntervalMs",
		);
		this.maxSayCodePoints = positiveMs(
			options.maxSayCodePoints ?? DEFAULT_AGENDA_MAX_SAY_CODE_POINTS,
			"maxSayCodePoints",
		);
		this.founderSpeakingStaleMs = positiveMs(
			options.founderSpeakingStaleMs ?? DEFAULT_FOUNDER_SPEAKING_STALE_MS,
			"founderSpeakingStaleMs",
		);
		this.now = options.now ?? Date.now;
		this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
		this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
		this.nextId = options.nextId ?? (() => crypto.randomUUID());
		this.lastActivity = this.now();
		this.state = this.freshState();
	}

	/** Current durable state (read-only view for adapters and tests). */
	get snapshotState(): Readonly<AgendaState> {
		return this.state;
	}

	start(): Promise<void> {
		if (this.started) throw new Error("agenda_conductor_already_started");
		this.started = true;
		this.unsubscribers.push(
			this.options.engine.onUtterance((utterance) => {
				if (!utterance.final) return;
				if (utterance.role === "user") {
					this.founderSpeaking = false;
					this.lastFounderUtteranceAt = this.now();
				}
				this.noteActivity();
			}),
			this.options.room.onBargeIn((event) => {
				if (
					event.sessionId !== this.options.sessionId ||
					event.generation !== this.options.generation
				)
					return;
				this.founderSpeaking = event.phase !== "end";
				this.lastBargeEventAt = this.now();
				if (event.phase === "start") this.lastFounderUtteranceAt = this.now();
			}),
		);
		return this.enqueue(() => this.initialize());
	}

	/** Bridge said the agenda sources may have changed (or the poll fired). */
	notifySourceChanged(): Promise<void> {
		return this.enqueue(() => this.refresh());
	}

	/** Reply wakeup for one request id; payloads are always reread. */
	notifyResults(requestId: string): Promise<void> {
		return this.enqueue(async () => {
			if (!this.knownRequests.has(requestId)) return;
			if (this.state.outstanding?.requestId !== requestId) {
				this.options.record({
					kind: "agenda_result_stale",
					requestId,
					reason: "not_outstanding",
				});
				return;
			}
			await this.drain();
		});
	}

	/** R-T1: the owner of a founder turn is fixed the moment it starts. */
	bindTurn(utteranceId: string): AgendaTurnBinding {
		const prior = this.turns.get(utteranceId);
		if (prior) return prior;
		const itemKey = this.state.activeUrgent ?? this.state.active;
		const binding: AgendaTurnBinding =
			this.started && !this.closing && itemKey
				? { owner: "agenda", itemKey }
				: { owner: "front", itemKey: null };
		this.turns.set(utteranceId, binding);
		// Wall-clock based so it stays monotonic across a restart; the counter
		// orders turns that start in the same millisecond.
		this.turnOrders.set(
			utteranceId,
			this.now() * 1_000 + (this.turnCounter++ % 1_000),
		);
		this.noteActivity();
		if (binding.owner === "agenda" && binding.itemKey) {
			this.options.record({
				kind: "agenda_turn_bound",
				utteranceId,
				itemKey: binding.itemKey,
			});
			// Keep the rejection: a handoff must not proceed without the server
			// binding (it would reach the Lead as an unbound ordinary request).
			const work = this.options.ports.bindTurn({
				utteranceId,
				itemKey: binding.itemKey,
			});
			work.catch((error) =>
				this.options.record({
					kind: "agenda_turn_bind_failed",
					utteranceId,
					message: error instanceof Error ? error.message : String(error),
				}),
			);
			this.turnWork.set(utteranceId, work);
		}
		return binding;
	}

	turnBinding(utteranceId: string): AgendaTurnBinding | undefined {
		return this.turns.get(utteranceId);
	}

	/** Resolves once the server has the turn binding (before its handoff);
	 * rejects when binding failed, so the caller fails closed. */
	whenTurnBound(utteranceId: string): Promise<void> {
		return this.turnWork.get(utteranceId) ?? Promise.resolve();
	}

	/** R-T5: an agenda turn's user handoff becomes the outstanding request. */
	adoptReply(input: { utteranceId: string; handoffId: string }): Promise<void> {
		return this.enqueue(async () => {
			const binding = this.turns.get(input.utteranceId);
			if (binding?.owner !== "agenda" || !binding.itemKey) return;
			this.knownRequests.add(input.handoffId);
			const turnOrder = this.turnOrders.get(input.utteranceId) ?? 0;
			const current = this.state.outstanding;
			// Review R5: a handoff can converge late (background retry); an older
			// turn must not take the floor from a newer turn she already moved to.
			if (
				current?.purpose === "reply" &&
				(current.turnOrder ?? 0) > turnOrder
			) {
				this.options.record({
					kind: "agenda_reply_superseded_late",
					requestId: input.handoffId,
					newerRequestId: current.requestId,
				});
				return;
			}
			const replaced = this.state.outstanding?.requestId;
			const committed = await this.commit((state) => {
				state.outstanding = {
					requestId: input.handoffId,
					purpose: "reply",
					itemKey: binding.itemKey,
					issuedAt: new Date(this.now()).toISOString(),
					rewrites: 0,
					answered: false,
					turnOrder,
				};
			});
			if (!committed) return;
			this.clearResumeTimer();
			this.clearLeadTimer();
			if (replaced && replaced !== input.handoffId)
				this.options.record({
					kind: "agenda_request_superseded",
					requestId: replaced,
					by: input.handoffId,
				});
			await this.drain();
		});
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		for (const timer of [
			this.leadTimer,
			this.checkinTimer,
			this.pollTimer,
			this.resumeTimer,
		])
			if (timer) this.clearTimeoutFn(timer);
		this.leadTimer = this.checkinTimer = this.pollTimer = undefined;
		this.resumeTimer = undefined;
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		await this.work.catch(() => undefined);
	}

	// ── lifecycle ──

	private freshState(): AgendaState {
		return {
			version: 1,
			sessionId: this.options.sessionId,
			generation: this.options.generation,
			stateVersion: 0,
			opened: false,
			queue: [],
			active: null,
			urgentQueue: [],
			activeUrgent: null,
			items: {},
			outstanding: null,
			applied: {},
			lastActivityAt: new Date(this.now()).toISOString(),
		};
	}

	private async initialize(): Promise<void> {
		let loaded: AgendaState | undefined;
		try {
			loaded = await this.options.ports.loadState();
		} catch (error) {
			this.options.record({
				kind: "agenda_state_load_failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
		if (loaded && loaded.sessionId === this.options.sessionId) {
			this.state = loaded;
			if (loaded.outstanding)
				this.knownRequests.add(loaded.outstanding.requestId);
		}
		const snapshot = await this.fetchSnapshot();
		if (!this.state.opened) {
			await this.open(snapshot);
		} else {
			if (this.state.generation !== this.options.generation) {
				await this.adoptGeneration();
			} else if (this.state.outstanding) {
				await this.drain();
				this.armLeadTimer();
			}
			if (snapshot) await this.merge(snapshot);
		}
		this.armPoll();
		this.armCheckin();
	}

	private async fetchSnapshot(): Promise<AgendaSnapshot | undefined> {
		try {
			const snapshot = await this.options.ports.fetchSnapshot();
			this.sourceHealthy = snapshot.complete;
			return snapshot;
		} catch (error) {
			this.sourceHealthy = false;
			this.options.record({
				kind: "agenda_snapshot_failed",
				message: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	private async refresh(): Promise<void> {
		if (!this.state.opened) return;
		const snapshot = await this.fetchSnapshot();
		if (snapshot) await this.merge(snapshot);
	}

	/** Entry: never replays history; only the current agenda is briefed. */
	private async open(snapshot: AgendaSnapshot | undefined): Promise<void> {
		const ordered = defaultAgendaOrder(snapshot?.items ?? []);
		const enqueuedAt = new Date(this.now()).toISOString();
		const requestId = await this.issue({ purpose: "open", itemKey: null });
		const committed = await this.commit((state) => {
			state.opened = true;
			for (const item of ordered) {
				state.items[item.itemKey] = { item, status: "queued", enqueuedAt };
				if (item.urgent) state.urgentQueue.push(item.itemKey);
				else state.queue.push(item.itemKey);
			}
			state.outstanding = requestId
				? this.outstanding(requestId, "open", null)
				: null;
		});
		this.options.record({
			kind: "agenda_opened",
			mode: this.options.mode,
			items: ordered.length,
			complete: snapshot?.complete ?? false,
			olderUnspokenCount: snapshot?.olderUnspokenCount ?? 0,
			requestId: requestId ?? null,
		});
		if (!committed) return;
		if (requestId) this.armLeadTimer();
		else await this.startNext(undefined);
	}

	/** A new resident generation invalidates every in-flight request. */
	private async adoptGeneration(): Promise<void> {
		const target = this.state.activeUrgent ?? this.state.active;
		const committed = await this.commit((state) => {
			state.generation = this.options.generation;
			state.outstanding = null;
		});
		if (!committed) return;
		this.options.record({
			kind: "agenda_generation_adopted",
			generation: this.options.generation,
			itemKey: target,
		});
		if (target) await this.request("resume", target);
		else await this.startNext(undefined);
	}

	// ── snapshot merge (Q3/Q4, U1/U2) ──

	private async merge(snapshot: AgendaSnapshot): Promise<void> {
		const enqueuedAt = new Date(this.now()).toISOString();
		const added = snapshot.items.filter(
			(item) => !this.state.items[item.itemKey],
		);
		const present = new Set(snapshot.items.map((item) => item.itemKey));
		// R1-6: only a complete read of the item's own source proves absence.
		const gone = Object.values(this.state.items)
			.filter(
				(entry) =>
					entry.status !== "closed" &&
					!present.has(entry.item.itemKey) &&
					(snapshot.complete ||
						snapshot.sourceStatus[entry.item.sourceKey]?.status === "complete"),
			)
			.map((entry) => entry.item.itemKey);
		// An open item can change in place: its urgent flag in particular may
		// arrive after it was queued (U2 learns priority asynchronously; U1 may
		// be flagged after the message is collected).
		const changed = snapshot.items.filter((item) => {
			const entry = this.state.items[item.itemKey];
			return (
				entry !== undefined &&
				entry.status !== "closed" &&
				JSON.stringify(entry.item) !== JSON.stringify(item)
			);
		});
		if (added.length === 0 && gone.length === 0 && changed.length === 0) {
			await this.maybeStartWork();
			return;
		}
		const wasActive = gone.includes(this.state.active ?? "")
			? this.state.active
			: null;
		const wasUrgent = gone.includes(this.state.activeUrgent ?? "")
			? this.state.activeUrgent
			: null;
		// Her own words stay answerable (R-T4/R-T5): a reply in flight keeps its
		// request even when its item leaves; the reply's answer advances later.
		const replyPending =
			this.state.outstanding?.purpose === "reply" &&
			!this.state.outstanding.answered;
		const outstandingItem = replyPending
			? undefined
			: this.state.outstanding?.itemKey;
		const committed = await this.commit((state) => {
			for (const item of defaultAgendaOrder(added)) {
				state.items[item.itemKey] = { item, status: "queued", enqueuedAt };
				if (item.urgent) state.urgentQueue.push(item.itemKey);
				else state.queue.push(item.itemKey);
			}
			for (const key of gone) {
				const entry = state.items[key];
				if (!entry) continue;
				entry.status = "closed";
				entry.closedAs = "source_gone";
				state.queue = state.queue.filter((candidate) => candidate !== key);
				state.urgentQueue = state.urgentQueue.filter(
					(candidate) => candidate !== key,
				);
				if (state.active === key) state.active = null;
				if (state.activeUrgent === key) state.activeUrgent = null;
			}
			if (outstandingItem && gone.includes(outstandingItem))
				state.outstanding = null;
			for (const item of changed) {
				const entry = state.items[item.itemKey];
				if (!entry) continue;
				entry.item = item;
				if (entry.status !== "queued") continue;
				const key = item.itemKey;
				if (item.urgent && state.queue.includes(key)) {
					state.queue = state.queue.filter((candidate) => candidate !== key);
					state.urgentQueue.push(key);
				} else if (!item.urgent && state.urgentQueue.includes(key)) {
					state.urgentQueue = state.urgentQueue.filter(
						(candidate) => candidate !== key,
					);
					state.queue.push(key);
				}
			}
		});
		if (!committed) return;
		for (const item of changed)
			if (item.urgent && this.state.urgentQueue.includes(item.itemKey))
				this.options.record({
					kind: "agenda_item_promoted_urgent",
					itemKey: item.itemKey,
					urgent: item.urgent,
				});
		for (const item of added)
			this.options.record({
				kind: "agenda_item_enqueued",
				itemKey: item.itemKey,
				class: item.class,
				urgent: item.urgent,
			});
		for (const key of gone)
			this.options.record({ kind: "agenda_item_source_gone", itemKey: key });
		if (replyPending && (wasUrgent || wasActive)) return;
		if (wasUrgent) {
			await this.afterUrgentClosed({
				itemKey: wasUrgent,
				closedAs: "source_gone",
			});
			return;
		}
		if (wasActive && !this.state.activeUrgent) {
			await this.startNext({ itemKey: wasActive, closedAs: "source_gone" });
			return;
		}
		await this.maybeStartWork();
	}

	private async maybeStartWork(): Promise<void> {
		if (!this.state.opened || this.closing) return;
		if (this.state.urgentQueue.length > 0 && !this.state.activeUrgent) {
			await this.startUrgent();
			return;
		}
		const openPending =
			this.state.outstanding?.purpose === "open" &&
			!this.state.outstanding.answered;
		if (
			!this.state.active &&
			!this.state.activeUrgent &&
			!openPending &&
			this.state.queue.length > 0
		)
			await this.startNext(undefined);
	}

	// ── advancing ──

	private async startNext(
		previous: AgendaBriefRequestInput["previous"],
	): Promise<void> {
		if (this.state.urgentQueue.length > 0 && !this.state.activeUrgent) {
			await this.startUrgent();
			return;
		}
		const head = this.state.queue[0];
		if (!head) {
			if (this.state.outstanding?.purpose !== "checkin")
				await this.commit((state) => {
					state.outstanding = null;
				});
			this.options.record({ kind: "agenda_idle" });
			return;
		}
		await this.request("item", head, previous);
	}

	private async startUrgent(): Promise<void> {
		if (!(await this.waitSafeBoundary())) return;
		const key = this.state.urgentQueue[0];
		if (!key || this.state.activeUrgent) return;
		const entry = this.state.items[key];
		await this.request("urgent", key);
		if (entry)
			this.options.record({
				kind: "agenda_preempted",
				itemKey: key,
				reason: entry.item.urgent?.reason ?? null,
				source: entry.item.urgent?.source ?? null,
				pausedItemKey: this.state.active,
			});
	}

	private async afterUrgentClosed(
		previous: NonNullable<AgendaBriefRequestInput["previous"]>,
	): Promise<void> {
		if (this.state.urgentQueue.length > 0) {
			await this.startUrgent();
			return;
		}
		if (this.state.active) {
			await this.request("resume", this.state.active, previous);
			return;
		}
		await this.startNext(previous);
	}

	/** Issues one brief request and makes it the only outstanding one. */
	private async request(
		purpose: "item" | "urgent" | "resume" | "checkin",
		itemKey: string | null,
		previous?: AgendaBriefRequestInput["previous"],
		rewriteReason?: AgendaSayRejection,
	): Promise<boolean> {
		const requestId = await this.issue({
			purpose,
			itemKey,
			...(previous ? { previous } : {}),
			...(rewriteReason ? { rewriteReason } : {}),
		});
		const rewrites = rewriteReason
			? (this.state.outstanding?.rewrites ?? 0) + 1
			: 0;
		const committed = await this.commit((state) => {
			if (purpose === "item" && itemKey) {
				state.queue = state.queue.filter((key) => key !== itemKey);
				state.active = itemKey;
				const entry = state.items[itemKey];
				if (entry) entry.status = "active";
			}
			if (purpose === "urgent" && itemKey) {
				state.urgentQueue = state.urgentQueue.filter((key) => key !== itemKey);
				state.activeUrgent = itemKey;
				const entry = state.items[itemKey];
				if (entry) entry.status = "active";
			}
			state.outstanding = requestId
				? { ...this.outstanding(requestId, purpose, itemKey), rewrites }
				: null;
		});
		if (!committed) return false;
		if (!requestId) {
			// The Lead cannot be reached: say only what is known, visibly degraded.
			if (itemKey) await this.speakFallback(itemKey, `unreachable:${itemKey}`);
			else if (purpose === "checkin") await this.speakCheckinFallback("none");
			return false;
		}
		this.armLeadTimer();
		return true;
	}

	private async issue(
		input: Omit<AgendaBriefRequestInput, "clientRequestId">,
	): Promise<string | undefined> {
		try {
			const { requestId } = await this.options.ports.requestBrief({
				...input,
				clientRequestId: this.nextId(),
			});
			this.knownRequests.add(requestId);
			this.options.record({
				kind: "agenda_request_issued",
				requestId,
				purpose: input.purpose,
				itemKey: input.itemKey,
				...(input.rewriteReason ? { rewriteReason: input.rewriteReason } : {}),
			});
			return requestId;
		} catch (error) {
			this.options.record({
				kind: "agenda_request_failed",
				purpose: input.purpose,
				itemKey: input.itemKey,
				message: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	private outstanding(
		requestId: string,
		purpose: AgendaOutstanding["purpose"],
		itemKey: string | null,
	): AgendaOutstanding {
		return {
			requestId,
			purpose,
			itemKey,
			issuedAt: new Date(this.now()).toISOString(),
			rewrites: 0,
			answered: false,
		};
	}

	// ── results (§3.2 matrix, R1-5 stale fencing) ──

	private async drain(): Promise<void> {
		const outstanding = this.state.outstanding;
		if (!outstanding) return;
		let results: AgendaResult[];
		try {
			results = await this.options.ports.listResults(
				outstanding.requestId,
				this.state.applied[outstanding.requestId] ?? 0,
			);
		} catch (error) {
			this.options.record({
				kind: "agenda_results_read_failed",
				requestId: outstanding.requestId,
				message: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		for (const result of results) {
			if (this.closing) return;
			if (this.state.outstanding?.requestId !== result.requestId) {
				this.options.record({
					kind: "agenda_result_stale",
					requestId: result.requestId,
					resultEventId: result.resultEventId,
					reason: "superseded",
				});
				continue;
			}
			if (result.seq <= (this.state.applied[result.requestId] ?? 0)) continue;
			await this.apply(result);
		}
	}

	private markApplied(state: AgendaState, result: AgendaResult): void {
		state.applied[result.requestId] = result.seq;
		const keys = Object.keys(state.applied);
		if (keys.length > MAX_APPLIED_REQUESTS)
			for (const key of keys.slice(0, keys.length - MAX_APPLIED_REQUESTS))
				delete state.applied[key];
		if (state.outstanding?.requestId === result.requestId)
			state.outstanding.answered = true;
	}

	private async reject(result: AgendaResult, reason: string): Promise<void> {
		this.options.record({
			kind: "agenda_result_rejected",
			requestId: result.requestId,
			resultEventId: result.resultEventId,
			resultKind: result.kind,
			reason,
		});
		await this.commit((state) => this.markApplied(state, result));
	}

	private targetItem(outstanding: AgendaOutstanding): string | null {
		switch (outstanding.purpose) {
			case "item":
			case "resume":
				return this.state.active;
			case "urgent":
				return this.state.activeUrgent;
			case "reply":
				return outstanding.itemKey;
			default:
				return null;
		}
	}

	private async apply(result: AgendaResult): Promise<void> {
		const outstanding = this.state.outstanding;
		if (!outstanding) return;
		this.clearLeadTimer();
		if (result.kind === "close") {
			await this.applyClose(result, outstanding);
			return;
		}
		const itemKey =
			result.kind === "say"
				? result.itemKey
				: outstanding.purpose === "open" || outstanding.purpose === "checkin"
					? null
					: outstanding.itemKey;
		const order = result.kind === "say" ? result.order : undefined;
		const current = this.state.activeUrgent ?? this.state.active;
		let allowed = false;
		let activateHead = false;
		switch (outstanding.purpose) {
			case "open": {
				if (
					order &&
					(new Set(order).size !== order.length ||
						!order.every((key) => this.state.items[key]))
				)
					break;
				const head =
					(order
						? applyOpeningOrder(order, this.state.queue)
						: this.state.queue)[0] ?? null;
				allowed =
					itemKey === null ||
					(this.state.active === null && itemKey === head) ||
					itemKey === this.state.active;
				activateHead =
					itemKey !== null && this.state.active === null && itemKey === head;
				break;
			}
			case "item":
			case "resume":
				allowed = !order && itemKey !== null && itemKey === this.state.active;
				break;
			case "urgent":
				allowed =
					!order && itemKey !== null && itemKey === this.state.activeUrgent;
				break;
			case "checkin":
				allowed = !order && itemKey === null;
				break;
			case "reply":
				allowed =
					!order && (itemKey === null || itemKey === outstanding.itemKey);
				break;
		}
		if (!allowed) {
			await this.reject(result, "matrix");
			return;
		}
		const validation = validateAgendaSay(result.text, this.maxSayCodePoints);
		if (!validation.ok) {
			this.options.record({
				kind: "agenda_say_invalid",
				requestId: result.requestId,
				reason: validation.reason,
			});
			if (
				outstanding.rewrites === 0 &&
				outstanding.purpose !== "reply" &&
				outstanding.purpose !== "open"
			) {
				await this.commit((state) => this.markApplied(state, result));
				await this.request(
					outstanding.purpose as "item" | "urgent" | "resume" | "checkin",
					outstanding.itemKey,
					undefined,
					validation.reason,
				);
				return;
			}
			if (outstanding.purpose === "open" && outstanding.rewrites === 0) {
				await this.commit((state) => this.markApplied(state, result));
				await this.reissueOpen(validation.reason);
				return;
			}
			await this.commit((state) => this.markApplied(state, result));
			await this.speakDegraded(outstanding, itemKey);
			return;
		}
		const committed = await this.commit((state) => {
			this.markApplied(state, result);
			if (order) state.queue = applyOpeningOrder(order, state.queue);
			if (activateHead && itemKey) {
				state.queue = state.queue.filter((key) => key !== itemKey);
				state.active = itemKey;
				const entry = state.items[itemKey];
				if (entry) entry.status = "active";
			}
		});
		if (!committed) return;
		const kind: SpeakKind =
			outstanding.purpose === "item" ||
			outstanding.purpose === "urgent" ||
			outstanding.purpose === "reply"
				? "question"
				: "brief";
		await this.speak(result.text, kind, {
			pendingKey: `agenda:${result.requestId}:${result.resultEventId}`,
			purpose: outstanding.purpose,
			itemKey,
		});
		if (outstanding.purpose === "checkin") {
			this.checkinPending = null;
			this.armCheckin();
		}
		if (outstanding.purpose === "open" && itemKey === null) {
			await this.maybeStartWork();
			return;
		}
		if (outstanding.purpose === "reply") {
			const bound = outstanding.itemKey
				? this.state.items[outstanding.itemKey]
				: undefined;
			if (bound?.status === "closed") {
				// R-T5: explain the late turn, then brief the item that is live now.
				const live = this.state.activeUrgent ?? this.state.active;
				if (live)
					await this.request(this.state.activeUrgent ? "resume" : "item", live);
				else
					await this.startNext({
						itemKey: bound.item.itemKey,
						closedAs: bound.closedAs ?? "source_gone",
					});
				return;
			}
			if (itemKey === null && current) this.armResumeGap(result.requestId);
		}
	}

	private async reissueOpen(reason: AgendaSayRejection): Promise<void> {
		const requestId = await this.issue({
			purpose: "open",
			itemKey: null,
			rewriteReason: reason,
		});
		if (!requestId) {
			await this.speakDegraded(this.outstanding("none", "open", null), null);
			return;
		}
		const committed = await this.commit((state) => {
			state.outstanding = {
				...this.outstanding(requestId, "open", null),
				rewrites: 1,
			};
		});
		if (committed) this.armLeadTimer();
	}

	private async applyClose(
		result: Extract<AgendaResult, { kind: "close" }>,
		outstanding: AgendaOutstanding,
	): Promise<void> {
		const target = this.targetItem(outstanding);
		const current = this.state.activeUrgent ?? this.state.active;
		const allowed =
			(outstanding.purpose === "item" ||
				outstanding.purpose === "resume" ||
				outstanding.purpose === "urgent" ||
				outstanding.purpose === "reply") &&
			target !== null &&
			result.itemKey === target &&
			result.itemKey === current &&
			this.state.items[result.itemKey]?.status === "active" &&
			(result.disposition !== "resolved" || Boolean(result.evidence?.trim()));
		if (!allowed) {
			await this.reject(result, "matrix");
			return;
		}
		const wasUrgent = this.state.activeUrgent === result.itemKey;
		const createdAt = new Date(this.now()).toISOString();
		const committed = await this.commit(
			(state) => {
				this.markApplied(state, result);
				const entry = state.items[result.itemKey];
				if (entry) {
					entry.status = "closed";
					entry.closedAs = result.disposition;
				}
				if (wasUrgent) state.activeUrgent = null;
				else state.active = null;
				state.outstanding = null;
			},
			[
				{
					itemKey: result.itemKey,
					disposition: result.disposition,
					evidence: result.evidence?.trim() || null,
					reason: result.reason,
					requestId: result.requestId,
					createdAt,
				},
			],
		);
		if (!committed) return;
		this.clearResumeTimer();
		this.options.record({
			kind: "agenda_item_closed",
			itemKey: result.itemKey,
			disposition: result.disposition,
			requestId: result.requestId,
		});
		const previous = { itemKey: result.itemKey, closedAs: result.disposition };
		if (wasUrgent) await this.afterUrgentClosed(previous);
		else await this.startNext(previous);
	}

	// ── timers ──

	private armLeadTimer(): void {
		this.clearLeadTimer();
		const outstanding = this.state.outstanding;
		if (
			!outstanding ||
			outstanding.answered ||
			outstanding.purpose === "reply" ||
			this.closing
		)
			return;
		const requestId = outstanding.requestId;
		this.leadTimer = this.setTimeoutFn(() => {
			this.leadTimer = undefined;
			void this.enqueue(() => this.onLeadTimeout(requestId));
		}, this.leadReplyTimeoutMs);
		this.leadTimer.unref?.();
	}

	private clearLeadTimer(): void {
		if (this.leadTimer) this.clearTimeoutFn(this.leadTimer);
		this.leadTimer = undefined;
	}

	/** §3.5: one bridging line, then a known-facts fallback; never silence,
	 * never the raw source text. */
	private async onLeadTimeout(requestId: string): Promise<void> {
		const outstanding = this.state.outstanding;
		if (
			!outstanding ||
			outstanding.requestId !== requestId ||
			outstanding.answered
		)
			return;
		const stage = this.leadTimeoutStage.get(requestId) ?? 0;
		this.leadTimeoutStage.set(requestId, stage + 1);
		this.options.record({
			kind: "agenda_lead_timeout",
			requestId,
			purpose: outstanding.purpose,
			stage: stage + 1,
		});
		if (outstanding.purpose === "checkin") {
			this.checkinPending = null;
			await this.speakCheckinFallback(requestId);
			this.armCheckin();
			return;
		}
		if (stage === 0) {
			const count =
				this.state.queue.length +
				(this.state.active ? 1 : 0) +
				this.state.urgentQueue.length +
				(this.state.activeUrgent ? 1 : 0);
			if (outstanding.purpose === "open" && count > 0)
				await this.speakFixed(
					agendaTransitionLine(count),
					`agenda-transition:${requestId}`,
				);
			this.armLeadTimer();
			return;
		}
		if (stage === 1) await this.speakDegraded(outstanding, outstanding.itemKey);
	}

	/** Fallback for the item the request was about; an open request activates
	 * the head so the founder can answer it. */
	private async speakDegraded(
		outstanding: AgendaOutstanding,
		itemKey: string | null,
	): Promise<void> {
		if (outstanding.purpose === "checkin") {
			await this.speakCheckinFallback(outstanding.requestId);
			return;
		}
		let target = itemKey ?? this.targetItem(outstanding);
		if (!target && outstanding.purpose === "open") {
			const head = this.state.queue[0];
			if (head) {
				const committed = await this.commit((state) => {
					state.queue = state.queue.filter((key) => key !== head);
					state.active = head;
					const entry = state.items[head];
					if (entry) entry.status = "active";
				});
				if (committed) target = head;
			}
		}
		if (target) await this.speakFallback(target, outstanding.requestId);
	}

	private armResumeGap(requestId: string): void {
		this.clearResumeTimer();
		const since = this.lastFounderUtteranceAt;
		this.resumeTimer = this.setTimeoutFn(() => {
			this.resumeTimer = undefined;
			void this.enqueue(async () => {
				if (
					this.state.outstanding?.requestId !== requestId ||
					this.lastFounderUtteranceAt !== since
				)
					return;
				const current = this.state.activeUrgent ?? this.state.active;
				if (current) await this.request("resume", current);
			});
		}, this.resumeGapMs);
		this.resumeTimer.unref?.();
	}

	private clearResumeTimer(): void {
		if (this.resumeTimer) this.clearTimeoutFn(this.resumeTimer);
		this.resumeTimer = undefined;
	}

	private armPoll(): void {
		if (this.closing) return;
		this.pollTimer = this.setTimeoutFn(() => {
			this.pollTimer = undefined;
			void this.enqueue(() => this.refresh()).finally(() => this.armPoll());
		}, this.pollIntervalMs);
		this.pollTimer.unref?.();
	}

	private armCheckin(): void {
		if (this.checkinTimer) this.clearTimeoutFn(this.checkinTimer);
		this.checkinTimer = undefined;
		if (this.closing || this.checkinPending) return;
		// One check-in per quiet interval: a failed or fixed-line attempt is not
		// retried early (never stacked, never replayed).
		const since = Math.max(this.lastActivity, this.lastCheckinAttempt);
		const delay = Math.max(1, this.checkinIntervalMs - (this.now() - since));
		this.checkinTimer = this.setTimeoutFn(() => {
			this.checkinTimer = undefined;
			void this.enqueue(() => this.checkCheckin()).finally(() =>
				this.armCheckin(),
			);
		}, delay);
		this.checkinTimer.unref?.();
	}

	/** Public deterministic clock seam; the real timer calls the same path. */
	checkCheckinNow(): Promise<void> {
		return this.enqueue(() => this.checkCheckin());
	}

	private async checkCheckin(): Promise<void> {
		if (this.closing || !this.state.opened) return;
		const since = Math.max(this.lastActivity, this.lastCheckinAttempt);
		if (this.now() - since < this.checkinIntervalMs) return;
		if (this.checkinPending) return;
		if (this.isFounderSpeaking() || !this.options.room.audibleTail().drained) {
			this.noteActivity();
			return;
		}
		this.lastCheckinAttempt = this.now();
		const outstanding = this.state.outstanding;
		if (
			outstanding &&
			!outstanding.answered &&
			outstanding.purpose !== "checkin"
		) {
			// The Lead is still thinking: do not replace its request.
			await this.speakCheckinFallback(`busy:${this.now()}`);
			return;
		}
		const requested = await this.request("checkin", null);
		if (requested)
			this.checkinPending = this.state.outstanding?.requestId ?? null;
	}

	// ── speech ──

	private isFounderSpeaking(): boolean {
		return (
			this.founderSpeaking &&
			this.now() - this.lastBargeEventAt < this.founderSpeakingStaleMs
		);
	}

	/** Q6: speak only when she is not talking and our own audio has drained.
	 * An unsafe boundary is never waited out into speech; it only ends when the
	 * room says so (or a barge-in that lost its end goes stale). */
	private async waitSafeBoundary(): Promise<boolean> {
		let waitingRecorded = false;
		while (!this.closing) {
			let drained = true;
			try {
				drained = this.options.room.audibleTail().drained;
			} catch {
				drained = true;
			}
			if (!this.isFounderSpeaking() && drained) return true;
			if (!waitingRecorded) {
				waitingRecorded = true;
				this.options.record({
					kind: "agenda_safe_boundary_waiting",
					founderSpeaking: this.isFounderSpeaking(),
					drained,
				});
			}
			await new Promise<void>((resolve) => {
				const timer = this.setTimeoutFn(resolve, SAFE_BOUNDARY_RECHECK_MS);
				timer.unref?.();
			});
		}
		return false;
	}

	private async speak(
		text: string,
		kind: SpeakKind,
		meta: {
			pendingKey: string;
			purpose: AgendaOutstanding["purpose"] | "fallback" | "fixed";
			itemKey: string | null;
		},
	): Promise<boolean> {
		if (!(await this.waitSafeBoundary())) return false;
		let receipt: SpeakReceipt;
		try {
			receipt = await this.options.engine.speak(text, kind, {
				pendingKey: meta.pendingKey,
				verification: "required",
			});
		} catch (error) {
			this.voiceUnavailable(error);
			return false;
		}
		this.options.record({
			kind: "agenda_spoken",
			purpose: meta.purpose,
			itemKey: meta.itemKey,
			pendingKey: meta.pendingKey,
			outcome: receipt.outcome,
			contentProof: receipt.contentProof,
		});
		if (receipt.outcome === "completed") {
			this.noteActivity();
			return true;
		}
		if (
			receipt.outcome === "failed" &&
			receipt.reason === SPEAK_BARGE_IN_REASON
		) {
			this.options.record({
				kind: "agenda_speech_interrupted",
				pendingKey: meta.pendingKey,
			});
			return false;
		}
		this.voiceUnavailable(receipt.reason);
		return false;
	}

	private async speakFallback(
		itemKey: string,
		requestId: string,
	): Promise<void> {
		const entry = this.state.items[itemKey];
		if (!entry) return;
		const text = agendaFallbackLine(entry.item);
		this.options.record({
			kind: "agenda_fallback_spoken",
			itemKey,
			requestId,
		});
		await this.speak(text, "question", {
			pendingKey: `agenda-fallback:${requestId}:${itemKey}`,
			purpose: "fallback",
			itemKey,
		});
	}

	private async speakCheckinFallback(key: string): Promise<void> {
		await this.speakFixed(
			agendaCheckinFallbackLine(this.sourceHealthy),
			`agenda-checkin:${key}`,
		);
	}

	private async speakFixed(text: string, pendingKey: string): Promise<void> {
		await this.speak(text, "heartbeat", {
			pendingKey,
			purpose: "fixed",
			itemKey: null,
		});
	}

	// ── plumbing ──

	private async commit(
		mutate: (state: AgendaState) => void,
		dispositions: readonly AgendaDispositionRecord[] = [],
	): Promise<boolean> {
		const next = structuredClone(this.state);
		mutate(next);
		next.stateVersion = this.state.stateVersion + 1;
		next.lastActivityAt = new Date(this.lastActivity).toISOString();
		let outcome: Awaited<ReturnType<AgendaPorts["saveState"]>>;
		try {
			outcome = await this.options.ports.saveState({
				state: next,
				expectedVersion: this.state.stateVersion,
				dispositions,
			});
		} catch (error) {
			this.options.record({
				kind: "agenda_state_save_failed",
				message: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
		if (outcome.ok) {
			this.state = next;
			return true;
		}
		this.options.record({
			kind: "agenda_state_conflict",
			expectedVersion: this.state.stateVersion,
			currentVersion: outcome.current?.stateVersion ?? null,
		});
		if (outcome.current && outcome.current.sessionId === this.options.sessionId)
			this.state = outcome.current;
		return false;
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.work.then(async () => {
			if (this.closing) return undefined as T;
			return task();
		});
		this.work = result.catch((error) =>
			this.options.record({
				kind: "agenda_task_failed",
				message: error instanceof Error ? error.message : String(error),
			}),
		);
		return result;
	}

	private noteActivity(): void {
		this.lastActivity = this.now();
		if (this.started && !this.closing && this.state.opened) this.armCheckin();
	}

	private voiceUnavailable(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.options.record({ kind: "agenda_voice_unavailable", message });
		this.options.textStatus?.("语音不可用，请看文字状态。");
	}
}
