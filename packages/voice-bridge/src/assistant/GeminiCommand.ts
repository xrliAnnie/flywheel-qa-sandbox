/**
 * GeminiCommand (FLY-967 P7) — the /gemini invocation orchestrator:
 * slot acquire (busy → founder-facing rejection, nothing created) → kickoff
 * issue → invite reply (Join link) + founder @ping (+ best-effort MOVE) →
 * hand off to the AssistantSession factory. The session owns the slot from
 * here (it releases on every exit path); any failure BEFORE the handoff
 * releases the slot right here so the room can never leak.
 *
 * Mirrors the MeetCommand shape (545 PR-2, not landed yet — whoever lands
 * second extracts the shared discord/commandKit per the plan's 谁后落谁抽
 * note). Discord specifics are injected seams.
 */
import { randomUUID } from "node:crypto";
import type { SessionSlot } from "../SessionSlot.js";
import { ASSISTANT_SLOT_MODE } from "./config.js";

export interface GeminiInvocation {
	topic?: string;
	/** the invocation reply (回执); the adapter renders joinUrl as a button. */
	reply(text: string, opts?: { joinUrl?: string }): Promise<void>;
}

export interface GeminiCommandOptions {
	commandName?: string;
	slot: SessionSlot;
	/** the resident #huddle VC link for the Join button. */
	joinUrl: string;
	founderName?: string;
	createIssue(title: string): Promise<{ identifier: string; url?: string }>;
	/** channel @ping so her phone buzzes. */
	pingFounder(text: string): Promise<void>;
	/** MOVE_MEMBERS when she is already in another VC; false = no permission /
	 * not applicable — never fatal (the Join button is always there). */
	moveFounderToVc?(): Promise<boolean>;
	startSession(args: {
		sessionId: string;
		issueId: string;
		topic?: string;
	}): Promise<void>;
	now?: () => Date;
	log?: (line: string) => void;
}

export class GeminiCommand {
	constructor(private readonly opts: GeminiCommandOptions) {}

	get name(): string {
		return this.opts.commandName ?? "gemini";
	}

	async handle(inv: GeminiInvocation): Promise<void> {
		const sessionId = randomUUID();
		const acquired = this.opts.slot.acquire(ASSISTANT_SLOT_MODE, sessionId);
		if (!acquired.ok) {
			// FLY-1159 (Codex R3): /gemini and /gemini-advanced share
			// ASSISTANT_SLOT_MODE, so the slot's per-mode copy would misname
			// whichever assistant command is running as /gemini. Same-mode busy
			// gets neutral assistant-session wording; a cross-mode holder
			// (e.g. /eleven) keeps the slot's accurate message.
			await inv.reply(
				acquired.busy.mode === ASSISTANT_SLOT_MODE
					? `有一场助理语音会话正在进行(${acquired.busy.holder}),先结束它再开新的。`
					: acquired.message,
			);
			return;
		}

		let identifier: string;
		let issueUrl: string | undefined;
		try {
			const created = await this.opts.createIssue(
				kickoffTitle(
					this.opts.now?.() ?? new Date(),
					this.name,
					this.opts.founderName ?? "Annie",
					inv.topic,
				),
			);
			identifier = created.identifier;
			issueUrl = created.url;
		} catch (err) {
			this.opts.slot.release(ASSISTANT_SLOT_MODE, sessionId);
			await inv.reply(
				`/${this.name} 没起起来:立项 issue 创建失败(${String((err as Error).message ?? err)})。稍后再试。`,
			);
			return;
		}

		// invite + ping are best-effort: a Discord hiccup here must not strand
		// the acquired slot before the session takes ownership (Codex R1 MEDIUM).
		try {
			await inv.reply(
				`🎙 /${this.name} 开场了 — 立项 ${identifier}${issueUrl ? `(${issueUrl})` : ""}。点 Join 进语音频道。`,
				{ joinUrl: this.opts.joinUrl },
			);
			await this.opts.pingFounder(
				`🎙 /${this.name} 在等你 — 点 Join 进 #huddle,聊完纪要自动落 ${identifier}。`,
			);
		} catch (err) {
			this.opts.log?.(
				`[gemini-command] invite/ping failed (non-fatal, session continues): ${String((err as Error).message ?? err)}`,
			);
		}
		if (this.opts.moveFounderToVc) {
			const moved = await this.opts.moveFounderToVc().catch(() => false);
			if (!moved) {
				this.opts.log?.(
					"[gemini-command] MOVE_MEMBERS unavailable — Join button is the path in",
				);
			}
		}

		try {
			await this.opts.startSession({
				sessionId,
				issueId: identifier,
				topic: inv.topic,
			});
		} catch (err) {
			this.opts.slot.release(ASSISTANT_SLOT_MODE, sessionId);
			// the session's abort path may have already closed the kickoff issue
			// (flagged on the error) — the founder-facing reply must not lie (R17)
			const issueClosed =
				(err as { issueClosed?: boolean }).issueClosed === true;
			await inv.reply(
				issueClosed
					? `/${this.name} 会话启动失败(${String((err as Error).message ?? err)})——${identifier} 已自动关闭,重新 /${this.name} 即可再试。`
					: `/${this.name} 会话启动失败(${String((err as Error).message ?? err)})——${identifier} 保持打开,重新 /${this.name} 即可。`,
			);
		}
	}
}

function kickoffTitle(
	now: Date,
	command: string,
	founder: string,
	topic?: string,
): string {
	const d = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const t = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
	// raw Discord mention markup in the typed topic (<@id>/<@!id>/<#id>/<@&id>)
	// must not leak into the founder-facing issue title (FLY-993 regression).
	const cleaned = topic
		?.replace(/<[@#][!&]?\d+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return `${d} ${t} · ${command}(${founder})${cleaned ? ` — ${cleaned}` : ""}`;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}
