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
			this.reapMissed(at);
			for (const schedule of this.deps.store.listDueVoiceSchedules(at)) {
				await this.prewarm(schedule, at);
			}
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

	private async prewarm(schedule: VoiceScheduleRow, at: string): Promise<void> {
		// Re-read: the row may have been cancelled or moved since the listing.
		const current = this.deps.store.getVoiceSchedule(schedule.scheduleId);
		if (
			!current ||
			current.state !== "scheduled" ||
			current.revision !== schedule.revision ||
			Date.parse(current.prewarmAt) > Date.parse(at) ||
			Date.parse(current.presenceDeadlineAt) < Date.parse(at)
		)
			return;
		if (current.sessionId) {
			const previous = this.deps.store.getVoiceSession(current.sessionId);
			// An earlier revision's session must reach a terminal state first; two
			// bots in one room is worse than a late start.
			if (previous && !TERMINAL_SESSION_STATES.has(previous.state)) return;
		}
		const sessionId = this.deps.newSessionId();
		const reserved = this.deps.store.reserveVoiceSession({
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
		});
		if (reserved.status !== "inserted") {
			// The room is busy or the meeting already has a session. Keep the
			// original deadline and try again on the next scan; never preempt.
			this.deps.log?.(
				`voice schedule ${current.scheduleId} deferred: ${reserved.status}`,
			);
			return;
		}
		const linked = this.deps.store.attachVoiceScheduleSession({
			scheduleId: current.scheduleId,
			expectedRevision: current.revision,
			sessionId,
			updatedAt: at,
		});
		if (linked.status !== "linked") {
			this.deps.store.failVoiceSessionAdmission(
				sessionId,
				"schedule_revision_conflict",
				at,
			);
			return;
		}
		try {
			await this.provisionWithDeadline(sessionId);
		} catch {
			// The session row survives; recovery and the next scan own the retry.
			this.deps.log?.(`voice schedule ${current.scheduleId} provision failed`);
		}
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
