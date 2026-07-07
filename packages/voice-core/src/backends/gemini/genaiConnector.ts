/**
 * genaiConnector — the REAL @google/genai Live transport (converse face). Kept
 * separate from index.ts and dynamically imported, so the package builds and its
 * tests run without the SDK installed (CI uses the mock transport).
 *
 * ⚠️ S0.2-PENDING: the exact SDK message → LiveServerEvent mapping below is
 * written to the documented @google/genai Live shape (research.md r2: connect-
 * time sessionResumption, dual-side transcription, toolCallCancellation) but has
 * NOT yet been verified against a live session (needs GEMINI_API_KEY — plan.md
 * r2 §4 S0.2). Treat as best-effort until evidence/poc-converse.md confirms it.
 * The tested contract is GeminiLiveBackend against the injectable transport.
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
			const config: any = {
				responseModalities: [Modality.AUDIO],
				outputAudioTranscription: {},
				inputAudioTranscription: {},
				sessionResumption: params.resumeHandle
					? { handle: params.resumeHandle }
					: {},
				tools: [
					{
						functionDeclarations: [{ name: params.toolNames[0] ?? "ask_lead" }],
					},
				],
			};
			if (params.systemHint) {
				config.systemInstruction = { parts: [{ text: params.systemHint }] };
			}

			const session = await client.live.connect({
				model: params.model,
				config,
				callbacks: {
					onmessage: (msg: any) => mapMessage(msg, onEvent),
					onerror: (e: any) =>
						onEvent({ type: "error", message: String(e?.message ?? e) }),
					onclose: (e: any) => {
						// plan r2 §3: ws disconnects must surface explicitly. Only an
						// intentional close() (or a server goAway already surfaced) is silent.
						if (!intentionalClose) {
							onEvent({
								type: "error",
								message: `Gemini Live connection closed unexpectedly${e?.reason ? `: ${e.reason}` : ""}`,
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
				sendToolResponse(callId: string, output: string) {
					session.sendToolResponse({
						functionResponses: [
							{ id: callId, name: "ask_lead", response: { output } },
						],
					});
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

/** Map one @google/genai LiveServerMessage to zero-or-more LiveServerEvents. */
function mapMessage(msg: any, emit: (e: LiveServerEvent) => void): void {
	const sc = msg?.serverContent;
	if (sc?.interrupted) emit({ type: "interrupted" });
	if (sc?.inputTranscription?.text) {
		emit({
			type: "transcript",
			role: "user",
			text: sc.inputTranscription.text,
			final: !!sc.turnComplete,
		});
	}
	if (sc?.outputTranscription?.text) {
		emit({
			type: "transcript",
			role: "assistant",
			text: sc.outputTranscription.text,
			final: !!sc.turnComplete,
		});
	}
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
