import type { StateStore, VoiceScheduleRow } from "../StateStore.js";

export interface VoiceScheduleRuntimeDeps {
	store: StateStore;
	now?: () => string;
	newSessionId: () => string;
	/** Runs the existing Discord provisioning chain for the reserved session. */
	provision: (sessionId: string, signal?: AbortSignal) => Promise<void>;
	/** Bound on one provisioning pass; a hung call must not freeze the lane. */
	provisionDeadlineMs?: number;
	scanIntervalMs?: number;
	log?: (message: string) => void;
}

const TERMINAL_SESSION_STATES = new Set(["ended", "cancelled", "failed"]);

/**
 * FLY-2701: the Bridge holds the meeting calendar, so nothing about a booked
 * meeting depends on a voice process being alive. Each scan reads durable state
 * from scratch — a lost kickstart, a Bridge restart, or a crashed provisioning
 * pass all converge on the next tick instead of stranding a meeting.
 */
export class VoiceScheduleRuntime {
	private ticking = false;
	private readonly provisioning = new Map<string, Promise<void>>();
	private timer?: ReturnType<typeof setInterval>;
	private readonly now: () => string;

	constructor(private readonly deps: VoiceScheduleRuntimeDeps) {
		this.now = deps.now ?? (() => new Date().toISOString());
	}

	/** Runs immediately on Bridge start so a restart re-scans the backlog. */
	start(): void {
		if (this.timer) return;
		const run = () =>
			void this.tick().catch(() =>
				this.deps.log?.("voice schedule tick failed"),
			);
		run();
		this.timer = setInterval(run, this.deps.scanIntervalMs ?? 3_000);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const at = this.now();
			// Bookings whose session died outside the state route, or that ran past
			// their own presence deadline, must reach a terminal state or they keep
			// blocking every new booking for the same meeting.
			this.deps.store.reapStrandedVoiceSchedules(at);
			this.reapMissed(at);
			// Claim first, provision after. Every due booking reaches `prewarming`
			// in this tick using only durable state; the external provisioning call
			// for each one then runs on its own, because one hung network call must
			// not freeze the reaper, the next scan, or anybody else's meeting.
			const claimed: string[] = [];
			for (const schedule of this.deps.store.listDueVoiceSchedules(at)) {
				const sessionId = this.claim(schedule, at);
				if (sessionId) claimed.push(sessionId);
			}
			for (const sessionId of claimed) this.provisionInBackground(sessionId);
			// Waking is deliberately not done here. The session runtime's wake lane
			// already scans every desired row on its own cadence and spends the
			// per-demand launch budget that replaced the resident storm gate; a
			// second caller would ask launchd every 3s forever and re-create the
			// restart storm this design exists to remove.
		} finally {
			this.ticking = false;
		}
	}

	/**
	 * A booking whose presence deadline has passed with no session is a missed
	 * meeting, not a late one: starting the bot now would drop it into a meeting
	 * that is already over.
	 */
	private reapMissed(at: string): void {
		const atMs = Date.parse(at);
		for (const schedule of this.deps.store.listDueVoiceSchedules(at)) {
			if (Date.parse(schedule.presenceDeadlineAt) >= atMs) continue;
			this.deps.store.failVoiceSchedule({
				scheduleId: schedule.scheduleId,
				expectedRevision: schedule.revision,
				reason: "missed",
				updatedAt: at,
			});
		}
	}

	/**
	 * Reserves the session and links it to the booking in one committed step.
	 * Returns the session id when this tick is the one that claimed it.
	 */
	private claim(schedule: VoiceScheduleRow, at: string): string | undefined {
		// Re-read: the row may have been cancelled or moved since the listing.
		const current = this.deps.store.getVoiceSchedule(schedule.scheduleId);
		if (
			!current ||
			current.state !== "scheduled" ||
			current.revision !== schedule.revision ||
			Date.parse(current.prewarmAt) > Date.parse(at) ||
			Date.parse(current.presenceDeadlineAt) < Date.parse(at)
		)
			return undefined;
		if (current.sessionId) {
			const previous = this.deps.store.getVoiceSession(current.sessionId);
			// An earlier revision's session must reach a terminal state first; two
			// bots in one room is worse than a late start.
			if (previous && !TERMINAL_SESSION_STATES.has(previous.state)) {
				return undefined;
			}
		}
		const sessionId = this.deps.newSessionId();
		const reserved = this.deps.store.reserveVoiceScheduleSession({
			scheduleId: current.scheduleId,
			expectedRevision: current.revision,
			updatedAt: at,
			reservation: {
				sessionId,
				mode: "meeting",
				projectName: current.projectName,
				leadId: current.leadId,
				guildId: current.guildId,
				voiceChannelId: current.voiceChannelId,
				voiceBotUserId: current.voiceBotUserId,
				...(current.meetingId ? { meetingId: current.meetingId } : {}),
				...(current.evidenceDir ? { evidenceDir: current.evidenceDir } : {}),
				...(current.topic ? { topic: current.topic } : {}),
				requestedBy: current.requestedBy,
				credentialTier: current.credentialTier,
				createdAt: at,
				scheduleId: current.scheduleId,
				scheduleRevision: current.revision,
				notBeforeLiveAt: current.scheduledAt,
				presenceDeadlineAt: current.presenceDeadlineAt,
			},
		});
		if (reserved.status !== "reserved") {
			// The room is busy, the meeting already has a session, or the booking
			// moved under us. Nothing was written either way — the booking keeps its
			// original deadline and the next scan tries again; never preempt.
			this.deps.log?.(
				`voice schedule ${current.scheduleId} deferred: ${reserved.status}`,
			);
			return undefined;
		}
		return sessionId;
	}

	/**
	 * One bounded single-flight provisioning pass per session. The tick does not
	 * await it; a second tick finding the same session still in flight leaves it
	 * alone rather than opening a second external call for one meeting.
	 */
	private provisionInBackground(sessionId: string): void {
		if (this.provisioning.has(sessionId)) return;
		const task = this.provisionWithDeadline(sessionId)
			.catch(() => {
				// The session row survives; recovery and the next scan own the retry.
				this.deps.log?.(`voice schedule provision failed for ${sessionId}`);
			})
			.finally(() => {
				if (this.provisioning.get(sessionId) === task) {
					this.provisioning.delete(sessionId);
				}
			});
		this.provisioning.set(sessionId, task);
	}

	/**
	 * One external provisioning pass cannot be allowed to hold the whole lane:
	 * while it hangs, every other booking and the missed-meeting reaper stop.
	 */
	private async provisionWithDeadline(sessionId: string): Promise<void> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				const error = new Error("voice_schedule_provision_timeout");
				reject(error);
				controller.abort(error);
			}, this.deps.provisionDeadlineMs ?? 30_000);
			timer.unref?.();
		});
		try {
			await Promise.race([
				this.deps.provision(sessionId, controller.signal),
				deadline,
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}
