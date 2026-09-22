import { afterEach, describe, expect, it } from "vitest";
import { RealtimeFrontend } from "../realtime.js";
import { prepareReplySpeech } from "../speech.js";

const LIVE_READBACK_TEXTS = [
	"Acorn. I heard you clearly, the voice preflight is working.",
	"好的，我听见你了。收音链路已经恢复正常。",
	"Understood. I will look into the deployment and report back shortly.",
] as const;
const apiKey = process.env.OPENAI_API_KEY;
const liveIt = apiKey ? it : it.skip;
const clients: RealtimeFrontend[] = [];

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe("live OpenAI Realtime readback contract", () => {
	liveIt.each(LIVE_READBACK_TEXTS)(
		apiKey
			? "returns verbatim=true for %s"
			: "SKIP: OPENAI_API_KEY unavailable — %s",
		async (text) => {
			if (!apiKey) return;
			const speeches = prepareReplySpeech(text);
			expect(speeches).toHaveLength(1);
			const speech = speeches[0]!;
			const speechId = speech.speechId;
			let settle!: (outcome: { verbatim: boolean; reason?: string }) => void;
			const outcome = new Promise<{ verbatim: boolean; reason?: string }>(
				(resolve) => {
					settle = resolve;
				},
			);
			const client = new RealtimeFrontend({
				apiKey,
				voice: "marin",
				displayName: "Raya",
				minimumSessionLifetimeMs: 0,
				onTranscript: () => {},
				onEvidence: (record) => {
					if (
						record.kind === "realtime_output_validated" &&
						record.speechId === speechId
					)
						settle({ verbatim: true });
				},
				onSpeechResult: (result) => {
					if (result.speechId === speechId)
						settle({ verbatim: false, reason: result.reason });
				},
				onClosed: (result) =>
					settle({ verbatim: false, reason: result.reason }),
			});
			clients.push(client);
			await client.start();
			await client.appendSpeech(speech);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timedOutcome = await Promise.race([
				outcome,
				new Promise<{ verbatim: false; reason: string }>((resolve) => {
					timer = setTimeout(
						() => resolve({ verbatim: false, reason: "live_readback_timeout" }),
						70_000,
					);
				}),
			]);
			if (timer) clearTimeout(timer);
			expect(timedOutcome).toEqual({ verbatim: true });
		},
		90_000,
	);
});
