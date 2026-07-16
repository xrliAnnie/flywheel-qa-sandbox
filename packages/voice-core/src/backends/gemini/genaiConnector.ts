/**
 * genaiConnector — the REAL @google/genai Live transport (converse face). Kept
 * separate from index.ts and dynamically imported, so the package builds and its
 * tests run without the SDK installed (CI uses the mock transport).
 *
 * The SDK message → LiveServerEvent mapping below is live-verified (FLY-543
 * real-machine QA, evidence/poc-converse.md). The tested contract is
 * GeminiLiveBackend against the injectable transport.
 */
import { Buffer } from "node:buffer";
import type {
	GeminiLiveTransport,
	LiveConnection,
	LiveConnectParams,
	LiveServerEvent,
} from "./transport.js";

export interface GenaiConnectorOptions {
	apiKey: string;
	/**
	 * connect() retry/backoff (FLY-545 QA R2 F1): the meeting-assembly burst
	 * (N Discord voice joins + N Gemini connects in one window) can starve the
	 * ws handshake — a transient abort on FIRST connect must not kill the whole
	 * meeting. Default ON: 3 attempts, 250ms exponential base, 8s per-attempt
	 * timeout (Codex R13: the SDK's live.connect() stays PENDING when the ws
	 * handshake dies — its failure surfaces via callbacks, never a rejection —
	 * so a bare promise-retry would wait forever). attempts:1 disables retries.
	 */
	retry?: { attempts?: number; baseMs?: number; attemptTimeoutMs?: number };
}

/**
 * Build a transport backed by @google/genai. Import is dynamic + `any`-typed so
 * this module type-checks and the package builds without the dependency present.
 */
export function createGenaiTransport(
	opts: GenaiConnectorOptions,
): GeminiLiveTransport {
	return {
		async connect(params: LiveConnectParams): Promise<LiveConnection> {
			let genai: any;
			try {
				genai = await import("@google/genai");
			} catch (err) {
				throw new Error(
					"@google/genai is not installed — `pnpm add @google/genai` in packages/voice-core to use the real Gemini Live transport",
					{ cause: err },
				);
			}
			const { GoogleGenAI, Modality } = genai;
			const client = new GoogleGenAI({ apiKey: opts.apiKey });

			let onEvent: (e: LiveServerEvent) => void = () => {};
			let intentionalClose = false;
			// callId → declared tool name, so function-responses echo the exact
			// name the model called (was hardcoded "ask_lead").
			const callNames = new Map<string, string>();
			const config: any = {
				responseModalities: [Modality.AUDIO],
				outputAudioTranscription: {},
				inputAudioTranscription: {},
				sessionResumption: params.resumeHandle
					? { handle: params.resumeHandle }
					: {},
				tools: [
					{
						functionDeclarations: params.tools.map((t) => ({
							name: t.name,
							description: t.description,
							parameters: t.parameters,
						})),
					},
				],
			};
			// FLY-967 round-5 (Annie's call — barge-in switch, default ON):
			// bargeIn=false pins NO_INTERRUPTION so a live response cannot be
			// cancelled by server VAD — for SPEAKER users, whose mic echoes the
			// assistant's own audio back and every reply died ~0.3s in (round-4).
			// ON/unset = the SDK's native START_OF_ACTIVITY_INTERRUPTS: headphone
			// users get real voice barge-in. The string literal IS the
			// @google/genai ActivityHandling enum value (verified against 1.44.0).
			if (params.bargeIn === false) {
				config.realtimeInputConfig = { activityHandling: "NO_INTERRUPTION" };
			}
			// FLY-967: briefing preamble composes BEFORE the spoken-register hint.
			const instruction = [params.systemPreamble, params.systemHint]
				.filter((s): s is string => !!s)
				.join("\n\n");
			if (instruction) {
				config.systemInstruction = { parts: [{ text: instruction }] };
			}
			if (params.voice) {
				// voiceName only — native-audio Live models pick the language
				// themselves and reject an explicit languageCode (FLY-967 R1 #3).
				config.speechConfig = {
					voiceConfig: { prebuiltVoiceConfig: { voiceName: params.voice } },
				};
			}

			const attempts = Math.max(1, opts.retry?.attempts ?? 3);
			const baseMs = opts.retry?.baseMs ?? 250;
			const attemptTimeoutMs = opts.retry?.attemptTimeoutMs ?? 8_000;
			// Every attempt gets its OWN abandoned flag captured by its callbacks
			// (Codex R14 HIGH-1): a timed-out attempt that settles late is closed
			// as an orphan — without the flag its onclose fired a FAKE
			// connectionClosed into the healthy winner's event stream and
			// triggered a pointless rotation. The SDK session is `any`-typed on
			// purpose (dynamic import).
			const session: any = await connectWithRetry(
				attempts,
				baseMs,
				attemptTimeoutMs,
				() => {
					const attempt = { abandoned: false };
					const promise = client.live.connect({
						model: params.model,
						config,
						callbacks: {
							onmessage: (msg: any) => {
								if (attempt.abandoned) return;
								mapMessage(msg, (e) => {
									if (e.type === "tool-call") callNames.set(e.callId, e.name);
									onEvent(e);
								});
							},
							onerror: (e: any) => {
								if (attempt.abandoned) return;
								onEvent({ type: "error", message: String(e?.message ?? e) });
							},
							onclose: (e: any) => {
								// plan r2 §3: ws disconnects must surface explicitly. Only an
								// intentional close() (or a server goAway already surfaced) is
								// silent. connectionClosed lets the rotator auto-reconnect
								// (FLY-545 QA R2 F1) — this is connection DEATH, not a protocol
								// hiccup. An abandoned attempt's close is never surfaced.
								if (attempt.abandoned || intentionalClose) return;
								onEvent({
									type: "error",
									message: describeUnexpectedClose(e?.reason, params.model),
									connectionClosed: true,
								});
							},
						},
					});
					return { promise, attempt };
				},
			);

			return {
				sendAudio(frame: Buffer) {
					session.sendRealtimeInput({
						audio: {
							data: frame.toString("base64"),
							mimeType: "audio/pcm;rate=16000",
						},
					});
				},
				sendText(text: string) {
					session.sendRealtimeInput({ text });
				},
				injectContext(text: string) {
					// FLY-968 B-cell: the one injection path measured to add
					// context with 0 bytes of speech on gemini-3.1.
					session.sendClientContent({
						turns: [{ role: "user", parts: [{ text }] }],
						turnComplete: false,
					});
				},
				endAudioStream() {
					session.sendRealtimeInput({ audioStreamEnd: true });
				},
				sendToolResponse(callId: string, output: string) {
					session.sendToolResponse({
						functionResponses: [
							{
								id: callId,
								name:
									callNames.get(callId) ?? params.tools[0]?.name ?? "ask_lead",
								response: { output },
							},
						],
					});
					callNames.delete(callId);
				},
				onEvent(cb) {
					onEvent = cb;
				},
				async close() {
					intentionalClose = true;
					session.close();
				},
			};
		},
	};
}

