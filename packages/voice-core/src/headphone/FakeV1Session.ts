import type {
	SpeakKind,
	SpeakReceipt,
	SpeakVerification,
	VoiceUtterance,
	VoiceV1Capabilities,
	VoiceV1Session,
} from "../types.js";
import { speakRequestDigest } from "./speak-request.js";

export interface FakeSpeakCall {
	text: string;
	kind: SpeakKind;
	pendingKey: string;
	verification: SpeakVerification;
	requestDigest: string;
}

export interface FakeV1SessionOptions {
	sessionId?: string;
	generation?: number;
	backendId?: string;
	capabilities?: Partial<VoiceV1Capabilities>;
	respond?(call: FakeSpeakCall): Promise<SpeakReceipt> | SpeakReceipt;
}

/** Complete V1 fake: it supports utterances, request-bound speak receipts,
 * open/close, initial context, and silent context injection. */
export class FakeV1Session implements VoiceV1Session {
	readonly sessionId: string;
	readonly generation: number;
	readonly backendId: string;
	readonly capabilities: VoiceV1Capabilities;
	readonly speakCalls: FakeSpeakCall[] = [];
	readonly injectedContexts: string[] = [];
	initialSessionContext?: string;
	opened = false;
	closed = false;
	private readonly listeners = new Set<(utterance: VoiceUtterance) => void>();
	private readonly pending = new Map<
		string,
		{ digest: string; promise: Promise<SpeakReceipt> }
	>();

	constructor(private readonly options: FakeV1SessionOptions = {}) {
		this.sessionId = options.sessionId ?? "fake-session";
		this.generation = options.generation ?? 1;
		this.backendId = options.backendId ?? "fake-v1";
		this.capabilities = {
			audioIn: [{ encoding: "pcm16", sampleRateHz: 24_000, channels: 1 }],
			audioOut: [{ encoding: "pcm16", sampleRateHz: 24_000, channels: 1 }],
			onUtterance: true,
			verbatim: true,
			attribution: true,
			turnCancelOrSuppress: true,
			...options.capabilities,
		};
	}

	async open(initialSessionContext: string): Promise<void> {
		if (this.opened && !this.closed) throw new Error("voice_v1_already_open");
		if (!initialSessionContext) throw new Error("voice_v1_context_required");
		this.initialSessionContext = initialSessionContext;
		this.opened = true;
		this.closed = false;
	}

	speak(
		text: string,
		kind: SpeakKind,
		opts: { pendingKey: string; verification: SpeakVerification },
	): Promise<SpeakReceipt> {
		const requestDigest = speakRequestDigest({
			sessionId: this.sessionId,
			generation: this.generation,
			text,
			kind,
			verification: opts.verification,
		});
		const call = { text, kind, ...opts, requestDigest };
		const prior = this.pending.get(opts.pendingKey);
		if (prior) {
			if (prior.digest === requestDigest) return prior.promise;
			return Promise.resolve({
				pendingKey: opts.pendingKey,
				requestDigest,
				outcome: "rejected",
				reason: "pending_key_conflict",
				transport: "none",
				contentProof: "none",
			});
		}
		this.speakCalls.push(call);
		let promise: Promise<SpeakReceipt>;
		if (!this.opened || this.closed) {
			promise = Promise.resolve({
				pendingKey: opts.pendingKey,
				requestDigest,
				outcome: "rejected",
				reason: "not_live",
				transport: "none",
				contentProof: "none",
			});
		} else {
			const response =
				this.options.respond?.(call) ??
				({
					pendingKey: opts.pendingKey,
					requestDigest,
					outcome: "completed",
					transport: "submitted",
					contentProof: "deterministic_tts",
				} satisfies SpeakReceipt);
			promise = Promise.resolve(response).then((receipt): SpeakReceipt => {
				if (
					opts.verification === "required" &&
					receipt.outcome === "completed" &&
					receipt.contentProof === "none"
				) {
					return {
						pendingKey: opts.pendingKey,
						requestDigest,
						outcome: "failed",
						reason: "content_proof_required",
						transport: "submitted",
						contentProof: "none",
					};
				}
				return receipt;
			});
		}
		this.pending.set(opts.pendingKey, { digest: requestDigest, promise });
		return promise;
	}

	onUtterance(listener: (utterance: VoiceUtterance) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emitUtterance(utterance: VoiceUtterance): void {
		for (const listener of this.listeners) listener(utterance);
	}

	injectContext(text: string): void {
		if (!this.opened || this.closed) throw new Error("voice_v1_not_live");
		this.injectedContexts.push(text);
	}

	async close(): Promise<void> {
		this.closed = true;
		this.listeners.clear();
	}
}
