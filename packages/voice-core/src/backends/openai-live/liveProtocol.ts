import type { AudioFormat } from "../../types.js";
import { VoiceError } from "../../types.js";

export const OPENAI_LIVE_AUDIO_FORMAT: AudioFormat = {
	encoding: "pcm16",
	sampleRateHz: 24_000,
	channels: 1,
};

export interface OpenAiLiveSessionConfig {
	model: string;
	instructions: string;
	voice: string;
	delegation: "client";
	audio: AudioFormat;
}

export type OpenAiLiveClientEvent =
	| {
			type: "session.start";
			event_id: string;
			session: {
				model: string;
				instructions: string;
				audio: {
					format: { type: "audio/pcm"; rate: number };
					output: { voice: string };
				};
				delegation: { type: "client" };
			};
	  }
	| {
			type: "session.input_audio.append";
			event_id: string;
			audio: string;
	  }
	| {
			type: "session.commentary.append";
			event_id: string;
			delegation_id: string | null;
			content: string;
	  }
	| {
			type: "session.thinking.append";
			event_id: string;
			delegation_id: null;
			content: string;
	  }
	| { type: "session.close"; event_id: string };

export type OpenAiLiveServerEvent =
	| {
			type: "session-started";
			eventId?: string;
			sessionId: string;
			model: string;
			status: string;
			audio: { type: string; rate: number };
			delegation: string;
	  }
	| { type: "output-audio"; chunk: Buffer; format: AudioFormat }
	| {
			type: "transcript-delta";
			direction: "input" | "output";
			eventId?: string;
			startMs: number;
			endMs: number;
			delta: string;
	  }
	| {
			type: "delegation-created";
			delegationId: string;
			target: "client";
			offsetMs?: number;
	  }
	| { type: "session-closed" }
	| { type: "server-error"; message: string }
	| { type: "ignored"; serverType: string };

type JsonObject = Record<string, unknown>;

function protocolError(message: string, cause?: unknown): VoiceError {
	return new VoiceError("backend-protocol", `openai-live: ${message}`, cause);
}

function object(value: unknown, label: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw protocolError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw protocolError(`${label} must be a non-empty string`);
	}
	return value;
}

function finiteNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw protocolError(`${label} must be a finite number`);
	}
	return value;
}

function assertPcm24kMono(format: AudioFormat): void {
	if (
		format.encoding !== OPENAI_LIVE_AUDIO_FORMAT.encoding ||
		format.sampleRateHz !== OPENAI_LIVE_AUDIO_FORMAT.sampleRateHz ||
		format.channels !== OPENAI_LIVE_AUDIO_FORMAT.channels
	) {
		throw protocolError("audio format must be PCM16 mono 24 kHz");
	}
}

export function buildSessionStart(
	config: OpenAiLiveSessionConfig,
	eventId: string,
): OpenAiLiveClientEvent {
	assertPcm24kMono(config.audio);
	if (config.delegation !== "client") {
		throw protocolError("delegation must be client");
	}
	return {
		type: "session.start",
		event_id: string(eventId, "eventId"),
		session: {
			model: string(config.model, "model"),
			instructions: string(config.instructions, "instructions"),
			audio: {
				format: { type: "audio/pcm", rate: config.audio.sampleRateHz },
				output: { voice: string(config.voice, "voice") },
			},
			delegation: { type: "client" },
		},
	};
}

export function buildInputAudioAppend(
	chunk: Buffer,
	eventId: string,
): OpenAiLiveClientEvent {
	if (chunk.length === 0) throw protocolError("audio chunk must not be empty");
	return {
		type: "session.input_audio.append",
		event_id: string(eventId, "eventId"),
		audio: chunk.toString("base64"),
	};
}

export function buildCommentaryAppend(
	content: string,
	delegationId: string | null,
	eventId: string,
): OpenAiLiveClientEvent {
	return {
		type: "session.commentary.append",
		event_id: string(eventId, "eventId"),
		delegation_id:
			delegationId === null ? null : string(delegationId, "delegationId"),
		content: string(content, "content"),
	};
}

export function buildThinkingAppend(
	content: string,
	eventId: string,
): OpenAiLiveClientEvent {
	return {
		type: "session.thinking.append",
		event_id: string(eventId, "eventId"),
		delegation_id: null,
		content: string(content, "content"),
	};
}

export function buildSessionClose(eventId: string): OpenAiLiveClientEvent {
	return { type: "session.close", event_id: string(eventId, "eventId") };
}