/** Map one @google/genai LiveServerMessage to zero-or-more LiveServerEvents.
 *
 * FLY-1065 emit-order contract, ROLE-AWARE around `interrupted` (Codex R1 #5
 * + delta review R1): in an interrupted frame the OUTPUT transcript belongs
 * to the OLD generation — it must be appended into the turn buffer before the
 * interrupted flush or the half-line is swallowed by cancel suppression —
 * while the INPUT transcript is her NEW words that caused the barge-in: it
 * must land AFTER `interrupted`, or its cancel-window reset would be clobbered
 * by the cancel and the next assistant answer suppressed. Frames without
 * `interrupted` keep the input-before-output order. `final` keeps its legacy
 * `!!turnComplete` computation (a dead signal the session no longer relies
 * on; kept for transport type compat). */
function mapMessage(msg: any, emit: (e: LiveServerEvent) => void): void {
	const sc = msg?.serverContent;
	const emitInput = () => {
		if (sc?.inputTranscription?.text) {
			emit({
				type: "transcript",
				role: "user",
				text: sc.inputTranscription.text,
				final: !!sc.turnComplete,
				finished: sc.inputTranscription.finished === true,
			});
		}
	};
	if (!sc?.interrupted) emitInput();
	if (sc?.outputTranscription?.text) {
		emit({
			type: "transcript",
			role: "assistant",
			text: sc.outputTranscription.text,
			final: !!sc.turnComplete,
			finished: sc.outputTranscription.finished === true,
		});
	}
	if (sc?.interrupted) emit({ type: "interrupted" });
	const parts = sc?.modelTurn?.parts ?? [];
	for (const p of parts) {
		if (p?.inlineData?.data) {
			emit({
				type: "audio",
				chunk: Buffer.from(p.inlineData.data, "base64"),
				format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
			});
		}
	}
	// interrupted frame: her new words come LAST of the old-generation events —
	// after `interrupted` (so the cancel-window reset survives the cancel) AND
	// after the frame's audio (also the old generation's — the reset must not
	// un-suppress it into the next turn's first output; delta review R2).
	if (sc?.interrupted) emitInput();
	if (sc?.generationComplete) emit({ type: "generation-complete" });
	if (sc?.turnComplete) emit({ type: "turn-complete" });
	if (msg?.toolCall?.functionCalls) {
		for (const fc of msg.toolCall.functionCalls) {
			emit({ type: "tool-call", callId: fc.id, name: fc.name, args: fc.args });
		}
	}
	if (msg?.toolCallCancellation?.ids) {
		emit({
			type: "tool-call-cancellation",
			callIds: msg.toolCallCancellation.ids,
		});
	}
	if (msg?.sessionResumptionUpdate?.newHandle) {
		emit({
			type: "resumption-update",
			handle: msg.sessionResumptionUpdate.newHandle,
		});
	}
	if (msg?.goAway?.timeLeft) {
		emit({ type: "go-away", timeLeftSec: secondsFrom(msg.goAway.timeLeft) });
	}
}

