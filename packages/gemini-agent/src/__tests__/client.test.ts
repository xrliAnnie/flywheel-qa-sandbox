import { describe, expect, it } from "vitest";
import { createModelSurface, type RawGenAi } from "../client.js";
import { AbortedError, classifyError, retryAfterMsFrom } from "../errors.js";
import type { AuditLog, ToolSpec } from "../types.js";

function noopAudit(): AuditLog & {
	retries: Array<{ attempt: number; delayMs: number; errorKind: string }>;
} {
	const retries: Array<{
		attempt: number;
		delayMs: number;
		errorKind: string;
	}> = [];
	return {
		retries,
		sessionStart: () => {},
		modelCall: () => {},
		modelResponse: () => {},
		toolDispatch: () => {},
		toolResult: () => {},
		retry: (_layer, attempt, _max, delayMs, errorKind) => {
			retries.push({ attempt, delayMs, errorKind });
		},
		terminal: () => {},
		warning: () => {},
	};
}

const TOOL: ToolSpec = {
	name: "create_issue",
	description: "d",
	parameters: { type: "object", properties: { title: { type: "string" } } },
	readonly: false,
	execute: async () => ({ ok: true, body: "{}" }),
};

function apiError(status: number, message = `http ${status}`) {
	return Object.assign(new Error(message), { status });
}

/** Interaction fixture with one text output. */
function textInteraction(id: string, text: string) {
	return {
		id,
		steps: [{ type: "model_output", content: [{ type: "text", text }] }],
		usage: { total_input_tokens: 10, total_output_tokens: 5 },
	};
}

function makeInteractionsAi(
	script: Array<
		{ ok: unknown } | { err: unknown } | ((params: unknown) => unknown)
	>,
) {
	const calls: Array<Record<string, unknown>> = [];
	let i = 0;
	const ai: RawGenAi = {
		interactions: {
			create: async (params) => {
				calls.push(params);
				const entry = script[Math.min(i, script.length - 1)];
				i += 1;
				if (typeof entry === "function") return entry(params);
				if (entry && "err" in entry) throw entry.err;
				return (entry as { ok: unknown }).ok;
			},
		},
		models: {
			generateContent: async () => {
				throw new Error("not used");
			},
		},
	};
	return { ai, calls };
}

const instantSleep = async () => {};

describe("classifyError (§2.4 table — fields, not message regexes)", () => {
	it("429 status → quota, 3 retries", () => {
		expect(classifyError(apiError(429))).toMatchObject({
			kind: "quota",
			maxRetries: 3,
		});
	});
	it("RESOURCE_EXHAUSTED code → quota", () => {
		const err = Object.assign(new Error("x"), { code: "RESOURCE_EXHAUSTED" });
		expect(classifyError(err).kind).toBe("quota");
	});
	it("5xx → server, 3 retries", () => {
		expect(classifyError(apiError(503))).toMatchObject({
			kind: "server",
			maxRetries: 3,
		});
	});
	it("UNAVAILABLE code → server", () => {
		const err = Object.assign(new Error("x"), { code: "UNAVAILABLE" });
		expect(classifyError(err).kind).toBe("server");
	});
	it("401/403 → auth, no retries", () => {
		expect(classifyError(apiError(401))).toMatchObject({
			kind: "auth",
			maxRetries: 0,
		});
		expect(classifyError(apiError(403)).kind).toBe("auth");
	});
	it("400 → validation, no retries", () => {
		expect(classifyError(apiError(400))).toMatchObject({
			kind: "validation",
			maxRetries: 0,
		});
	});
	it("fetch TypeError → network, 1 retry", () => {
		expect(classifyError(new TypeError("fetch failed"))).toMatchObject({
			kind: "network",
			maxRetries: 1,
		});
	});
	it("timeout AbortError → network", () => {
		const err = Object.assign(new Error("t"), { name: "TimeoutError" });
		expect(classifyError(err).kind).toBe("network");
	});
	it("a message that merely MENTIONS 429 is not quota (no regex classification)", () => {
		const err = new Error("your usage of the word 429 is not a rate limit");
		expect(classifyError(err).kind).toBe("unknown");
	});
});

describe("retryAfterMsFrom", () => {
	it("prefers a numeric retryAfterMs field", () => {
		expect(retryAfterMsFrom({ retryAfterMs: 1500 })).toBe(1500);
	});
	it("parses a retry-after seconds header object", () => {
		expect(retryAfterMsFrom({ headers: { "retry-after": "7" } })).toBe(7000);
	});
	it("returns undefined when absent", () => {
		expect(retryAfterMsFrom(new Error("x"))).toBeUndefined();
	});
});

