import { createHash } from "node:crypto";
import type { StateStore, VoiceSessionRow } from "../StateStore.js";

const TERMINAL_STATES = new Set(["ended", "cancelled", "failed"]);
const ACTIVE_STATES = new Set(["claimed", "warming", "live", "ending"]);

function safeReason(reason: string | null): string {
	return reason && /^[a-z0-9_-]{1,80}$/iu.test(reason) ? reason : "unknown";
}

function healthIsFresh(
	session: VoiceSessionRow,
	now: string,
	leaseRenewMs: number,
): boolean {
	if (
		!session.receiveHealth ||
		!session.receiveHealthObservedAt ||
		!session.leaseExpiresAt ||
		!ACTIVE_STATES.has(session.state) ||
		Date.parse(session.leaseExpiresAt) <= Date.parse(now)
	)
		return false;
	const ageMs = Date.parse(now) - Date.parse(session.receiveHealthObservedAt);
	return ageMs >= 0 && ageMs <= 3 * leaseRenewMs;
}

export function renderVoiceSessionCard(
	session: VoiceSessionRow,
	now: string,
	leaseRenewMs: number,
): string {
	const header = `📻 ${session.mode.toUpperCase()} · ${session.sessionId.slice(0, 8)}`;
	if (TERMINAL_STATES.has(session.state)) {
		return `${header}\n状态：${session.state}\n收音：会话已结束（${safeReason(session.reason)}）\n需要新会话时请重新说「语音」或「开会」。`;
	}
	let receiveLine = "等待你说话；文字回复仍可由 Lead 播报。";
	if (healthIsFresh(session, now, leaseRenewMs)) {
		if (session.receiveHealth?.state === "receiving") {
			receiveLine = "已接收音频；对话是否成功以实际回复为准。";
		} else if (
			session.receiveHealth?.state === "degraded" &&
			session.receiveHealth.reason === "dave_decrypt"
		) {
			receiveLine =
				"收音暂不可用（加密音频未解开），文字回复仍可播报，请稍后重说。";
		} else if (session.receiveHealth?.state === "degraded") {
			receiveLine = "收音暂不可用，文字回复仍可播报，请稍后重说。";
		}
	}
	return `${header}\n状态：${session.state}\n收音：${receiveLine}\n停止：在文字里说「停止语音」。`;
}

export function voiceSessionCardDigest(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export interface VoiceSessionCardProjectorDeps {
	store: Pick<
		StateStore,
		| "listVoiceSessionCardCandidates"
		| "getVoiceSession"
		| "markVoiceSessionCardProjected"
	>;
	leaseRenewMs: number;
	now?: () => string;
	validateSession(session: VoiceSessionRow): void | Promise<void>;
	patch(
		session: VoiceSessionRow,
		content: string,
		signal: AbortSignal,
	): Promise<void>;
	intervalMs?: number;
	requestTimeoutMs?: number;
}

export class VoiceSessionCardProjector {
	private timer?: ReturnType<typeof setInterval>;
	private ticking = false;
	private stopped = false;
	private cursor = "";
	private activeController?: AbortController;
	private readonly failures = new Map<
		string,
		{ nextAt: number; delayMs: number }
	>();
	private readonly now: () => string;

	constructor(private readonly deps: VoiceSessionCardProjectorDeps) {
		this.now = deps.now ?? (() => new Date().toISOString());
	}

	async tick(): Promise<void> {
		if (this.ticking || this.stopped) return;
		this.ticking = true;
		try {
			const candidates = this.deps.store.listVoiceSessionCardCandidates(
				this.cursor,
				25,
			);
			if (candidates.length === 0) {
				this.cursor = "";
				return;
			}
			for (const candidate of candidates) {
				if (this.stopped) return;
				this.cursor = candidate.sessionId;
				await this.project(candidate);
			}
			if (candidates.length < 25) this.cursor = "";
		} finally {
			this.ticking = false;
		}
	}

	start(): void {
		if (this.timer) return;
		this.stopped = false;
		void this.tick().catch((error) => this.logFailure(error));
		this.timer = setInterval(() => {
			void this.tick().catch((error) => this.logFailure(error));
		}, this.deps.intervalMs ?? 3_000);
		this.timer.unref?.();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.activeController?.abort(new Error("voice_card_projector_stopped"));
		this.activeController = undefined;
	}

	private async project(candidate: VoiceSessionRow): Promise<void> {
		const at = this.now();
		const failure = this.failures.get(candidate.sessionId);
		if (failure && Date.parse(at) < failure.nextAt) return;
		const candidateContent = renderVoiceSessionCard(
			candidate,
			at,
			this.deps.leaseRenewMs,
		);
		if (
			candidate.receiveCardDigest === voiceSessionCardDigest(candidateContent)
		) {
			this.failures.delete(candidate.sessionId);
			return;
		}
		try {
			await this.deps.validateSession(candidate);
			const current = this.deps.store.getVoiceSession(candidate.sessionId);
			if (
				!current?.rootMessageId ||
				!current.receiveHealthObservedAt ||
				this.stopped
			)
				return;
			const content = renderVoiceSessionCard(
				current,
				this.now(),
				this.deps.leaseRenewMs,
			);
			const digest = voiceSessionCardDigest(content);
			if (current.receiveCardDigest === digest) {
				this.failures.delete(current.sessionId);
				return;
			}
			const controller = new AbortController();
			this.activeController = controller;
			const timeout = setTimeout(
				() => controller.abort(new Error("voice_card_patch_timeout")),
				this.deps.requestTimeoutMs ?? 2_000,
			);
			timeout.unref?.();
			try {
				await this.deps.patch(current, content, controller.signal);
			} finally {
				clearTimeout(timeout);
				if (this.activeController === controller)
					this.activeController = undefined;
			}
			this.deps.store.markVoiceSessionCardProjected(current, digest);
			this.failures.delete(current.sessionId);
		} catch (error) {
			if (this.stopped) return;
			const previous = this.failures.get(candidate.sessionId);
			const delayMs = previous?.delayMs ?? 30_000;
			this.failures.set(candidate.sessionId, {
				nextAt: Date.parse(this.now()) + delayMs,
				delayMs: Math.min(delayMs * 2, 300_000),
			});
			this.logFailure(error, candidate.sessionId);
		}
	}

	private logFailure(error: unknown, sessionId?: string): void {
		console.warn(
			`[voice-session-card] ${sessionId ?? "tick"} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
