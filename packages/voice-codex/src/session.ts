import { randomUUID } from "node:crypto";
import { scrubTranscript } from "flywheel-voice-core";
import type { VoiceSessionProjection } from "./bridge-client.js";
import type { ActiveVoiceSession, VoiceEnd } from "./daemon.js";
import type { CapturedTranscript } from "./delivery.js";
import { stripForSpeech } from "./speech.js";

export interface FrontendHandlers {
	onTranscript(input: { role: "user" | "assistant"; text: string }): void;
	onAudio(frame: Buffer): void;
	onClosed(reason: string): void;
	onFrontendDelegation(input: { itemId: string }): void;
}

export interface RoomHandlers {
	onAudio(frame: Buffer): void;
	onFounderPresence(present: boolean): void;
	onError(error: Error): void;
}

interface FrontendLike {
	start(): Promise<void>;
	appendAudio(frame: Buffer): void;
	appendSpeech(text: string): Promise<void>;
	stop(): Promise<void>;
}

interface RoomLike {
	start(): Promise<{ founderPresent: boolean }>;
	speaker(): { userId: string; name: string } | null;
	feedOutputAudio(frame: Buffer): void;
	finishOutputAudio(): void;
	flushOutputAudio(): void;
	status(text: string): Promise<void>;
	stop(): Promise<void>;
	setBedEnabled?(enabled: boolean): void;
	setWaiting?(waiting: boolean): void;
}

export interface GenericVoiceSessionOptions {
	projection: VoiceSessionProjection;
	delivery: { capture(input: CapturedTranscript): Promise<boolean> | boolean };
	createFrontend(handlers: FrontendHandlers): FrontendLike;
	createRoom(handlers: RoomHandlers): RoomLike;
	lifecycle(
		state: "ready" | "live" | "interrupted" | "ended",
		reason?: string,
	): Promise<void> | void;
	evidence(record: Record<string, unknown>): void;
	confirmationMs: number;
	now?: () => Date;
	cleanup?(): void;
	assertLease?(): void;
	postStatus?(text: string): Promise<void>;
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
} {
	let resolve!: (value: T) => void;
	return {
		promise: new Promise<T>((done) => {
			resolve = done;
		}),
		resolve,
	};
}

function normalized(value: string): string {
	return stripForSpeech(value).normalize("NFKC").replace(/\s+/gu, "");
}

export class GenericVoiceSession implements ActiveVoiceSession {
	private readonly frontend: FrontendLike;
	private readonly room: RoomLike;
	private readonly founder = deferred<boolean>();
	private readonly ended = deferred<VoiceEnd>();
	private readonly now: () => Date;
	private live = false;
	private stopping = false;
	private pendingSpeech?: {
		normalized: string;
		resolve(status: "confirmed" | "unconfirmed" | "failed"): void;
		timer: ReturnType<typeof setTimeout>;
	};

	constructor(private readonly options: GenericVoiceSessionOptions) {
		this.now = options.now ?? (() => new Date());
		this.frontend = options.createFrontend({
			onTranscript: (input) => this.transcript(input),
			onAudio: (frame) => this.guarded(() => this.room.feedOutputAudio(frame)),
			onClosed: (reason) => this.finish({ kind: "failed", reason }),
			onFrontendDelegation: ({ itemId }) =>
				this.options.evidence({
					ts: this.now().toISOString(),
					kind: "frontend_delegation",
					itemId,
				}),
		});
		this.room = options.createRoom({
			onAudio: (frame) => this.guarded(() => this.frontend.appendAudio(frame)),
			onFounderPresence: (present) => this.founderPresence(present),
			onError: (error) =>
				this.finish({
					kind: "failed",
					reason: `discord_audio:${error.message}`,
				}),
		});
	}

	async start(): Promise<{ founderPresent: boolean }> {
		if (this.stopping) throw new Error("voice_session_stopped");
		this.options.assertLease?.();
		await this.frontend.start();
		if (this.stopping) {
			await this.frontend.stop();
			throw new Error("voice_session_stopped");
		}
		this.options.assertLease?.();
		const result = await this.room.start();
		if (this.stopping) {
			await this.room.stop();
			throw new Error("voice_session_stopped");
		}
		if (result.founderPresent) this.founder.resolve(true);
		await this.options.lifecycle("ready");
		return result;
	}

