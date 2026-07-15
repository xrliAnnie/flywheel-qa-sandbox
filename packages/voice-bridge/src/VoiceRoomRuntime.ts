/**
 * VoiceRoomRuntime — shared single-VC room state for ALL voice modes
 * (FLY-1006 S5b). FLY-967 built the SessionSlot and the resident-ears frame
 * routing PRIVATELY inside the /gemini wiring; a second mode (/eleven) would
 * have duplicated both — two modes each believing they own the room (slot
 * mutex void) and double-subscribing the receiver. This lifts them into ONE
 * runtime owned by runVoiceBridge and injected into every mode wiring.
 *
 * Inbound surface (called by the physical ears wiring, wireRoomEars):
 * routeFrame / routeSpeakingEnd / routeBargeIn / fireDown / fireUp.
 * Consumer surface (mode wirings register for their live session):
 * onFrame / onSpeakingEnd / onBargeIn are SINGLE-SLOT — they reach only the
 * currently-registered (= active) session, and a stale unsubscribe never
 * clears a successor's registration; onDown / onUp fan out to every
 * subscriber. Both semantics are exactly the FLY-967 wiring's.
 */
import { SessionSlot } from "./SessionSlot.js";

export type RoomFrameCb = (frame: Buffer, format: unknown) => void;

export class VoiceRoomRuntime {
	readonly slot: SessionSlot;
	private frames: RoomFrameCb | null = null;
	private speakingStart: (() => void) | null = null;
	private speakingEnd: (() => void) | null = null;
	private bargeIn: (() => void) | null = null;
	private readonly downCbs = new Set<() => void>();
	private readonly upCbs = new Set<() => void>();

	constructor(slot: SessionSlot = new SessionSlot()) {
		this.slot = slot;
	}

	// ---- consumer surface (the active session's wiring registers) ----
	onFrame(cb: RoomFrameCb): () => void {
		this.frames = cb;
		return () => {
			if (this.frames === cb) this.frames = null;
		};
	}

	onSpeakingStart(cb: () => void): () => void {
		this.speakingStart = cb;
		return () => {
			if (this.speakingStart === cb) this.speakingStart = null;
		};
	}

	onSpeakingEnd(cb: () => void): () => void {
		this.speakingEnd = cb;
		return () => {
			if (this.speakingEnd === cb) this.speakingEnd = null;
		};
	}

	onBargeIn(cb: () => void): () => void {
		this.bargeIn = cb;
		return () => {
			if (this.bargeIn === cb) this.bargeIn = null;
		};
	}

	onDown(cb: () => void): () => void {
		this.downCbs.add(cb);
		return () => this.downCbs.delete(cb);
	}

	onUp(cb: () => void): () => void {
		this.upCbs.add(cb);
		return () => this.upCbs.delete(cb);
	}

	// ---- inbound surface (the physical ears wiring calls) ----
	routeFrame(frame: Buffer, format: unknown): void {
		this.frames?.(frame, format);
	}

	routeSpeakingStart(): void {
		this.speakingStart?.();
	}

	routeSpeakingEnd(): void {
		this.speakingEnd?.();
	}

	routeBargeIn(): void {
		this.bargeIn?.();
	}

	fireDown(): void {
		for (const cb of this.downCbs) cb();
	}

	fireUp(): void {
		for (const cb of this.upCbs) cb();
	}
}