function parseJson(raw: string | Buffer | JsonObject): JsonObject {
	if (typeof raw === "object" && !Buffer.isBuffer(raw)) {
		return object(raw, "server event");
	}
	try {
		return object(JSON.parse(raw.toString()), "server event");
	} catch (error) {
		if (error instanceof VoiceError) throw error;
		throw protocolError("server event is not valid JSON", error);
	}
}

function decodeBase64(value: unknown, label: string): Buffer {
	const encoded = string(value, label);
	if (
		encoded.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			encoded,
		)
	) {
		throw protocolError(`${label} must be canonical base64`);
	}
	const decoded = Buffer.from(encoded, "base64");
	if (decoded.toString("base64") !== encoded) {
		throw protocolError(`${label} must be canonical base64`);
	}
	return decoded;
}

export function parseLiveServerEvent(
	raw: string | Buffer | JsonObject,
): OpenAiLiveServerEvent {
	const event = parseJson(raw);
	const type = string(event.type, "server event type");
	switch (type) {
		case "session.started": {
			const session = object(event.session, "session.started.session");
			const audio = object(session.audio, "session.started.session.audio");
			const format = object(
				audio.format,
				"session.started.session.audio.format",
			);
			const delegation = object(
				session.delegation,
				"session.started.session.delegation",
			);
			return {
				type: "session-started",
				...(typeof event.event_id === "string"
					? { eventId: event.event_id }
					: {}),
				sessionId: string(session.id, "session.started.session.id"),
				model: string(session.model, "session.started.session.model"),
				status: string(session.status, "session.started.session.status"),
				audio: {
					type: string(
						format.type,
						"session.started.session.audio.format.type",
					),
					rate: finiteNumber(
						format.rate,
						"session.started.session.audio.format.rate",
					),
				},
				delegation: string(
					delegation.type,
					"session.started.session.delegation.type",
				),
			};
		}
		case "session.output_audio.delta":
			return {
				type: "output-audio",
				chunk: decodeBase64(event.delta, "session.output_audio.delta.delta"),
				format: OPENAI_LIVE_AUDIO_FORMAT,
			};
		case "session.input_transcript.delta":
		case "session.output_transcript.delta":
			return {
				type: "transcript-delta",
				direction: type.includes("input") ? "input" : "output",
				...(typeof event.event_id === "string"
					? { eventId: event.event_id }
					: {}),
				startMs: finiteNumber(event.start_ms, `${type}.start_ms`),
				endMs: finiteNumber(event.end_ms, `${type}.end_ms`),
				delta: string(event.delta, `${type}.delta`),
			};
		case "session.delegation.created": {
			const delegation = object(event.delegation, "session.delegation.created");
			const delegationType = string(delegation.type, "delegation.type");
			if (delegationType !== "delegation") {
				throw protocolError(
					`delegation type must be delegation, got ${delegationType}`,
				);
			}
			const target = string(delegation.target, "delegation.target");
			if (target !== "client") {
				throw protocolError(`delegation target must be client, got ${target}`);
			}
			return {
				type: "delegation-created",
				delegationId: string(delegation.id, "delegation.id"),
				target: "client",
				...(event.offset_ms === undefined
					? {}
					: {
							offsetMs: finiteNumber(
								event.offset_ms,
								"session.delegation.created.offset_ms",
							),
						}),
			};
		}
		case "session.closed":
			return { type: "session-closed" };
		case "error":
		case "session.error": {
			const nested =
				event.error && typeof event.error === "object"
					? (event.error as JsonObject)
					: undefined;
			return {
				type: "server-error",
				message:
					typeof nested?.message === "string"
						? nested.message
						: typeof event.message === "string"
							? event.message
							: "unknown server error",
			};
		}
		default:
			return { type: "ignored", serverType: type };
	}
}

export function assertStartedMatchesConfig(
	event: OpenAiLiveServerEvent,
	config: OpenAiLiveSessionConfig,
): asserts event is Extract<
	OpenAiLiveServerEvent,
	{ type: "session-started" }
> {
	if (event.type !== "session-started") {
		throw protocolError(`expected session.started, got ${event.type}`);
	}
	if (event.model !== config.model) {
		throw protocolError(
			`model mismatch: expected ${config.model}, got ${event.model}`,
		);
	}
	if (event.status !== "active") {
		throw protocolError(`session status must be active, got ${event.status}`);
	}
	if (
		event.audio.type !== "audio/pcm" ||
		event.audio.rate !== OPENAI_LIVE_AUDIO_FORMAT.sampleRateHz
	) {
		throw protocolError("server audio format must be PCM16 mono 24 kHz");
	}
	if (event.delegation !== "client") {
		throw protocolError(
			`delegation mismatch: expected client, got ${event.delegation}`,
		);
	}
}
