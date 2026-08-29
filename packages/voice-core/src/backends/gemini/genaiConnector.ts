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

			const session = await client.live.connect({
				model: params.model,
				config,
				callbacks: {
					onmessage: (msg: any) =>
						mapMessage(msg, (e) => {
							if (e.type === "tool-call") callNames.set(e.callId, e.name);
							onEvent(e);
						}),
					onerror: (e: any) =>
						onEvent({ type: "error", message: String(e?.message ?? e) }),
					onclose: (e: any) => {
						// plan r2 §3: ws disconnects must surface explicitly. Only an
						// intentional close() (or a server goAway already surfaced) is silent.
						if (!intentionalClose) {
							onEvent({
								type: "error",
								message: describeUnexpectedClose(e?.reason, params.model),
							});
						}
					},
				},
			});

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
