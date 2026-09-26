/**
 * TivPresenter (FLY-1065) — the text-panel (TIV) renderer for the /gemini
 * assistant. It replaces the inline `tiv` object in wiring.ts and is the
 * shared surface FLY-545 (/meet) and FLY-1018 (/gemini-advanced) reuse
 * (谁后落谁抽 — they were waiting on this file's 545-plan path).
 *
 * Two rendering disciplines:
 *   - caption(role, text): ONE new message per turn (a running bidirectional
 *     transcript in the channel — Annie's ask). Role-prefixed, scrubbed at the
 *     exit (defense in depth), truncated past a cap with a pointer to the
 *     after-meeting record.
 *   - status(line): ONE message edited in place — a single-flight async state
 *     machine so the 967 status-spam (a fresh message per state change) becomes
 *     one quiet line. status() is a sync void interface over async send/edit,
 *     so throttling alone can't stop promise-timing double-sends: the machine
 *     keeps at most one send/edit in flight and always converges on the latest
 *     line.
 *
 * All sends are fire-and-forget: a Discord hiccup logs, never throws (matches
 * the 967 tiv discipline — the meeting must not die on a failed caption).
 */
import { scrubTranscript } from "flywheel-voice-core";
import type { TivSurface } from "../assistant/AssistantSession.js";

export interface TivSendDeps {
	/** a plain new channel message (caption / card / error). */
	send(text: string): Promise<void>;
	/** a new channel message whose id we keep (the status anchor). */
	sendForId(text: string): Promise<{ messageId: string }>;
	/** edit an existing message in place (the status anchor). */
	edit(messageId: string, text: string): Promise<void>;
}

export interface TivPresenterOptions {
	deps: TivSendDeps;
	/** display name for the founder's captions (default "Annie"). */
	founderName?: string;
	/** display name for the assistant's captions (default "助理"). */
	assistantName?: string;
	/** false = caption degrades to a log line (967 v1 behavior; escape hatch). */
	captions?: boolean;
	/** min ms between status sends/edits (default 1000). */
	statusThrottleMs?: number;
	/** caption hard cap before truncation (default 1800, Discord ~2000). */
	captionMaxChars?: number;
	log?: (line: string) => void;
}

const DEFAULT_THROTTLE_MS = 1000;
const DEFAULT_CAPTION_MAX = 1800;
const TRUNCATION_NOTE = "…(截断,完整见会后记录)";

export class TivPresenter implements TivSurface {
	private readonly deps: TivSendDeps;
	private readonly founderName: string;
	private readonly assistantName: string;
	private readonly captionsOn: boolean;
	private readonly throttleMs: number;
	private readonly captionMax: number;
	private readonly log: (line: string) => void;

	// ---- status single-flight state ----
	private statusMessageId: string | null = null;
	private latestLine = "";
	private dirty = false;
	private inFlight = false;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private lastSentAt = 0;

	constructor(opts: TivPresenterOptions) {
		this.deps = opts.deps;
		this.founderName = opts.founderName ?? "Annie";
		this.assistantName = opts.assistantName ?? "助理";
		this.captionsOn = opts.captions !== false;
		this.throttleMs = opts.statusThrottleMs ?? DEFAULT_THROTTLE_MS;
		this.captionMax = opts.captionMaxChars ?? DEFAULT_CAPTION_MAX;
		this.log = opts.log ?? (() => {});
	}

	status(line: string): void {
		this.latestLine = line;
		this.dirty = true;
		this.scheduleFlush();
	}

	caption(role: "user" | "assistant", text: string): void {
		const clean = scrubTranscript(text);
		if (!this.captionsOn) {
			this.log(`[caption:${role}] ${clean}`);
			return;
		}
		const body =
			clean.length > this.captionMax
				? clean.slice(0, this.captionMax) + TRUNCATION_NOTE
				: clean;
		const name = role === "user" ? this.founderName : this.assistantName;
		const prefix = role === "user" ? "🗣️" : "💬";
		void this.deps
			.send(`${prefix} **${name}**:${body}`)
			.catch((err) => this.log(`TIV caption send failed: ${errMsg(err)}`));
	}

	card(text: string): void {
		void this.deps
			.send(text)
			.catch((err) => this.log(`TIV card send failed: ${errMsg(err)}`));
	}

	error(text: string): void {
		void this.deps
			.send(`⚠️ ${text}`)
			.catch((err) => this.log(`TIV error send failed: ${errMsg(err)}`));
	}

	// ---- status single-flight machine ----

	private scheduleFlush(): void {
		// a pending timer or an in-flight send already owns the next flush —
		// merge into it (the latest line is picked up when it runs).
		if (this.flushTimer !== null || this.inFlight) return;
		const wait = Math.max(0, this.throttleMs - (Date.now() - this.lastSentAt));
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, wait);
		this.flushTimer.unref?.();
	}

	private async flush(): Promise<void> {
		if (this.inFlight || !this.dirty) return;
		this.inFlight = true;
		this.dirty = false;
		const line = this.latestLine;
		try {
			if (this.statusMessageId === null) {
				const { messageId } = await this.deps.sendForId(line);
				this.statusMessageId = messageId;
			} else {
				await this.deps.edit(this.statusMessageId, line);
			}
		} catch (err) {
			// self-heal: the anchor is gone (deleted / edit rejected) — drop it and
			// re-send a fresh one carrying the latest line on the next flush.
			this.log(`TIV status send failed (self-healing): ${errMsg(err)}`);
			if (this.statusMessageId !== null) {
				this.statusMessageId = null;
				this.dirty = true; // force a re-send of the latest line
			}
		} finally {
			this.lastSentAt = Date.now();
			this.inFlight = false;
			// a newer line landed while we were in flight — schedule again so it is
			// never lost and never overwritten by a stale line (single-flight +
			// latest-line-wins is immune to stale writes).
			if (this.dirty) this.scheduleFlush();
		}
	}
}

function errMsg(err: unknown): string {
	return String((err as Error)?.message ?? err);
}