function secondsFrom(timeLeft: any): number {
	if (typeof timeLeft === "number") return timeLeft;
	if (typeof timeLeft === "string") {
		const m = timeLeft.match(/([\d.]+)s/);
		if (m) return Math.round(Number(m[1]));
	}
	return 0;
}

/** Human-actionable message for an unexpected ws close. A "model not found"
 * reason gets self-rescue guidance (FLY-959 bug 4: Google retires preview
 * models; the next 404 should cost the user 30 seconds, not a debug session). */
/** Exponential-backoff retry for the initial ws handshake (FLY-545 QA R2 F1).
 * Every failure is treated as retryable — at connect time there is no session
 * to protect, and the terminal attempt rethrows the real error.
 *
 * Codex R13 HIGH: the SDK's live.connect() does NOT reject on a failed ws
 * handshake — it stays pending while the failure goes to onerror/onclose. So
 * each attempt races a timeout; an abandoned attempt that later resolves gets
 * its session closed immediately (never leak a half-open connection). */
async function connectWithRetry<T>(
	attempts: number,
	baseMs: number,
	attemptTimeoutMs: number,
	connect: () => { promise: Promise<T>; attempt: { abandoned: boolean } },
): Promise<T> {
	let lastErr: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return await attemptWithTimeout(connect, attemptTimeoutMs);
		} catch (err) {
			lastErr = err;
			if (i < attempts - 1) {
				await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
			}
		}
	}
	throw lastErr;
}

async function attemptWithTimeout<T>(
	connect: () => { promise: Promise<T>; attempt: { abandoned: boolean } },
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const { promise: pending, attempt } = connect();
	try {
		return await Promise.race([
			pending,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					// mark FIRST: from this instant the attempt's callbacks are
					// muted (Codex R14 HIGH-1 — its later close must never inject
					// a fake connectionClosed into the winner's event stream).
					attempt.abandoned = true;
					reject(
						new Error(
							`Gemini connect timed out after ${timeoutMs}ms (ws handshake starved)`,
						),
					);
				}, timeoutMs);
				timer.unref?.();
			}),
		]);
	} catch (err) {
		// EVERY failed attempt is abandoned, not just timeouts (Codex R15):
		// some SDK failure modes reject the promise and STILL fire a late
		// onclose from the dying socket — that close must stay muted too.
		attempt.abandoned = true;
		throw err;
	} finally {
		if (timer) clearTimeout(timer);
		if (attempt.abandoned) {
			// the SDK promise may still settle later — close the orphan session
			// so a lost race never leaves a half-open ws behind.
			void pending.then((s: any) => s?.close?.()).catch(() => undefined);
		}
	}
}

export function describeUnexpectedClose(
	reason: string | undefined,
	model: string,
): string {
	const base = `Gemini Live connection closed unexpectedly${reason ? `: ${reason}` : ""}`;
	if (
		reason &&
		/is not found for API version|not supported for bidiGenerateContent/i.test(
			reason,
		)
	) {
		return `${base} — the configured model "${model}" looks retired/renamed; set FLYWHEEL_VOICE_GEMINI_MODEL to a live model (verify with client.models.list(); snapshot: packages/voice-core/evidence/real-live-models-list.json)`;
	}
	return base;
}
