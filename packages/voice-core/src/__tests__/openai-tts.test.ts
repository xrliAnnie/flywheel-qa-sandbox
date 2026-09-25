import { describe, expect, it } from "vitest";
import { OpenAiTts } from "../backends/openai-tts/OpenAiTts.js";
import { VoiceError } from "../types.js";

function streamed(chunks: number[][]): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
				controller.close();
			},
		}),
		{ status: 200 },
	);
}

describe("OpenAiTts (FLY-2863 §5.2)", () => {
	it("asks for the Lead's GPT voice as raw PCM and yields whole 16-bit samples", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		let t = 0;
		const tts = new OpenAiTts({
			apiKey: "sk-test",
			now: () => {
				t += 5;
				return t;
			},
			fetchImpl: (async (url: string, init: RequestInit) => {
				calls.push({ url, init });
				return streamed([[1, 2, 3], [4, 5, 6, 7], [8]]);
			}) as unknown as typeof fetch,
		});
		const chunks = [];
		for await (const chunk of tts.synthesizeStream("两件事要你拍。", "marin", {
			signal: new AbortController().signal,
		}))
			chunks.push(chunk);
		expect(calls[0]?.url).toBe("https://api.openai.com/v1/audio/speech");
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			model: "gpt-4o-mini-tts",
			input: "两件事要你拍。",
			voice: "marin",
			response_format: "pcm",
		});
		expect(
			(calls[0]?.init.headers as Record<string, string>).Authorization,
		).toBe("Bearer sk-test");
		expect(chunks.map((chunk) => [...chunk.audio])).toEqual([
			[1, 2],
			[3, 4, 5, 6],
			[7, 8],
		]);
		expect(chunks.every((chunk) => chunk.format.sampleRateHz === 24_000)).toBe(
			true,
		);
		expect(chunks[0]?.ttsFirstByteMs).toBeGreaterThan(0);
		expect(chunks[1]?.ttsFirstByteMs).toBeUndefined();
	});

	it("reports voice unavailable on an HTTP error without echoing the provider body", async () => {
		const tts = new OpenAiTts({
			apiKey: "sk-test",
			fetchImpl: (async () =>
				new Response('{"error":{"message":"account acct_123 over quota"}}', {
					status: 429,
				})) as unknown as typeof fetch,
		});
		const run = async () => {
			for await (const _ of tts.synthesizeStream("hi", "verse", {
				signal: new AbortController().signal,
			}));
		};
		const error = await run().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(VoiceError);
		expect((error as Error).message).toBe("语音不可用: GPT voice HTTP 429");
	});

	it("treats caller cancellation as cancelled, not a failure", async () => {
		const controller = new AbortController();
		const tts = new OpenAiTts({
			apiKey: "sk-test",
			fetchImpl: ((_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () =>
						reject(new Error("aborted")),
					);
				})) as unknown as typeof fetch,
		});
		const pending = (async () => {
			for await (const _ of tts.synthesizeStream("hi", "alloy", {
				signal: controller.signal,
			}));
		})().catch((caught: unknown) => caught);
		controller.abort();
		expect(((await pending) as VoiceError).code).toBe("cancelled");
	});

	it("refuses endpoints outside api.openai.com and a missing credential", () => {
		expect(
			() =>
				new OpenAiTts({ apiKey: "k", endpoint: "http://api.openai.com/v1/x" }),
		).toThrow(/TLS allowlist/);
		expect(() => new OpenAiTts({ apiKey: "" })).toThrow(/credential/);
	});
});
