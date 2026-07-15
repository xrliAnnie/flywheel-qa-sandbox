/**
 * ElevenCommand (FLY-1006 S7) — the /eleven invocation orchestrator, the
 * GeminiCommand shape minus the kickoff issue (this is a product-test
 * surface, not a meeting-minutes pipeline):
 *
 *   preflight (agent reachable + shim healthy + key present; any gap is a
 *   fail-loud founder-facing reply, NEVER a silent degrade — research §2.3)
 *   → shared-slot acquire("eleven") (busy → founder-facing rejection)
 *   → session start (the session owns the slot from here).
 *
 * "/eleven stop" tears the live session down.
 */
import { randomUUID } from "node:crypto";
import type { SessionSlot } from "../SessionSlot.js";
import { ELEVEN_SLOT_MODE } from "./config.js";

export interface ElevenInvocation {
	topic?: string;
	reply(text: string, opts?: { joinUrl?: string }): Promise<void>;
}

export type ElevenPreflightResult =
	| { ok: true }
	| { ok: false; reason: string };

export interface ElevenCommandOptions {
	commandName?: string;
	slot: SessionSlot;
	joinUrl: string;
	/** agent GET + shim health + key-in-place, injected by the wiring. */
	preflight(): Promise<ElevenPreflightResult>;
	startSession(args: { sessionId: string; topic?: string }): Promise<void>;
	/** stop the live session (undefined result = nothing live). */
	stopSession(): Promise<boolean>;
	pingFounder?(text: string): Promise<void>;
	log?: (line: string) => void;
}

export class ElevenCommand {
	constructor(private readonly opts: ElevenCommandOptions) {}

	get name(): string {
		return this.opts.commandName ?? "eleven";
	}

	async handle(inv: ElevenInvocation): Promise<void> {
		if (inv.topic?.trim().toLowerCase() === "stop") {
			const stopped = await this.opts.stopSession();
			await inv.reply(
				stopped
					? `/${this.name} 会话已结束。`
					: `没有进行中的 /${this.name} 会话。`,
			);
			return;
		}

		const pre = await this.opts.preflight();
		if (!pre.ok) {
			await inv.reply(
				`/${this.name} 没起起来（预检失败）:${pre.reason}。修好再试——不带病开会话。`,
			);
			return;
		}

		const sessionId = randomUUID();
		const acquired = this.opts.slot.acquire(ELEVEN_SLOT_MODE, sessionId);
		if (!acquired.ok) {
			await inv.reply(acquired.message);
			return;
		}

		try {
			await inv.reply(
				`🎙 /${this.name} 开场了 — 点 Join 进语音频道,直接开口聊。说 /${this.name} stop 结束。`,
				{ joinUrl: this.opts.joinUrl },
			);
			await this.opts.pingFounder?.(
				`🎙 /${this.name} 在等你 — 点 Join 进语音频道。`,
			);
		} catch (err) {
			this.opts.log?.(
				`[eleven-command] invite/ping failed (non-fatal): ${String((err as Error).message ?? err)}`,
			);
		}

		try {
			await this.opts.startSession({ sessionId, topic: inv.topic });
		} catch (err) {
			this.opts.slot.release(ELEVEN_SLOT_MODE, sessionId);
			await inv.reply(
				`/${this.name} 会话启动失败(${String((err as Error).message ?? err)})——重新 /${this.name} 即可再试。`,
			);
		}
	}
}