	async waitForFounder(timeoutMs: number): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.founder.promise,
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), timeoutMs);
					timer.unref?.();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async markLive(): Promise<void> {
		this.live = true;
		await this.options.lifecycle("live");
	}

	waitForEnd(): Promise<VoiceEnd> {
		return this.ended.promise;
	}

	requestEnd(outcome: VoiceEnd): void {
		this.finish(outcome);
	}

	async speak(text: string): Promise<"confirmed" | "unconfirmed" | "failed"> {
		if (this.pendingSpeech) return "failed";
		this.room.setWaiting?.(false);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pendingSpeech = undefined;
				resolve("unconfirmed");
			}, this.options.confirmationMs);
			timer.unref?.();
			this.pendingSpeech = { normalized: normalized(text), resolve, timer };
			void this.frontend.appendSpeech(text).catch(() => {
				if (this.pendingSpeech?.timer !== timer) return;
				clearTimeout(timer);
				this.pendingSpeech = undefined;
				resolve("failed");
			});
		});
	}

	async stop(outcome?: VoiceEnd): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		if (this.pendingSpeech) {
			clearTimeout(this.pendingSpeech.timer);
			this.pendingSpeech.resolve("failed");
			this.pendingSpeech = undefined;
		}
		try {
			if (outcome) {
				await this.options.lifecycle(
					outcome.kind === "ended" ? "ended" : "interrupted",
					outcome.reason,
				);
			}
		} finally {
			this.room.flushOutputAudio();
			await this.room.stop().catch(() => undefined);
			await this.frontend.stop().catch(() => undefined);
			this.options.cleanup?.();
		}
	}

	private founderPresence(present: boolean): void {
		if (present) {
			this.founder.resolve(true);
		} else if (this.live) {
			this.finish({ kind: "ended", reason: "she-left" });
		}
	}

	private transcript(input: {
		role: "user" | "assistant";
		text: string;
	}): void {
		if (this.stopping) return;
		if (input.role === "assistant") {
			this.room.finishOutputAudio();
			const safeText = Array.from(scrubTranscript(input.text).trim())
				.slice(0, 1_800)
				.join("");
			if (safeText) {
				this.options.evidence({
					ts: this.now().toISOString(),
					kind: "realtime_transcript",
					role: "assistant",
					generation: 1,
					text: safeText,
				});
			}
			const pending = this.pendingSpeech;
			if (pending && normalized(safeText) === pending.normalized) {
				clearTimeout(pending.timer);
				this.pendingSpeech = undefined;
				pending.resolve("confirmed");
				this.status("📻 已念完");
				return;
			}
			if (safeText) {
				this.options.evidence({
					ts: this.now().toISOString(),
					kind: "frontend_utterance",
					text: safeText,
				});
				this.status(`🤖(前台自言) ${safeText}`);
			}
			return;
		}
		if (!this.live) return;
		const speaker = this.room.speaker();
		if (!speaker) {
			const text = scrubTranscript(input.text).trim();
			if (text) {
				this.options.evidence({
					ts: this.now().toISOString(),
					kind: "realtime_transcript",
					role: "user",
					generation: 1,
					text,
				});
				this.status("📻 有一句话没能确认说话人，请再说一遍");
			}
			return;
		}
		const command = input.text.normalize("NFKC").replace(/\s+/gu, "");
		if (speaker.userId === this.options.projection.founderUserId) {
			if (command === "退出语音模式") {
				this.finish({ kind: "ended", reason: "voice-stop" });
				return;
			}
			if (command === "等待音关掉" || command === "等待音打开") {
				this.room.setBedEnabled?.(command.endsWith("打开"));
				return;
			}
		}
		this.room.setWaiting?.(true);
		void Promise.resolve(
			this.options.delivery.capture({
				transcriptId: randomUUID(),
				speakerUserId: speaker.userId,
				speakerName: speaker.name,
				rawText: input.text,
				ts: this.now().toISOString(),
			}),
		)
			.then((delivered) => {
				if (delivered)
					this.status(`📻 已转达，${this.options.projection.displayName} 在想`);
			})
			.catch((error) =>
				this.finish({
					kind: "failed",
					reason: `delivery_failed:${(error as Error).message}`,
				}),
			);
	}

	private status(text: string): void {
		void (this.options.postStatus ?? ((value) => this.room.status(value)))(
			text,
		).catch((error) =>
			this.options.evidence({
				ts: this.now().toISOString(),
				kind: "status_failed",
				reason: (error as Error).message,
			}),
		);
	}

	private finish(outcome: VoiceEnd): void {
		this.ended.resolve(outcome);
	}

	private guarded(effect: () => void): void {
		if (this.stopping) return;
		try {
			this.options.assertLease?.();
			effect();
		} catch {
			this.finish({ kind: "failed", reason: "lease_lost" });
		}
	}
}