describe("createModelSurface — interactions adapter", () => {
	it("parses functionCalls + text + usage from steps[]", async () => {
		const { ai, calls } = makeInteractionsAi([
			{
				ok: {
					id: "i1",
					steps: [
						{
							type: "function_call",
							id: "c1",
							name: "create_issue",
							arguments: { title: "t" },
						},
					],
					usage: { total_input_tokens: 11, total_output_tokens: 3 },
				},
			},
		]);
		const surface = createModelSurface({
			ai,
			model: "m",
			surface: "interactions",
			audit: noopAudit(),
			sleep: instantSleep,
		});
		const turn = await surface.start(
			"sys",
			"user msg",
			[TOOL],
			new AbortController().signal,
		);
		expect(turn.functionCalls).toEqual([
			{ id: "c1", name: "create_issue", args: { title: "t" } },
		]);
		expect(turn.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
		// wire shape: system + tools + store on the create call
		expect(calls[0]).toMatchObject({
			model: "m",
			system_instruction: "sys",
			store: true,
			stream: false,
		});
		expect(
			(calls[0]?.tools as Array<Record<string, unknown>>)[0],
		).toMatchObject({ type: "function", name: "create_issue" });
	});

	it("threads previous_interaction_id and reports ids to the resume hook", async () => {
		const ids: string[] = [];
		const { ai, calls } = makeInteractionsAi([
			{ ok: textInteraction("i1", "") },
			{ ok: textInteraction("i2", "done") },
		]);
		const surface = createModelSurface({
			ai,
			model: "m",
			surface: "interactions",
			audit: noopAudit(),
			sleep: instantSleep,
			onInteractionId: (id) => ids.push(id),
		});
		const signal = new AbortController().signal;
		await surface.start("s", "u", [TOOL], signal);
		await surface.continueWith(
			[{ callId: "c1", name: "create_issue", result: "{}", isError: false }],
			signal,
		);
		expect(ids).toEqual(["i1", "i2"]);
		expect(calls[0]?.previous_interaction_id).toBeUndefined();
		expect(calls[1]?.previous_interaction_id).toBe("i1");
		const input = calls[1]?.input as Array<Record<string, unknown>>;
		expect(input[0]).toMatchObject({
			type: "function_result",
			call_id: "c1",
			name: "create_issue",
			result: "{}",
		});
		expect(input[0]?.is_error).toBeUndefined();
	});

	it("marks error results with is_error on the wire", async () => {
		const { ai, calls } = makeInteractionsAi([
			{ ok: textInteraction("i1", "") },
			{ ok: textInteraction("i2", "done") },
		]);
		const surface = createModelSurface({
			ai,
			model: "m",
			surface: "interactions",
			audit: noopAudit(),
			sleep: instantSleep,
		});
		const signal = new AbortController().signal;
		await surface.start("s", "u", [TOOL], signal);
		await surface.continueWith(
			[{ callId: "c1", name: "x", result: "boom", isError: true }],
			signal,
		);
		const input = calls[1]?.input as Array<Record<string, unknown>>;
		expect(input[0]?.is_error).toBe(true);
	});

	it("starts from a resumed interaction id when provided", async () => {
		const { ai, calls } = makeInteractionsAi([
			{ ok: textInteraction("i9", "hello again") },
		]);
		const surface = createModelSurface({
			ai,
			model: "m",
			surface: "interactions",
			audit: noopAudit(),
			sleep: instantSleep,
			resumeInteractionId: "i-resumed",
		});
		await surface.start("s", "u", [TOOL], new AbortController().signal);
		expect(calls[0]?.previous_interaction_id).toBe("i-resumed");
	});

	it("retries 5xx with backoff then succeeds (retry audit lines written)", async () => {
		const audit = noopAudit();
		const { ai } = makeInteractionsAi([
			{ err: apiError(503) },
			{ err: apiError(503) },
			{ ok: textInteraction("i1", "ok") },
		]);
		const surface = createModelSurface({
			ai,
			model: "m",
			surface: "interactions",
			audit,
			sleep: instantSleep,
		});
		const turn = await surface.start(
			"s",
			"u",
			[TOOL],
			new AbortController().signal,
		);
		expect(turn.text).toBe("ok");
		expect(audit.retries).toEqual([
			{ attempt: 1, delayMs: 2000, errorKind: "server" },
			{ attempt: 2, delayMs: 4000, errorKind: "server" },
		]);
	});

	it("exhausts 3 retries on persistent 5xx then throws ModelCallError with original message", async () => {
		const audit = noopAudit();
		const { ai, calls } = makeInteractionsAi([
			{ err: apiError(502, "bad gateway original") },
		]);
		const surface = createModelSurface({
			ai,
			model: "m",
			surface: "interactions",
			audit,
			sleep: instantSleep,
		});
		await expect(
			surface.start("s", "u", [TOOL], new AbortController().signal),
		).rejects.toMatchObject({
			name: "ModelCallError",
			kind: "server",
			httpStatus: 502,
			message: "bad gateway original",
		});
		expect(calls).toHaveLength(4); // 1 try + 3 retries
		expect(audit.retries).toHaveLength(3);
	});

	it("honors retry-after over the backoff ladder", async () => {
		const audit = noopAudit();
		const delays: number[] = [];
		const err = Object.assign(new Error("quota"), {
			status: 429,
			retryAfterMs: 1234,
		});
		const { ai } = makeInteractionsAi([
			{ err },
			{ ok: textInteraction("i1", "ok") },
		]);
		const surface = createModelSurface({
			ai,
			model: "m",
			surface: "interactions",
			audit,
			sleep: async (ms) => {
				delays.push(ms);
			},
		});
		await surface.start("s", "u", [TOOL], new AbortController().signal);
		expect(delays).toEqual([1234]);
	});

	it("4xx (non-429) is immediately fatal — zero retries", async () => {
		const audit = noopAudit();
		const { ai, calls } = makeInteractionsAi([
			{ err: apiError(400, "invalid request") },
		]);
		const surface = createModelSurface({
			ai,
			model: "m",
			surface: "interactions",
			audit,
			sleep: instantSleep,
		});
		await expect(
			surface.start("s", "u", [TOOL], new AbortController().signal),
		).rejects.toMatchObject({ kind: "validation", httpStatus: 400 });
		expect(calls).toHaveLength(1);
		expect(audit.retries).toHaveLength(0);
	});

	it("network TypeError retries once then fails as network", async () => {
		const { ai, calls } = makeInteractionsAi([
			{ err: new TypeError("fetch failed") },
		]);
		const surface = createModelSurface({
			ai,
			model: "m",
			surface: "interactions",
			audit: noopAudit(),
			sleep: instantSleep,
		});
		await expect(
			surface.start("s", "u", [TOOL], new AbortController().signal),
		).rejects.toMatchObject({ kind: "network" });
		expect(calls).toHaveLength(2);
	});

	it("caller abort surfaces as AbortedError, not a retry", async () => {
		const ac = new AbortController();
		const { ai } = makeInteractionsAi([
			(() => {
				ac.abort();
				throw Object.assign(new Error("aborted"), { name: "AbortError" });
			}) as (params: unknown) => unknown,
		]);
		const surface = createModelSurface({
			ai,
			model: "m",
			surface: "interactions",
			audit: noopAudit(),
			sleep: instantSleep,
		});
		await expect(
			surface.start("s", "u", [TOOL], ac.signal),
		).rejects.toBeInstanceOf(AbortedError);
	});
});

describe("createModelSurface — generate fallback adapter", () => {
	function makeGenerateAi(responses: unknown[]) {
		const calls: Array<Record<string, unknown>> = [];
		let i = 0;
		const ai: RawGenAi = {
			interactions: {
				create: async () => {
					throw new Error("not used");
				},
			},
			models: {
				generateContent: async (params) => {
					calls.push(params);
					return responses[Math.min(i++, responses.length - 1)];
				},
			},
		};
		return { ai, calls };
	}

	it("disables automaticFunctionCalling and accumulates local history", async () => {
		const { ai, calls } = makeGenerateAi([
			{
				candidates: [{ content: { role: "model", parts: [] } }],
				functionCalls: [{ name: "create_issue", args: { title: "t" } }],
				usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
			},
			{
				candidates: [{ content: { role: "model", parts: [] } }],
				text: "done",
				usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
			},
		]);
		const surface = createModelSurface({
			ai,
			model: "m",
			surface: "generate",
			audit: noopAudit(),
			sleep: instantSleep,
		});
		const signal = new AbortController().signal;
		const turn1 = await surface.start("sys", "user", [TOOL], signal);
		expect(turn1.functionCalls[0]).toMatchObject({
			name: "create_issue",
			args: { title: "t" },
		});
		// synthetic call id assigned when the API omits one
		expect(turn1.functionCalls[0]?.id).toBe("call-1");
		const config = calls[0]?.config as Record<string, unknown>;
		expect(config.automaticFunctionCalling).toEqual({ disable: true });

		const turn2 = await surface.continueWith(
			[
				{
					callId: "call-1",
					name: "create_issue",
					result: "{}",
					isError: false,
				},
			],
			signal,
		);
		expect(turn2.text).toBe("done");
		// history after round 2 (captured array is live): user msg + model
		// content 1 + functionResponse turn + model content 2
		expect((calls[1]?.contents as unknown[]).length).toBe(4);
	});
});
