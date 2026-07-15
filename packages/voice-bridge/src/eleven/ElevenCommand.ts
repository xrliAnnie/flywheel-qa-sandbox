/**
 * ElevenCommand (FLY-1006 S7 + FLY-1160 §4.2) — the /eleven invocation
 * orchestrator, now with a KICKOFF ISSUE (FLY-1160: /eleven is no longer a
 * bare product-test surface — the resident brain writes minutes onto its own
 * meeting issue):
 *
 *   preflight (agent reachable + shim healthy + key present; any gap is a
 *   fail-loud founder-facing reply, NEVER a silent degrade — research §2.3)
 *   → shared-slot acquire("eleven") (busy → founder-facing rejection)
 *   → kickoff issue (FLY-1160; failure = no issue, no meeting — fail-loud)
 *   → session start (owns the slot + issue from here; the resident brain is
 *     pre-heated by the wiring in the assembling window — plan §4.2-3).
 *
 * The sessionId is the daemon-minted conversation UUID (custom_llm_extra_body
 * → shim keying); the strict order slot → issue → open → WS kills the 404
 * race (Codex R1 #6).
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
	/** FLY-1160: mint the kickoff issue the resident brain lands minutes on. */
	createIssue(title: string): Promise<{ identifier: string; url?: string }>;
	startSession(args: {
		sessionId: string;
		issueId: string;
		topic?: string;
	}): Promise<void>;
	/** stop the live session (undefined result = nothing live). */
	stopSession(): Promise<boolean>;
	pingFounder?(text: string): Promise<void>;
	/** founder name in the kickoff title (default Annie). */
	founderName?: string;
	now?: () => Date;
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

		// FLY-1160: kickoff issue BEFORE the session — the resident brain lands
		// minutes here. Failure = no issue, no meeting (fail-loud): release the
		// slot so a retry starts clean (Codex GeminiCommand R1 MEDIUM shape).
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
			this.opts.slot.release(ELEVEN_SLOT_MODE, sessionId);
			await inv.reply(
				`/${this.name} 没起起来:立项 issue 创建失败(${String((err as Error).message ?? err)})。稍后再试。`,
			);
			return;
		}

		// invite + ping are best-effort: a Discord hiccup must not strand the
		// acquired slot + issue before the session takes ownership.
		try {
			await inv.reply(
				`🎙 /${this.name} 开场了 — 立项 ${identifier}${issueUrl ? `(${issueUrl})` : ""}。点 Join 进语音频道,直接开口聊。说 /${this.name} stop 结束。`,
				{ joinUrl: this.opts.joinUrl },
			);
			await this.opts.pingFounder?.(
				`🎙 /${this.name} 在等你 — 点 Join 进语音频道,聊完纪要自动落 ${identifier}。`,
			);
		} catch (err) {
			this.opts.log?.(
				`[eleven-command] invite/ping failed (non-fatal): ${String((err as Error).message ?? err)}`,
			);
		}

		try {
			await this.opts.startSession({
				sessionId,
				issueId: identifier,
				topic: inv.topic,
			});
		} catch (err) {
			this.opts.slot.release(ELEVEN_SLOT_MODE, sessionId);
			// the session's abort path may have already closed the kickoff issue
			// (flagged on the error) — the founder-facing reply must not lie.
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

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** kickoff issue title (GeminiCommand shape; FLY-993: strip Discord mention
 * markup from the typed topic so it never leaks into the founder-facing title). */
function kickoffTitle(
	now: Date,
	command: string,
	founder: string,
	topic?: string,
): string {
	const d = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const t = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
	const cleaned = topic
		?.replace(/<[@#][!&]?\d+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return `${d} ${t} · ${command}(${founder})${cleaned ? ` — ${cleaned}` : ""}`;
}
